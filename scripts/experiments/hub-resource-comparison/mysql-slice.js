#!/usr/bin/env node
'use strict';

// Disposable three-table storage slice. This is NOT a Hub backend/migration.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { makeFixture, nextPayload, distribution, safeOutputPath } = require('../../benchmark-hub-resources');

const SCALE = 10n ** 10n;
const TABLES = ['slice_snapshots', 'slice_raw_baseline', 'slice_usage_events'];

function failure(code) { return Object.assign(new Error(code), { code }); }

function decimal(units) {
  units = BigInt(units);
  if (units < 0n) throw new Error('negative_exact_meter');
  return `${units / SCALE}.${String(units % SCALE).padStart(10, '0')}`;
}

function units(value) {
  // Never round or convert a DECIMAL through Number, including mysql2 results.
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,10})?$/.test(value)) throw new Error('invalid_exact_decimal');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(10, '0'));
}

function safeCode(error) {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'SLICE_FAILED';
}

function mysqlConfig(env) {
  if (env.JIRAN_DISPOSABLE_MYSQL !== '1') return null;
  if (env.CI !== 'true') throw new Error('mysql_requires_CI_true');
  if (!['127.0.0.1', 'localhost'].includes(env.JIRAN_MYSQL_HOST)) throw new Error('mysql_requires_loopback_host');
  if (!/^jiran_ci_[a-z0-9_]{1,55}$/.test(env.JIRAN_MYSQL_DATABASE || '')) throw new Error('mysql_requires_temporary_schema');
  const port = Number(env.JIRAN_MYSQL_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_mysql_port');
  if (!env.JIRAN_MYSQL_USER || !env.JIRAN_MYSQL_PASSWORD) throw new Error('mysql_requires_env_credentials');
  return { host: env.JIRAN_MYSQL_HOST, port, database: env.JIRAN_MYSQL_DATABASE,
    user: env.JIRAN_MYSQL_USER, password: env.JIRAN_MYSQL_PASSWORD,
    connectTimeout: 10000, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
    multipleStatements: false, enableKeepAlive: false };
}

function parseOptions(args) {
  const options = { devices: 20, sessions: 40, iterations: 100, seed: 613 };
  for (const argument of args) {
    const equals = argument.indexOf('=');
    const flag = argument.slice(0, equals), value = argument.slice(equals + 1);
    if (equals < 0 || !['--devices', '--sessions', '--iterations', '--seed', '--output'].includes(flag) || !value) throw new Error('invalid_slice_option');
    options[flag.slice(2)] = flag === '--output' ? value : Number(value);
  }
  for (const [key, min, max] of [['devices', 1, 50], ['sessions', 0, 200], ['iterations', 1, 1000], ['seed', 1, 0xffffffff]]) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error('invalid_slice_option');
  }
  return options;
}

function makeSteps(options) {
  const fixture = makeFixture(options);
  const state = fixture.map((record, index) => ({ tokens: BigInt(record.allTime.totalTokens),
    cost: BigInt(record.allTime.totalTokens) * 10000n,
    credits: BigInt(index + 1) * SCALE + 1234567891n, increment: 0 }));
  const meter = (value) => ({ tokens: String(value.tokens), costUsd: decimal(value.cost), credits: decimal(value.credits) });
  const step = (index, id, delta, previous = null) => {
    const value = state[index];
    const payload = { ...nextPayload(fixture[index], value.increment, fixture[index].updatedAt), exactMeters: meter(value) };
    return { id, deviceId: fixture[index].deviceId, previous, meters: meter(value),
      delta: meter(delta), payload: JSON.stringify(payload) };
  };
  const setup = state.map((value, index) => step(index, `seed-${index}`, value));
  const writes = Array.from({ length: options.iterations }, (_, i) => {
    const index = i % fixture.length, value = state[index], previous = meter(value);
    const delta = { tokens: BigInt(7 + i % 31), cost: BigInt(7 + i % 31) * 10000n + 1n, credits: 1234567891n + BigInt(i) };
    value.tokens += delta.tokens; value.cost += delta.cost; value.credits += delta.credits;
    value.increment += Number(delta.tokens);
    return step(index, `tick-${i}`, delta, previous);
  });
  const expected = state.reduce((total, value) => ({ tokens: total.tokens + value.tokens,
    cost: total.cost + value.cost, credits: total.credits + value.credits }), { tokens: 0n, cost: 0n, credits: 0n });
  return { fixture, setup, writes, expected: meter(expected) };
}

