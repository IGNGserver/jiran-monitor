'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { parseOptions, safeOutputPath, makeFixture, nextPayload, distribution, instrumentRepository, runScenario } = require('../../scripts/benchmark-hub-resources');

test('benchmark fixture is deterministic and contains disjoint device sessions and both history tiers', () => {
  const options = { devices: 5, sessions: 3, seed: 613 };
  const fixture = makeFixture(options);
  assert.deepEqual(fixture, makeFixture(options));
  assert.notDeepEqual(fixture, makeFixture({ ...options, seed: 614 }));
  const ids = new Set();
  for (const record of fixture) {
    assert.equal(record.history.daily.length, 30);
    assert.ok(record.history.monthly.length > 0);
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(Object.keys(record[name].sessions).length, 3);
      assert.equal(record[name].totalTokens, Object.values(record[name].sessions).reduce((sum, session) => sum + session.totalTokens, 0));
    }
    for (const key of Object.keys(record.today.sessions)) { assert.ok(!ids.has(key)); ids.add(key); }
  }
  fixture[0].today.totalTokens++;
  assert.notEqual(fixture[0].today.totalTokens, fixture[0].month.totalTokens);
});

test('benchmark options reject malformed values and expose the fleet matrix', () => {
  assert.deepEqual(parseOptions([]).devices, [1, 5, 20, 50]);
  assert.equal(parseOptions(['--duration=0.2', '--sessions', '0']).duration, 0.2);
  for (const args of [['--devices=0'], ['--devices=51'], ['--duration=NaN'], ['--sessions=-1'],
    ['--sessions=201'], ['--sessions=1.5'], ['--epoch=nope'], ['--output'], ['--typo=1']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('measured ingests advance archived sessions and coherent period counters without changing the fixture', () => {
  const record = makeFixture({ devices: 1, sessions: 2 })[0];
  const before = structuredClone(record);
  const updatedAt = '2026-10-24T12:00:01.000Z';
  const payload = nextPayload(record, 2, updatedAt);
  assert.deepEqual(record, before);
  for (const name of ['today', 'month', 'allTime']) {
    const period = payload[name];
    assert.equal(period.totalTokens, record[name].totalTokens + 2);
    assert.equal(period.totalTokens, Object.values(period.sessions).reduce((sum, session) => sum + session.totalTokens, 0));
    assert.equal(Object.values(period.sessions)[0].lastUsedAt, updatedAt);
    assert.equal(period.models['bench-model'], period.totalTokens);
    assert.equal(period.costUsd, record[name].costUsd + 2 / 1e6);
  }
  assert.doesNotThrow(() => nextPayload(makeFixture({ devices: 1, sessions: 0 })[0], 1, updatedAt));
});

test('percentiles report exact sample counts, empty samples and small-tail caveats', () => {
  assert.deepEqual(distribution([]), { samples: 0, p50: null, p95: null, p99: null, max: null,
    tailWarning: 'Fewer than 100 samples; tail percentiles are descriptive only.' });
  assert.equal(distribution([3, 1, 2]).p50, 2);
  assert.equal(distribution([3, 1, 2]).p95, 3);
  assert.equal(distribution(Array.from({ length: 100 }, (_, i) => i)).tailWarning, null);
});

test('repository counters preserve nested invocation and transaction semantics', async () => {
  class Repository {
    async read() { return 7; }
    async transaction(work) { return work(this); }
    async nested() { return this.read(); }
  }
  const repository = new Repository();
  const counted = instrumentRepository(repository);
  assert.equal(await repository.transaction((connection) => connection.nested()), 7);
  assert.deepEqual(counted.calls, { transaction: 1, nested: 1, read: 1 });
  counted.reset(); assert.deepEqual(counted.calls, {});
});

test('output guard rejects traversal, symlink escapes, existing files and project paths', () => {
  const root = path.resolve(process.env.BUILD_SCRATCH_ROOT || path.join(os.homedir(), '.build'));
  fs.mkdirSync(root, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, 'hub-benchmark-test-'));
  const outside = fs.mkdtempSync(path.join(root, 'hub-benchmark-outside-'));
  try {
    assert.throws(() => safeOutputPath(path.join(scratch, '../escape.json'), scratch), /inside/);
    fs.symlinkSync(outside, path.join(scratch, 'link'));
    assert.throws(() => safeOutputPath(path.join(scratch, 'link/new/result.json'), scratch), /escapes/);
    fs.writeFileSync(path.join(scratch, 'existing.json'), 'unchanged');
    assert.throws(() => safeOutputPath(path.join(scratch, 'existing.json'), scratch), /overwrite/);
    assert.equal(fs.readFileSync(path.join(scratch, 'existing.json'), 'utf8'), 'unchanged');
    assert.throws(() => safeOutputPath(undefined, path.join(os.homedir(), '项目', 'forbidden')), /project/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('isolated HTTP workload measures child resources, minimal ingest, both reads and both SSE shapes', { timeout: 30000 }, async () => {
  const root = path.resolve(process.env.BUILD_SCRATCH_ROOT || path.join(os.homedir(), '.build'));
  fs.mkdirSync(root, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, 'hub-benchmark-smoke-'));
  try {
    const options = { ...parseOptions(['--duration=0.2', '--sessions=2', '--interval=0']), output: path.join(scratch, 'result.json') };
    const result = await runScenario(options, 1);
    assert.ok(result.rounds >= 1);
    for (const name of ['ingest', 'summary', 'full']) {
      assert.equal(result.requests[name].latencyMs.samples, result.rounds);
      assert.ok(result.requests[name].bodyBytes > 0);
    }
    assert.ok(result.requests.full.meanBodyBytes > result.requests.summary.meanBodyBytes);
    assert.ok(result.requests.ingest.meanBodyBytes < result.requests.summary.meanBodyBytes);
    assert.ok(result.cpuMicroseconds.user > 0);
    assert.ok(result.memoryBytes.sampledPeak.rss > 0);
    assert.ok(result.eventLoopMs.samples > 0);
    assert.equal(result.repositoryCalls.saveDevice, result.rounds);
    for (const shape of ['full', 'slim']) {
      assert.equal(result.sse[shape].setup.events.snapshot, 1);
      assert.ok(result.sse[shape].events.stats >= 1);
      assert.ok(result.sse[shape].bytes > 0);
      assert.deepEqual(result.sse[shape].errors, []);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
