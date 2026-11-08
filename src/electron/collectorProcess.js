'use strict';

// Main-process side of the out-of-process collector (see collectorHost.js).
//
// `createCollectorProcess()` returns a `createUsageRuntime(options)` drop-in for
// `createDeviceRuntime(..., { createUsageRuntime })`: the runtime it returns has
// the same tick/refreshClient/stop/getDiagnostics shape as `startCollector`, so
// the device state, the summary transformation and the upload sink stay where
// they were. Only the scan itself — and every synchronous file, SQLite and
// child-process call it makes — leaves the thread that pumps the window.
//
// One utility process serves every runtime the main process starts (mode
// switches create a new runtime, not a new process). If it dies, the active
// runtime is restarted in a fresh process after a backoff, so collection
// resumes on its own; pending calls settle as `false` like a failed tick.

const path = require('node:path');

const RESTART_DELAYS_MS = Object.freeze([1000, 5000, 15000, 60000]);
const CALLBACK_KEYS = Object.freeze(['onUpdate', 'onPreview', 'onError', 'onDiagnosticEvent', 'logger', 'dailyHistoryArchiveWriteEnabled']);

function serializableOptions(options = {}) {
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    if (CALLBACK_KEYS.includes(key) || typeof value === 'function') continue;
    out[key] = value;
  }
  // The archive-write gate is a callback in-process; the host re-derives it from
  // the same agent pid files instead of asking the main process per tick.
  if (typeof options.dailyHistoryArchiveWriteEnabled === 'function') {
    out.dailyHistoryArchiveWriteEnabled = 'unless-external-agent';
  } else if (options.dailyHistoryArchiveWriteEnabled !== undefined) {
    out.dailyHistoryArchiveWriteEnabled = options.dailyHistoryArchiveWriteEnabled;
  }
  return out;
}

function reviveError(error) {
  const revived = new Error(error?.message || 'collector error');
  if (error?.code != null) revived.code = error.code;
  if (error?.status != null) revived.status = error.status;
  if (error?.name) revived.name = error.name;
  return revived;
}

