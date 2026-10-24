'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRepository, emptyUsageRange } = require('../../src/hub/repository');
const { calculateUsageEventDeltas, usageCandidates } = require('../../src/hub/usage-events');
const { normalizeDeviceRecord } = require('../../src/shared/usage');
const { MemoryRepository } = require('./memory-repository');

const at = '2026-10-24T00:00:00.000Z';

function recorder(result = []) {
  const calls = [];
  return {
    calls,
    async execute(sql, values) {
      calls.push({ sql, values });
      return [typeof result === 'function' ? result(sql, values) : result];
    },
    async query(sql, values) { return this.execute(sql, values); }
  };
}

function summary(sessionId = 'session-1', patch = {}) {
  return {
    client: 'codex', sessionId, totalTokens: 21, inputTokens: 5, outputTokens: 6,
    cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 1, messageCount: 2,
    costUsd: 0.1234567890123, startedAt: at, lastUsedAt: at,
    models: { 'gpt-5': 20, other: 1 }, ...patch
  };
}

function sessionRow(item) {
  return {
    device_id: 'device-1', client: item.client, session_id: item.sessionId,
    total_tokens: item.totalTokens, input_tokens: item.inputTokens, output_tokens: item.outputTokens,
    cache_read_tokens: item.cacheReadTokens, cache_write_tokens: item.cacheWriteTokens,
    reasoning_tokens: item.reasoningTokens, message_count: item.messageCount,
    cost_usd: item.costUsd.toFixed(10), started_at: new Date(item.startedAt), last_used_at: new Date(item.lastUsedAt),
    models: JSON.stringify(Object.fromEntries(Object.entries(item.models).reverse()))
  };
}

function event(index, patch = {}) {
  return {
    client: 'codex', sessionId: `session-${index}`, model: 'gpt-5', provider: null,
    projectId: null, projectLabel: null, recordedAt: at, inputTokens: index + 1,
    outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5,
    messageCount: 6, priceInputPerMillion: 0.12345678, priceOutputPerMillion: 0.23456789,
    priceCacheReadPerMillion: 0.34567891, priceCacheWritePerMillion: 0.45678912,
    pricingSource: 'manual', pricingSnapshotAt: at, costUsd: 0.0123456789, credits: 0.12345678,
    ...patch
  };
}

test('saveDevice serializes the display snapshot once and keeps legacy baseline semantics', async () => {
  const sql = recorder();
  const repository = createRepository(sql);
  let visits = 0;
  const record = {
    deviceId: 'device-1', updatedAt: at, receivedAt: at, limits: { private: true }, limitsOnly: true,
    periods: { toJSON() { visits++; return { allTime: { totalTokens: 42 } }; } }
  };
  await repository.saveDevice(record);
  assert.equal(visits, 1);
  assert.equal(sql.calls.length, 3);
  assert.equal(sql.calls[1].values[1], sql.calls[2].values[1]);
  assert.equal(JSON.parse(sql.calls[1].values[1]).limits, undefined);
  assert.equal(JSON.parse(sql.calls[1].values[1]).limitsOnly, undefined);
  assert.doesNotMatch(sql.calls[2].sql.split('ON DUPLICATE KEY UPDATE')[1], /transferred/);
});

test('saveDevice binds raw baseline separately or leaves it untouched for display-only saves', async () => {
  const sql = recorder();
  const repository = createRepository(sql);
  const display = { deviceId: 'device-1', periods: { allTime: { totalTokens: 0 } } };
  const raw = { ...display, periods: { allTime: { totalTokens: 100 } } };
  await repository.saveDevice(display, sql, { baseline: raw });
  assert.equal(JSON.parse(sql.calls[1].values[1]).periods.allTime.totalTokens, 0);
  assert.equal(JSON.parse(sql.calls[2].values[1]).periods.allTime.totalTokens, 100);
  sql.calls.length = 0;
  await repository.saveDevice(display, sql, { baseline: false });
  assert.equal(sql.calls.length, 2);
  assert.ok(sql.calls.every(({ sql: statement }) => !statement.includes('device_ingest_baseline')));
});

