#!/usr/bin/env node
'use strict';

// This is a deliberately narrow local experiment, never a production backend.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { makeFixture, safeOutputPath, distribution } = require('../../benchmark-hub-resources');

function aggregate(records) {
  const result = Object.fromEntries(['today', 'month', 'allTime'].map((name) => [name, { totalTokens: 0, costUsd: 0, clients: {}, models: {} }]));
  for (const record of records) for (const name of Object.keys(result)) {
    const out = result[name], period = record[name];
    out.totalTokens += period.totalTokens; out.costUsd += period.costUsd;
    for (const field of ['clients', 'models']) for (const [key, value] of Object.entries(period[field])) out[field][key] = (out[field][key] || 0) + value;
  }
  return result;
}

function measure(iterations, work) {
  const times = [];
  let value;
  const cpu = process.cpuUsage();
  for (let i = 0; i < iterations; i++) {
    const start = performance.now(); value = work(i); times.push(performance.now() - start);
  }
  return { latencyMs: distribution(times), elapsedMs: times.reduce((a, b) => a + b, 0), cpuMicroseconds: process.cpuUsage(cpu), value };
}

function assertSameSummary(left, right) {
  for (const name of ['today', 'month', 'allTime']) {
    if (!Number.isSafeInteger(left[name]?.totalTokens) || !Number.isSafeInteger(right[name]?.totalTokens)
      || !Number.isFinite(left[name]?.costUsd) || !Number.isFinite(right[name]?.costUsd)
      || left[name].totalTokens !== right[name].totalTokens || Math.abs(left[name].costUsd - right[name].costUsd) > 1e-8) throw new Error('Aggregate totals differ');
    for (const field of ['clients', 'models']) {
      const a = Object.entries(left[name][field]).sort(), b = Object.entries(right[name][field]).sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Aggregate maps differ');
    }
  }
}

function run(args = process.argv.slice(2)) {
  const options = { devices: 20, sessions: 40, iterations: 30, seed: 613 };
  for (const arg of args) {
    const [flag, value] = arg.split('=');
    if (!['--devices', '--sessions', '--iterations', '--seed', '--output'].includes(flag) || !value) throw new Error('Use --devices=N --sessions=N --iterations=N --seed=N --output=SCRATCH/file.json');
    options[flag.slice(2)] = flag === '--output' ? value : Number(value);
  }
  for (const [key, min, max] of [['devices', 1, 50], ['sessions', 0, 200], ['iterations', 1, 1000], ['seed', 1, 0xffffffff]]) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid ${key}`);
  }
  const output = safeOutputPath(options.output);
  const directory = fs.mkdtempSync(path.join(path.dirname(output), 'comparison-'));
  const fixture = makeFixture(options);
  const input = JSON.stringify(fixture);
  const fixtureFile = path.join(directory, 'fixture.json');
  fs.writeFileSync(fixtureFile, input, { mode: 0o600 });
  const result = { schemaVersion: 1, options, node: process.version, platform: process.platform,
    fixture: { path: fixtureFile, bytes: Buffer.byteLength(input), sha256: createHash('sha256').update(input).digest('hex') },
    limitations: ['Microbenchmarks, not complete Hub comparisons or migration evidence.',
      'MySQL is NOT measured: this script has no MySQL adapter and contacts no external database. No inference about SQLite vs MySQL is valid.',
      'SQLite uses one connection, one local APFS database, WAL + synchronous FULL, one autocommitted device snapshot per write; no network latency, production SQL, concurrent readers or multi-process contention.',
      'Go typed decoding skips materializing unknown sessions/history while JS JSON.parse materializes them. Input bytes and output totals match, but allocation work is not equivalent.',
      'Primitive aggregation omits normalization, history/session merging, provenance, cache invalidation, auth, HTTP/SSE, compression and real Hub correctness.',
      'Warmup and small sample sizes bias results. Wall time is not an energy measurement. Single-process timings cannot predict total deployment RSS or idle resource usage.'],
    mysql: { measured: false, reason: 'No isolated MySQL adapter configured; no endpoint is contacted.' } };
  for (let i = 0; i < 5; i++) JSON.stringify(aggregate(JSON.parse(input)));
  const js = measure(options.iterations, () => JSON.stringify(aggregate(JSON.parse(input))));
  const reference = JSON.parse(js.value);
  result.nodeJsonAggregation = { ...js, value: undefined, summary: reference };
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbFile = path.join(directory, 'snapshots.sqlite');
    let db = new DatabaseSync(dbFile);
    try {
      const version = db.prepare('SELECT sqlite_version() version, sqlite_source_id() source').get();
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; CREATE TABLE snapshots (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
      const modes = { journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: db.prepare('PRAGMA synchronous').get().synchronous };
      if (modes.journalMode !== 'wal' || modes.synchronous !== 2) throw new Error('WAL/FULL was not applied');
      const write = db.prepare('INSERT INTO snapshots(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
      for (const record of fixture) write.run(record.deviceId, JSON.stringify(record));
      const payloads = fixture.map((record) => JSON.stringify(record));
      const writes = measure(options.iterations, (i) => {
        const index = i % fixture.length;
        // Change updatedAt with constant-width text to force a real page write,
        // not an identical-value update optimized away by the storage engine.
        const payload = payloads[index].replace('2026-10-24T12:00:00.000Z', new Date(Date.parse('2026-10-24T12:00:00.000Z') + (i + 1) * 1000).toISOString());
        write.run(fixture[index].deviceId, payload);
      });
      const read = db.prepare('SELECT payload FROM snapshots ORDER BY id');
      const reads = measure(options.iterations, () => JSON.stringify(aggregate(read.all().map((row) => JSON.parse(row.payload)))));
      assertSameSummary(reference, JSON.parse(reads.value));
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      db.close(); db = new DatabaseSync(dbFile);
      const reopened = aggregate(db.prepare('SELECT payload FROM snapshots ORDER BY id').all().map((row) => JSON.parse(row.payload)));
      assertSameSummary(reference, reopened);
      result.sqlite = { measured: true, version, modes, writes: { ...writes, value: undefined }, reads: { ...reads, value: undefined },
        checkpoint, reopenedTotalsMatch: true, databaseBytes: fs.statSync(dbFile).size,
        note: 'Single-connection smoke checks do not establish absence of WAL concurrency/corruption bugs. No concurrent writer stress, crash or power-loss test was performed.' };
    } finally { db.close(); }
  } catch (error) { result.sqlite = { measured: false, error: error.message }; }
  try {
    const scratch = path.resolve(process.env.BUILD_SCRATCH_ROOT || path.join(os.homedir(), '.build'));
    const goEnv = { ...process.env, GOCACHE: path.join(scratch, 'go-cache'), GOPATH: path.join(scratch, 'go'), GOTOOLCHAIN: 'local', GOPROXY: 'off' };
    const binary = path.join(directory, 'aggregate-go');
    execFileSync('go', ['build', '-o', binary, path.join(__dirname, 'aggregate.go')], { env: goEnv, timeout: 120000 });
    const go = JSON.parse(execFileSync(binary, [fixtureFile, String(options.iterations)], { env: goEnv, timeout: 120000, encoding: 'utf8' }));
    assertSameSummary(reference, go.summary);
    result.goJsonAggregation = { ...go, sortedSamplesMs: undefined, latencyMs: distribution(go.sortedSamplesMs), totalsMatch: true };
  } catch (error) { result.goJsonAggregation = { measured: false, error: error.message }; }
  result.retainedDirectory = directory;
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(output);
  return result;
}

if (require.main === module) {
  try { run(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = { aggregate, assertSameSummary, measure, run };
