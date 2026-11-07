'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryRepository } = require('./memory-repository');
const { createUsageAnalyticsService, analyticsCsv, csvCell, normalizeAnalyticsQuery } = require('../../src/hub/usage-analytics');

function fact(deviceId, model, tokens, overrides = {}) {
  return {
    deviceId, date: '2026-11-06', client: 'claude', model, provider: 'anthropic',
    tokens, cost: tokens / 100, messages: 2, outputTokens: tokens / 4,
    cacheReadTokens: 0, cacheWriteTokens: 0, unclassifiedTokens: 0,
    tokenComponentsAvailable: true, provenance: 'exact',
    source: 'tokscaleGraph', timeBasis: 'producerCalendarDay', ...overrides
  };
}

async function seed(store, facts) {
  const graph = facts.filter((row) => row.source === 'tokscaleGraph');
  const best = facts.filter((row) => row.source === 'usageEventsBestEffort');
  for (const [source, rows] of [['tokscaleGraph', graph], ['usageEventsBestEffort', best]]) {
    if (!rows.length) continue;
    const days = [...new Set(rows.map((row) => `${row.deviceId}\0${row.date}`))].map((key) => {
      const [deviceId, date] = key.split('\0');
      return { deviceId, date, source, timeBasis: rows[0].timeBasis, factCount: rows.filter((row) => row.deviceId === deviceId && row.date === date).length, truncated: false };
    });
    await store.replaceUsageDailyFacts('seed', { source, facts: rows, days, truncated: false });
  }
}

function service(store) {
  return createUsageAnalyticsService({ store, fleetTimeZone: 'Asia/Shanghai', now: () => new Date('2026-11-07T12:00:00+08:00') });
}

test('auto source prefers graph per device/day and labels mixed event fallback', async () => {
  const store = new MemoryRepository();
  await seed(store, [
    fact('a', 'm1', 100),
    fact('a', 'duplicate', 900, { source: 'usageEventsBestEffort', provenance: 'bestEffort', timeBasis: 'recordedAtDay' }),
    fact('b', 'm2', 40, { source: 'usageEventsBestEffort', provenance: 'bestEffort', timeBasis: 'recordedAtDay' })
  ]);
  const result = await service(store).query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', groupBy: 'model', bucket: 'none'
  }));
  assert.equal(result.source, 'mixed');
  assert.equal(result.bestEffort, true);
  assert.equal(result.totals.totalTokens, 140);
  assert.equal(result.rows.find((row) => row.model === 'm1').provenance, 'exact');
  assert.equal(result.rows.find((row) => row.model === 'm2').provenance, 'bestEffort');
  assert.equal(result.rows.find((row) => row.model === 'm2').timeBasis, 'recordedAtDay');
  const exact = await service(store).query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', groupBy: 'model', bucket: 'none', device: 'a'
  }));
  assert.equal(exact.source, 'tokscaleGraph');
  assert.equal(exact.totals.totalTokens, 100);
});

test('auto source fills uncovered partitions from the live ledger without double counting', async () => {
  const store = new MemoryRepository();
  await seed(store, [fact('a', 'graph-model', 100)]);
  for (const [deviceId, model, tokens] of [['a', 'duplicate-event', 900], ['b', 'event-model', 40]]) {
    store.devices.set(deviceId, { deviceId });
    store.events.push({
      deviceId, client: 'claude', sessionId: `s-${deviceId}`, model, provider: 'p',
      recordedAt: '2026-11-06T04:00:00.000Z', inputTokens: tokens, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, messageCount: 1, credits: 0
    });
  }
  const result = await service(store).query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', groupBy: 'model', bucket: 'none'
  }));
  assert.equal(result.source, 'mixed');
  assert.equal(result.totals.totalTokens, 140);
  assert.equal(result.rows.some((row) => row.model === 'duplicate-event'), false);
  assert.equal(result.rows.find((row) => row.model === 'event-model').totalTokens, 40);
});

