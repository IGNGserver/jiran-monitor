'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHub } = require('../../src/hub/server');
const { createMySqlPool, createRepository } = require('../../src/hub/repository');
const { runMigrations } = require('../../migrations/run');
const { loadDotEnv } = require('../../src/shared/config');

loadDotEnv();

const enabled = process.env.MYSQL_TEST_ENABLED === '1' && Boolean(process.env.MYSQL_TEST_PASSWORD);

function payload(totalTokens, updatedAt = '2026-07-18T00:00:00.000Z') {
  return {
    deviceId: 'mysql-device', updatedAt,
    allTime: {
      totalTokens, clients: { codex: totalTokens }, models: { 'gpt-5': totalTokens },
      clientModels: { codex: { 'gpt-5': totalTokens } },
      sessions: {
        'codex:session-1': {
          client: 'codex', sessionId: 'session-1', totalTokens, inputTokens: totalTokens,
          models: { 'gpt-5': totalTokens }, lastUsedAt: updatedAt, startedAt: updatedAt
        }
      }
    },
    today: { totalTokens }, month: { totalTokens }
  };
}

test('MySQL ingest snapshots prices and preserves baseline identity across delete and re-ingest', { skip: !enabled && 'set MYSQL_TEST_PASSWORD and start docker-compose.test.yml' }, async () => {
  const pool = createMySqlPool({
    host: process.env.MYSQL_TEST_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_TEST_PORT || 17322),
    user: process.env.MYSQL_TEST_USER || 'token_monitor_test',
    password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE || 'token_monitor_test'
  });
  const repository = createRepository(pool);
  const hub = createHub({ repository, logger: { error() {} } });
  try {
    await runMigrations(pool);
    await pool.query('DELETE FROM usage_events');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM device_ingest_state');
    await pool.query('DELETE FROM device_ingest_baseline');
    await pool.query('DELETE FROM devices');
    await pool.query('DELETE FROM model_pricing');

    await hub.setPricing('gpt-5', {
      inputPricePerMillion: 1,
      outputPricePerMillion: 0,
      cacheReadPricePerMillion: 0,
      cacheWritePricePerMillion: 0
    });
    await hub.ingest(payload(1_000_000));
    await hub.setPricing('gpt-5', {
      inputPricePerMillion: 2,
      outputPricePerMillion: 0,
      cacheReadPricePerMillion: 0,
      cacheWritePricePerMillion: 0
    });
    await hub.ingest(payload(2_000_000, '2026-07-18T00:01:00.000Z'));

    const [events] = await pool.query('SELECT price_input_per_million, cost_usd FROM usage_events ORDER BY id');
    assert.deepEqual(events.map((row) => Number(row.price_input_per_million)), [1, 2]);
    assert.deepEqual(events.map((row) => Number(row.cost_usd)), [1, 2]);
    await hub.deleteDevice('mysql-device');
    assert.equal(await repository.getActiveDeviceRecord('mysql-device'), null);
    assert.ok(await repository.getDeviceRecord('mysql-device'), 'hidden snapshots remain ingest baselines');
    const [remaining] = await pool.query('SELECT device_id FROM usage_events ORDER BY id');
    assert.equal(remaining.length, 2);
    assert.ok(remaining.every((row) => row.device_id === 'mysql-device'));
    assert.equal((await hub.getStats()).devices.length, 0);

    await hub.ingest(payload(2_000_000, '2026-07-18T00:02:00.000Z'));
    const [afterReingest] = await pool.query('SELECT device_id FROM usage_events ORDER BY id');
    assert.equal(afterReingest.length, 2, 're-ingesting the same cumulative snapshot must not duplicate the ledger');
    assert.equal((await hub.getStats()).devices.length, 1);
    assert.equal((await repository.getActiveDeviceRecord('mysql-device')).deviceId, 'mysql-device');

    const previous = await repository.getDeviceRecord('mysql-device');
    const history = { version: 1, days: { '2026-07-18': { totalTokens: 2_000_000 } } };
    const withHistory = { ...previous, history };
    await repository.transaction((connection) => repository.saveDevice(withHistory, connection, { previousRecord: previous }));
    const timestampOnly = { ...withHistory, receivedAt: '2026-07-18T00:03:00.000Z', updatedAt: '2026-07-18T00:03:00.000Z' };
    const timestampWrites = [];
    await repository.transaction((connection) => repository.saveDevice(timestampOnly, {
      async execute(sql, values) {
        timestampWrites.push({ sql, values });
        return connection.execute(sql, values);
      }
    }, { previousRecord: withHistory, previousBaseline: withHistory }));
    assert.doesNotMatch(timestampWrites[0].sql, /\bhistory\b/);
    assert.match(timestampWrites[1].sql, /JSON_SET/);
    assert.match(timestampWrites[2].sql, /^UPDATE device_ingest_baseline SET snapshot_json = JSON_SET/);
    const storedTimestampOnly = await repository.getDeviceRecord('mysql-device');
    assert.equal(storedTimestampOnly.updatedAt, timestampOnly.updatedAt);
    assert.equal(storedTimestampOnly.receivedAt, timestampOnly.receivedAt);
    assert.deepEqual(storedTimestampOnly.history, history);
    assert.deepEqual((await repository.getIngestBaseline('mysql-device')).snapshot.history, history);
    const [deviceHistory] = await pool.query('SELECT history FROM devices WHERE device_id = ?', ['mysql-device']);
    const metadataHistory = typeof deviceHistory[0].history === 'string'
      ? JSON.parse(deviceHistory[0].history) : deviceHistory[0].history;
    assert.deepEqual(metadataHistory, history);
    const unchangedWrites = [];
    await repository.transaction(async (connection) => {
      const previousBaseline = (await repository.getIngestBaseline('mysql-device', connection)).snapshot;
      await repository.saveDevice(timestampOnly, {
        async execute(sql, values) {
          unchangedWrites.push(sql);
          return connection.execute(sql, values);
        }
      }, { previousRecord: storedTimestampOnly, previousBaseline });
    });
    assert.equal(unchangedWrites.length, 1, 'exactly unchanged persisted display/raw snapshots only update device metadata');

    // Exercise the real MySQL multi-row bindings, JSON comparison and tuple
    // removal path as well as the deterministic executor tests.
    const summaries = Array.from({ length: 501 }, (_, index) => ({
      client: 'codex', sessionId: `batch-${index}`, totalTokens: index + 1,
      inputTokens: index + 1, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, messageCount: 1, costUsd: 0.1234567890123,
      startedAt: '2026-07-18T00:00:00.000Z', lastUsedAt: '2026-07-18T00:00:00.000Z',
      models: { 'gpt-5': index + 1 }
    }));
    await repository.transaction((connection) => repository.replaceSessions('mysql-device', summaries, connection));
    const repeatedWrites = [];
    await repository.transaction((connection) => repository.replaceSessions('mysql-device', summaries, {
      async execute(sql, values) {
        repeatedWrites.push(sql);
        return connection.execute(sql, values);
      }
    }));
    assert.equal(repeatedWrites.length, 1, 'unchanged SQL-normalized rows must not be rewritten');
    await repository.transaction((connection) => repository.replaceSessions('mysql-device', summaries.slice(0, 1), connection));
    const [sessionRows] = await pool.query('SELECT session_id, total_tokens, cost_usd FROM sessions WHERE device_id = ?', ['mysql-device']);
    assert.equal(sessionRows.length, 1);
    assert.equal(sessionRows[0].session_id, 'batch-0');
    assert.equal(Number(sessionRows[0].total_tokens), 1);
    assert.equal(Number(sessionRows[0].cost_usd), 0.123456789);

    const batchEvents = Array.from({ length: 501 }, (_, index) => ({
      client: 'codex', sessionId: `batch-${index}`, model: 'gpt-5', provider: null,
      projectId: null, projectLabel: null, recordedAt: '2040-01-01T00:00:00.000Z',
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
      reasoningTokens: 5, messageCount: 1, priceInputPerMillion: 0.12345678,
      priceOutputPerMillion: 0.23456789, priceCacheReadPerMillion: 0.34567891,
      priceCacheWritePerMillion: 0.45678912, pricingSource: 'manual',
      pricingSnapshotAt: '2040-01-01T00:00:00.000Z', costUsd: 0.0123456789, credits: 0.25
    }));
    await repository.transaction((connection) => repository.insertUsageEvents('mysql-device', batchEvents, connection));
    const range = await repository.aggregateUsageRange({ from: '2040-01-01T00:00:00.000Z', to: '2040-01-02T00:00:00.000Z' });
    assert.equal(range.eventCount, 501);
    assert.equal(range.totalTokens, 5010, 'reasoning tokens are not an extra token component');
    assert.equal(range.clientCredits.codex, 125.25);
    assert.equal(range.costUsd, Number((501 * 0.0123456789).toFixed(10)));
  } finally {
    await pool.end();
  }
});