function countedSql(execute) {
  const counts = {};
  return { counts, async sql(statement, params = [], phase = 'setup') {
    const command = statement.trim().split(/\s/)[0].toUpperCase();
    const group = counts[phase] ||= { total: 0, commands: {} };
    group.total++; group.commands[command] = (group.commands[command] || 0) + 1;
    return execute(statement, params);
  } };
}

async function openSqlite(filename, initialize = true) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filename);
  const statements = new Map();
  const counted = countedSql((sql, params) => {
    let statement = statements.get(sql);
    if (!statement) { statement = db.prepare(sql); statement.setReadBigInts(true); statements.set(sql, statement); }
    return statement.all(...params);
  });
  const adapter = { kind: 'sqlite', ...counted, close: async () => db.close(),
    bindMeters: (meters) => [BigInt(meters.tokens), units(meters.costUsd), units(meters.credits)],
    normalize: (row) => ({ tokens: String(row.tokens), costUsd: decimal(row.cost), credits: decimal(row.credits) }) };
  try {
    await adapter.sql('PRAGMA journal_mode=WAL'); await adapter.sql('PRAGMA synchronous=FULL');
    await adapter.sql('PRAGMA fullfsync=ON'); await adapter.sql('PRAGMA checkpoint_fullfsync=ON');
    await adapter.sql('PRAGMA foreign_keys=ON'); await adapter.sql('PRAGMA busy_timeout=10000');
    const mode = (await adapter.sql('PRAGMA journal_mode'))[0].journal_mode;
    const synchronous = Number((await adapter.sql('PRAGMA synchronous'))[0].synchronous);
    if (mode !== 'wal' || synchronous !== 2) throw failure('SQLITE_REQUIRES_WAL_FULL');
    adapter.metadata = { version: (await adapter.sql('SELECT sqlite_version() AS version'))[0].version,
      journalMode: mode, synchronous, fullfsync: Number((await adapter.sql('PRAGMA fullfsync'))[0].fullfsync),
      checkpointFullfsync: Number((await adapter.sql('PRAGMA checkpoint_fullfsync'))[0].checkpoint_fullfsync) };
    if (initialize) {
      for (const table of TABLES.slice(0, 2)) await adapter.sql(`CREATE TABLE ${table} (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, tokens INTEGER NOT NULL CHECK(tokens>=0),
        cost INTEGER NOT NULL CHECK(cost>=0), credits INTEGER NOT NULL CHECK(credits>=0)
        ${table === TABLES[1] ? ', FOREIGN KEY(id) REFERENCES slice_snapshots(id)' : ''}) STRICT`);
      await adapter.sql(`CREATE TABLE slice_usage_events (id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
        tokens INTEGER NOT NULL CHECK(tokens>=0), cost INTEGER NOT NULL CHECK(cost>=0), credits INTEGER NOT NULL CHECK(credits>=0),
        FOREIGN KEY(device_id) REFERENCES slice_snapshots(id)) STRICT`);
    }
    return adapter;
  } catch (error) { db.close(); throw error; }
}