test('a value-identical raw cumulative clone reuses the display snapshot serialization', async () => {
  const sql = recorder();
  let serializations = 0;
  const display = {
    deviceId: 'device-1', updatedAt: at, receivedAt: at,
    periods: { toJSON() { serializations++; return { allTime: { totalTokens: 123 } }; } }
  };
  const raw = { ...display, limits: { ignored: true } };
  await createRepository(sql).saveDevice(display, sql, { baseline: raw });
  assert.equal(serializations, 1);
  assert.equal(sql.calls[1].values[1], sql.calls[2].values[1]);
});

test('active device lookup uses one keyed JOIN and the supplied transaction executor', async () => {
  const sql = recorder([{ snapshot_json: '{"deviceId":"device-1","history":{"days":{}}}' }]);
  const pool = { async execute() { assert.fail('must use the supplied executor'); } };
  const repository = createRepository(pool);
  assert.deepEqual(await repository.getActiveDeviceRecord('device-1', sql), { deviceId: 'device-1', history: { days: {} } });
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].sql, /INNER JOIN devices device ON device.device_id = state.device_id/);
  assert.match(sql.calls[0].sql, /WHERE device.device_id = \? AND device.deleted_at IS NULL/);
  assert.deepEqual(sql.calls[0].values, ['device-1']);
  assert.doesNotMatch(sql.calls[0].sql, /ORDER BY/);
  assert.equal(await repository.getActiveDeviceRecord('missing', recorder()), null);
});

test('hidden devices are absent from active lookup but retain their ingest snapshot and baseline', async () => {
  const repository = new MemoryRepository();
  const record = { deviceId: 'device-1', history: { days: { '2026-10-24': { tokens: 123 } } } };
  await repository.saveDevice(record);
  const active = await repository.getActiveDeviceRecord('device-1');
  active.history.days = {};
  assert.deepEqual(await repository.getActiveDeviceRecord('device-1'), record, 'return a detached snapshot');
  await repository.deleteDevice('device-1');
  assert.equal(await repository.getActiveDeviceRecord('device-1'), null);
  assert.equal(await repository.getActiveDeviceRecord('missing'), null);
  assert.deepEqual(await repository.getDeviceRecord('device-1'), record);
  assert.deepEqual((await repository.getIngestBaseline('device-1')).snapshot, record);
  await repository.saveDevice(record, repository, { previousRecord: record });
  assert.deepEqual(await repository.getActiveDeviceRecord('device-1'), record, 're-ingest reactivates the device');
});

test('persisted previousRecord omits unchanged history from metadata UPDATE without weakening baseline writes', async () => {
  const sql = recorder();
  const repository = createRepository(sql);
  const previous = {
    deviceId: 'device-1', updatedAt: at, receivedAt: at,
    history: { days: { '2026-10-24': { totalTokens: 123, costUsd: 0.123456789 } }, version: 1 },
    periods: { allTime: { totalTokens: 123, clientCredits: { qoder: 0.12345678 } } }
  };
  const current = {
    ...previous, updatedAt: '2026-10-24T00:01:00.000Z', receivedAt: '2026-10-24T00:01:01.000Z',
    history: { version: 1, days: { '2026-10-24': { costUsd: 0.123456789, totalTokens: 123 } } }
  };
  const raw = { ...current, periods: { allTime: { totalTokens: 999, clientCredits: { qoder: 0.87654321 } } } };
  await repository.saveDevice(current, sql, { previousRecord: previous, baseline: raw });
  assert.equal(sql.calls.length, 3);
  const metadata = sql.calls[0];
  assert.match(metadata.sql, /^UPDATE devices SET/);
  assert.match(metadata.sql, /deleted_at = NULL WHERE device_id = \?/);
  assert.doesNotMatch(metadata.sql, /\bhistory\b/);
  assert.equal(metadata.values.length, 16);
  assert.equal(metadata.values.at(-1), 'device-1');
  assert.ok(!metadata.values.includes(JSON.stringify(current.history)));
  assert.match(sql.calls[1].sql, /^UPDATE device_ingest_state SET snapshot_json = JSON_SET/);
  assert.deepEqual(sql.calls[1].values, [current.updatedAt, current.receivedAt, current.deviceId]);
  assert.match(sql.calls[2].sql, /^INSERT INTO device_ingest_baseline/);
  assert.deepEqual(JSON.parse(sql.calls[2].values[1]), raw, 'baseline timestamps and all raw counters must still advance');
  assert.doesNotMatch(sql.calls[2].sql.split('ON DUPLICATE KEY UPDATE')[1], /transferred/);
});

