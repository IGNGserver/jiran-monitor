'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAgentShutdown } = require('../../src/agent/processLifecycle');

test('signal shutdown flushes before stopping and releasing the PID owner', async () => {
  const events = [];
  let finishFlush;
  const flush = new Promise((resolve) => { finishFlush = resolve; });
  let exitCode = null;
  const runtime = {
    async shutdown() {
      events.push('shutdown:start');
      const result = await flush;
      events.push('shutdown:flushed');
      return result;
    },
    stop() { events.push('runtime:stop'); }
  };
  const shutdown = createAgentShutdown({
    getRuntime: () => runtime,
    release: () => events.push('pid:release'),
    exit: (code) => { exitCode = code; events.push(`exit:${code}`); },
    logger: { log: () => {}, warn: () => {} },
    timeoutMs: 1000
  });
  const first = shutdown('SIGTERM');
  const second = shutdown('SIGINT');
  assert.equal(first, second);
  await new Promise(setImmediate);
  assert.deepEqual(events, ['shutdown:start']);
  finishFlush({ ok: true });
  await first;
  assert.equal(exitCode, 0);
  assert.deepEqual(events, ['shutdown:start', 'shutdown:flushed', 'pid:release', 'exit:0']);
});

test('a failed final flush still releases ownership and exits non-zero', async () => {
  const events = [];
  let exitCode = null;
  const shutdown = createAgentShutdown({
    getRuntime: () => ({ shutdown: async () => ({ ok: false, code: 'upload_failed' }) }),
    release: () => events.push('release'),
    exit: (code) => { exitCode = code; },
    logger: { warn: (message) => events.push(message), log: () => {} },
    timeoutMs: 1000
  });
  await shutdown('SIGTERM');
  assert.equal(exitCode, 1);
  assert.match(events[0], /upload_failed/);
  assert.equal(events.at(-1), 'release');
});

test('the shutdown deadline forces runtime stop before ownership cleanup', async () => {
  const events = [];
  let exitCode = null;
  const shutdown = createAgentShutdown({
    getRuntime: () => ({
      shutdown: () => new Promise(() => {}),
      stop: () => events.push('stop')
    }),
    release: () => events.push('release'),
    exit: (code) => { exitCode = code; },
    logger: { warn: () => {}, log: () => {} },
    timeoutMs: 5
  });
  await shutdown('SIGTERM');
  assert.equal(exitCode, 1);
  assert.deepEqual(events, ['stop', 'release']);
});
