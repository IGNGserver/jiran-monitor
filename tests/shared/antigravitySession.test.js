'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const {
  decodeProtoFields,
  readSessionMeta,
  timestampIsoFromProto,
  workspacePathFromUri
} = require('../../src/shared/antigravitySession');
const { sessionTimestampMap } = require('../../src/shared/collector');

const maybe = sqlite ? test : test.skip;

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agy-session-'));
  tmpDirs.push(dir);
  return dir;
}

function encodeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeBytesField(fieldNumber, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(buf.length), buf]);
}

function encodeVarintField(fieldNumber, value) {
  return Buffer.concat([encodeVarint(fieldNumber << 3), encodeVarint(value)]);
}

function encodeTimestamp(isoString) {
  const ms = Date.parse(isoString);
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1_000_000;
  return Buffer.concat([
    encodeVarintField(1, seconds),
    ...(nanos > 0 ? [encodeVarintField(2, nanos)] : [])
  ]);
}

function encodeTrajectoryMeta({ workspaceUri, createdAt }) {
  const parts = [];
  if (workspaceUri) parts.push(encodeBytesField(1, encodeBytesField(1, workspaceUri)));
  if (createdAt) parts.push(encodeBytesField(2, encodeTimestamp(createdAt)));
  return Buffer.concat(parts);
}

function encodeStepMeta(timestampIso) {
  return encodeBytesField(1, encodeTimestamp(timestampIso));
}

test('protobuf wire decoder and URI normalizer handle edge cases safely', () => {
  const iso = '2026-11-14T10:15:30.250Z';
  const raw = encodeTrajectoryMeta({ workspaceUri: 'file:///Users/lvziw/dev/token%E8%AE%B0%E5%BD%95%E7%B3%BB%E7%BB%9F', createdAt: iso });
  const fields = decodeProtoFields(new Uint8Array(raw));
  assert.equal(fields.length, 2);
  assert.equal(timestampIsoFromProto(fields[1].value), iso);

  assert.equal(timestampIsoFromProto(Buffer.alloc(0)), '');
  assert.equal(timestampIsoFromProto(encodeVarintField(1, 0)), '');
  assert.deepEqual(decodeProtoFields(Buffer.from([0x0a, 0x7f])), []);

  assert.equal(workspacePathFromUri('file:///Users/lvziw/dev/my%20repo'), '/Users/lvziw/dev/my repo');
  assert.equal(workspacePathFromUri('file:///C:/Users/dev/app'), 'C:/Users/dev/app');
  assert.equal(workspacePathFromUri('file://nas/share/repo'), '//nas/share/repo');
  assert.equal(workspacePathFromUri('file:///'), '');
  assert.equal(workspacePathFromUri('/'), '');
  assert.equal(workspacePathFromUri('https://example.com/repo'), '');
});