async function openMysql(config, initialize = true) {
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection(config);
  const counted = countedSql(async (sql, params) => {
    const method = /^(SELECT|INSERT)\b/i.test(sql) ? 'execute' : 'query';
    const [rows] = await connection[method](sql, params);
    return rows;
  });
  const adapter = { kind: 'mysql', ...counted, close: () => connection.end(),
    bindMeters: (meters) => [meters.tokens, meters.costUsd, meters.credits],
    normalize: (row) => ({ tokens: String(row.tokens), costUsd: decimal(units(row.cost)), credits: decimal(units(row.credits)) }) };
  try {
    const [settings] = await adapter.sql(`SELECT VERSION() AS version,
      @@GLOBAL.innodb_flush_log_at_trx_commit AS flushLogAtTrxCommit,
      @@GLOBAL.log_bin AS logBin, @@GLOBAL.sync_binlog AS syncBinlog,
      @@GLOBAL.innodb_doublewrite AS doubleWrite, @@SESSION.sql_mode AS sqlMode`);
    if (Number(settings.flushLogAtTrxCommit) !== 1 || (Number(settings.logBin) && Number(settings.syncBinlog) !== 1)
      || !/STRICT_(TRANS|ALL)_TABLES/.test(settings.sqlMode)) throw failure('MYSQL_DURABILITY_OR_STRICT_MODE_MISMATCH');
    adapter.metadata = settings;
    if (initialize) {
      const [existing] = await adapter.sql('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()');
      if (Number(existing.count)) throw failure('MYSQL_SCHEMA_MUST_BE_EMPTY');
      for (const table of TABLES.slice(0, 2)) await adapter.sql(`CREATE TABLE ${table} (
        id VARCHAR(64) PRIMARY KEY, payload LONGTEXT NOT NULL, tokens BIGINT UNSIGNED NOT NULL,
        cost DECIMAL(24,10) UNSIGNED NOT NULL, credits DECIMAL(24,10) UNSIGNED NOT NULL
        ${table === TABLES[1] ? ', FOREIGN KEY(id) REFERENCES slice_snapshots(id)' : ''}) ENGINE=InnoDB`);
      await adapter.sql(`CREATE TABLE slice_usage_events (id VARCHAR(64) PRIMARY KEY, device_id VARCHAR(64) NOT NULL,
        tokens BIGINT UNSIGNED NOT NULL, cost DECIMAL(24,10) UNSIGNED NOT NULL, credits DECIMAL(24,10) UNSIGNED NOT NULL,
        FOREIGN KEY(device_id) REFERENCES slice_snapshots(id)) ENGINE=InnoDB`);
    }
    return adapter;
  } catch (error) { await connection.end(); throw error; }
}

function sameMeters(actual, expected) {
  return ['tokens', 'costUsd', 'credits'].every((key) => actual[key] === expected[key]);
}

async function applyTransaction(adapter, step, phase = 'writes') {
  await adapter.sql(adapter.kind === 'sqlite' ? 'BEGIN IMMEDIATE' : 'START TRANSACTION', [], phase);
  try {
    const rows = await adapter.sql(`SELECT tokens,cost,credits FROM slice_raw_baseline WHERE id=?${adapter.kind === 'mysql' ? ' FOR UPDATE' : ''}`, [step.deviceId], phase);
    if (step.previous ? rows.length !== 1 || !sameMeters(adapter.normalize(rows[0]), step.previous) : rows.length !== 0) throw failure('RAW_BASELINE_MISMATCH');
    for (const table of TABLES.slice(0, 2)) {
      const conflict = adapter.kind === 'sqlite'
        ? 'ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,tokens=excluded.tokens,cost=excluded.cost,credits=excluded.credits'
        : 'ON DUPLICATE KEY UPDATE payload=VALUES(payload),tokens=VALUES(tokens),cost=VALUES(cost),credits=VALUES(credits)';
      await adapter.sql(`INSERT INTO ${table}(id,payload,tokens,cost,credits) VALUES (?,?,?,?,?) ${conflict}`,
        [step.deviceId, step.payload, ...adapter.bindMeters(step.meters)], phase);
    }
    await adapter.sql('INSERT INTO slice_usage_events(id,device_id,tokens,cost,credits) VALUES (?,?,?,?,?)',
      [step.id, step.deviceId, ...adapter.bindMeters(step.delta)], phase);
    // ACK latency stops only after this successful COMMIT response.
    await adapter.sql('COMMIT', [], phase);
  } catch (error) { await adapter.sql('ROLLBACK', [], phase); throw error; }
}

