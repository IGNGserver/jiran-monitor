'use strict';

// The single place that fixes how usage is collected.
//
// Every knob below used to be a settings.json key plus an env var plus (for the
// agent) a CLI flag. The desktop settings surface that carried them is gone, so
// the keys are gone with it: a persisted `settings.historyEnabled = false` or a
// `TOKEN_MONITOR_PROJECTS_ENABLED=0` must not keep narrowing collection for a
// machine that has no way to discover or change the switch any more. What is
// left here is a constant, and `source` only carries the two values that are
// genuinely per-device inputs (identity and the tokscale timeout).
//
// The *wire* fields (projectsEnabled / syncUploadIntervalMs / periodWindows)
// keep their shape — they are a producer manifest documented in docs/API.md and
// older agents and third-party producers still send them. Only the local
// configuration surface disappeared.

const { TRACKED_CLIENTS } = require('./clientTracking');
const { normalizeHistoryIntervalMs } = require('./collector');
const { normalizeSyncUploadIntervalMs } = require('./syncUploadScheduler');

// "live" cadence, which is the only behaviour the product promises: watch the
// source files, fall back to a 5 minute interval scan, derive month/allTime
// exactly from the last full scan (AGENTS.md, collector pipeline).
const DEFAULT_COLLECTION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_COMMAND_TIMEOUT_MS = 120 * 1000;
const DEFAULT_SYNC_UPLOAD_TIMEOUT_MS = 15 * 1000;
const DEFAULT_ALL_TIME_SINCE = '2024-01-01';
// WSL is not file-watched (a 9P watch is unreliable and heavy), so an active
// watch session refreshes it at most this often. Kept well below the collection
// interval so WSL-only work is not minutes behind the host's seconds-level
// refresh, and well above the watch debounce so it is not a per-event scan.
const DEFAULT_WSL_REFRESH_INTERVAL_MS = 60 * 1000;

function normalizeWslRefreshIntervalMs(value, fallback = DEFAULT_WSL_REFRESH_INTERVAL_MS) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return fallback;
  // 0 disables the watch-tick refresh (interval/full ticks still scan WSL).
  if (ms === 0) return 0;
  return Math.max(1000, Math.trunc(ms));
}

function usageConfigFromSource(source = {}, context = {}) {
  return {
    // The tracked set is complete and fixed: every wired harness is collected by
    // every runtime. `source.clients` is ignored on purpose — a persisted or
    // env-supplied subset must not resurrect the deleted selection surface.
    clients: TRACKED_CLIENTS,
    allTimeSince: DEFAULT_ALL_TIME_SINCE,
    commandTimeoutMs: Number(context.commandTimeoutMs ?? source.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
    deviceId: source.deviceId || context.defaultDeviceId,
    agentVersion: context.agentVersion,
    agentRuntime: context.agentRuntime || 'electron-widget',
    projectsEnabled: true,
    reasonixNativeSessionsEnabled: context.reasonixNativeSessionsEnabled ?? true,
    historyEnabled: true,
    historyIntervalMs: context.historyIntervalMs ?? normalizeHistoryIntervalMs(),
    dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveWriteEnabled: context.dailyHistoryArchiveWriteEnabled,
    anchorPersistenceEnabled: context.anchorPersistenceEnabled,
    intervalMs: context.intervalMs ?? DEFAULT_COLLECTION_INTERVAL_MS,
    watchEnabled: true,
    watchTriggersCollection: true,
    intervalRequiresActivity: false,
    watchDebounceMs: context.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
    wslScanEnabled: true,
    wslRefreshIntervalMs: normalizeWslRefreshIntervalMs(context.wslRefreshIntervalMs),
    syncUploadIntervalMs: normalizeSyncUploadIntervalMs(context.syncUploadIntervalMs),
    uploadTimeoutMs: Number(context.uploadTimeoutMs ?? DEFAULT_SYNC_UPLOAD_TIMEOUT_MS),
    onError: context.onError,
    onDiagnosticEvent: context.onDiagnosticEvent,
    logger: context.logger
  };
}

module.exports = {
  DEFAULT_ALL_TIME_SINCE,
  DEFAULT_COLLECTION_INTERVAL_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_SYNC_UPLOAD_TIMEOUT_MS,
  DEFAULT_WATCH_DEBOUNCE_MS,
  DEFAULT_WSL_REFRESH_INTERVAL_MS,
  normalizeWslRefreshIntervalMs,
  usageConfigFromSource
};