test('first inserts, mismatched previous ids and changed/cleared history still bind history', async () => {
  const current = { deviceId: 'device-1', updatedAt: at, receivedAt: at, history: { days: { today: 100 } } };
  const sql = recorder();
  const repository = createRepository(sql);
  for (const previousRecord of [undefined, { ...current, deviceId: 'other-device' }]) {
    sql.calls.length = 0;
    await repository.saveDevice(current, sql, { previousRecord });
    assert.equal(sql.calls.length, 3);
    assert.match(sql.calls[0].sql, /^INSERT INTO devices/);
    assert.match(sql.calls[0].sql, /\bhistory\b/);
    assert.equal(sql.calls[0].values.at(-1), JSON.stringify(current.history));
  }
  for (const history of [{ days: { today: 101 } }, null, undefined]) {
    sql.calls.length = 0;
    const next = { ...current, history };
    await repository.saveDevice(next, sql, { previousRecord: current });
    assert.match(sql.calls[0].sql, /^UPDATE devices SET/);
    assert.match(sql.calls[0].sql, /history = \?/);
    assert.equal(sql.calls[0].values.at(-2), history === undefined ? null : JSON.stringify(history));
    assert.match(sql.calls[1].sql, /^INSERT INTO device_ingest_state/);
    assert.deepEqual(JSON.parse(sql.calls[1].values[1]), JSON.parse(JSON.stringify(next)));
  }
});

test('unchanged display-only saves write metadata once and timestamp-only saves never serialize history', async () => {
  const sql = recorder();
  const repository = createRepository(sql);
  let serializations = 0;
  const current = {
    deviceId: 'device-1', updatedAt: at, receivedAt: at,
    history: { toJSON() { serializations++; return { days: {} }; } }
  };
  await repository.saveDevice(current, sql, { previousRecord: current, baseline: false });
  assert.equal(sql.calls.length, 1);
  assert.equal(serializations, 0);
  sql.calls.length = 0;
  const next = { ...current, receivedAt: '2026-10-24T00:01:00.000Z' };
  await repository.saveDevice(next, sql, { previousRecord: current, baseline: false });
  assert.equal(sql.calls.length, 2);
  assert.match(sql.calls[1].sql, /JSON_SET/);
  assert.equal(serializations, 0);
});

test('every changed usage/provenance field forces a full display snapshot rather than a timestamp-only update', async () => {
  const previous = {
    deviceId: 'device-1', updatedAt: at, receivedAt: at,
    periods: { allTime: { totalTokens: 123, costUsd: 0.1, clientCredits: { qoder: 0.25 } } },
    history: { days: {} }
  };
  const changed = [
    { ...previous, periods: { allTime: { ...previous.periods.allTime, totalTokens: 124 } } },
    { ...previous, periods: { allTime: { ...previous.periods.allTime, costUsd: 0.1000000001 } } },
    { ...previous, periods: { allTime: { ...previous.periods.allTime, clientCredits: { qoder: 0.2500000001 } } } },
    { ...previous, clientStatus: { qoder: { active: true } } },
    { ...previous, periodWindows: { allTime: { from: at } } },
    { ...previous, updatedAt: undefined, receivedAt: undefined }
  ];
  for (const record of changed) {
    const sql = recorder();
    await createRepository(sql).saveDevice(record, sql, { previousRecord: previous });
    assert.match(sql.calls[1].sql, /^INSERT INTO device_ingest_state/);
    assert.deepEqual(JSON.parse(sql.calls[1].values[1]), JSON.parse(JSON.stringify(record)));
    assert.deepEqual(JSON.parse(sql.calls[2].values[1]), JSON.parse(JSON.stringify(record)));
  }
});

test('explicit unchanged persisted raw baseline skips its write independently of a changed display', async () => {
  const sql = recorder();
  const previousRecord = { deviceId: 'device-1', updatedAt: at, receivedAt: at, periods: { allTime: { totalTokens: 100 } } };
  const raw = { ...previousRecord, periods: { allTime: { totalTokens: 40, clientCredits: { qoder: 0.25 } } } };
  const display = { ...previousRecord, periods: { allTime: { totalTokens: 140 } } };
  await createRepository(sql).saveDevice(display, sql, { previousRecord, baseline: raw, previousBaseline: structuredClone(raw) });
  assert.equal(sql.calls.length, 2);
  assert.match(sql.calls[1].sql, /^INSERT INTO device_ingest_state/);
  assert.equal(JSON.parse(sql.calls[1].values[1]).periods.allTime.totalTokens, 140);
  assert.ok(sql.calls.every((call) => !call.sql.includes('device_ingest_baseline')));
});

