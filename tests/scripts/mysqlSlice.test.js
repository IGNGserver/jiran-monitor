'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { decimal, units, safeCode, mysqlConfig, parseOptions, makeSteps, openSqlite,
  applyTransaction, verify, measureBackend } = require('../../scripts/experiments/hub-resource-comparison/mysql-slice');

test('MySQL slice requires every explicit disposable-environment guard', () => {
  const env = { JIRAN_DISPOSABLE_MYSQL: '1', CI: 'true', JIRAN_MYSQL_HOST: '127.0.0.1',
    JIRAN_MYSQL_DATABASE: 'jiran_ci_test_613', JIRAN_MYSQL_USER: 'temporary', JIRAN_MYSQL_PASSWORD: 'unit-test-only' };
  assert.equal(mysqlConfig({}), null);
  assert.equal(mysqlConfig({ ...env, JIRAN_DISPOSABLE_MYSQL: 'true' }), null);
  const config = mysqlConfig(env);
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 3306);
  assert.equal(config.decimalNumbers, false); assert.equal(config.bigNumberStrings, true);
  assert.equal(config.multipleStatements, false);
  assert.equal(mysqlConfig({ ...env, JIRAN_MYSQL_HOST: 'localhost' }).host, 'localhost');
  for (const override of [{ CI: 'false' }, { CI: '1' }, { JIRAN_MYSQL_HOST: '192.168.5.17' },
    { JIRAN_MYSQL_HOST: 'localhost.evil.test' }, { JIRAN_MYSQL_HOST: '::1' },
    { JIRAN_MYSQL_DATABASE: 'jiran' }, { JIRAN_MYSQL_DATABASE: 'jiran_ci_x;DROP DATABASE jiran' },
    { JIRAN_MYSQL_DATABASE: `jiran_ci_${'a'.repeat(56)}` }, { JIRAN_MYSQL_PORT: '0' },
    { JIRAN_MYSQL_USER: '' }, { JIRAN_MYSQL_PASSWORD: '' }]) assert.throws(() => mysqlConfig({ ...env, ...override }));
});

test('exact cost/credit conversion preserves ten decimal places without floating point', () => {
  for (const value of ['0.0000000001', '1.1234567891', '99999999999999.9999999999']) assert.equal(decimal(units(value)), value);
  assert.equal(decimal(units('2')), '2.0000000000');
  assert.equal(units('0.1234567891') + units('0.0000000001'), 1234567892n);
  for (const value of [0.1, '-1.0', '1e-10', '1.12345678912', 'NaN']) assert.throws(() => units(value));
  assert.throws(() => decimal(-1n));
});

test('slice fixture and transaction sequence are deterministic and advance all three exact meters', () => {
  const options = { devices: 5, sessions: 2, iterations: 100, seed: 613 };
  const steps = makeSteps(options);
  assert.deepEqual(steps, makeSteps(options));
  assert.equal(steps.setup.length, 5); assert.equal(steps.writes.length, 100);
  assert.ok(steps.writes.every((step) => units(step.delta.credits) > 0n && units(step.delta.costUsd) > 0n));
  const cost = [...steps.setup, ...steps.writes].reduce((sum, step) => sum + units(step.delta.costUsd), 0n);
  assert.equal(decimal(cost), steps.expected.costUsd);
  assert.notEqual(steps.expected.credits.slice(-1), '0');
  assert.notDeepEqual(steps, makeSteps({ ...options, seed: 614 }));
});

test('only safe error codes, never driver messages/credentials, are reportable', () => {
  assert.equal(safeCode({ code: 'ECONNREFUSED', message: 'sensitive' }), 'ECONNREFUSED');
  assert.equal(safeCode({ code: 'password=do-not-print', message: 'sensitive' }), 'SLICE_FAILED');
  assert.equal(safeCode(new Error('sensitive credentials')), 'SLICE_FAILED');
  assert.equal(parseOptions([]).iterations, 100);
  for (const arg of ['--iterations=0', '--iterations=1001', '--password=sensitive', '--devices=51']) assert.throws(() => parseOptions([arg]));
});

function localDirectory() {
  const root = path.resolve(process.env.BUILD_SCRATCH_ROOT || path.join(os.homedir(), '.build'));
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'mysql-slice-test-'));
}

test('SQLite three-table WAL/FULL slice measures 100 commit ACKs and 100 exact read/reopen samples', async () => {
  const directory = localDirectory();
  try {
    const options = { devices: 5, sessions: 2, iterations: 100, seed: 613 };
    const steps = makeSteps(options), filename = path.join(directory, 'slice.sqlite');
    const result = await measureBackend((initialize) => openSqlite(filename, initialize), steps, options);
    assert.equal(result.measured, true); assert.equal(result.metadata.journalMode, 'wal');
    assert.equal(result.metadata.synchronous, 2);
    assert.equal(result.writes.ackLatencyMs.samples, 100);
    assert.equal(result.writes.commitsAcknowledged, 100);
    assert.equal(result.reopenReads.latencyMs.samples, 100);
    assert.equal(result.sqlStatements.writes.total, 600);
    assert.deepEqual(result.sqlStatements.writes.commands, { BEGIN: 100, SELECT: 100, INSERT: 300, COMMIT: 100 });
    assert.equal(result.reopenSqlStatements.reopenReads.total, 300);
    assert.deepEqual(result.beforeReopen, result.afterReopen);
    assert.equal(result.afterReopen.totals.slice_usage_events.credits, steps.expected.credits);
    assert.equal(result.afterReopen.totals.slice_usage_events.costUsd, steps.expected.costUsd);
    assert.equal(result.afterReopen.totals.slice_usage_events.rows, 105);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failed ledger append rolls snapshot and raw baseline back atomically', async () => {
  const directory = localDirectory();
  let adapter;
  try {
    adapter = await openSqlite(path.join(directory, 'rollback.sqlite'));
    const steps = makeSteps({ devices: 1, sessions: 1, iterations: 1, seed: 613 });
    await applyTransaction(adapter, steps.setup[0], 'seed');
    const original = adapter.sql;
    adapter.sql = async (sql, params, phase) => {
      if (sql.startsWith('INSERT INTO slice_usage_events')) throw new Error('injected ledger append failure');
      return original(sql, params, phase);
    };
    await assert.rejects(applyTransaction(adapter, steps.writes[0]), /injected/);
    adapter.sql = original;
    const expectedRows = { slice_snapshots: 1, slice_raw_baseline: 1, slice_usage_events: 1 };
    await verify(adapter, steps.setup[0].meters, expectedRows);
    await applyTransaction(adapter, steps.writes[0]);
    await verify(adapter, steps.expected, { ...expectedRows, slice_usage_events: 2 });
  } finally { await adapter?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