function createCollectorProcess({
  fork,
  entryPath = path.join(__dirname, 'collectorHost.js'),
  serviceName = 'Jiran Collector',
  log = (message) => console.log(message),
  oneshotTimeoutMs = 180_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (typeof fork !== 'function') throw new TypeError('createCollectorProcess requires a fork function');
  let child = null;
  let nextRuntimeId = 1;
  let nextCallId = 1;
  let restartAttempt = 0;
  let restartTimer = null;
  let disposed = false;
  const runtimes = new Map();
  const oneshots = new Map();

  function send(message) {
    if (!child) return false;
    try { child.postMessage(message); return true; } catch (_) { return false; }
  }

  function settleCalls(entry, value) {
    for (const pending of entry.calls.values()) pending.resolve(value);
    entry.calls.clear();
  }

  function settleOneshot(id, error, value) {
    const pending = oneshots.get(id);
    if (!pending) return false;
    oneshots.delete(id);
    if (pending.timer) clearTimeoutFn(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(value);
    return true;
  }

  function failOneshots(code, message) {
    for (const id of [...oneshots.keys()]) {
      settleOneshot(id, Object.assign(new Error(message), { code }));
    }
  }

  function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'oneshotResult') {
      if (message.ok) settleOneshot(message.id, null, message.value);
      else settleOneshot(message.id, reviveError(message.error));
      return;
    }
    const entry = runtimes.get(message.runtimeId);
    if (!entry) return;
    const { options } = entry;
    switch (message.type) {
      case 'update': {
        let visible = null;
        Promise.resolve()
          .then(() => options.onUpdate?.(message.summary, message.reason))
          .then((transformed) => {
            const source = transformed && typeof transformed === 'object' ? transformed : message.summary;
            visible = { updatedAt: source?.updatedAt ?? null, today: source?.today ?? null };
          })
          .catch((error) => { try { options.onError?.(error, message.reason); } catch (_) {} })
          .finally(() => {
            restartAttempt = 0;
            send({ type: 'updateAck', runtimeId: message.runtimeId, seq: message.seq, visible });
          });
        break;
      }
      case 'preview':
        try { options.onPreview?.(message.summary, message.reason); } catch (_) {}
        break;
      case 'error':
        try { options.onError?.(reviveError(message.error), message.reason); } catch (_) {}
        break;
      case 'diagnostic':
        try { options.onDiagnosticEvent?.(message.event); } catch (_) {}
        break;
      case 'diagnostics':
        entry.diagnostics = message.value ?? null;
        break;
      case 'log':
        try { (options.logger || log)(message.message); } catch (_) {}
        break;
      case 'result': {
        const pending = entry.calls.get(message.id);
        if (!pending) break;
        entry.calls.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(reviveError(message.error));
        break;
      }
      default:
        break;
    }
  }

  function startChild() {
    if (child || disposed) return child;
    child = fork(entryPath, [], { serviceName, stdio: 'inherit' });
    const current = child;
    current.on('message', onMessage);
    current.on('exit', (code) => {
      if (child !== current) return;
      child = null;
      for (const entry of runtimes.values()) {
        entry.started = false;
        settleCalls(entry, false);
      }
      failOneshots('collector_process_exited', 'collector process exited');
      if (disposed || runtimes.size === 0) return;
      const delay = RESTART_DELAYS_MS[Math.min(restartAttempt, RESTART_DELAYS_MS.length - 1)];
      restartAttempt += 1;
      log(`[collector] host exited (code ${code}); restarting in ${delay}ms`);
      for (const entry of runtimes.values()) {
        try { entry.options.onError?.(Object.assign(new Error('collector process exited'), { code: 'collector_process_exited' }), 'collector-process'); } catch (_) {}
      }
      restartTimer = setTimeoutFn(() => {
        restartTimer = null;
        if (disposed || runtimes.size === 0) return;
        startChild();
        for (const [runtimeId, entry] of runtimes) startRuntime(runtimeId, entry);
      }, delay);
      restartTimer?.unref?.();
    });
    return current;
  }

  function startRuntime(runtimeId, entry) {
    startChild();
    entry.started = send({ type: 'start', runtimeId, options: entry.wireOptions });
  }

  function createUsageRuntime(options = {}) {
    const runtimeId = nextRuntimeId++;
    const entry = {
      options,
      wireOptions: serializableOptions(options),
      calls: new Map(),
      diagnostics: null,
      started: false
    };
    runtimes.set(runtimeId, entry);
    startRuntime(runtimeId, entry);

    function call(method, args) {
      if (!runtimes.has(runtimeId)) return Promise.resolve(false);
      if (!child || !entry.started) return Promise.resolve(false);
      const id = nextCallId++;
      return new Promise((resolve, reject) => {
        entry.calls.set(id, { resolve, reject });
        if (!send({ type: 'call', runtimeId, id, method, args })) {
          entry.calls.delete(id);
          resolve(false);
        }
      });
    }

    return {
      tick: (reason, tickOptions) => call('tick', [reason, tickOptions]),
      refreshClient: (clientId, refreshOptions) => call('refreshClient', [clientId, refreshOptions]),
      getDiagnostics: () => entry.diagnostics,
      // Synchronous like startCollector's stop(): once it returns, no callback
      // of this runtime fires again, whatever the host still has in flight.
      stop(stopOptions = {}) {
        if (!runtimes.has(runtimeId)) return;
        runtimes.delete(runtimeId);
        settleCalls(entry, false);
        send({ type: 'stop', runtimeId, options: stopOptions });
      }
    };
  }

  // A scan outside any runtime (e.g. a custom date range), run in the host.
  function run(method, args = [], options = {}) {
    if (disposed) return Promise.reject(Object.assign(new Error('collector process disposed'), { code: 'collector_process_disposed' }));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason || new Error('collector call cancelled'));
    startChild();
    const id = nextCallId++;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null, signal: options.signal || null, onAbort: null };
      oneshots.set(id, pending);
      const cancel = (error) => {
        if (!oneshots.has(id)) return;
        send({ type: 'cancelOneshot', id });
        settleOneshot(id, error);
      };
      if (pending.signal) {
        pending.onAbort = () => cancel(pending.signal.reason || Object.assign(new Error('collector call cancelled'), { name: 'AbortError', code: 'aborted' }));
        pending.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      const timeoutMs = Number(options.timeoutMs ?? oneshotTimeoutMs);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeoutFn(() => cancel(Object.assign(
          new Error(`collector call timed out after ${timeoutMs}ms`),
          { code: 'collector_call_timeout' }
        )), timeoutMs);
      }
      let coalesceKey = options.coalesceKey;
      if (!coalesceKey && method === 'collectCustomRangeOnce') {
        try { coalesceKey = `${method}:${JSON.stringify(args)}`; } catch (_) { /* data-only calls normally always serialize */ }
      }
      if (!send({ type: 'oneshot', id, method, args, timeoutMs, coalesceKey })) {
        cancel(Object.assign(new Error('collector process unavailable'), { code: 'collector_process_unavailable' }));
      }
    });
  }

  function dispose() {
    disposed = true;
    if (restartTimer) clearTimeoutFn(restartTimer);
    for (const [runtimeId, entry] of runtimes) {
      settleCalls(entry, false);
      send({ type: 'stop', runtimeId, options: {} });
    }
    runtimes.clear();
    failOneshots('collector_process_disposed', 'collector process disposed');
    if (child) {
      try { child.kill(); } catch (_) {}
      child = null;
    }
  }

  return {
    createUsageRuntime,
    dispose,
    run,
    get pid() { return child?.pid ?? null; }
  };
}

module.exports = { createCollectorProcess, serializableOptions };