test('timestamp-only raw and display updates bind only times without serializing history or resetting transferred', async () => {
  const sql = recorder();
  let serializations = 0;
  const previousRecord = {
    deviceId: 'device-1', updatedAt: at, receivedAt: at,
    history: { toJSON() { serializations++; return { days: {} }; } },
    periods: { allTime: { totalTokens: 160, clientCredits: { qoder: 0.25 } } }
  };
  const previousBaseline = { ...previousRecord, periods: { allTime: { totalTokens: 60, clientCredits: { qoder: 0.1 } } } };
  const times = { updatedAt: '2026-10-24T00:01:00.000Z', receivedAt: '2026-10-24T00:01:01.000Z' };
  const record = { ...previousRecord, ...times };
  const raw = { ...previousBaseline, ...times };
  await createRepository(sql).saveDevice(record, sql, { previousRecord, baseline: raw, previousBaseline });
  assert.equal(sql.calls.length, 3);
  assert.equal(serializations, 0);
  assert.match(sql.calls[1].sql, /^UPDATE device_ingest_state SET snapshot_json = JSON_SET/);
  assert.match(sql.calls[2].sql, /^UPDATE device_ingest_baseline SET snapshot_json = JSON_SET/);
  for (const call of sql.calls.slice(1)) {
    assert.deepEqual(call.values, [times.updatedAt, times.receivedAt, 'device-1']);
    assert.doesNotMatch(call.sql, /transferred/);
  }
});

test('unchanged raw and display snapshots need only the small metadata write', async () => {
  const sql = recorder();
  const record = { deviceId: 'device-1', updatedAt: at, receivedAt: at, periods: { allTime: { totalTokens: 160 } } };
  const baseline = { ...record, periods: { allTime: { totalTokens: 60 } } };
  await createRepository(sql).saveDevice(record, sql, { previousRecord: record, baseline, previousBaseline: baseline });
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].sql, /^UPDATE devices SET/);
});

test('JSON-persisted plain maps and normalized null-prototype maps compare by content', async () => {
  const sql = recorder();
  const map = Object.assign(Object.create(null), { project: { tokens: 60, costs: [0.125, 0.25] } });
  const baseline = {
    deviceId: 'device-1', updatedAt: at, receivedAt: at,
    periods: { allTime: { totalTokens: 60, projects: map } }, history: { projects: map }
  };
  const record = { ...baseline, periods: { allTime: { totalTokens: 160, projects: map } } };
  const previousRecord = JSON.parse(JSON.stringify(record));
  const previousBaseline = JSON.parse(JSON.stringify(baseline));
  await createRepository(sql).saveDevice(record, sql, { previousRecord, baseline, previousBaseline });
  assert.equal(sql.calls.length, 1, 'JSON round-trip prototype changes must not trigger large unchanged snapshot writes');
  assert.doesNotMatch(sql.calls[0].sql, /\bhistory\b/);
  sql.calls.length = 0;
  const times = { updatedAt: '2026-10-24T00:01:00.000Z', receivedAt: '2026-10-24T00:01:01.000Z' };
  await createRepository(sql).saveDevice({ ...record, ...times }, sql, {
    previousRecord, baseline: { ...baseline, ...times }, previousBaseline
  });
  assert.equal(sql.calls.length, 3);
  assert.match(sql.calls[1].sql, /JSON_SET/);
  assert.match(sql.calls[2].sql, /JSON_SET/);
});

test('unknown/wrong-device previous raw baseline always performs the first full upsert even if display is unchanged', async () => {
  const record = { deviceId: 'device-1', updatedAt: at, receivedAt: at, periods: { allTime: { totalTokens: 100 } } };
  for (const previousBaseline of [undefined, null, { ...record, deviceId: 'other-device' }]) {
    const sql = recorder();
    await createRepository(sql).saveDevice(record, sql, { previousRecord: record, baseline: { ...record }, previousBaseline });
    assert.equal(sql.calls.length, 2);
    assert.match(sql.calls[1].sql, /^INSERT INTO device_ingest_baseline/);
    assert.deepEqual(JSON.parse(sql.calls[1].values[1]), record);
  }
});