async function verify(adapter, expected, expectedRows, phase = 'validation') {
  const totals = {};
  const payloadHashes = {};
  for (const table of TABLES) {
    const rows = await adapter.sql(`SELECT * FROM ${table} ORDER BY id`, [], phase);
    const total = { tokens: 0n, cost: 0n, credits: 0n };
    for (const row of rows) {
      const meters = adapter.normalize(row);
      total.tokens += BigInt(meters.tokens); total.cost += units(meters.costUsd); total.credits += units(meters.credits);
      if (row.payload && !sameMeters(JSON.parse(row.payload).exactMeters, meters)) throw failure('PAYLOAD_EXACT_METERS_MISMATCH');
    }
    totals[table] = { rows: rows.length, tokens: String(total.tokens), costUsd: decimal(total.cost), credits: decimal(total.credits) };
    if (!sameMeters(totals[table], expected) || rows.length !== expectedRows[table]) throw failure('PERSISTED_TOTALS_MISMATCH');
    if (table !== TABLES[2]) payloadHashes[table] = createHash('sha256').update(JSON.stringify(rows.map((row) => [row.id, row.payload]))).digest('hex');
  }
  if (payloadHashes[TABLES[0]] !== payloadHashes[TABLES[1]]) throw failure('SNAPSHOT_RAW_BASELINE_PAYLOAD_MISMATCH');
  return { totals, payloadHash: payloadHashes[TABLES[0]] };
}

async function databaseMetrics(adapter) {
  try {
    if (adapter.kind === 'sqlite') {
      const result = {};
      for (const name of ['page_count', 'page_size', 'freelist_count']) result[name] = String((await adapter.sql(`PRAGMA ${name}`, [], 'metrics'))[0][name]);
      return { available: true, values: result };
    }
    const rows = await adapter.sql(`SHOW GLOBAL STATUS WHERE Variable_name IN (
      'Innodb_data_fsyncs','Innodb_os_log_fsyncs','Innodb_os_log_written','Innodb_buffer_pool_reads',
      'Innodb_buffer_pool_read_requests','Com_commit','Com_rollback','Threads_connected','Uptime')`, [], 'metrics');
    return { available: true, scope: 'Server-global counters; not attributable solely to this connection. Missing variables are not zero.',
      values: Object.fromEntries(rows.map((row) => [row.Variable_name, String(row.Value)])) };
  } catch (error) { return { available: false, errorCode: safeCode(error) }; }
}

async function measureBackend(open, steps, options) {
  let adapter = await open(true);
  const result = { measured: false, metadata: adapter.metadata };
  try {
    for (const step of steps.setup) await applyTransaction(adapter, step, 'seed');
    result.metricsBefore = await databaseMetrics(adapter);
    const samples = [], cpu = process.cpuUsage();
    const elapsedStart = performance.now();
    for (const step of steps.writes) {
      const start = performance.now(); await applyTransaction(adapter, step); samples.push(performance.now() - start);
    }
    result.writes = { ackLatencyMs: distribution(samples), elapsedMs: performance.now() - elapsedStart,
      clientCpuMicroseconds: process.cpuUsage(cpu), commitsAcknowledged: samples.length };
    result.metricsAfter = await databaseMetrics(adapter);
    if (result.metricsBefore.available && result.metricsAfter.available && adapter.kind === 'mysql') {
      result.metricCounterDeltas = Object.fromEntries(Object.entries(result.metricsAfter.values)
        .filter(([key, value]) => key !== 'Threads_connected' && key !== 'Uptime'
          && /^\d+$/.test(value) && /^\d+$/.test(result.metricsBefore.values[key] || ''))
        .map(([key, value]) => [key, String(BigInt(value) - BigInt(result.metricsBefore.values[key]))]));
    }
    const expectedRows = { slice_snapshots: options.devices, slice_raw_baseline: options.devices,
      slice_usage_events: options.devices + options.iterations };
    result.beforeReopen = await verify(adapter, steps.expected, expectedRows);
    result.sqlStatements = structuredClone(adapter.counts);
    await adapter.close(); adapter = await open(false);
    const readSamples = [];
    for (let i = 0; i < options.iterations; i++) {
      const start = performance.now();
      result.afterReopen = await verify(adapter, steps.expected, expectedRows, 'reopenReads');
      readSamples.push(performance.now() - start);
    }
    result.reopenReads = { latencyMs: distribution(readSamples), note: 'One connection close/reopen, then N complete three-table exact-total/hash verifications; not N process restarts.' };
    result.reopenSqlStatements = structuredClone(adapter.counts);
    if (result.beforeReopen.payloadHash !== result.afterReopen.payloadHash) throw failure('REOPEN_PAYLOAD_MISMATCH');
    result.measured = true;
    return result;
  } finally { await adapter.close(); }
}

