'use strict';

const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  consumeSessionArchiveDirty,
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  writeSessionUsageArchive
} = require('./sessionUsageArchive');
const { PERIODS, applyProjectRollups } = require('./usage');
const { normalizeTimeZone } = require('./fleetTimeZone');

function resolveOption(value, ...args) {
  return typeof value === 'function' ? value(...args) : value;
}

function projectTargetPeriods(scope) {
  if (scope === 'allTime') return ['allTime'];
  if (Array.isArray(scope) && scope.length > 0) return scope;
  return PERIODS;
}

function applySyncSummaryTransform(summary, options = {}) {
  if (!summary || typeof summary !== 'object') return summary;
  const now = options.now || sessionUsageArchiveDate(summary);
  let visibleSummary = summary;

  if (options.sessionUsageArchiveEnabled !== false) {
    visibleSummary = applySessionUsageArchive(
      visibleSummary,
      options.sessionUsageArchive || {},
      { now, timeZone: normalizeTimeZone(options.timeZone) }
    );
  }
  if (options.projectsEnabled !== false) {
    applyProjectRollups(visibleSummary, projectTargetPeriods(options.projectsScope));
  }
  return visibleSummary;
}

/**
 * Create the same historical-summary transform for Electron and headless.
 * Persistence and UI ownership are callbacks; the order and data semantics are
 * deliberately shared so an entry point cannot accidentally omit an archive.
 */
function createSyncSummaryTransformer(options = {}) {
  const initialTimeZone = normalizeTimeZone(options.timeZone);
  const writeThrottleMs = Math.max(0, Number(options.writeThrottleMs) || 0);
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;

  let sessionArchive = options.initialSessionUsageArchive === undefined
    ? null
    : normalizeSessionUsageArchive(options.initialSessionUsageArchive, { timeZone: initialTimeZone });
  let sessionArchiveLoaded = sessionArchive !== null;
  // The last calendar this transformer keyed entries in. A change means the
  // in-memory copy describes the old day boundaries (the collector's re-key
  // clears the file, but this copy would otherwise be written back on the next
  // capture), so drop it and reload from disk.
  let lastTimeZone = initialTimeZone;
  let pendingWrite = false;
  let lastWriteAt = 0;
  let writeTimer = null;

  function clearWriteTimer() {
    if (writeTimer !== null) {
      clearTimer(writeTimer);
      writeTimer = null;
    }
  }

  function persistArchiveNow() {
    clearWriteTimer();
    if (!pendingWrite || !sessionArchive) return false;
    pendingWrite = false;
    lastWriteAt = Number(nowMs());
    try {
      if (typeof options.writeSessionUsageArchive === 'function') {
        options.writeSessionUsageArchive(sessionArchive);
      } else {
        writeSessionUsageArchive(sessionArchive, {
          ...(options.archivePath ? { path: options.archivePath } : {}),
          timeZone: lastTimeZone
        });
      }
      return true;
    } catch (error) {
      try { options.onArchiveError?.(error, 'write'); } catch (_) {}
      return false;
    }
  }

  function schedulePersist() {
    if (!pendingWrite) return;
    if (writeThrottleMs <= 0) {
      persistArchiveNow();
      return;
    }
    const elapsed = lastWriteAt > 0 ? Number(nowMs()) - lastWriteAt : writeThrottleMs;
    if (elapsed >= writeThrottleMs) {
      persistArchiveNow();
      return;
    }
    if (writeTimer !== null) return;
    const delay = Math.max(1, writeThrottleMs - elapsed);
    writeTimer = setTimer(() => {
      writeTimer = null;
      persistArchiveNow();
    }, delay);
    writeTimer?.unref?.();
  }

  function loadSessionArchive() {
    if (sessionArchiveLoaded) return sessionArchive;
    sessionArchiveLoaded = true;
    try {
      const loaded = typeof options.readSessionUsageArchive === 'function'
        ? options.readSessionUsageArchive()
        : readSessionUsageArchive({
          ...(options.archivePath ? { path: options.archivePath } : {}),
          timeZone: lastTimeZone
        });
      sessionArchive = normalizeSessionUsageArchive(loaded, { timeZone: lastTimeZone });
    } catch (error) {
      sessionArchive = normalizeSessionUsageArchive({}, { timeZone: lastTimeZone });
      try { options.onArchiveError?.(error, 'read'); } catch (_) {}
    }
    return sessionArchive;
  }

  function transform(summary, reason = 'usage', meta = {}) {
    if (!summary || typeof summary !== 'object') return summary;
    const now = sessionUsageArchiveDate(summary);
    const timeZone = normalizeTimeZone(resolveOption(options.timeZone, summary, reason, meta));
    if (timeZone !== lastTimeZone) {
      clearWriteTimer();
      pendingWrite = false;
      lastTimeZone = timeZone;
      sessionArchive = null;
      sessionArchiveLoaded = false;
    }
    let nextArchive = loadSessionArchive();
    const archiveEnabled = resolveOption(options.sessionUsageArchiveEnabled, summary, reason, meta) !== false;
    if (archiveEnabled) {
      nextArchive = captureSessionUsageArchive(nextArchive, summary, now, { timeZone });
      const changed = consumeSessionArchiveDirty(nextArchive);
      sessionArchive = nextArchive;
      if (changed) pendingWrite = true;
      const writeAllowed = resolveOption(options.canWriteSessionUsageArchive, summary, reason, meta) !== false;
      if (pendingWrite && writeAllowed && meta.preview !== true) {
        schedulePersist();
      }
    }

    return applySyncSummaryTransform(summary, {
      sessionUsageArchiveEnabled: archiveEnabled,
      sessionUsageArchive: nextArchive,
      projectsEnabled: resolveOption(options.projectsEnabled, summary, reason, meta),
      projectsScope: resolveOption(options.projectsScope, summary, reason, meta),
      now,
      timeZone
    });
  }

  return {
    flush() {
      return persistArchiveNow();
    },
    stop() {
      clearWriteTimer();
    },
    getSessionUsageArchive: () => sessionArchive,
    resetSessionUsageArchive(value = {}) {
      clearWriteTimer();
      pendingWrite = false;
      sessionArchive = normalizeSessionUsageArchive(value, { timeZone: lastTimeZone });
      sessionArchiveLoaded = true;
    },
    reloadSessionUsageArchive() {
      clearWriteTimer();
      pendingWrite = false;
      sessionArchive = null;
      sessionArchiveLoaded = false;
    },
    transform
  };
}

module.exports = {
  applySyncSummaryTransform,
  createSyncSummaryTransformer
};