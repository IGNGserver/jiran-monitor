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
const { isProcessAlive, parseAgentPidRecord } = require('../shared/agentPidFile');

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
      const record = parseAgentPidRecord(fsApi.readFileSync(pidPath, 'utf8'));
      if (!record || record.pid === process.pid) continue;
      if (isProcessAlive(record.pid, kill)) return true;
    } catch (_) { /* try the next candidate */ }
  }
  return false;
}

function runCollectorHost(port, deps = {}) {
  const startCollector = deps.startCollector || require('../shared/collector').startCollector;
  // Scans that are not part of a running collector (a custom date range in local
  // mode runs its own tokscale pass) go through the same process.
  const oneshots = deps.oneshots || {
    collectCustomRangeOnce: (args, control = {}) => require('../shared/collector').collectCustomRangeOnce({ ...args, ...control })
  };
  const pidPaths = deps.pidPaths || require('../shared/config').pidFileCandidates();
  const runtimes = new Map();
  const oneshotControllers = new Map();
  let hostTransformer = null;

  const post = (message) => {
    try { port.postMessage(message); } catch (_) { /* parent gone */ }
  };

  function ensureHostTransformer() {
    if (hostTransformer) return hostTransformer;
    const { createSyncSummaryTransformer } = require('../shared/syncSummary');
    const { resolveFleetTimeZone } = require('../shared/fleetTimeZone');
    hostTransformer = createSyncSummaryTransformer({
      canWriteSessionUsageArchive: () => !externalAgentActive(pidPaths),
      writeThrottleMs: 30_000,
      timeZone: () => resolveFleetTimeZone(),
      onArchiveError: (error, operation) => post({ type: 'log', runtimeId: null, message: `[session-archive] ${operation} failed: ${error.message}` })
    });
    return hostTransformer;
  }

  function publishDiagnostics(runtimeId) {
    const entry = runtimes.get(runtimeId);
    if (!entry?.collector?.getDiagnostics) return;
    try { post({ type: 'diagnostics', runtimeId, value: entry.collector.getDiagnostics() }); } catch (_) {}
  }

  function start(runtimeId, options = {}) {
    stop(runtimeId);
    const { hostSyncTransform, ...collectorOptions } = options;
    let seq = 0;
    const pendingAcks = new Map();
    const entry = { collector: null, pendingAcks, hostSyncTransform: hostSyncTransform === true };
    runtimes.set(runtimeId, entry);
    const collector = startCollector({
      ...collectorOptions,
      // When hostSyncTransform is enabled, session archive & project rollups run
      // here in the utility process instead of blocking the main window thread;
      // the collector still receives visible `updatedAt`/`today` back via ack.
      onUpdate: (summary, reason) => new Promise((resolve) => {
        if (!runtimes.has(runtimeId)) return resolve(summary);
        let outgoing = summary;
        if (entry.hostSyncTransform) {
          const transformed = ensureHostTransformer().transform(summary, reason, { progressive: false });
          outgoing = transformed && typeof transformed === 'object'
            ? { ...transformed, __hostTransformed: true }
            : summary;
        }
        seq += 1;
        pendingAcks.set(seq, resolve);
        post({ type: 'update', runtimeId, seq, summary: outgoing, reason });
      }).then((visible) => {
        publishDiagnostics(runtimeId);
        return visible;
      }),
      onPreview: (summary, reason) => {
        let outgoing = summary;
        if (entry.hostSyncTransform) {
          const transformed = ensureHostTransformer().transform(summary, reason, { progressive: true });
          outgoing = transformed && typeof transformed === 'object'
            ? { ...transformed, __hostTransformed: true }
            : summary;
        }
        post({ type: 'preview', runtimeId, summary: outgoing, reason });
      },
      onError: (error, reason) => {
        post({ type: 'error', runtimeId, error: serializeError(error), reason: reason ?? null });
        publishDiagnostics(runtimeId);
      },
      onDiagnosticEvent: (event) => {
        post({ type: 'diagnostic', runtimeId, event });
        publishDiagnostics(runtimeId);
      },
      logger: (message) => post({ type: 'log', runtimeId, message: String(message) }),
      ...(collectorOptions.dailyHistoryArchiveWriteEnabled === 'unless-external-agent'
        ? { dailyHistoryArchiveWriteEnabled: () => !externalAgentActive(pidPaths) }
        : {})
    });
    entry.collector = collector;
    publishDiagnostics(runtimeId);
  }

  function stop(runtimeId, options = {}) {
    const entry = runtimes.get(runtimeId);
    if (!entry) return;
    runtimes.delete(runtimeId);
    try { hostTransformer?.flush?.(); } catch (_) {}
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

  async function oneshot(id, method, args = [], control = {}) {
    const fn = Object.prototype.hasOwnProperty.call(oneshots, method) ? oneshots[method] : null;
    if (!fn) {
      post({ type: 'oneshotResult', id, ok: false, error: { message: `unknown collector call ${method}`, code: 'unknown_call' } });
      return;
    }
    const controller = new AbortController();
    oneshotControllers.set(id, controller);
    try {
      const value = await fn(...args, {
        signal: controller.signal,
        scanTimeoutMs: control.timeoutMs,
        coalesceKey: control.coalesceKey || String(id)
      });
      post({ type: 'oneshotResult', id, ok: true, value: value ?? null });
    } catch (error) {
      post({ type: 'oneshotResult', id, ok: false, error: { ...serializeError(error), name: error?.name || 'Error' } });
    } finally {
      if (oneshotControllers.get(id) === controller) oneshotControllers.delete(id);
    }
  }

  function handle(message) {
    if (!message || typeof message !== 'object') return;
    const { type, runtimeId } = message;
    if (type === 'cancelOneshot') { oneshotControllers.get(message.id)?.abort(); return; }
    if (type === 'oneshot') { void oneshot(message.id, message.method, message.args, message); return; }
    if (type === 'reloadSessionArchive') { try { hostTransformer?.reloadSessionUsageArchive?.(); } catch (_) {} return; }
    if (type === 'flushTransform') { try { hostTransformer?.stop?.(); } catch (_) {} return; }
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
