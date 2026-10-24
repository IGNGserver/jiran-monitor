'use strict';

// Coalesce notifications, not durable writes. One builder and one dirty marker
// bound work even when mutations arrive faster than a slow database read.
function createLatestPublisher({ publish, delayMs = 50, onError = () => {} }) {
  let active = null;
  let dirty = false;
  let reason = 'update';
  let closed = false;
  let builds = 0;
  let completion = null;
  let complete = null;

  function nextCompletion() {
    if (!completion) completion = new Promise((resolve) => { complete = resolve; });
    return completion;
  }

  function request(nextReason = 'update') {
    if (closed) return Promise.resolve();
    dirty = true;
    reason = nextReason;
    const result = nextCompletion();
    if (!active) {
      const inFlight = (async () => {
        while (dirty && !closed) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (closed) break;
          const currentReason = reason;
          dirty = false;
          const done = complete;
          completion = complete = null;
          builds++;
          try { await publish(currentReason); }
          catch (error) { onError(error); }
          finally {
            // Clear idle ownership before resolving callers: their immediate
            // next request must not attach to a loop that has already exited.
            if (!dirty || closed) active = null;
            done?.();
          }
          if (!dirty || closed) return;
        }
      })().finally(() => { if (active === inFlight) active = null; });
      active = inFlight;
    }
    return result;
  }

  return {
    request,
    async close() { closed = true; dirty = false; complete?.(); await active; },
    metrics: () => ({ builds, active: Boolean(active), dirty })
  };
}

module.exports = { createLatestPublisher };