test('raw delta, credit, attribution, history and timestamp-shape changes force a full baseline write', async () => {
  const raw = {
    deviceId: 'device-1', updatedAt: at, receivedAt: at, history: { days: {} },
    periods: { allTime: { totalTokens: 60, costUsd: 0.0000000001, clientCredits: { qoder: 0.25 } } }
  };
  const record = { ...raw, periods: { allTime: { totalTokens: 160 } } };
  const changes = [
    { ...raw, periods: { allTime: { ...raw.periods.allTime, totalTokens: 61 } } },
    { ...raw, periods: { allTime: { ...raw.periods.allTime, costUsd: 0.0000000002 } } },
    { ...raw, periods: { allTime: { ...raw.periods.allTime, clientCredits: { qoder: 0.2500000001 } } } },
    { ...raw, periodWindows: { allTime: { from: at } } },
    { ...raw, history: { days: { '2026-10-24': { totalTokens: 60 } } } },
    { ...raw, updatedAt: undefined, receivedAt: undefined }
  ];
  for (const baseline of changes) {
    const sql = recorder();
    await createRepository(sql).saveDevice(record, sql, { previousRecord: record, baseline, previousBaseline: raw });
    assert.equal(sql.calls.length, 2);
    assert.match(sql.calls[1].sql, /^INSERT INTO device_ingest_baseline/);
    assert.deepEqual(JSON.parse(sql.calls[1].values[1]), JSON.parse(JSON.stringify(baseline)));
    assert.doesNotMatch(sql.calls[1].sql.split('ON DUPLICATE KEY UPDATE')[1], /transferred/);
  }
});

test('memory baseline updates mirror previousBaseline hints while retaining transferred and zero replay deltas', async () => {
  const repository = new MemoryRepository();
  const previousBaseline = normalizeDeviceRecord({ deviceId: 'device-1', updatedAt: at, receivedAt: at, allTime: { clients: { codex: 60 } } });
  const previousRecord = { ...previousBaseline, periods: { ...previousBaseline.periods, allTime: { totalTokens: 160 } } };
  await repository.saveDevice(previousRecord, repository, { baseline: previousBaseline });
  await repository.saveIngestBaseline('device-1', previousBaseline, { transferred: true });
  const times = { updatedAt: '2026-10-24T00:01:00.000Z', receivedAt: '2026-10-24T00:01:01.000Z' };
  const raw = { ...previousBaseline, ...times };
  await repository.saveDevice({ ...previousRecord, ...times }, repository, { baseline: raw, previousRecord, previousBaseline });
  const stored = await repository.getIngestBaseline('device-1');
  const expected = JSON.parse(JSON.stringify(raw));
  delete expected.limits;
  assert.deepEqual(stored.snapshot, expected);
  assert.equal(stored.transferred, true);
  assert.equal(calculateUsageEventDeltas(stored.snapshot, raw, { normalized: true }).events.length, 0);
});

test('memory baseline contract prevents repeated ledger entries after display-only changes and delete', async () => {
  const repository = new MemoryRepository();
  const raw = normalizeDeviceRecord({ deviceId: 'device-1', updatedAt: at, allTime: { clients: { codex: 100 } } });
  const display = normalizeDeviceRecord({ deviceId: 'device-1', updatedAt: at, allTime: { clients: { codex: 0 } } });
  await repository.saveDevice(display, repository, { baseline: raw });
  await repository.saveIngestBaseline('device-1', raw, { transferred: true });
  await repository.saveDevice(display, repository, { baseline: false });
  await repository.deleteDevice('device-1');
  const baseline = await repository.getIngestBaseline('device-1');
  assert.equal(baseline.transferred, true);
  assert.equal(calculateUsageEventDeltas(baseline.snapshot, raw).events.length, 0);
  await repository.renameDevice('device-1', 'device-2');
  assert.equal((await repository.getIngestBaseline('device-2')).transferred, true);
  assert.equal((await repository.getIngestBaseline('device-2')).snapshot.deviceId, 'device-2');
});

