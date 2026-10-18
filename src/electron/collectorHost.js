'use strict';

// Utility-process host for the usage collector.
//
// The collector (tokscale spawns and JSON parsing, the chokidar watch, and the
// adapters that read SQLite stores, Qoder transcripts, Claude Desktop and
// Reasonix files, and WSL homes over \\wsl$) does a lot of synchronous work.
// In the Electron main process that work runs on the thread that also pumps the
// window's native messages, so a long tick is exactly what Windows reports as
// "Not Responding". This host runs `startCollector` in an Electron
// utilityProcess instead; the main process keeps the callbacks, the
// transformation, the device state and the upload sink, and talks to the host
// over the message port (see collectorProcess.js for the other half).
//
// Protocol (all messages are structured-clone data):
//   main → host  { type: 'start', runtimeId, options }
//                { type: 'stop', runtimeId, options }
//                { type: 'call', runtimeId, id, method: 'tick'|'refreshClient', args }
//                { type: 'updateAck', runtimeId, seq, visible }
//                { type: 'oneshot', id, method: 'collectCustomRangeOnce', args }
//   host → main  { type: 'update', runtimeId, seq, summary, reason }   (awaits updateAck)
//                { type: 'preview', runtimeId, summary, reason }
//                { type: 'error', runtimeId, error, reason }
//                { type: 'diagnostic', runtimeId, event }
//                { type: 'diagnostics', runtimeId, value }
//                { type: 'log', runtimeId, message }
//                { type: 'result', runtimeId, id, ok, value, error }
//                { type: 'oneshotResult', id, ok, value, error }

const fs = require('node:fs');

const DIAGNOSTICS_INTERVAL_MS = 2000;

function serializeError(error) {
  return {
    message: String(error?.message || error || 'collector error'),
    code: error?.code ?? null,
    status: error?.status ?? null
  };
}

function externalAgentActive(pidPaths, fsApi = fs, kill = process.kill.bind(process)) {
  for (const pidPath of pidPaths) {
    try {
      const pid = parseInt(String(fsApi.readFileSync(pidPath, 'utf8')).trim(), 10);
      if (!pid || pid === process.pid) continue;
      kill(pid, 0);
      return true;
    } catch (_) { /* try the next candidate */ }
  }
  return false;
}

function runCollectorHost(port, deps = {}) {
  const startCollector = deps.startCollector || require('../shared/collector').startCollector;
  // Scans that are not part of a running collector (a custom date range in local
  // mode runs its own tokscale pass) go through the same process.
  const oneshots = deps.oneshots || {
    collectCustomRangeOnce: (...args) => require('../shared/collector').collectCustomRangeOnce(...args)
  };
  const pidPaths = deps.pidPaths || require('../shared/config').pidFileCandidates();
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  const runtimes = new Map();

  const post = (message) => {
    try { port.postMessage(message); } catch (_) { /* parent gone */ }
  };

  function publishDiagnostics(runtimeId) {
    const entry = runtimes.get(runtimeId);
    if (!entry?.collector?.getDiagnostics) return;
    try { post({ type: 'diagnostics', runtimeId, value: entry.collector.getDiagnostics() }); } catch (_) {}
  }

  function start(runtimeId, options = {}) {
    stop(runtimeId);
    let seq = 0;
    const pendingAcks = new Map();
    const entry = { collector: null, pendingAcks, timer: null };
    runtimes.set(runtimeId, entry);
    const collector = startCollector({
      ...options,
      // The transformation lives in the main process; the collector only needs
      // the visible `updatedAt`/`today` back for its live daily archive.
      onUpdate: (summary, reason) => new Promise((resolve) => {
        if (!runtimes.has(runtimeId)) return resolve(summary);
        seq += 1;
        pendingAcks.set(seq, resolve);
        post({ type: 'update', runtimeId, seq, summary, reason });
      }).then((visible) => {
        publishDiagnostics(runtimeId);
        return visible;
      }),
      onPreview: (summary, reason) => post({ type: 'preview', runtimeId, summary, reason }),
      onError: (error, reason) => {
        post({ type: 'error', runtimeId, error: serializeError(error), reason: reason ?? null });
        publishDiagnostics(runtimeId);
      },
      onDiagnosticEvent: (event) => post({ type: 'diagnostic', runtimeId, event }),
      logger: (message) => post({ type: 'log', runtimeId, message: String(message) }),
      ...(options.dailyHistoryArchiveWriteEnabled === 'unless-external-agent'
        ? { dailyHistoryArchiveWriteEnabled: () => !externalAgentActive(pidPaths) }
        : {})
    });
    entry.collector = collector;
    entry.timer = setIntervalFn(() => publishDiagnostics(runtimeId), DIAGNOSTICS_INTERVAL_MS);
    entry.timer?.unref?.();
    publishDiagnostics(runtimeId);
  }

  function stop(runtimeId, options = {}) {
    const entry = runtimes.get(runtimeId);
    if (!entry) return;
    runtimes.delete(runtimeId);
    if (entry.timer) clearIntervalFn(entry.timer);
    // Release a tick waiting on an ack so the stopped collector can unwind.
    for (const resolve of entry.pendingAcks.values()) resolve(null);
    entry.pendingAcks.clear();
    try { entry.collector?.stop?.(options); } catch (_) {}
  }

  async function call(runtimeId, id, method, args = []) {
    const entry = runtimes.get(runtimeId);
    if (!entry?.collector || typeof entry.collector[method] !== 'function' || !['tick', 'refreshClient'].includes(method)) {
      post({ type: 'result', runtimeId, id, ok: true, value: false });
      return;
    }
    try {
      const value = await entry.collector[method](...args);
      post({ type: 'result', runtimeId, id, ok: true, value: value ?? null });
    } catch (error) {
      post({ type: 'result', runtimeId, id, ok: false, error: { ...serializeError(error), name: error?.name || 'Error' } });
    } finally {
      publishDiagnostics(runtimeId);
    }
  }

  async function oneshot(id, method, args = []) {
    const fn = Object.prototype.hasOwnProperty.call(oneshots, method) ? oneshots[method] : null;
    if (!fn) {
      post({ type: 'oneshotResult', id, ok: false, error: { message: `unknown collector call ${method}`, code: 'unknown_call' } });
      return;
    }
    try {
      post({ type: 'oneshotResult', id, ok: true, value: (await fn(...args)) ?? null });
    } catch (error) {
      post({ type: 'oneshotResult', id, ok: false, error: { ...serializeError(error), name: error?.name || 'Error' } });
    }
  }

  function handle(message) {
    if (!message || typeof message !== 'object') return;
    const { type, runtimeId } = message;
    if (type === 'oneshot') { void oneshot(message.id, message.method, message.args); return; }
    if (type === 'start') start(runtimeId, message.options);
    else if (type === 'stop') stop(runtimeId, message.options);
    else if (type === 'call') void call(runtimeId, message.id, message.method, message.args);
    else if (type === 'updateAck') {
      const entry = runtimes.get(runtimeId);
      const resolve = entry?.pendingAcks.get(message.seq);
      if (resolve) {
        entry.pendingAcks.delete(message.seq);
        resolve(message.visible ?? null);
      }
    }
  }

  port.on('message', (event) => handle(event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : event));
  return { handle, runtimes };
}

module.exports = { externalAgentActive, runCollectorHost };

if (process.parentPort) {
  require('../shared/safeStdio').installSafeStdout?.();
  runCollectorHost(process.parentPort);
}
