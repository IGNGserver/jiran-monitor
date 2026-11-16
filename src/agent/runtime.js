'use strict';

const { createDeviceRuntime } = require('../shared/deviceRuntime');
const {
  createSyncUploadSink,
  withSyncUploadMetadata
} = require('../shared/syncUploadSink');

function createAgentDeviceRuntime(options = {}, deps = {}, overrides = {}) {
  const makeDeviceRuntime = deps.createDeviceRuntime || createDeviceRuntime;
  const makeSyncUploadSink = deps.createSyncUploadSink || createSyncUploadSink;
  const sink = overrides.sink === undefined
    ? makeSyncUploadSink({
        upload: options.deliver,
        intervalMs: options.syncUploadIntervalMs,
        watchIntervalMs: options.watchUploadIntervalMs,
        dedupeWatchUnchanged: options.dedupeWatchUnchanged === true,
        flushTimeoutMs: options.uploadTimeoutMs,
        onError: options.uploadOnError
      })
    : overrides.sink;

  return makeDeviceRuntime({
    envelope: options.envelope,
    usageOptions: overrides.usageOptions || options.usageOptions,
    transformUsage: options.transformUsage,
    retainSnapshot: overrides.retainSnapshot ?? options.retainSnapshot ?? false,
    sink,
    onRecord: overrides.onRecord || options.onRecord,
    onError: options.onError
  }, deps.deviceRuntimeDeps || {});
}

function runAgent(options = {}, deps = {}) {
  const runtime = createAgentDeviceRuntime(options, deps);
  options.onRuntime?.(runtime);
  return runtime;
}

async function runAgentOnce(options = {}, deps = {}) {
  let latestRecord = null;
  let usageSettled = false;
  let resolveUsage;
  let rejectUsage;
  const usageReady = new Promise((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });
  const originalUsageError = options.usageOptions?.onError;
  const usageOptions = {
    ...(options.usageOptions || {}),
    onError(error, reason) {
      originalUsageError?.(error, reason);
      if (!usageSettled) {
        usageSettled = true;
        rejectUsage(error);
      }
    }
  };
  const dryRun = options.dryRun === true;
  const runtime = createAgentDeviceRuntime(options, deps, {
    usageOptions,
    sink: dryRun ? null : undefined,
    onRecord(record, meta) {
      latestRecord = withSyncUploadMetadata(record, options.syncUploadIntervalMs);
      options.onRecord?.(latestRecord, meta);
      if (meta.source === 'usage' && !usageSettled) {
        usageSettled = true;
        resolveUsage(record);
      }
    }
  });
  options.onRuntime?.(runtime);

  try {
    await usageReady;
    if (dryRun && latestRecord) await options.deliver?.(latestRecord);
    const flushResult = await runtime.flush();
    if (flushResult?.ok === false) {
      const error = new Error(`headless upload failed (${flushResult.code || 'upload_failed'})`);
      if (flushResult.status !== undefined && flushResult.status !== null) error.status = flushResult.status;
      error.code = flushResult.code || 'upload_failed';
      throw error;
    }
    return latestRecord;
  } finally {
    runtime.stop();
  }
}

module.exports = {
  runAgent,
  runAgentOnce
};
