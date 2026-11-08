'use strict';

function abortError(message = 'Collector scan cancelled') {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'aborted' });
}

function timeoutError(timeoutMs) {
  return Object.assign(new Error(`Collector scan timed out after ${timeoutMs}ms`), {
    code: 'collector_scan_timeout'
  });
}

// One physical-scan lane per collector process. A caller's deadline settles only
// that caller: the lane advances after the underlying task actually settles, so
// a timeout can never turn into two concurrent tokscale/filesystem scans.
function createSerialScanQueue() {
  const pending = [];
  const keyed = new Map();
  let active = null;

  function detachWaiter(item, waiter) {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    item.waiters.delete(waiter);
    if (item.waiters.size === 0) {
      if (item.key !== null && keyed.get(item.key) === item) keyed.delete(item.key);
      if (item.started) item.controller.abort(waiter.error || abortError());
    }
  }

  function rejectWaiter(item, waiter, error) {
    if (!item.waiters.has(waiter)) return;
    waiter.error = error;
    detachWaiter(item, waiter);
    waiter.reject(error);
  }

  function settleItem(item, error, value) {
    for (const waiter of [...item.waiters]) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      item.waiters.delete(waiter);
      if (error) waiter.reject(error);
      else waiter.resolve(value);
    }
    if (item.key !== null && keyed.get(item.key) === item) keyed.delete(item.key);
  }

  function pump() {
    if (active) return;
    let item = null;
    while (pending.length && !item) {
      const candidate = pending.shift();
      if (candidate.waiters.size) item = candidate;
    }
    if (!item) return;
    active = item;
    item.started = true;
    Promise.resolve()
      .then(() => item.task({ signal: item.controller.signal }))
      .then(
        (value) => settleItem(item, null, value),
        (error) => settleItem(item, error)
      )
      .finally(() => {
        if (active === item) active = null;
        pump();
      });
  }

  function addWaiter(item, options) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal: options.signal || null, onAbort: null, timer: null, error: null };
      if (waiter.signal?.aborted) {
        reject(waiter.signal.reason || abortError());
        return;
      }
      item.waiters.add(waiter);
      if (waiter.signal) {
        waiter.onAbort = () => rejectWaiter(item, waiter, waiter.signal.reason || abortError());
        waiter.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      const timeoutMs = Number(options.timeoutMs);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        waiter.timer = setTimeout(() => rejectWaiter(item, waiter, timeoutError(timeoutMs)), timeoutMs);
      }
      pump();
    });
  }

  function run(task, options = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('scan task must be a function'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason || abortError());
    const key = options.coalesceKey === undefined || options.coalesceKey === null
      ? null
      : String(options.coalesceKey);
    let item = key === null ? null : keyed.get(key);
    if (!item) {
      item = {
        key,
        task,
        controller: new AbortController(),
        waiters: new Set(),
        started: false
      };
      if (key !== null) keyed.set(key, item);
      pending.push(item);
    }
    return addWaiter(item, options);
  }

  return {
    run,
    getDiagnostics: () => ({
      active: Boolean(active),
      activeWaiters: active?.waiters.size || 0,
      queued: pending.filter((item) => item.waiters.size).length,
      keyed: keyed.size
    })
  };
}

const collectorScanQueue = createSerialScanQueue();

module.exports = { abortError, collectorScanQueue, createSerialScanQueue, timeoutError };