test('unknown token components stay null in totals and blank in CSV', async () => {
  const store = new MemoryRepository();
  await seed(store, [fact('a', 'm1', 100, {
    outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, unclassifiedTokens: null,
    tokenComponentsAvailable: false
  })]);
  const result = await service(store).query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', groupBy: 'model', bucket: 'none', metrics: 'tokens,output'
  }));
  assert.equal(result.totals.totalTokens, 100);
  assert.equal(result.totals.outputTokens, null);
  assert.equal(result.rows[0].outputTokens, null);
  assert.equal(result.metricSemantics.outputTokens.available, false);
  const csv = analyticsCsv(result);
  assert.match(csv, /^\uFEFFmodel,totalTokens,outputTokens,/);
  assert.match(csv, /\r\nm1,100,,/);
});

test('event analytics does not relabel uncached input as unclassified', async () => {
  const store = new MemoryRepository();
  store.devices.set('a', { deviceId: 'a' });
  store.events.push({
    deviceId: 'a', client: 'claude', sessionId: 's1', model: 'm1', provider: 'p',
    projectId: 'p1', projectLabel: 'Project', recordedAt: '2026-11-06T04:00:00.000Z',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0,
    costUsd: 0.2, messageCount: 1, credits: 0
  });
  const result = await service(store).query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', source: 'events', groupBy: 'session', bucket: 'hour',
    metrics: 'tokens,output,unclassified'
  }));
  assert.equal(result.totals.totalTokens, 17);
  assert.equal(result.totals.unclassifiedTokens, 0);
  assert.equal(result.rows[0].session, 's1');
  const hourly = await service(store).query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', source: 'events', groupBy: 'date', bucket: 'hour', metrics: 'tokens'
  }));
  assert.equal(hourly.rows[0].date, '2026-11-06');
  assert.match(hourly.rows[0].hour, /^2026-11-06T12:00$/);
});

test('deterministic cursors and Top N Other preserve every group', async () => {
  const store = new MemoryRepository();
  await seed(store, [fact('a', 'm-b', 100), fact('a', 'm-a', 100), fact('a', 'm-c', 100)]);
  const analytics = service(store);
  const first = await analytics.query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', groupBy: 'model', bucket: 'none', sort: 'tokens', limit: '2', top: '1'
  }));
  assert.equal(first.rows.length, 2);
  assert.equal(first.totalRows, 3);
  assert.ok(first.nextCursor);
  assert.equal(first.breakdown.at(-1).model, 'Other');
  assert.equal(first.breakdown.at(-1).provenance, 'exact');
  assert.equal(first.breakdown.reduce((sum, row) => sum + row.totalTokens, 0), 300);
  const second = await analytics.query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', groupBy: 'model', bucket: 'none', sort: 'tokens', limit: '2', cursor: first.nextCursor
  }));
  assert.equal(second.rows.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.model)).size, 3);
});

test('unknown fact costs propagate through totals, groups and CSV', async () => {
  const store = new MemoryRepository();
  await seed(store, [
    fact('a', 'm1', 100, { cost: 2 }),
    fact('a', 'm1', 50, { cost: null, client: 'other' })
  ]);
  const result = await service(store).query(new URLSearchParams({
    startDate: '2026-11-06', endDate: '2026-11-06', groupBy: 'model', bucket: 'none', top: '1'
  }));
  assert.equal(result.totals.totalTokens, 150);
  assert.equal(result.totals.costUsd, null);
  assert.equal(result.rows[0].costUsd, null);
  assert.equal(result.coverage.costUnavailable, true);
  assert.equal(result.metricSemantics.costUsd.available, false);
  const [header, line] = analyticsCsv(result).replace(/^\uFEFF/, '').split('\r\n');
  const columns = header.split(',');
  assert.equal(line.split(',')[columns.indexOf('costUsd')], '');
});

test('analytics validates bounded queries and CSV neutralizes spreadsheet formulas', () => {
  assert.throws(() => normalizeAnalyticsQuery(new URLSearchParams({ startDate: '2020-01-01', endDate: '2026-01-01' })), (error) => error.code === 'range_too_large');
  assert.throws(() => normalizeAnalyticsQuery(new URLSearchParams({ groupBy: '__proto__' })), /invalid_groupBy/);
  assert.equal(csvCell(' =1+1'), "' =1+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
});
