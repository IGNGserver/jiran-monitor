'use strict';

const { createDeviceState } = require('./deviceState');
const { createUsageRuntime } = require('./usageRuntime');

let nextRuntimeEpoch = 1;

function createDeviceRuntime(options = {}, deps = {}) {
  const epoch = nextRuntimeEpoch++;
  const makeDeviceState = deps.createDeviceState || createDeviceState;
  const makeUsageRuntime = deps.createUsageRuntime || createUsageRuntime;
  const sink = options.sink || null;
  let active = true;
  let shutdownPromise = null;

  function forwardDiagnosticEvent(event) {
    if (!active) return;
    try {
      options.onDiagnosticEvent?.(event);
    } catch (error) {
      try { options.onError?.(error, 'diagnostic'); } catch (_) {}
    }
  }

  const deviceState = makeDeviceState({
    epoch,
    envelope: options.envelope,
    onRecord(record, meta) {
      if (!active) return;
      try {
        options.onRecord?.(record, meta);
      } catch (error) {
        try {
          options.onError?.(error, 'record');
        } catch {
          // Optional observers must never block the delivery path.
        }
      }
      if (sink?.enqueue) {
        Promise.resolve(sink.enqueue(record, meta.revision)).catch((error) => {
          options.onError?.(error, 'sink');
        });
      }
    }
  });

  const usageOptions = {
    ...(options.usageOptions || {}),
    onUpdate(summary, reason) {
      if (!active) return;
      const transformed = options.transformUsage
        ? options.transformUsage(summary, reason, { preview: false })
        : summary;
      deviceState.updateUsage(transformed, reason, { epoch, preview: false });
      return transformed;
    },
    onDiagnosticEvent(event) {
      if (!active) return;
      try { options.usageOptions?.onDiagnosticEvent?.(event); } catch (error) {
        try { options.onError?.(error, 'usage-diagnostic'); } catch (_) {}
      }
      forwardDiagnosticEvent(event);
    }
  };
  if (options.progressive === true) {
    usageOptions.onPreview = (summary, reason = 'progress') => {
      if (!active) return;
      const transformed = options.transformUsage
        ? options.transformUsage(summary, reason, { preview: true })
        : summary;
      deviceState.updateUsage(transformed, reason, { epoch, preview: true });
    };
  } else {
    delete usageOptions.onPreview;
  }
  const usageRuntime = makeUsageRuntime(usageOptions, deps.usageDeps || {});

  function stopCollection(options = {}) {
    if (!active) return;
    active = false;
    deviceState.stop();
    usageRuntime?.stop?.(options);
  }

  function stop(options = {}) {
    stopCollection(options);
    sink?.stop?.();
  }

  // Graceful process shutdown has two distinct phases: stop producing records,
  // then drain the latest upload before closing its scheduler. The ordinary
  // stop() path remains immediate for mode switches and once-run cleanup.
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopCollection();
    shutdownPromise = Promise.resolve()
      .then(() => sink?.flush?.())
      .finally(() => { sink?.stop?.(); });
    return shutdownPromise;
  }

  return {
    clearLimits: () => false,
    flush: () => active ? (sink?.flush?.() || Promise.resolve()) : Promise.resolve(),
    getDiagnostics: () => ({
      usage: usageRuntime?.getDiagnostics?.() ?? null,
      limits: null
    }),
    getSnapshot: () => deviceState.getSnapshot(),
    reconfigureLimits: () => null,
    refreshClient: (clientId, refreshOptions) => active ? usageRuntime.refreshClient(clientId, refreshOptions) : Promise.resolve(false),
    refreshLimits: async () => false,
    shutdown,
    stop,
    tick: (reason, tickOptions) => active ? usageRuntime.tick(reason, tickOptions) : Promise.resolve(false)
  };
}

module.exports = {
  createDeviceRuntime
};
