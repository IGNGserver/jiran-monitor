'use strict';

// Reads Antigravity CLI session metadata (workspace path -> project, created &
// last turn timestamps) from ~/.gemini/antigravity-cli/conversations/<id>.db.
// Mirrors opencodeSession.js: read-only node:sqlite with a `deps.sqlite` seam
// and bounded stat-keyed cache so active sessions track WAL growth while idle
// DBs skip reopening SQLite on every collector tick.

const fs = require('node:fs');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const META_CACHE_MAX = 10_000;
const defaultMetaCache = new Map();
const MAX_TIMESTAMP_SECONDS = 10_000_000_000n; // ~year 2286 sanity cap

function cacheSetBounded(cache, key, value, maxEntries = META_CACHE_MAX) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function readVarint(buf, startOffset) {
  let result = 0n;
  let shift = 0n;
  let offset = startOffset;
  while (offset < buf.length && shift <= 63n) {
    const byte = buf[offset++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { ok: true, value: result, offset };
    shift += 7n;
  }
  return { ok: false, value: 0n, offset: buf.length };
}

function decodeProtoFields(rawBuffer) {
  if (!rawBuffer || rawBuffer.length === 0) return [];
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag.ok || tag.value === 0n) break;
    offset = tag.offset;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (!Number.isSafeInteger(field) || field <= 0) break;
    if (wireType === 0) {
      const val = readVarint(buf, offset);
      if (!val.ok) break;
      offset = val.offset;
      fields.push({ field, wireType, value: val.value });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      fields.push({ field, wireType, value: buf.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, offset);
      if (!len.ok || len.value > BigInt(buf.length - len.offset)) break;
      const byteLength = Number(len.value);
      offset = len.offset;
      fields.push({ field, wireType, value: buf.subarray(offset, offset + byteLength) });
      offset += byteLength;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      fields.push({ field, wireType, value: buf.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

function timestampMsFromProto(bytes) {
  if (!bytes || bytes.length === 0) return 0;
  const fields = decodeProtoFields(bytes);
  const secField = fields.find((entry) => entry.field === 1 && entry.wireType === 0);
  if (!secField) return 0;
  const seconds = secField.value;
  if (seconds <= 0n || seconds >= MAX_TIMESTAMP_SECONDS) return 0;
  const nanoField = fields.find((entry) => entry.field === 2 && entry.wireType === 0);
  const nanos = nanoField && nanoField.value >= 0n && nanoField.value < 1_000_000_000n
    ? Number(nanoField.value)
    : 0;
  const ms = Number(seconds) * 1000 + Math.trunc(nanos / 1_000_000);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function timestampIsoFromProto(bytes) {
  const ms = timestampMsFromProto(bytes);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

function workspacePathFromUri(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    return raw === '/' ? '' : raw;
  }
  if (!/^file:\/\//i.test(raw)) return '';
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return '';
  }
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch (_) {
    decoded = url.pathname;
  }
  if (!decoded || decoded === '/') return '';
  // Windows file:///C:/path encodes a leading slash before the drive letter.
  if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
  if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
    return `//${url.hostname}${decoded}`;
  }
  return decoded;
}

function isSafeSessionId(sessionId) {
  const id = String(sessionId || '');
  return Boolean(id) && !id.includes('/') && !id.includes('\\') && !id.includes('..') && !id.includes('\0');
}

function statSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.size}:${st.mtimeMs}`;
  } catch (_) {
    return '';
  }
}

function readDbMeta(dbPath, sqliteMod) {
  let db;
  try {
    db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 250');

    let startedAtMs = 0;
    let projectPath = '';
    try {
      const metaRow = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
      if (metaRow?.data) {
        const metaFields = decodeProtoFields(metaRow.data);
        for (const wsEntry of metaFields) {
          if (wsEntry.field !== 1 || wsEntry.wireType !== 2) continue;
          const wsFields = decodeProtoFields(wsEntry.value);
          const uriEntry = wsFields.find((entry) => entry.field === 1 && entry.wireType === 2);
          if (!uriEntry) continue;
          const candidate = workspacePathFromUri(Buffer.from(uriEntry.value).toString('utf8'));
          if (candidate) {
            projectPath = candidate;
            break;
          }
        }
        const createdEntry = metaFields.find((entry) => entry.field === 2 && entry.wireType === 2);
        if (createdEntry) startedAtMs = timestampMsFromProto(createdEntry.value);
      }
    } catch (_) { /* table absent or unreadable */ }

    let latestStepMs = 0;
    try {
      const stepRows = db.prepare(
        'SELECT metadata FROM steps WHERE metadata IS NOT NULL ORDER BY rowid DESC LIMIT 32'
      ).all();
      for (const row of stepRows) {
        if (!row?.metadata) continue;
        const stepFields = decodeProtoFields(row.metadata);
        const tsEntry = stepFields.find((entry) => entry.field === 1 && entry.wireType === 2);
        if (!tsEntry) continue;
        const ms = timestampMsFromProto(tsEntry.value);
        if (ms > latestStepMs) latestStepMs = ms;
      }
      if (!startedAtMs) {
        const firstStep = db.prepare(
          'SELECT metadata FROM steps WHERE metadata IS NOT NULL ORDER BY rowid ASC LIMIT 1'
        ).get();
        if (firstStep?.metadata) {
          const tsEntry = decodeProtoFields(firstStep.metadata).find((entry) => entry.field === 1 && entry.wireType === 2);
          if (tsEntry) startedAtMs = timestampMsFromProto(tsEntry.value);
        }
      }
    } catch (_) { /* steps table absent or unreadable */ }

    const lastUsedAtMs = Math.max(startedAtMs, latestStepMs);
    if (!startedAtMs && !lastUsedAtMs && !projectPath) return null;
    const effectiveStartMs = startedAtMs || lastUsedAtMs;
    const effectiveEndMs = lastUsedAtMs || effectiveStartMs;
    return {
      ...(effectiveStartMs > 0 ? { startedAt: new Date(effectiveStartMs).toISOString() } : {}),
      ...(effectiveEndMs > 0 ? { lastUsedAt: new Date(effectiveEndMs).toISOString() } : {}),
      ...(projectPath ? { projectPath } : {})
    };
  } catch (_) {
    return null;
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
  }
}

function readSessionMeta(sessionIds, conversationsDir, deps = {}) {
  const out = new Map();
  const ids = Array.from(sessionIds || []).filter(isSafeSessionId);
  if (ids.length === 0 || !conversationsDir) return out;
  const sqliteMod = deps.sqlite !== undefined ? deps.sqlite : sqlite;

  const cache = deps.metaCache || defaultMetaCache;
  for (const sessionId of ids) {
    const dbPath = path.join(conversationsDir, `${sessionId}.db`);
    const dbSig = statSignature(dbPath);
    if (!dbSig) continue;
    // Active Antigravity sessions append turns to SQLite WAL before checkpoint.
    const cacheKey = `${dbSig}|${statSignature(`${dbPath}-wal`)}`;
    const cached = cache.get(dbPath);
    if (cached && cached.key === cacheKey) {
      cacheSetBounded(cache, dbPath, cached);
      if (cached.value) out.set(sessionId, cached.value);
      continue;
    }
    if (!sqliteMod) continue;
    const meta = readDbMeta(dbPath, sqliteMod);
    cacheSetBounded(cache, dbPath, { key: cacheKey, value: meta });
    if (meta) out.set(sessionId, meta);
  }
  return out;
}

module.exports = {
  decodeProtoFields,
  readSessionMeta,
  timestampIsoFromProto,
  workspacePathFromUri
};