test('MySQL transfer preserves independent raw baselines, display sessions and ledger across both devices resuming', { skip: !enabled && 'set MYSQL_TEST_PASSWORD and start docker-compose.test.yml' }, async () => {
  const pool = createMySqlPool({
    host: process.env.MYSQL_TEST_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_TEST_PORT || 17322),
    user: process.env.MYSQL_TEST_USER || 'token_monitor_test',
    password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE || 'token_monitor_test'
  });
  const repository = createRepository(pool);
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', repository, logger: { error() {}, warn() {} } });
  const a = 'mysql-transfer-a';
  const b = 'mysql-transfer-b';
  const upload = (deviceId, tokens, minute) => hub.ingest({
    ...payload(tokens, new Date(Date.UTC(2026, 6, 18, 0, minute)).toISOString()), deviceId
  });
  const assertState = async (total, devices) => {
    const stats = await hub.getStats();
    assert.equal(stats.periods.allTime.totalTokens, total);
    assert.deepEqual(Object.fromEntries(stats.devices.map((device) => [device.deviceId, device.periods.allTime.totalTokens])), devices);
    const [ledger] = await pool.query(`SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
      FROM usage_events`);
    assert.equal(Number(ledger[0].tokens), total, 'display total and immutable ledger must conserve the same usage');
    const [sessions] = await pool.query('SELECT device_id, session_id, total_tokens FROM sessions ORDER BY device_id');
    assert.equal(sessions.length, Object.keys(devices).length, 'one shared session row per visible device');
    assert.deepEqual(Object.fromEntries(sessions.map((row) => [row.device_id, Number(row.total_tokens)])), devices,
      'the shared client/session identity follows display ownership, never raw cumulative totals');
    assert.ok(sessions.every((row) => row.session_id === 'session-1'));
  };
  try {
    await runMigrations(pool);
    await pool.query('DELETE FROM usage_events');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM device_ingest_state');
    await pool.query('DELETE FROM device_ingest_baseline');
    await pool.query('DELETE FROM devices');
    await hub.start();
    await upload(a, 100, 0);
    await upload(b, 40, 1);
    await assertState(140, { [a]: 100, [b]: 40 });
    const { port } = hub.server.address();
    const transfer = await fetch(`http://127.0.0.1:${port}/api/devices/${encodeURIComponent(a)}/transfer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDeviceId: b }), signal: AbortSignal.timeout(5000)
    });
    assert.equal(transfer.status, 200, await transfer.text());
    assert.equal(await repository.getActiveDeviceRecord(a), null);
    await assertState(140, { [b]: 140 });

    await upload(b, 50, 2);
    await assertState(150, { [b]: 150 });
    await upload(b, 60, 3);
    await assertState(160, { [b]: 160 });
    await upload(a, 120, 4);
    await assertState(180, { [a]: 20, [b]: 160 });
    await upload(a, 130, 5);
    await assertState(190, { [a]: 30, [b]: 160 });
    for (const [deviceId, rawTokens] of [[a, 130], [b, 60]]) {
      const baseline = await repository.getIngestBaseline(deviceId);
      assert.equal(baseline.snapshot.periods.allTime.totalTokens, rawTokens);
      assert.equal(baseline.transferred, true);
    }
    const [sessions] = await pool.query('SELECT device_id, input_tokens, models FROM sessions ORDER BY device_id');
    for (const row of sessions) {
      const expected = row.device_id === a ? 30 : 160;
      assert.equal(Number(row.input_tokens), expected);
      assert.deepEqual(typeof row.models === 'string' ? JSON.parse(row.models) : row.models, { 'gpt-5': expected });
    }
    const [beforeReplay] = await pool.query('SELECT COUNT(*) AS count FROM usage_events');
    await upload(b, 60, 3);
    await upload(a, 130, 5);
    await assertState(190, { [a]: 30, [b]: 160 });
    const [afterReplay] = await pool.query('SELECT COUNT(*) AS count FROM usage_events');
    assert.equal(Number(afterReplay[0].count), Number(beforeReplay[0].count), 'replaying either raw cumulative report must not double-book transferred history');
    assert.equal((await repository.getIngestBaseline(a)).transferred, true, 'timestamp-only baseline refresh retains the transfer flag');
    assert.equal((await repository.getIngestBaseline(b)).transferred, true);
  } finally {
    await hub.stop();
    await pool.end();
  }
});

test('transaction retries on transient connection lost errors', async () => {
  let attempts = 0;
  const fakePool = {
    async getConnection() {
      attempts++;
      if (attempts === 1) {
        const err = new Error('Connection lost');
        err.code = 'PROTOCOL_CONNECTION_LOST';
        throw err;
      }
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {}
      };
    }
  };
  const repo = createRepository(fakePool);
  const result = await repo.transaction(async (conn) => {
    assert.ok(conn);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('device snapshot listing does not sort JSON payloads in MySQL', async () => {
  let query = '';
  const fakePool = {
    async query(sql) {
      query = sql;
      return [[{ snapshot_json: '{"deviceId":"device-1"}' }], []];
    }
  };
  const repository = createRepository(fakePool);
  assert.deepEqual(await repository.listDeviceRecords(), [{ deviceId: 'device-1' }]);
  assert.doesNotMatch(query, /ORDER BY/i);
});

test('batched session replacement binds every session counter column', async () => {
  const calls = [];
  const fakePool = {
    async execute(sql, values) {
      calls.push({ sql, values });
      return [[], {}];
    }
  };
  const repository = createRepository(fakePool);
  await repository.replaceSessions('device-1', [{
    client: 'codex',
    sessionId: 'session-1',
    totalTokens: 21,
    inputTokens: 5,
    outputTokens: 6,
    cacheReadTokens: 7,
    cacheWriteTokens: 2,
    reasoningTokens: 1,
    messageCount: 3,
    costUsd: 0.5,
    startedAt: '2026-09-20T00:00:00.000Z',
    lastUsedAt: '2026-09-20T00:01:00.000Z',
    models: { 'gpt-5': 21 }
  }]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /^SELECT \* FROM sessions/);
  assert.doesNotMatch(calls[1].sql, /DELETE FROM sessions/);
  assert.equal(calls[1].values.length, 14);
  assert.equal(calls[1].values[7], 2);
  assert.equal(calls[1].values[8], 1);
});
