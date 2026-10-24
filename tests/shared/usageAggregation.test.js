'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PERIODS, addPeriodInto, aggregateDevices, emptyPeriod, mergePeriods,
  normalizeDeviceRecord, projectDeviceForNow, summarizeStats
} = require('../../src/shared/usage');

const NOW = Date.parse('2026-06-26T12:00:00Z');
const LIGHTWEIGHT = { normalized: true, omitAggregateSessions: true };

function record(deviceId, extra = {}) {
  const period = {
    totalTokens: 100, costUsd: 0.123456789,
    cacheReadTokens: 10, cacheWriteTokens: 20, outputTokens: 30,
    timedTokens: 100, timedOutputTokens: 30, timedDurationMs: 1500,
    clients: { codex: 100 }, clientCosts: { codex: 0.123456789 },
    clientCacheReads: { codex: 10 }, clientCacheWrites: { codex: 20 }, clientOutputs: { codex: 30 },
    clientCredits: { codex: 0.234567891 }, clientEstimated: { codex: true },
    clientMeasurements: { codex: { tokens: 'estimated', costUsd: 'exact', meters: { requests: { value: 3, provenance: 'exact' } } } },
    models: { 'gpt-5': 100 }, modelCosts: { 'gpt-5': 0.123456789 },
    modelCacheReads: { 'gpt-5': 10 }, modelCacheWrites: { 'gpt-5': 20 }, modelOutputs: { 'gpt-5': 30 },
    clientModels: { codex: { 'gpt-5': 100 } }, clientModelCosts: { codex: { 'gpt-5': 0.123456789 } },
    clientModelCredits: { codex: { 'gpt-5': 0.234567891 } },
    // A bounded session archive must never replace the separately retained rollup.
    projects: { work: { label: 'Work', tokens: 100, costUsd: 0.123456789, clients: { codex: 100 } } },
    sessions: { s: { client: 'codex', sessionId: 's', totalTokens: 40, costUsd: 0.043456789,
      projectId: 'work', projectLabel: 'Work', models: { 'gpt-5': 40 }, modelCosts: { 'gpt-5': 0.043456789 } } }
  };
  return {
    deviceId, hostname: deviceId, platform: 'darwin', osName: 'macOS', osVersion: '26',
    agentVersion: '1.0.0', agentRuntime: 'agent', updatedAt: '2026-06-26T11:59:00Z', receivedAt: '2026-06-26T11:59:00Z',
    trackedClients: ['codex'], clientStatus: { codex: 'active' }, projectsEnabled: true,
    syncUploadIntervalMs: 60000, sessionDetailsOmitted: { today: 2 }, periodProjectsOmitted: { month: 1 },
    periodWindows: { today: { key: '2026-06-26', endsAt: '2026-06-27T00:00:00Z' },
      month: { key: '2026-06', endsAt: '2026-07-01T00:00:00Z' } },
    today: period, month: period, allTime: period, ...extra
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function withoutClock(stats) {
  const { updatedAt: _updatedAt, ...rest } = stats;
  return rest;
}

test('normalized full and lightweight aggregation agree on every non-session field', () => {
  const raw = [record('a'), record('b', { projectsEnabled: false }), record('old', {
    periodWindows: { today: { key: '2026-06-25', endsAt: '2026-06-26T00:00:00Z' },
      month: { key: '2026-05', endsAt: '2026-06-01T00:00:00Z' } },
    allTimeProjectsIncomplete: true
  })];
  const normalized = raw.map(normalizeDeviceRecord);
  const full = aggregateDevices(normalized, 600000, NOW, { normalized: true });
  const lightweight = aggregateDevices(normalized, 600000, NOW, LIGHTWEIGHT);
  assert.deepEqual(withoutClock(full), withoutClock(aggregateDevices(raw, 600000, NOW)));
  for (const period of PERIODS) {
    assert.ok(Object.keys(full.periods[period].sessions).length > 0);
    assert.equal(Object.keys(lightweight.periods[period].sessions).length, 0);
    const { sessions: _sessions, ...nonSessionFields } = full.periods[period];
    const { sessions: _emptySessions, ...lightFields } = lightweight.periods[period];
    assert.deepEqual(lightFields, nonSessionFields);
    assert.ok(Object.keys(lightFields.projects).length > 0);
  }
  assert.deepEqual(lightweight.devices, full.devices);
  assert.deepEqual(withoutClock(summarizeStats(lightweight)), withoutClock(summarizeStats(full)));
});

test('aggregation never modifies shared normalized records, maps or session costs', () => {
  const source = normalizeDeviceRecord(record('a'));
  const before = JSON.stringify(source);
  freeze(source);
  const full = aggregateDevices([source, source], 600000, NOW, { normalized: true });
  const lightweight = aggregateDevices([source, source], 600000, NOW, LIGHTWEIGHT);
  assert.equal(JSON.stringify(source), before);
  assert.notEqual(full.periods.today.projects.work, source.periods.today.projects.work);
  assert.notEqual(full.periods.today.sessions['codex:s'], source.periods.today.sessions['codex:s']);
  assert.equal(full.periods.today.totalTokens, 200);
  assert.deepEqual(lightweight.periods.today.projects, full.periods.today.projects);
});

test('normalized lightweight aggregation never reads session detail or renormalizes periods', () => {
  const source = normalizeDeviceRecord(record('a'));
  for (const period of Object.values(source.periods)) {
    Object.defineProperty(period, 'sessions', { get() { throw new Error('session archive traversed'); } });
  }
  const lightweight = aggregateDevices([source], 600000, NOW, LIGHTWEIGHT);
  assert.equal(lightweight.periods.today.totalTokens, 100);
  assert.equal(lightweight.periods.today.projects.work.tokens, 100);
  assert.equal(Object.keys(lightweight.periods.today.sessions).length, 0);
});

test('normalized full aggregation folds each session archive once without normalization', () => {
  const source = normalizeDeviceRecord(record('a'));
  let reads = 0;
  for (const period of Object.values(source.periods)) {
    const sessions = period.sessions;
    Object.defineProperty(period, 'sessions', { get() { reads++; return sessions; } });
  }
  const full = aggregateDevices([source], 600000, NOW, { normalized: true });
  assert.equal(reads, PERIODS.length);
  assert.equal(full.periods.today.sessions['codex:s'].totalTokens, 40);
});

test('legacy omitSessionDetail and ordinary collector merges retain their semantics', () => {
  const source = normalizeDeviceRecord(record('a')).periods.today;
  const omitted = addPeriodInto(emptyPeriod(), source, { omitSessionDetail: true });
  assert.equal(Object.keys(omitted.projects).length, 0);
  assert.equal(Object.keys(omitted.sessions).length, 0);
  const merged = mergePeriods(source, source);
  assert.equal(merged.projects.work.tokens, 200);
  assert.equal(merged.sessions['codex:s'].totalTokens, 80);
});

test('device detail projection shares aggregate expiry and interval-aware stale rules', () => {
  const source = freeze(normalizeDeviceRecord(record('a', { syncUploadIntervalMs: 3600000 })));
  for (const now of [NOW, Date.parse('2026-06-27T00:00:00Z'), Date.parse('2026-07-01T00:00:00Z')]) {
    const device = projectDeviceForNow(source, 600000, now);
    assert.deepEqual(device, aggregateDevices([source], 600000, now, { normalized: true }).devices[0]);
    assert.equal(device.periods.allTime, source.periods.allTime);
  }
  const stale = projectDeviceForNow(source, 600000, NOW + 3600000 * 2);
  assert.equal(projectDeviceForNow(source, 600000, NOW).stale, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.periods.today.totalTokens, 100);
  const expired = projectDeviceForNow(source, 600000, Date.parse('2026-07-01T00:00:00Z'));
  assert.equal(expired.periods.today.totalTokens, 0);
  assert.equal(expired.periods.month.totalTokens, 0);
  assert.equal(source.periods.today.totalTokens, 100);
});