test('SQL rename preserves the raw baseline and transferred flag rather than anchoring to display', async () => {
  const display = { deviceId: 'old', periods: { allTime: { totalTokens: 10 } } };
  const raw = { ...display, periods: { allTime: { totalTokens: 100 } } };
  const sql = recorder((statement) => {
    if (statement.includes('WHERE device_id IN')) return [{ device_id: 'old' }];
    if (statement.startsWith('SELECT snapshot_json FROM device_ingest_state')) return [{ snapshot_json: display }];
    if (statement.startsWith('SELECT snapshot_json, transferred')) return [{ snapshot_json: raw, transferred: 1 }];
    return [];
  });
  const repository = createRepository(sql);
  assert.equal((await repository.renameDevice('old', 'new', sql)).renamed, true);
  const displayWrite = sql.calls.find((call) => call.sql.startsWith('INSERT INTO device_ingest_state'));
  const baselineWrites = sql.calls.filter((call) => call.sql.startsWith('INSERT INTO device_ingest_baseline'));
  assert.equal(JSON.parse(displayWrite.values[1]).periods.allTime.totalTokens, 10);
  assert.equal(baselineWrites.length, 2);
  assert.equal(JSON.parse(baselineWrites[0].values[1]).periods.allTime.totalTokens, 100);
  assert.equal(JSON.parse(baselineWrites[0].values[1]).deviceId, 'new');
  assert.deepEqual(baselineWrites[1].values.slice(2), [1]);
});

test('usage event batches bound row/placeholder counts and retain every pricing and credit parameter', async () => {
  const sql = recorder();
  const pool = { async execute() { assert.fail('must use the supplied transaction executor'); } };
  const repository = createRepository(pool);
  const events = Array.from({ length: 1001 }, (_, index) => event(index));
  await repository.insertUsageEvents('device-1', [], sql);
  assert.equal(sql.calls.length, 0);
  await repository.insertUsageEvents('device-1', events, sql);
  assert.deepEqual(sql.calls.map((call) => call.values.length), [500 * 22, 500 * 22, 22]);
  const allValues = sql.calls.flatMap((call) => {
    assert.equal((call.sql.match(/\?/g) || []).length, call.values.length);
    assert.match(call.sql, /^INSERT INTO usage_events/);
    return call.values;
  });
  for (let index = 0; index < events.length; index++) {
    const row = allValues.slice(index * 22, (index + 1) * 22);
    const source = events[index];
    assert.deepEqual(row, [
      'device-1', source.client, source.sessionId, source.model, source.provider, source.projectId,
      source.projectLabel, new Date(at), source.inputTokens, source.outputTokens, source.cacheReadTokens,
      source.cacheWriteTokens, source.reasoningTokens, source.messageCount, source.priceInputPerMillion,
      source.priceOutputPerMillion, source.priceCacheReadPerMillion, source.priceCacheWritePerMillion,
      source.pricingSource, new Date(at), source.costUsd, source.credits
    ]);
  }
});

test('usage event batches also split on UTF-8 parameter bytes', async () => {
  const sql = recorder();
  const repository = createRepository(sql);
  // Under the row-count limit, but enough UTF-8 bytes to need several batches.
  const events = Array.from({ length: 400 }, (_, index) => event(index, {
    client: '中'.repeat(100), sessionId: `${index}${'中'.repeat(250)}`, model: '中'.repeat(255),
    provider: '中'.repeat(255), projectId: '中'.repeat(255), projectLabel: '中'.repeat(255)
  }));
  await repository.insertUsageEvents('device-1', events);
  assert.ok(sql.calls.length > 1);
  assert.equal(sql.calls.reduce((count, call) => count + call.values.length / 22, 0), 400);
  for (const call of sql.calls) {
    const bytes = call.values.reduce((sum, value) => sum + 16 + (typeof value === 'string' ? Buffer.byteLength(value) : 8), 0);
    assert.ok(bytes <= 512 * 1024);
  }
});

test('identical sessions skip all writes, including reordered models and SQL decimal rounding', async () => {
  const item = summary();
  const sql = recorder([sessionRow(item)]);
  const repository = createRepository(sql);
  await repository.replaceSessions('device-1', [item]);
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].sql, /^SELECT \* FROM sessions/);
  assert.deepEqual(sql.calls[0].values, ['device-1']);
});