maybe('readSessionMeta decodes workspace/timestamps and invalidates cache on uncheckpointed WAL writes', () => {
  const dir = makeTmpDir();
  const cache = new Map();
  const dbPath = path.join(dir, 'sess-1.db');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE trajectory_metadata_blob (data BLOB);');
  db.exec('CREATE TABLE steps (metadata BLOB);');
  const tStart = '2026-11-14T08:00:00.000Z';
  const tStep1 = '2026-11-14T08:05:00.000Z';
  const tStep2 = '2026-11-14T08:20:00.500Z';
  db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(
    encodeTrajectoryMeta({ workspaceUri: 'file:///Users/lvziw/dev/jiran-repo', createdAt: tStart })
  );
  db.prepare('INSERT INTO steps (metadata) VALUES (?)').run(encodeStepMeta(tStep1));

  // Keep `db` open without checkpointing so tStep1 lives in -wal (active session shape).
  try {
    const first = readSessionMeta(['sess-1', '../escape', 'missing-db'], dir, { metaCache: cache });
    assert.deepEqual(first.get('sess-1'), {
      startedAt: tStart,
      lastUsedAt: tStep1,
      projectPath: '/Users/lvziw/dev/jiran-repo'
    });
    assert.equal(first.has('../escape'), false);
    assert.equal(first.has('missing-db'), false);
    assert.ok(cache.has(dbPath));

    // Appending a newer step through the open writer grows -wal without rewriting .db.
    db.prepare('INSERT INTO steps (metadata) VALUES (?)').run(encodeStepMeta(tStep2));
    const updated = readSessionMeta(['sess-1'], dir, { metaCache: cache });
    assert.deepEqual(updated.get('sess-1'), {
      startedAt: tStart,
      lastUsedAt: tStep2,
      projectPath: '/Users/lvziw/dev/jiran-repo'
    });

    // When neither .db nor -wal changes, the bounded cache entry is reused even without sqlite.
    const cachedOnly = readSessionMeta(['sess-1'], dir, { metaCache: cache, sqlite: null });
    assert.equal(cachedOnly.get('sess-1')?.lastUsedAt, tStep2);
  } finally {
    db.close();
  }

  // Root-only workspace URI (`file:///`) skips projectPath while keeping timestamps.
  const barePath = path.join(dir, 'sess-bare.db');
  const bareDb = new sqlite.DatabaseSync(barePath);
  bareDb.exec('CREATE TABLE trajectory_metadata_blob (data BLOB); CREATE TABLE steps (metadata BLOB);');
  bareDb.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(
    encodeTrajectoryMeta({ workspaceUri: 'file:///', createdAt: tStart })
  );
  bareDb.close();
  const bareMeta = readSessionMeta(['sess-bare'], dir, { metaCache: new Map() }).get('sess-bare');
  assert.deepEqual(bareMeta, { startedAt: tStart, lastUsedAt: tStart });
});

maybe('sessionTimestampMap populates antigravity project and timestamps and stays retryable until DB exists', () => {
  const home = makeTmpDir();
  const conversationsDir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  const cache = new Map();
  const attempted = new Set();
  const resolved = new Set();
  const periods = {
    today: {
      sessions: {
        'antigravity:agy-live': { client: 'antigravity', sessionId: 'agy-live', totalTokens: 100 }
      }
    }
  };

  // Before the SQLite DB is flushed to disk, antigravity must not be marked permanently resolved.
  const empty = sessionTimestampMap(periods, home, {
    scopedHome: true,
    attemptedSessionKeys: attempted,
    resolvedSessionKeys: resolved,
    antigravityDeps: { metaCache: cache }
  });
  assert.equal(empty.has('antigravity:agy-live'), false);
  assert.equal(resolved.has('antigravity:agy-live'), false);

  const db = new sqlite.DatabaseSync(path.join(conversationsDir, 'agy-live.db'));
  db.exec('CREATE TABLE trajectory_metadata_blob (data BLOB); CREATE TABLE steps (metadata BLOB);');
  db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(
    encodeTrajectoryMeta({
      workspaceUri: 'file:///Users/lvziw/dev/token%E8%AE%B0%E5%BD%95%E7%B3%BB%E7%BB%9F',
      createdAt: '2026-11-14T09:00:00.000Z'
    })
  );
  db.prepare('INSERT INTO steps (metadata) VALUES (?)').run(encodeStepMeta('2026-11-14T09:30:00.000Z'));
  db.close();

  const populated = sessionTimestampMap(periods, home, {
    scopedHome: true,
    retryMisses: true,
    attemptedSessionKeys: attempted,
    resolvedSessionKeys: resolved,
    antigravityDeps: { metaCache: cache }
  });
  const entry = populated.get('antigravity:agy-live');
  assert.equal(entry?.startedAt, '2026-11-14T09:00:00.000Z');
  assert.equal(entry?.lastUsedAt, '2026-11-14T09:30:00.000Z');
  assert.equal(entry?.projectLabel, 'token记录系统');
  assert.ok(entry?.projectId);
});
