'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDeviceRuntime } = require('../../src/shared/deviceRuntime');

function harness(options = {}) {
  let usageOptions;
  let limitsFactoryCalls = 0;
  const calls = [];
  const usageHandle = {
    refreshClient: (...args) => { calls.push(['refreshClient', ...args]); return 'client'; },
    stop: () => calls.push(['usageStop']),
    tick: (...args) => { calls.push(['tick', ...args]); return 'tick'; }
  };
  const records = [];
  const runtime = createDeviceRuntime({
    envelope: { deviceId: 'device-1', hostname: 'host' },
    onRecord: (record, meta) => records.push({ record, meta }),
    ...options
  }, {
    createUsageRuntime(next) {
      usageOptions = next;
      return usageHandle;
    },
    createLimitsRuntime() {
      limitsFactoryCalls += 1;
      throw new Error('device limits runtime must not be constructed');
    }
  });
  return { calls, limitsFactoryCalls: () => limitsFactoryCalls, records, runtime, usageOptions };
}

test('device runtime constructs usage only and never starts a local limits collector', async () => {
  const { limitsFactoryCalls, records, runtime, usageOptions } = harness({
    initialLimits: { providers: [{ provider: 'kimi' }] },
    limitsOptions: { limitProviders: 'kimi' }
  });

  usageOptions.onUpdate({
    updatedAt: 'usage-time',
    today: { totalTokens: 10 },
    month: { totalTokens: 10 },
    allTime: { totalTokens: 10 },
    limits: { providers: [{ provider: 'kimi' }] }
  }, 'startup');

  assert.equal(limitsFactoryCalls(), 0);
  assert.equal(records.length, 1);
  assert.equal(Object.hasOwn(records[0].record, 'limits'), false);
  assert.equal(await runtime.refreshLimits({ provider: 'kimi' }, 'manual'), false);
  assert.equal(runtime.clearLimits({ provider: 'kimi' }, 'logout'), false);
  assert.equal(runtime.reconfigureLimits({ limitsRefreshMs: 60_000 }), null);
  assert.equal(runtime.getDiagnostics().limits, null);
});

test('usage transforms and progressive previews remain device-local responsibilities', () => {
  const transformed = [];
  const { records, runtime, usageOptions } = harness({
    progressive: true,
    transformUsage(summary, reason, meta) {
      transformed.push({ reason, preview: meta.preview });
      return { ...summary, transformed: true };
    }
  });

  usageOptions.onPreview({ updatedAt: 'preview-time', today: { totalTokens: 2 } });
  assert.equal(records.length, 0);
  usageOptions.onUpdate({
    updatedAt: 'usage-time',
    today: { totalTokens: 3 },
    month: { totalTokens: 4 },
    allTime: { totalTokens: 5 }
  }, 'startup');

  assert.deepEqual(transformed, [
    { reason: 'progress', preview: true },
    { reason: 'startup', preview: false }
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].record.transformed, true);
  runtime.stop();
});

test('graceful shutdown stops collection before flushing and closes the sink once', async () => {
  const events = [];
  const sink = {
    enqueue: () => events.push('enqueue'),
    flush: async () => { events.push('flush'); return { ok: true }; },
    stop: () => events.push('sinkStop')
  };
  const { calls, records, runtime, usageOptions } = harness({ sink });
  usageOptions.onUpdate({ updatedAt: 'usage-time', today: { totalTokens: 3 } }, 'startup');
  const first = runtime.shutdown();
  const second = runtime.shutdown();
  assert.equal(first, second);
  assert.deepEqual(calls, [['usageStop']]);
  usageOptions.onUpdate({ updatedAt: 'late', today: { totalTokens: 99 } }, 'late');
  assert.equal(records.length, 1);
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(events, ['enqueue', 'flush', 'sinkStop']);
});

test('device runtime forwards usage controls and invalidates callbacks on stop', () => {
  const { calls, records, runtime, usageOptions } = harness();
  assert.equal(runtime.tick('manual', { forceHistory: true }), 'tick');
  assert.equal(runtime.refreshClient('cursor', { forceSync: true }), 'client');

  runtime.stop();
  usageOptions.onUpdate({ today: { totalTokens: 99 } }, 'late');
  assert.deepEqual(records, []);
  assert.deepEqual(calls, [
    ['tick', 'manual', { forceHistory: true }],
    ['refreshClient', 'cursor', { forceSync: true }],
    ['usageStop']
  ]);
});
