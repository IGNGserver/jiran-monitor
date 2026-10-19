'use strict';

// Opt-in runtime probe for the desktop app (JIRAN_PERF=1, or the legacy
// TOKEN_MONITOR_PERF=1). It answers the two questions a "the window froze" or
// "the app uses 900 MB" report cannot answer on its own: how long the main
// process event loop stalls, and which Chromium process type owns the memory.
// The Windows "Not Responding" ghost is the browser process failing to pump
// window messages for ~5 s, so loop stalls are the number that matters there;
// the per-type split separates GPU/compositor cost (materials, backdrop-filter)
// from the renderer heap and from the main-process collector.
//
// Off by default and inert when off: no histogram, no timer, no file.

const fs = require('node:fs');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const DEFAULT_INTERVAL_MS = 10 * 1000;
const MIN_INTERVAL_MS = 1000;

function perfProbeEnabled(env = process.env) {
  const raw = String(env.TOKEN_MONITOR_PERF ?? env.JIRAN_PERF ?? '').trim().toLowerCase();
  return raw !== '' && !['0', 'false', 'no', 'off'].includes(raw);
}

function perfProbeIntervalMs(env = process.env) {
  const value = Number(env.TOKEN_MONITOR_PERF_INTERVAL_MS ?? env.JIRAN_PERF_INTERVAL_MS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.trunc(value));
}

const megabytes = (bytes) => Math.round((Number(bytes) || 0) / 1024 / 102.4) / 10;
const nsToMs = (ns) => Math.round((Number(ns) || 0) / 1e5) / 10;

// app.getAppMetrics() reports memory in KiB; group by process type so one line
// shows Browser / GPU / Tab / Utility side by side.
function summarizeAppMetrics(metrics = []) {
  const byType = {};
  let workingSetKb = 0;
  let privateKb = 0;
  let cpuPercent = 0;
  for (const metric of metrics) {
    const type = metric.serviceName ? `${metric.type}:${metric.serviceName}` : (metric.name ? `${metric.type}:${metric.name}` : metric.type);
    const ws = Number(metric.memory?.workingSetSize) || 0;
    const priv = Number(metric.memory?.privateBytes) || 0;
    const cpu = Number(metric.cpu?.percentCPUUsage) || 0;
    const entry = byType[type] || { count: 0, workingSetMb: 0, privateMb: 0, cpuPercent: 0 };
    entry.count += 1;
    entry.workingSetMb = Math.round((entry.workingSetMb + ws / 1024) * 10) / 10;
    entry.privateMb = Math.round((entry.privateMb + priv / 1024) * 10) / 10;
    entry.cpuPercent = Math.round((entry.cpuPercent + cpu) * 10) / 10;
    byType[type] = entry;
    workingSetKb += ws;
    privateKb += priv;
    cpuPercent += cpu;
  }
  return {
    byType,
    total: {
      processes: metrics.length,
      workingSetMb: Math.round(workingSetKb / 102.4) / 10,
      privateMb: Math.round(privateKb / 102.4) / 10,
      cpuPercent: Math.round(cpuPercent * 10) / 10
    }
  };
}

function startPerfProbe({
  app,
  env = process.env,
  filePath = null,
  log = (line) => console.log(line),
  extra = () => null,
  monitor = monitorEventLoopDelay,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  appendFile = fs.appendFile
} = {}) {
  if (!perfProbeEnabled(env) || !app) return null;
  const histogram = monitor({ resolution: 20 });
  histogram.enable();
  const intervalMs = perfProbeIntervalMs(env);

  function sample() {
    const memory = process.memoryUsage();
    let metrics = [];
    try { metrics = app.getAppMetrics(); } catch (_) {}
    let extraFields = null;
    try { extraFields = extra(); } catch (_) {}
    const record = {
      at: new Date().toISOString(),
      loop: {
        p50Ms: nsToMs(histogram.percentile(50)),
        p99Ms: nsToMs(histogram.percentile(99)),
        maxMs: nsToMs(histogram.max)
      },
      main: {
        rssMb: megabytes(memory.rss),
        heapUsedMb: megabytes(memory.heapUsed),
        heapTotalMb: megabytes(memory.heapTotal),
        externalMb: megabytes(memory.external),
        arrayBuffersMb: megabytes(memory.arrayBuffers)
      },
      app: summarizeAppMetrics(metrics),
      ...(extraFields ? { extra: extraFields } : {})
    };
    histogram.reset();
    log(`[perf] loop p99=${record.loop.p99Ms}ms max=${record.loop.maxMs}ms total=${record.app.total.workingSetMb}MB cpu=${record.app.total.cpuPercent}% mainHeap=${record.main.heapUsedMb}MB`);
    if (filePath) appendFile(filePath, `${JSON.stringify(record)}\n`, () => {});
    return record;
  }

  const timer = setIntervalFn(sample, intervalMs);
  timer?.unref?.();
  return {
    intervalMs,
    sample,
    stop() {
      clearIntervalFn(timer);
      histogram.disable();
    }
  };
}

module.exports = {
  perfProbeEnabled,
  perfProbeIntervalMs,
  startPerfProbe,
  summarizeAppMetrics
};