async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args);
  const output = safeOutputPath(options.output);
  const directory = fs.mkdtempSync(path.join(path.dirname(output), 'storage-slice-'));
  const steps = makeSteps(options);
  const result = { schemaVersion: 1, options: { ...options, output: undefined }, node: process.version,
    fixtureSha256: createHash('sha256').update(JSON.stringify(steps.fixture)).digest('hex'),
    transactionInputSha256: createHash('sha256').update(JSON.stringify({ setup: steps.setup, writes: steps.writes })).digest('hex'),
    expectedExactTotals: steps.expected, retainedDirectory: directory,
    scope: 'Same deterministic three-table short transactions: locked raw baseline read, snapshot upsert, raw baseline upsert, append event, COMMIT ACK. Single writer. Not production Hub logic or a backend migration.',
    limitations: ['ACK means COMMIT returned under checked engine settings, not a tested power-loss guarantee.',
      'SQLite scaled 1e-10 integer meters and MySQL DECIMAL(24,10) meters are verified via BigInt/string arithmetic; no Number conversion for accounting.',
      'SQLite client CPU includes the embedded engine; MySQL client CPU excludes the server. These CPU values are not comparable deployment resource totals.',
      'SQL counts are client statement invocations including transaction boundaries, not prepared-statement protocol messages or server-internal IO.',
      'No concurrency/crash/power-loss test, production schema parity, network/fanout load, HTTP/SSE, providers or full-stack resource comparison.',
      'SQLite runs before MySQL; filesystem/cache/order effects remain. Reopen is a connection reopen, not a MySQL server restart.'],
    sqlite: { measured: false }, mysql: { measured: false, reason: 'not_opted_in' }, success: true, comparisonMeasured: false };
  let config;
  try { config = mysqlConfig(env); } catch (_) { result.mysql.reason = 'unsafe_or_incomplete_disposable_configuration'; result.success = false; }
  if (result.success) {
    const filename = path.join(directory, 'slice.sqlite');
    try { result.sqlite = await measureBackend((initialize) => openSqlite(filename, initialize), steps, options); }
    catch (error) { result.sqlite = { measured: false, errorCode: safeCode(error) }; result.success = false; }
    if (config) {
      try { result.mysql = await measureBackend((initialize) => openMysql(config, initialize), steps, options); }
      catch (error) { result.mysql = { measured: false, errorCode: safeCode(error), reason: 'disposable_mysql_measurement_failed' }; result.success = false; }
    }
    if (result.sqlite.measured && result.mysql.measured
      && result.sqlite.afterReopen.payloadHash !== result.mysql.afterReopen.payloadHash) {
      result.success = false; result.crossBackendPayloadsMatch = false;
    } else if (result.sqlite.measured && result.mysql.measured) {
      result.crossBackendPayloadsMatch = true; result.comparisonMeasured = true;
    }
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(output);
  if (!result.success) process.exitCode = 1;
  return result;
}

if (require.main === module) main().catch(() => { console.error('Storage slice failed before report creation; check safe scratch path and options.'); process.exitCode = 1; });
module.exports = { decimal, units, safeCode, mysqlConfig, parseOptions, makeSteps, sameMeters,
  countedSql, openSqlite, applyTransaction, verify, measureBackend, main };
