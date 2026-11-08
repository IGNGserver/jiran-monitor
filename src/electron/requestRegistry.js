'use strict';

function createRequestRegistry() {
  const requests = new Map();
  let fallbackId = 0;
  const keyOf = (ownerId, requestId) => `${String(ownerId)}:${requestId}`;

  function begin(requestId, ownerId) {
    const id = typeof requestId === 'string' && /^[\w:.-]{1,200}$/.test(requestId)
      ? requestId
      : `legacy-${++fallbackId}`;
    const key = keyOf(ownerId, id);
    if (requests.has(key)) throw Object.assign(new Error('Duplicate desktop request id'), { code: 'duplicate_request_id' });
    const controller = new AbortController();
    const entry = { id, ownerId, controller, finished: false };
    requests.set(key, entry);
    return {
      id,
      signal: controller.signal,
      cancel(reason) {
        if (entry.finished || !requests.has(key)) return false;
        controller.abort(reason);
        return true;
      },
      finish() {
        if (entry.finished) return false;
        entry.finished = true;
        requests.delete(key);
        return true;
      }
    };
  }

  function cancel(requestId, ownerId, reason) {
    const entry = requests.get(keyOf(ownerId, requestId));
    if (!entry || entry.finished) return false;
    entry.controller.abort(reason);
    return true;
  }

  function cancelOwner(ownerId, reason) {
    let count = 0;
    for (const entry of requests.values()) {
      if (entry.ownerId !== ownerId || entry.finished) continue;
      entry.controller.abort(reason);
      count += 1;
    }
    return count;
  }

  return { begin, cancel, cancelOwner, get size() { return requests.size; } };
}

module.exports = { createRequestRegistry };
