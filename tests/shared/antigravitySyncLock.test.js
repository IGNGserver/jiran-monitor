'use strict';

// `tokscale antigravity sync` publishes a legacy `sync.lock` record (pid +
// timestamp) before a sync starts and removes it on a clean exit. A sync killed
// mid-flight — this collector's 30s timeout kill, an app quit, a machine reset —
// strands the record, and tokscale then fails closed on it forever: every later
// sync exits 1 until the file is removed by hand. Because the sync cache is one
// of the two IDE data sources (the other is the `antigravity-extension` SQLite
// store), a stranded lock silently stops AGY reporting — which is exactly the
// 2026-10 workstation incident. These tests pin which records
// maybeSyncAntigravity() clears and which it leaves alone.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { installSourceEnvGuard } = require('../helpers/sourceEnv');

const collectorPath = require.resolve('../../src/shared/collector');

installSourceEnvGuard(test);

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

function withTmpHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sync-lock-'));
  fs.mkdirSync(path.join(tmp, '.gemini', 'antigravity'), { recursive: true });
  return tmp;
}

// Above every platform's pid_max, so process.kill(pid, 0) fails with ESRCH
// instead of probing a live stranger.
const DEAD_PID = 999999999;

function writeLock(tmp, contents) {
  const lockPath = path.join(tmp, 'config', 'antigravity-cache', 'sync.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, contents);
  return lockPath;
}

async function runMaybeSync(tmp, collector, logger = () => {}) {
  let ran = false;
  const result = await collector.maybeSyncAntigravity('antigravity', logger, tmp, {
    minIntervalMs: 0,
    // Hermetic: the collector resolves the cache dir from this env, so the
    // fixture lock lives under tmp instead of the developer's real config dir.
    env: { TOKSCALE_CONFIG_DIR: path.join(tmp, 'config') },
    platform: process.platform,
    run: async () => { ran = true; }
  });
  return { result, ran };
}

test('a stale lock record left by a dead sync is cleared before the next attempt', async () => {
  const tmp = withTmpHome();
  const logs = [];
  try {
    const lockPath = writeLock(tmp, `${DEAD_PID} 1792004412\n`);
    const collector = freshCollector();
    const { result, ran } = await runMaybeSync(tmp, collector, (line) => logs.push(line));
    assert.equal(result.attempted, true);
    assert.equal(result.failed, false);
    assert.equal(ran, true, 'the sync must still run once the stale record is cleared');
    assert.equal(fs.existsSync(lockPath), false, 'the dead-pid record should be removed');
    assert.ok(
      logs.some((line) => line.includes(String(DEAD_PID))),
      `expected a log line naming the stale pid, got: ${logs.join(' | ')}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a lock record with a live pid is left alone', async () => {
  const tmp = withTmpHome();
  try {
    // process.pid is alive by definition. The real tokscale then fails closed on
    // the record, and that error — not a silently reclaimed lock — is what the
    // user sees.
    const lockPath = writeLock(tmp, `${process.pid} 1792004412\n`);
    const collector = freshCollector();
    const { ran } = await runMaybeSync(tmp, collector);
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockPath), true, 'a live-pid record must not be reclaimed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a lock record that cannot be parsed is left alone', async () => {
  const tmp = withTmpHome();
  try {
    const lockPath = writeLock(tmp, '');
    const collector = freshCollector();
    await runMaybeSync(tmp, collector);
    assert.equal(fs.existsSync(lockPath), true, 'an unparsable record must not be reclaimed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a record with a dead pid but no timestamp still counts as stale', async () => {
  const tmp = withTmpHome();
  try {
    // The pid is the whole staleness proof; the timestamp is advisory, so a
    // truncated record must not pin the lock forever.
    const lockPath = writeLock(tmp, `${DEAD_PID}\n`);
    const collector = freshCollector();
    await runMaybeSync(tmp, collector);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
