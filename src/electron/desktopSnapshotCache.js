'use strict';

// The desktop renderer must remain useful when the Hub is down. This file is
// deliberately a small, versioned snapshot store rather than a second data
// source: the collector and Hub responses remain authoritative whenever they
// are available, while this store only supplies the last known read model.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writePrivateJsonAtomic } = require('../shared/credentialStore');

const DESKTOP_SNAPSHOT_CACHE_VERSION = 1;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cacheable(value) {
  return isRecord(value) ? cloneJson(value) : null;
}

function normalizeEntry(value) {
  if (!isRecord(value) || !isRecord(value.stats)) return null;
  return {
    capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : null,
    stats: cacheable(value.stats),
    device: cacheable(value.device),
    history: cacheable(value.history)
  };
}

function normalizeDesktopSnapshotCache(value) {
  if (!isRecord(value) || value.version !== DESKTOP_SNAPSHOT_CACHE_VERSION) return null;
  const local = value.local == null ? null : normalizeEntry(value.local);
  const hub = value.hub == null ? null : normalizeEntry(value.hub);
  if ((value.local != null && !local) || (value.hub != null && !hub)) return null;
  return {
    version: DESKTOP_SNAPSHOT_CACHE_VERSION,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    local,
    hub
  };
}

function emptyDesktopSnapshotCache() {
  return {
    version: DESKTOP_SNAPSHOT_CACHE_VERSION,
    updatedAt: null,
    local: null,
    hub: null
  };
}

function readDesktopSnapshotCache(filePath, fsApi = fs) {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    return normalizeDesktopSnapshotCache(parsed);
  } catch (_) {
    // A corrupt or partial cache is non-authoritative. The collector will
    // rebuild it after the next successful tick; startup must still continue.
    return null;
  }
}

function writeDesktopSnapshotCache(filePath, value, fsApi = fs) {
  const normalized = normalizeDesktopSnapshotCache(value) || emptyDesktopSnapshotCache();
  normalized.updatedAt = new Date().toISOString();
  writePrivateJsonAtomic(filePath, normalized, { fs: fsApi });
  return normalized;
}

function entryForWrite(value) {
  if (!isRecord(value) || !isRecord(value.stats)) return null;
  return {
    capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : null,
    stats: value.stats,
    device: isRecord(value.device) ? value.device : null,
    history: isRecord(value.history) ? value.history : null
  };
}

// The live read model and the cache entries are the same objects, so the
// serialized text is the snapshot: there is no need to deep-copy a ~1 MB fleet
// document (three times per tick, as the entry setters used to) before
// JSON.stringify copies it again. Compact on purpose — this file is a cache,
// not something a person edits, and pretty-printing doubled its size.
function serializeDesktopSnapshotCache(value, now = new Date()) {
  return JSON.stringify({
    version: DESKTOP_SNAPSHOT_CACHE_VERSION,
    updatedAt: now.toISOString(),
    local: entryForWrite(value?.local),
    hub: entryForWrite(value?.hub)
  });
}

// Off-thread write for the hot path. The synchronous writer above fsyncs and
// renames on the Electron main thread, which is also the thread that pumps the
// window's messages — doing that on every collector tick and every Hub frame is
// how a busy fleet made the window stop responding. The cache is
// non-authoritative (a torn or missing file is rebuilt on the next tick), so the
// write keeps the atomic rename but skips the fsync.
async function writeDesktopSnapshotCacheAsync(filePath, value, fsApi = fs.promises) {
  const text = serializeDesktopSnapshotCache(value);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsApi.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let handle = null;
  try {
    handle = await fsApi.open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.close();
    handle = null;
    await fsApi.rename(temporary, filePath);
  } catch (error) {
    if (handle) { try { await handle.close(); } catch (_) {} }
    try { await fsApi.unlink(temporary); } catch (_) {}
    throw error;
  }
  return text.length;
}

module.exports = {
  DESKTOP_SNAPSHOT_CACHE_VERSION,
  cacheable,
  emptyDesktopSnapshotCache,
  normalizeDesktopSnapshotCache,
  readDesktopSnapshotCache,
  serializeDesktopSnapshotCache,
  writeDesktopSnapshotCache,
  writeDesktopSnapshotCacheAsync
};
