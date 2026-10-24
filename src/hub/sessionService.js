'use strict';

const crypto = require('node:crypto');
const {
  SESSION_TOKEN_PREFIX,
  clearSessionCookies,
  createSessionCookie,
  sessionSecretFingerprint,
  sessionTokenHash
} = require('../shared/hubSessions');

// Writing last_seen_at on every request turns a passive dashboard into a
// constant MySQL writer. Five minutes is fine-grained enough for the device
// list and keeps both the memory update and the database write bounded.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function newSessionToken() {
  return `${SESSION_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function newSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function publicSession(row, currentId = '') {
  if (!row) return null;
  return {
    id: row.sessionId,
    deviceName: row.deviceName || '',
    platform: row.platform || '',
    createdAt: row.createdAt || null,
    lastSeenAt: row.lastSeenAt || null,
    expiresAt: row.expiresAt || null,
    current: Boolean(currentId && row.sessionId === currentId)
  };
}

function createHubSessionService({
  store,
  ownerSecret,
  idleDays = 0,
  now = Date.now,
  logger = console
} = {}) {
  const secret = String(ownerSecret || '').trim();
  const configured = Boolean(secret);
  const secretFingerprint = configured ? sessionSecretFingerprint(secret) : '';
  const parsedIdleDays = Math.max(0, Number(idleDays) || 0);
  const idleMs = parsedIdleDays > 0 ? parsedIdleDays * DAY_MS : 0;
  const byHash = new Map();
  const byId = new Map();
  const touchWrites = new Set();
  let loaded = false;
  let loadPromise = null;

  function expiresAtFrom(at) {
    return idleMs > 0 ? iso(at + idleMs) : null;
  }

  function isValid(row, at = now()) {
    if (!row || row.revokedAt) return false;
    if (row.secretFingerprint !== secretFingerprint) return false;
    if (row.expiresAt && Date.parse(row.expiresAt) <= at) return false;
    return true;
  }

  function remember(row) {
    byHash.set(row.tokenHash, row);
    byId.set(row.sessionId, row);
  }

  function forget(row) {
    if (!row) return;
    byHash.delete(row.tokenHash);
    byId.delete(row.sessionId);
  }

  async function revokeRow(row, reason = '') {
    if (!row) return false;
    await store.revokeHubSession(row.sessionId);
    row.revokedAt = iso(now());
    forget(row);
    if (reason) logger.info?.(`[hub-session] revoked ${row.sessionId} (${reason})`);
    return true;
  }

  async function load() {
    if (!configured) {
      loaded = true;
      return;
    }
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const rows = typeof store.loadActiveHubSessions === 'function'
        ? await store.loadActiveHubSessions()
        : await store.listHubSessions();
      const at = now();
      byHash.clear();
      byId.clear();
      for (const row of rows) {
        if (row.revokedAt) continue;
        // A changed JIRAN_SECRET invalidates every old session. Revoking the row
        // in the database (rather than only skipping it in memory) means changing
        // the secret back cannot resurrect credentials issued under the old one.
        if (row.secretFingerprint !== secretFingerprint) {
          await store.revokeHubSession(row.sessionId).catch(() => {});
          continue;
        }
        if (row.expiresAt && Date.parse(row.expiresAt) <= at) {
          await store.revokeHubSession(row.sessionId).catch(() => {});
          continue;
        }
        remember(row);
      }
      loaded = true;
    })().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  async function create({ deviceName = '', platform = '', userAgent = '', persistent = true } = {}) {
    if (!configured) {
      const error = new Error('Hub session authentication is unavailable');
      error.code = 'session_auth_unavailable';
      throw error;
    }
    const at = now();
    const token = newSessionToken();
    const row = {
      sessionId: newSessionId(),
      tokenHash: sessionTokenHash(token),
      secretFingerprint,
      deviceName: cleanText(deviceName, 128),
      platform: cleanText(platform, 32),
      userAgent: cleanText(userAgent, 255),
      persistent: persistent !== false,
      createdAt: iso(at),
      lastSeenAt: iso(at),
      expiresAt: expiresAtFrom(at),
      revokedAt: null
    };
    await store.createHubSession(row);
    remember(row);
    return { token, session: publicSession(row, row.sessionId) };
  }

  function touch(row) {
    const at = now();
    const previous = Date.parse(row.lastSeenAt) || 0;
    if (at - previous < TOUCH_INTERVAL_MS) return;
    row.lastSeenAt = iso(at);
    if (idleMs > 0) row.expiresAt = expiresAtFrom(at);
    if (touchWrites.has(row.sessionId)) return;
    touchWrites.add(row.sessionId);
    Promise.resolve()
      .then(() => store.touchHubSession(row.sessionId, {
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt
      }))
      .catch((error) => {
        logger.warn?.(`[hub-session] could not update last-seen for ${row.sessionId}: ${error?.message || error}`);
      })
      .finally(() => touchWrites.delete(row.sessionId));
  }

  /** Synchronous lookup used by the route guard. */
  function resolve(token) {
    if (!configured || !loaded) return null;
    const hash = sessionTokenHash(token);
    const row = byHash.get(hash);
    if (!row) return null;
    const at = now();
    if (!isValid(row, at)) {
      forget(row);
      if (!row.revokedAt) {
        row.revokedAt = iso(at);
        void store.revokeHubSession(row.sessionId).catch((error) => {
          logger.warn?.(`[hub-session] could not revoke expired ${row.sessionId}: ${error?.message || error}`);
        });
      }
      return null;
    }
    touch(row);
    return row;
  }

  function list(currentId = '') {
    const at = now();
    const active = [];
    for (const row of byId.values()) {
      if (isValid(row, at)) active.push(row);
      else forget(row);
    }
    return active
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
      .map((row) => publicSession(row, currentId));
  }

  async function revoke(sessionId) {
    const row = byId.get(String(sessionId || ''));
    if (!row) return null;
    await revokeRow(row, 'manual');
    return publicSession(row);
  }

  async function revokeToken(token) {
    const row = byHash.get(sessionTokenHash(token));
    if (!row) return null;
    await revokeRow(row, 'logout');
    return publicSession(row);
  }

  async function revokeAll() {
    await store.revokeAllHubSessions();
    const at = iso(now());
    for (const row of byId.values()) row.revokedAt = at;
    byHash.clear();
    byId.clear();
  }

  function cookieHeader(token, { secure = false, remember = true } = {}) {
    return createSessionCookie(token, { secure, remember });
  }

  function clearCookieHeader({ secure = false } = {}) {
    return clearSessionCookies({ secure });
  }

  return {
    clearCookieHeader,
    configured,
    cookieHeader,
    create,
    idleDays: parsedIdleDays,
    list,
    load,
    publicSession,
    resolve,
    revoke,
    revokeAll,
    revokeToken,
    secretFingerprint
  };
}

module.exports = { createHubSessionService, publicSession };