test('trusted persisted previousSummaries skips SQL reads and unchanged writes', async () => {
  const sql = recorder();
  const repository = createRepository(sql);
  const previous = summary();
  await repository.replaceSessions('device-1', [previous], sql, { previousSummaries: [previous] });
  assert.equal(sql.calls.length, 0);
  await repository.replaceSessions('device-1', [summary('session-1', { messageCount: 3 })], sql, { previousSummaries: [previous] });
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].sql, /^INSERT INTO sessions/);
  assert.equal(sql.calls[0].values[9], 3);
  sql.calls.length = 0;
  await repository.replaceSessions('device-1', [], sql, { previousSummaries: [previous] });
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].sql, /^DELETE FROM sessions/);
  assert.deepEqual(sql.calls[0].values, ['device-1', 'codex', 'session-1']);
});

test('memory repository mirrors the fourth-argument session replacement contract', async () => {
  const repository = new MemoryRepository();
  const previous = [summary('old'), summary('unchanged')];
  await repository.replaceSessions('device-1', previous);
  await repository.replaceSessions('device-1', [previous[1], summary('new')], repository, { previousSummaries: previous });
  assert.deepEqual([...repository.sessions.values()].map((item) => item.sessionId).sort(), ['new', 'unchanged']);
});

test('session diff upserts resets/model/date changes and deletes only removed identities', async () => {
  const original = [summary('unchanged'), summary('removed'), summary('reset'), summary('models'), summary('date')];
  const sql = recorder((statement) => statement.startsWith('SELECT') ? original.map(sessionRow) : []);
  const repository = createRepository(sql);
  const next = [original[0], summary('reset', { totalTokens: 1, inputTokens: 1 }),
    summary('models', { models: { replacement: 21 } }),
    summary('date', { lastUsedAt: '2026-10-24T00:01:00.000Z' }), summary('new')];
  await repository.replaceSessions('device-1', next);
  assert.equal(sql.calls.length, 3);
  assert.match(sql.calls[1].sql, /DELETE FROM sessions WHERE device_id = \?/);
  assert.deepEqual(sql.calls[1].values, ['device-1', 'codex', 'removed']);
  assert.match(sql.calls[2].sql, /ON DUPLICATE KEY UPDATE/);
  assert.equal(sql.calls[2].values.length, 4 * 14);
  assert.deepEqual([0, 1, 2, 3].map((index) => sql.calls[2].values[index * 14 + 2]), ['reset', 'models', 'date', 'new']);
  assert.equal(sql.calls[2].values[3], 1);
  assert.equal(sql.calls[2].values[10], next[1].costUsd, 'send full precision, not the rounded comparison value');
});

test('session additions and removals use bounded batches without wholesale device deletion', async () => {
  const sql = recorder();
  const repository = createRepository(sql);
  const items = Array.from({ length: 1001 }, (_, index) => summary(`session-${index}`));
  await repository.replaceSessions('device-1', items);
  assert.deepEqual(sql.calls.map((call) => call.values.length), [1, 7000, 7000, 14]);
  const removing = recorder((statement) => statement.startsWith('SELECT') ? items.map(sessionRow) : []);
  await repository.replaceSessions('device-1', [], removing);
  assert.deepEqual(removing.calls.map((call) => call.values.length), [1, 1001, 1001, 3]);
  assert.ok(removing.calls.slice(1).every((call) => call.sql.includes('(client, session_id) IN')));
});

test('failed transactional session writes leave no process cache that could skip a retry', async () => {
  let fail = true;
  let commits = 0;
  let rollbacks = 0;
  let releases = 0;
  const connection = recorder((statement) => {
    if (fail && statement.startsWith('INSERT INTO sessions')) throw new Error('test_write_failure');
    return [];
  });
  connection.beginTransaction = async () => {};
  connection.commit = async () => { commits++; };
  connection.rollback = async () => { rollbacks++; };
  connection.release = () => { releases++; };
  const repository = createRepository({ async getConnection() { return connection; } });
  await assert.rejects(repository.transaction((executor) => repository.replaceSessions('device-1', [summary()], executor)), /test_write_failure/);
  fail = false;
  await repository.transaction((executor) => repository.replaceSessions('device-1', [summary()], executor));
  assert.deepEqual([commits, rollbacks, releases], [1, 1, 2]);
  assert.equal(connection.calls.filter((call) => call.sql.startsWith('INSERT INTO sessions')).length, 2);
  assert.equal(connection.calls.filter((call) => call.sql.startsWith('SELECT')).length, 2);
});

