'use strict';

const { sessionTokenFromRequest } = require('./hubSessions');

// 计然 / Jiran has one operator. `AUTHENTICATED_SCOPE` is an internal route
// guard, not a user role or a permission level.
const AUTHENTICATED_SCOPE = 'authenticated';

function normalizedSecret(value) {
  return String(value || '').trim();
}

// Portable constant-time comparison for Hub runtimes. Secrets are
// high-entropy operator-generated values; comparing the complete byte sequence
// avoids the early-exit timing leak of ordinary string equality.
function secretMatches(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(normalizedSecret(left));
  const b = encoder.encode(normalizedSecret(right));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index % (a.length || 1)] || 0) ^ (b[index % (b.length || 1)] || 0);
  }
  return mismatch === 0 && a.length > 0;
}

function requestCredential(request) {
  const headers = request?.headers;
  const header = (name) => {
    if (typeof headers?.get === 'function') return headers.get(name);
    return headers?.[name] ?? headers?.[name.toLowerCase()];
  };
  const authorization = String(header('authorization') || '');
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return { secret: authorization.slice(7).trim(), source: 'authorization' };
  }
  // x-jiran-secret is canonical; the historical x-token-monitor-secret stays accepted so
  // devices that predate the 计然 / Jiran rename keep authenticating against a renamed Hub.
  const explicit = normalizedSecret(header('x-jiran-secret') || header('x-token-monitor-secret'));
  if (explicit) return { secret: explicit, source: 'header' };
  try {
    const query = new URL(String(request?.url || ''), 'http://localhost').searchParams.get('secret');
    return { secret: normalizedSecret(query), source: query ? 'query' : 'none' };
  } catch (_) {
    return { secret: '', source: 'none' };
  }
}

// Kept as a parser for migration diagnostics. These entries are never treated
// as separate principals and never grant access by themselves.
function ingestCredentialEntries(value) {
  if (!value) return [];
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch (error) {
      const wrapped = new Error(`JIRAN_INGEST_CREDENTIALS (or TOKEN_MONITOR_INGEST_CREDENTIALS) must be valid JSON: ${error.message}`);
      wrapped.code = 'invalid_ingest_credentials';
      throw wrapped;
    }
  }
  const entries = Array.isArray(parsed)
    ? parsed.map((item) => [item?.deviceId, item?.secret])
    : Object.entries(parsed && typeof parsed === 'object' ? parsed : {});
  return Object.freeze(entries.map(([deviceId, secret]) => Object.freeze({
    deviceId: String(deviceId || '').trim(),
    secret: normalizedSecret(secret)
  })));
}

function createHubAuthPolicy(options = {}) {
  const ownerSecret = normalizedSecret(
    options.ownerSecret || options.unifiedSecret || options.adminSecret || options.legacySecret
  );
  const deprecatedViewerSecret = normalizedSecret(options.viewerSecret);
  const deprecatedIngestCredentials = ingestCredentialEntries(options.ingestCredentials);
  const resolveSession = typeof options.resolveSession === 'function' ? options.resolveSession : null;
  const configured = Boolean(ownerSecret);
  if (!ownerSecret && (deprecatedViewerSecret || deprecatedIngestCredentials.length)) {
    const error = new Error('JIRAN_SECRET (or legacy TOKEN_MONITOR_SECRET) is required; viewer/device credentials are no longer supported');
    error.code = 'owner_secret_required';
    throw error;
  }

  function authorize(request, scope) {
    if (scope !== AUTHENTICATED_SCOPE) throw new Error(`unknown Hub authorization scope: ${scope}`);
    if (!configured) return { ok: true, principal: { id: 'local-owner', authenticated: true } };
    // Device sessions are checked first. They are opaque, revocable bearer
    // credentials; the owner secret remains accepted for provisioning and for
    // clients that have not migrated yet.
    const sessionToken = sessionTokenFromRequest(request);
    if (sessionToken && resolveSession) {
      const session = resolveSession(sessionToken);
      if (session) {
        return {
          ok: true,
          principal: { id: 'owner', authenticated: true, session }
        };
      }
    }
    const credential = requestCredential(request);
    // Secrets in URLs are removed from the single-owner protocol. They are
    // routinely copied into browser/proxy logs and cannot be made safe by
    // assigning them a weaker role.
    if (credential.source === 'query' || !credential.secret) {
      return { ok: false, status: 401, error: 'unauthorized' };
    }
    if (!secretMatches(credential.secret, ownerSecret)) {
      return { ok: false, status: 401, error: 'unauthorized' };
    }
    return { ok: true, principal: { id: 'owner', authenticated: true } };
  }

  return Object.freeze({
    authorize,
    configured,
    secretRequired: configured,
    summary: Object.freeze({ ownerConfigured: configured, sessionAuth: configured })
  });
}

module.exports = {
  AUTHENTICATED_SCOPE,
  createHubAuthPolicy,
  ingestCredentialEntries,
  requestCredential,
  secretMatches
};
