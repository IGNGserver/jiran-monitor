'use strict';

const crypto = require('node:crypto');
const {
  createSyncUploadScheduler,
  normalizeSyncUploadIntervalMs
} = require('./syncUploadScheduler');

const DEFAULT_WATCH_HEARTBEAT_MAX_AGE_MS = 4 * 60 * 1000;

function withSyncUploadMetadata(summary, intervalMs) {
  if (!summary || typeof summary !== 'object') return summary;
  return {
    ...summary,
    syncUploadIntervalMs: normalizeSyncUploadIntervalMs(intervalMs)
  };
}

function isWatchMeta(meta) {
  const reason = typeof meta?.reason === 'string' ? meta.reason : '';
  return (reason === 'watch' || reason.startsWith('watch:')) && meta?.source !== 'limits';
}

function computeWatchDedupeDigest(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const hash = crypto.createHash('sha1');
  hash.update(String(summary.deviceId || summary.id || ''));
  hash.update('\0');
  hash.update(String(summary.syncUploadIntervalMs ?? 0));
  hash.update('\0');
  hash.update(String(summary.projectsEnabled !== false));
  hash.update('\0');
  hash.update(JSON.stringify(summary.periodWindows || null));
  hash.update('\0');
  hash.update(JSON.stringify(summary.clientStatus || null));
  hash.update('\0');
  hash.update(JSON.stringify(summary.wslStatus || null));
  hash.update('\0');
  hash.update(String(summary.limits?.updatedAt || ''));
  for (const periodName of ['today', 'month', 'allTime']) {
    const p = summary[periodName];
    hash.update('\0');
    if (!p || typeof p !== 'object') continue;
    hash.update(`${p.totalTokens ?? 0}:${p.inputTokens ?? 0}:${p.outputTokens ?? 0}:${p.cacheReadTokens ?? 0}:${p.cacheWriteTokens ?? 0}:${p.reasoningTokens ?? 0}:${p.costUsd ?? 0}`);
    hash.update('\0');
    hash.update(JSON.stringify(p.clients || null));
    hash.update('\0');
    hash.update(JSON.stringify(p.models || null));
  }
  const todaySessions = summary.today?.sessions;
  if (todaySessions && typeof todaySessions === 'object') {
    const keys = Object.keys(todaySessions).sort();
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const s = todaySessions[k];
      hash.update(`\0${k}:${s?.totalTokens ?? 0}:${s?.costUsd ?? 0}:${s?.lastUsedAt || ''}:${s?.projectKey || ''}:${s?.title || ''}`);
    }
  }
  return hash.digest('hex');
}

/**
 * Build the upload sink used by both the Electron client mode and the headless
 * agent. UI code may observe or reject a record in `beforeEnqueue`, but the
 * actual latest-wins, retry, timeout, and flush behaviour stays shared.
 */
function createSyncUploadSink(options = {}) {
  const intervalMs = normalizeSyncUploadIntervalMs(options.intervalMs);
  const watchIntervalMs = normalizeSyncUploadIntervalMs(options.watchIntervalMs, 0);
  const dedupeWatchUnchanged = options.dedupeWatchUnchanged === true;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const heartbeatMaxAgeMs = Number.isFinite(Number(options.heartbeatMaxAgeMs)) && Number(options.heartbeatMaxAgeMs) > 0
    ? Number(options.heartbeatMaxAgeMs)
    : DEFAULT_WATCH_HEARTBEAT_MAX_AGE_MS;
  const rawUpload = typeof options.upload === 'function' ? options.upload : async () => {};

  let lastDeliveredDigest = null;
  let lastDeliveredHistoryRef = undefined;
  let lastDeliveredAt = 0;

  async function trackedUpload(summary, context) {
    const result = await rawUpload(summary, context);
    const responseStatus = Number(result?.status ?? result?.response?.status);
    if (!Number.isInteger(responseStatus) || (responseStatus >= 200 && responseStatus < 300)) {
      if (dedupeWatchUnchanged) {
        lastDeliveredDigest = computeWatchDedupeDigest(summary);
        lastDeliveredHistoryRef = Object.prototype.hasOwnProperty.call(summary || {}, 'history')
          ? summary.history
          : undefined;
        lastDeliveredAt = Number(now());
      }
    }
    return result;
  }

  const scheduler = createSyncUploadScheduler({
    ...options,
    intervalMs,
    watchIntervalMs,
    upload: trackedUpload
  });

  async function enqueue(summary, revision = null, meta = null) {
    const visibleSummary = withSyncUploadMetadata(summary, intervalMs);
    if (typeof options.beforeEnqueue === 'function') {
      const allowed = await options.beforeEnqueue(visibleSummary, revision, meta);
      if (allowed === false) {
        return { queued: false, skipped: true, reason: 'before_enqueue', revision };
      }
    }
    if (dedupeWatchUnchanged && isWatchMeta(meta) && lastDeliveredDigest !== null) {
      const diag = scheduler.getDiagnostics();
      const currentHasHistory = Object.prototype.hasOwnProperty.call(visibleSummary || {}, 'history');
      const sameHistory = !currentHasHistory || visibleSummary.history === lastDeliveredHistoryRef;
      if (
        diag.failureCode === null
        && diag.pendingRevision === null
        && sameHistory
        && Number(now()) - lastDeliveredAt < heartbeatMaxAgeMs
      ) {
        const digest = computeWatchDedupeDigest(visibleSummary);
        if (digest !== null && digest === lastDeliveredDigest) {
          return { queued: false, skipped: true, reason: 'unchanged_watch', revision };
        }
      }
    }
    return scheduler.enqueue(visibleSummary, revision, meta);
  }

  return {
    enqueue,
    flush: (flushOptions) => scheduler.flush(flushOptions),
    flushLatest: (flushOptions) => scheduler.flushLatest(flushOptions),
    retryNow: (retryOptions) => scheduler.retryNow(retryOptions),
    stop: () => scheduler.stop(),
    getDiagnostics: () => scheduler.getDiagnostics(),
    scheduler
  };
}

module.exports = {
  createSyncUploadSink,
  withSyncUploadMetadata
};