test('usage batch failure propagates to the caller transaction for rollback', async () => {
  let writes = 0;
  let rolledBack = false;
  let committed = false;
  const connection = recorder(() => {
    if (++writes === 2) throw new Error('second_batch_failed');
    return [];
  });
  connection.beginTransaction = async () => {};
  connection.commit = async () => { committed = true; };
  connection.rollback = async () => { rolledBack = true; };
  connection.release = () => {};
  const repository = createRepository({ async getConnection() { return connection; } });
  const events = Array.from({ length: 1001 }, (_, index) => event(index));
  await assert.rejects(repository.transaction((executor) => repository.insertUsageEvents('device-1', events, executor)), /second_batch_failed/);
  assert.equal(writes, 2, 'do not continue writing later batches after failure');
  assert.equal(rolledBack, true);
  assert.equal(committed, false);
});

test('range count and sums come from one grouped scan, including zero-token credit-only events', async () => {
  const sql = recorder([
    { client: 'codex', model: 'gpt-5', tokens: '100', cost_usd: '0.1234567890', credits: '0', event_count: '2' },
    { client: 'qoder', model: 'native', tokens: '0', cost_usd: '0', credits: '0.12345678', event_count: '3' }
  ]);
  const repository = createRepository(sql);
  const range = { from: at, to: '2026-10-25T00:00:00.000Z' };
  const result = await repository.aggregateUsageRange(range);
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].sql, /COUNT\(\*\) AS event_count/);
  assert.match(sql.calls[0].sql, /GROUP BY client, model/);
  assert.deepEqual(sql.calls[0].values, [new Date(range.from), new Date(range.to)]);
  assert.equal(result.eventCount, 5);
  assert.equal(result.totalTokens, 100);
  assert.equal(result.costUsd, 0.123456789);
  assert.deepEqual(result.clientCredits, { qoder: 0.12345678 });
  assert.deepEqual(await createRepository(recorder()).aggregateUsageRange(range), emptyUsageRange());
  sql.calls.length = 0;
  assert.deepEqual(await repository.aggregateUsageRange({ from: at, to: at }), emptyUsageRange());
  assert.equal(sql.calls.length, 0);
});

test('active Hub session loading omits revoked/expired rows without changing administrative listing', async () => {
  const sql = recorder([{ session_id: 'active', persistent: 1, last_seen_at: new Date(at) }]);
  const repository = createRepository(sql);
  assert.equal((await repository.loadActiveHubSessions())[0].sessionId, 'active');
  assert.match(sql.calls[0].sql, /revoked_at IS NULL/);
  assert.match(sql.calls[0].sql, /expires_at > CURRENT_TIMESTAMP\(3\)/);
  assert.doesNotMatch(sql.calls[0].sql, /ORDER BY/);
  await repository.listHubSessions();
  assert.match(sql.calls[1].sql, /ORDER BY last_seen_at DESC/);
  const memory = new MemoryRepository();
  await memory.createHubSession({ sessionId: 'active', expiresAt: null });
  await memory.createHubSession({ sessionId: 'revoked', revokedAt: at });
  await memory.createHubSession({ sessionId: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.deepEqual((await memory.loadActiveHubSessions()).map((session) => session.sessionId), ['active']);
  assert.equal((await memory.listHubSessions()).length, 3);
});

test('normalized delta fast path matches the validating default including credits and counter resets', () => {
  const before = { deviceId: 'device-1', updatedAt: at, allTime: {
    totalTokens: 100, clients: { qoder: 100 }, clientCredits: { qoder: 0.25 }
  } };
  const after = { ...before, allTime: { totalTokens: 200, clients: { qoder: 200 }, clientCredits: { qoder: 0.75 } } };
  const normalizedBefore = normalizeDeviceRecord(before);
  const normalizedAfter = normalizeDeviceRecord(after);
  assert.deepEqual(calculateUsageEventDeltas(normalizedBefore, normalizedAfter, { normalized: true }), calculateUsageEventDeltas(before, after));
  assert.deepEqual(calculateUsageEventDeltas(null, normalizedAfter, { normalized: true }), calculateUsageEventDeltas(null, after));
  assert.deepEqual(calculateUsageEventDeltas(normalizedAfter, normalizedBefore, { normalized: true }), calculateUsageEventDeltas(after, before));
  assert.deepEqual(usageCandidates(normalizedAfter, { normalized: true }), usageCandidates(after));
  assert.equal(calculateUsageEventDeltas(before, after).events[0].credits, 0.5);
  assert.equal(calculateUsageEventDeltas(after, before).events[0].counterReset, true);
});
