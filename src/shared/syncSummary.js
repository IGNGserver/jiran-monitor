'use strict';

const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  writeSessionUsageArchive
} = require('./sessionUsageArchive');
const { applyProjectRollups } = require('./usage');
const { normalizeTimeZone } = require('./fleetTimeZone');

function resolveOption(value, ...args) {
  return typeof value === 'function' ? value(...args) : value;
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
  if (options.projectsEnabled !== false) applyProjectRollups(visibleSummary);
  return visibleSummary;
}

/**
 * Create the same historical-summary transform for Electron and headless.
 * Persistence and UI ownership are callbacks; the order and data semantics are
 * deliberately shared so an entry point cannot accidentally omit an archive.
 */
function createSyncSummaryTransformer(options = {}) {
  const initialTimeZone = normalizeTimeZone(options.timeZone);
  let sessionArchive = options.initialSessionUsageArchive === undefined
    ? null
    : normalizeSessionUsageArchive(options.initialSessionUsageArchive, { timeZone: initialTimeZone });
  let sessionArchiveLoaded = sessionArchive !== null;
  // The last calendar this transformer keyed entries in. A change means the
  // in-memory copy describes the old day boundaries (the collector's re-key
  // clears the file, but this copy would otherwise be written back on the next
  // capture), so drop it and reload from disk.
  let lastTimeZone = initialTimeZone;

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
      lastTimeZone = timeZone;
      sessionArchive = null;
      sessionArchiveLoaded = false;
    }
    let nextArchive = loadSessionArchive();
    const archiveEnabled = resolveOption(options.sessionUsageArchiveEnabled, summary, reason, meta) !== false;
    if (archiveEnabled) {
      nextArchive = captureSessionUsageArchive(nextArchive, summary, now, { timeZone });
      const changed = JSON.stringify(nextArchive) !== JSON.stringify(sessionArchive);
      sessionArchive = nextArchive;
      const writeAllowed = resolveOption(options.canWriteSessionUsageArchive, summary, reason, meta) !== false;
      if (changed && writeAllowed && meta.preview !== true) {
        try {
          if (typeof options.writeSessionUsageArchive === 'function') {
            options.writeSessionUsageArchive(nextArchive);
          } else {
            writeSessionUsageArchive(nextArchive, {
              ...(options.archivePath ? { path: options.archivePath } : {}),
              timeZone
            });
          }
        } catch (error) {
          try { options.onArchiveError?.(error, 'write'); } catch (_) {}
        }
      }
    }

    return applySyncSummaryTransform(summary, {
      sessionUsageArchiveEnabled: archiveEnabled,
      sessionUsageArchive: nextArchive,
      projectsEnabled: resolveOption(options.projectsEnabled, summary, reason, meta),
      now,
      timeZone
    });
  }

  return {
    getSessionUsageArchive: () => sessionArchive,
    resetSessionUsageArchive(value = {}) {
      sessionArchive = normalizeSessionUsageArchive(value, { timeZone: lastTimeZone });
      sessionArchiveLoaded = true;
    },
    reloadSessionUsageArchive() {
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