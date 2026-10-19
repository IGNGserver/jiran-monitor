'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  perfProbeEnabled,
  perfProbeIntervalMs,
  startPerfProbe,
  summarizeAppMetrics
} = require('../../src/electron/perfProbe');

function fakeHistogram() {
  const calls = { enable: 0, disable: 0, reset: 0 };
  return {
    calls,
    enable() { calls.enable += 1; },
    disable() { calls.disable += 1; },
    reset() { calls.reset += 1; },
    percentile(p) { return p === 99 ? 42e6 : 2e6; },
    max: 120e6
  };
}

test('perf probe is off unless explicitly enabled, and inert when off', () => {
  assert.equal(perfProbeEnabled({}), false);
  assert.equal(perfProbeEnabled({ JIRAN_PERF: '0' }), false);
  assert.equal(perfProbeEnabled({ JIRAN_PERF: '1' }), true);
  assert.equal(perfProbeEnabled({ TOKEN_MONITOR_PERF: 'true' }), true);
  let monitorCalls = 0;
  const handle = startPerfProbe({
    app: { getAppMetrics: () => [] },
    env: {},
    monitor: () => { monitorCalls += 1; return fakeHistogram(); }
  });
  assert.equal(handle, null);
  assert.equal(monitorCalls, 0, 'no histogram is created while disabled');
});

test('perf probe interval is clamped and defaults to ten seconds', () => {
  assert.equal(perfProbeIntervalMs({}), 10000);
  assert.equal(perfProbeIntervalMs({ JIRAN_PERF_INTERVAL_MS: '50' }), 1000);
  assert.equal(perfProbeIntervalMs({ JIRAN_PERF_INTERVAL_MS: '2500' }), 2500);
});

test('app metrics are grouped by process type with KiB converted to MB', () => {
  const summary = summarizeAppMetrics([
    { type: 'Browser', memory: { workingSetSize: 102400, privateBytes: 51200 }, cpu: { percentCPUUsage: 1.5 } },
    { type: 'GPU', memory: { workingSetSize: 204800 }, cpu: { percentCPUUsage: 3 } },
    { type: 'Utility', serviceName: 'network.mojom.NetworkService', memory: { workingSetSize: 10240 }, cpu: { percentCPUUsage: 0 } }
  ]);
  assert.equal(summary.byType.Browser.workingSetMb, 100);
  assert.equal(summary.byType.GPU.workingSetMb, 200);
  assert.equal(summary.byType['Utility:network.mojom.NetworkService'].count, 1);
  assert.equal(summary.total.workingSetMb, 310);
  assert.equal(summary.total.cpuPercent, 4.5);
});

test('a sample records loop delay, resets the histogram and appends one JSON line', () => {
  const histogram = fakeHistogram();
  const lines = [];
  const appended = [];
  let scheduled = null;
  const handle = startPerfProbe({
    app: { getAppMetrics: () => [{ type: 'Browser', memory: { workingSetSize: 1024 }, cpu: { percentCPUUsage: 0 } }] },
    env: { JIRAN_PERF: '1' },
    filePath: '/tmp/perf.log',
    log: (line) => lines.push(line),
    extra: () => ({ mode: 'local' }),
    monitor: () => histogram,
    setIntervalFn: (fn) => { scheduled = fn; return { unref() {} }; },
    clearIntervalFn: () => {},
    appendFile: (file, text, done) => { appended.push({ file, text }); done(); }
  });
  assert.ok(handle);
  assert.equal(typeof scheduled, 'function');
  const record = handle.sample();
  assert.equal(record.loop.p99Ms, 42);
  assert.equal(record.loop.maxMs, 120);
  assert.deepEqual(record.extra, { mode: 'local' });
  assert.equal(histogram.calls.reset, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].file, '/tmp/perf.log');
  assert.deepEqual(JSON.parse(appended[0].text).loop, record.loop);
  assert.match(lines[0], /^\[perf\] loop p99=42ms max=120ms/);
  handle.stop();
  assert.equal(histogram.calls.disable, 1);
});
