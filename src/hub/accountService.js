'use strict';

const crypto = require('node:crypto');
const { encryptCredential, decryptCredential } = require('./accountCrypto');
const { LIMIT_PROVIDER_IDS } = require('../shared/limitProviders');
const { normalizeLimitProvider, normalizeLimitsSummary } = require('../shared/limits');
const { HUB_MANUAL_PROVIDER_IDS } = require('../shared/limitProviderSources');
const { probeLimitProvider } = require('../shared/limitCollector');
const { refreshOAuthToken, credentialWithOAuthTokens } = require('./oauthService');
const { createMimoManagedAccount } = require('../shared/mimoLimits');
const {
  hostnameIsNonPublic,
  normalizeThirdPartyBaseUrl
} = require('../shared/thirdPartyLimits');
const { runWithProbeDeadline } = require('../shared/probeDeadline');
const { createOutboundFetch } = require('../shared/outboundFetch');

const MAX_ACCOUNT_NAME_LENGTH = 128;
const MAX_ACCOUNT_LABEL_LENGTH = 256;
const MAX_CREDENTIAL_BYTES = 128 * 1024;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;
const MAX_RUNTIME_ACCOUNTS = 128;
const MAX_QUEUED_PROBES = 256;

// Hard ceiling for one provider probe on the Hub. Some fetchers (openrouter,
// thirdparty, opencode) rely solely on the caller's signal, so without this they
// are bounded only by undici's 300 s *inactivity* timeouts — which a peer that
// trickles bytes can defeat indefinitely. A probe that never settles holds the
// refresh latch below and silently stops every account's limit refresh until the
// process is restarted.
const DEFAULT_PROBE_DEADLINE_MS = 60 * 1000;

// These providers already accept an explicit API key, Cookie, or profile. The
// remaining providers currently depend on a local CLI, browser profile, or OS
// credential store and must not silently fall back to those sources on the Hub.
const HUB_MANUAL_PROVIDERS = HUB_MANUAL_PROVIDER_IDS;

function cleanText(value, maxLength = 512) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function accountId(value) {
  const text = cleanText(value, 128);
  return text || crypto.randomUUID();
}

function providerId(value) {
  const provider = cleanText(value, 64).toLowerCase();
  if (!LIMIT_PROVIDER_IDS.includes(provider)) {
    const error = new Error('Unsupported limit provider');
    error.code = 'provider_unsupported';
    throw error;
  }
  if (!HUB_MANUAL_PROVIDERS.has(provider)) {
    const error = new Error(`Provider ${provider} has no Hub-side manual login adapter yet`);
    error.code = 'provider_manual_login_unavailable';
    throw error;
  }
  return provider;
}

function credentialObject(input) {
  let value = input;
  if (typeof value === 'string') value = { value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('credential must be an object or string');
    error.code = 'credential_required';
    throw error;
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CREDENTIAL_BYTES) {
    const error = new Error('credential is too large');
    error.code = 'credential_too_large';
    throw error;
  }
  return value;
}

function field(credential, ...names) {
  for (const name of names) {
    if (credential[name] !== undefined && credential[name] !== null) return credential[name];
    if (credential.fields && credential.fields[name] !== undefined && credential.fields[name] !== null) {
      return credential.fields[name];
    }
  }
  return '';
}

const SAFE_CREDENTIAL_METADATA_FIELDS = [
  'site',
  'region',
  'organizationId',
  'projectId',
  'adapter',
  'baseUrl',
  'enterpriseHost',
  'endpoint',
  'accountId',
  'accessKeyId'
];

// Keys that describe provenance or scheduling rather than a usable secret. A
// credential holding only these is "cleared": there is nothing left to probe.
const CREDENTIAL_BOOKKEEPING_FIELDS = new Set(['source', 'expiresAt', 'expires_at']);

function hasUsableCredentialValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasUsableCredentialValue);
  if (typeof value === 'object') {
    return Object.entries(value).some(([key, nested]) => (
      !CREDENTIAL_BOOKKEEPING_FIELDS.has(key) && hasUsableCredentialValue(nested)
    ));
  }
  return false;
}

/**
 * Whether a stored credential still carries something usable.
 *
 * The Hub never returns credential material, so a client cannot tell "has a
 * token" from "was cleared" on its own. This boolean is the minimum the UI needs
 * to show "filled in" vs "authorize again"; it is derived from the decrypted
 * credential and never exposes a value.
 */
function credentialIsConfigured(credential) {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return false;
  return hasUsableCredentialValue(credential);
}

function credentialMetadata(credential) {
  const profile = credential?.profile && typeof credential.profile === 'object'
    ? credential.profile
    : null;
  const metadata = {};
  for (const name of SAFE_CREDENTIAL_METADATA_FIELDS) {
    const direct = field(credential, name);
    const value = direct === '' && profile ? field(profile, name) : direct;
    if (value === '' || value === null || value === undefined || typeof value === 'object') continue;
    metadata[name] = cleanText(value, 512);
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function mergeCredential(existingCredential, incomingCredential, provider) {
  if (provider !== 'thirdparty') return { ...existingCredential, ...incomingCredential };
  const existingProfile = existingCredential?.profile && typeof existingCredential.profile === 'object'
    ? existingCredential.profile
    : null;
  if (!existingProfile) return { ...existingCredential, ...incomingCredential };
  const incomingProfile = incomingCredential?.profile && typeof incomingCredential.profile === 'object'
    ? incomingCredential.profile
    : incomingCredential;
  return {
    ...existingCredential,
    profile: { ...existingProfile, ...incomingProfile }
  };
}

function validateHubThirdPartyCredential(credential) {
  const profile = credential?.profile && typeof credential.profile === 'object'
    ? credential.profile
    : credential;
  const normalized = normalizeThirdPartyBaseUrl(profile?.baseUrl, {
    stripTerminalV1: profile?.adapter !== 'custom'
  });
  let parsed;
  try { parsed = new URL(normalized); } catch (_) { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:' || hostnameIsNonPublic(parsed.hostname)) {
    const error = new Error('Hub third-party accounts require an HTTPS public endpoint');
    error.code = 'credential_invalid';
    throw error;
  }
}

function profileName(account) {
  return cleanText(account.name || account.label || account.id || 'hub-account', 128) || 'hub-account';
}

function providerOptions(account, credential) {
  const name = profileName(account);
  const cookie = field(credential, 'cookie', 'cookieHeader', 'value');
  const apiKey = field(credential, 'apiKey', 'key', 'value');
  const accessToken = field(credential, 'accessToken', 'token', 'value');
  const options = {
    limitProviders: account.provider,
    limitProviderAuthority: 'hub',
    limitProviderAutoDetectDisabled: account.provider,
    suppressAutoDetectedAccounts: true,
    opencodeAmbientEnabled: false,
    opencodeLocalLimitsEnabled: false
  };
  switch (account.provider) {
    // Claude accepts either a web session cookie (fragile: Cloudflare-gated and
    // short-lived) or an OAuth access/refresh pair. OAuth is strongly preferred
    // because the collector already implements refresh_token renewal, so an
    // account configured this way keeps working without the user re-pasting.
    // Gemini Code Assist uses an OAuth access/refresh pair, like Codex.
    case 'gemini': return {
      ...options,
      geminiAccessToken: String(accessToken || '').trim(),
      geminiRefreshToken: field(credential, 'refreshToken', 'refresh_token'),
      geminiAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
    };
    // Kilo Code bills through its own app tRPC endpoint with a Bearer key.
    case 'kilocode': return {
      ...options,
      kiloApiKey: String(apiKey || accessToken || '').trim(),
      kiloAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
    };
    // ClinePass takes a Bearer API key from app.cline.bot.
    case 'cline': return {
      ...options,
      clineApiKey: String(apiKey || accessToken || '').trim(),
      clineAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
    };
    // Droid (Factory) takes a WorkOS access token, optionally paired with a
    // refresh token so the Hub can renew it instead of expiring every ~7 days.
    case 'droid': return {
      ...options,
      factoryApiKey: String(accessToken || apiKey || '').trim(),
      factoryRefreshToken: field(credential, 'refreshToken', 'refresh_token'),
      factoryAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
    };
    // Warp bills over GraphQL: a `wk-` API key, or a raw Cookie header.
    case 'warp': return {
      ...options,
      warpApiKey: String(apiKey || cookie || accessToken || '').trim(),
      warpAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
    };
    // Grok bills with a bearer token (the value its CLI stores under
    // ~/.grok/auth.json as `key`).
    case 'grok': return {
      ...options,
      grokBearerToken: String(accessToken || apiKey || cookie || '').trim(),
      grokAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
    };
    // Cursor needs only the pasted WorkosCursorSessionToken; the probe is HTTP-only.
    case 'cursor': return {
      ...options,
      cursorSessionToken: String(cookie || accessToken || '').trim(),
      cursorManualAccountConfigured: true,
      cursorAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
    };
    case 'claude': return {
      ...options,
      claudeWebCookie: cookie,
      claudeAccessToken: accessToken,
      claudeRefreshToken: field(credential, 'refreshToken', 'refresh_token'),
      claudeExpiresAt: field(credential, 'expiresAt', 'expires_at'),
      claudeAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
    };
    case 'codex': {
      const authJson = credential.authJson || (credential.tokens ? credential : null);
      const codexAccessToken = accessToken || field(credential, 'access_token');
      const codexAccountId = field(credential, 'account_id', 'accountId');
      return {
        ...options,
        codexAuthJson: authJson,
        codexAccessToken,
        codexAccountId,
        codexAccountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
      };
    }
    case 'antigravity': {
      const antigravityAccessToken = field(credential, 'accessToken', 'access_token');
      if (antigravityAccessToken) {
        return {
          ...options,
          antigravityAccessToken,
          antigravityRefreshToken: field(credential, 'refreshToken', 'refresh_token'),
          antigravityIdToken: field(credential, 'idToken', 'id_token'),
          antigravityProjectId: field(credential, 'projectId', 'project'),
          antigravityAccountEmail: field(credential, 'accountEmail', 'email')
        };
      }
      const antigravityEndpoint = field(credential, 'endpoint', 'url') || 'http://127.0.0.1:0';
      const antigravityCsrfToken = field(credential, 'csrfToken', 'token', 'csrf');
      return {
        ...options,
        antigravityEndpoint,
        antigravityCsrfToken
      };
    }
    case 'opencode':
      return {
        ...options,
        opencodeCookie: field(credential, 'cookie', 'cookieHeader'),
        opencodeProfiles: {
          [name]: {
            cookie: field(credential, 'cookie', 'cookieHeader'),
            apiKey: field(credential, 'apiKey', 'key'),
            enabled: true
          }
        }
      };
    case 'openrouter':
      return { ...options, openrouterProfiles: { [name]: { apiKey, enabled: true } } };
    case 'deepseek': return { ...options, deepseekApiKey: apiKey };
    case 'minimax': return { ...options, minimaxApiKey: apiKey };
    case 'mimo': {
      const created = createMimoManagedAccount(cookie, []);
      if (!created.ok) {
        const error = new Error('Invalid MiMo credential');
        error.code = 'credential_invalid';
        throw error;
      }
      return {
        ...options,
        mimoManagedAccounts: [{
          ...created.account,
          id: account.id,
          accountLabel: cleanText(account.label, MAX_ACCOUNT_LABEL_LENGTH)
        }]
      };
    }
    case 'copilot': return { ...options, copilotApiToken: accessToken, copilotEnterpriseHost: field(credential, 'enterpriseHost', 'host') };
    case 'zai': return { ...options, zaiApiKey: apiKey, zaiApiRegion: field(credential, 'region') || 'global' };
    case 'zaiteam':
      return {
        ...options,
        zaiTeamApiKey: apiKey,
        zaiTeamOrganizationId: field(credential, 'organizationId', 'organization'),
        zaiTeamProjectId: field(credential, 'projectId', 'project')
      };
    case 'volcengine':
      return {
        ...options,
        volcengineAccessKeyId: field(credential, 'accessKeyId', 'accessKey'),
        volcengineSecretAccessKey: field(credential, 'secretAccessKey', 'secret'),
        volcengineApiKey: apiKey,
        volcengineRegion: field(credential, 'region')
      };
    case 'qoder':
      return { ...options, qoderCookie: cookie, qoderSite: field(credential, 'site') || 'global', qoderCookieMode: 'manual' };
    // The API key is the `cmd` CLI's own credential and the better one (it does
    // not expire like a session cookie); the pasted cookie stays supported for
    // accounts configured before it existed. The collector dispatches on which
    // one is present, so both are forwarded and neither is guessed at.
    case 'commandcode': return {
      ...options,
      commandcodeApiKey: String(apiKey || '').trim(),
      commandcodeCookie: cookie
    };
    case 'ollama': return { ...options, ollamaCookie: cookie };
    // Kimi accepts an API key (concurrency metrics) AND a web access token (the
    // 5-hour/weekly meters). The web token is short-lived, so a refresh token is
    // passed through to let the collector renew it instead of expiring.
    case 'kimi': return {
      ...options,
      kimiApiKey: apiKey,
      kimiWebAccessToken: accessToken,
      kimiRefreshToken: field(credential, 'refreshToken', 'refresh_token'),
      kimiExpiresAt: field(credential, 'expiresAt', 'expires_at')
    };
    case 'thirdparty': {
      const profile = credential.profile && typeof credential.profile === 'object'
        ? credential.profile
        : credential;
      return { ...options, thirdPartyProfiles: { [name]: { ...profile, enabled: true } } };
    }
    default: return options;
  }
}

function credentialRefreshToken(credential) {
  const direct = field(credential, 'refreshToken', 'refresh_token');
  if (direct) return String(direct).trim();
  let authJson = credential?.authJson;
  if (typeof authJson === 'string') {
    try { authJson = JSON.parse(authJson); } catch (_) { authJson = null; }
  }
  return String(authJson?.tokens?.refresh_token || authJson?.tokens?.refreshToken || '').trim();
}

function credentialExpiresAtMs(credential) {
  const raw = field(credential, 'expiresAt', 'expires_at');
  const number = Number(raw);
  if (Number.isFinite(number) && number > 0) return number < 20_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldRefreshOAuthCredential(provider, credential, nowMs) {
  if (!['codex', 'antigravity'].includes(provider) || !credentialRefreshToken(credential)) return false;
  const expiresAt = credentialExpiresAtMs(credential);
  return expiresAt !== null && expiresAt - nowMs <= 2 * 60 * 1000;
}

function publicAccount(account, snapshot = null) {
  const current = snapshot?.provider || null;
  return {
    id: account.id,
    provider: account.provider,
    name: account.name,
    label: account.label,
    accountKey: account.accountKey || current?.accountKey || '',
    accountEmail: account.accountEmail || current?.accountEmail || '',
    accountLabel: account.accountLabel || current?.accountLabel || '',
    enabled: account.enabled !== false,
    status: account.status || current?.status || 'notConfigured',
    lastErrorCode: account.lastErrorCode || '',
    lastErrorMessage: account.lastErrorMessage || '',
    lastAttemptAt: account.lastAttemptAt || null,
    lastSuccessAt: account.lastSuccessAt || null,
    nextRefreshAt: account.nextRefreshAt || null,
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
    limits: current
  };
}

function statusFromError(error) {
  const status = cleanText(error?.status || error?.code, 64);
  return ['unauthorized', 'rateLimited', 'sourceRateLimited', 'unavailable', 'notConfigured'].includes(status)
    ? status
    : 'error';
}

function errorMessage(error) {
  return cleanText(error?.message || 'limit refresh failed', 512)
    .replace(/cookie|token|secret|api[_ -]?key|authorization/gi, '[redacted]');
}

function rowsFromProbe(result) {
  return (Array.isArray(result) ? result : [result])
    .filter(Boolean)
    .map((row) => normalizeLimitProvider(row));
}

function createHubAccountService({
  store,
  credentialKey,
  refreshMs = DEFAULT_REFRESH_MS,
  concurrency = DEFAULT_CONCURRENCY,
  probe = probeLimitProvider,
  oauthFetch,
  logger = console,
  onUpdate = null,
  now = Date.now,
  probeDeadlineMs = DEFAULT_PROBE_DEADLINE_MS,
  refreshCeilingOverride = null
} = {}) {
  if (!store || typeof store.listHubAccounts !== 'function') {
    throw new TypeError('Hub account repository methods are required');
  }
  const intervalMs = Number.isFinite(Number(refreshMs)) && Number(refreshMs) > 0
    ? Number(refreshMs)
    : DEFAULT_REFRESH_MS;
  const maxConcurrency = Math.max(1, Math.min(32, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY)));
  const probeTimeoutMs = Number.isFinite(Number(probeDeadlineMs)) && Number(probeDeadlineMs) > 0
    ? Number(probeDeadlineMs)
    : DEFAULT_PROBE_DEADLINE_MS;
  let timer = null;
  let stopped = false;
  let refreshPromise = null;
  let refreshStartedAt = 0;
  const refreshFlights = new Map();
  const probeFlights = new Map();
  const tokenFlights = new Map();
  const runtimeAccounts = new Map();
  const probeQueue = [];
  let activeProbes = 0;
  const fetchProvider = oauthFetch || createOutboundFetch(process.env);

  function refreshCredential(provider, credential, deps) {
    const refreshToken = credentialRefreshToken(credential);
    const key = `${provider}:${crypto.createHash('sha256').update(refreshToken).digest('hex')}`;
    const existing = tokenFlights.get(key);
    const withCredential = (tokens) => ({ credential: credentialWithOAuthTokens(provider, credential, tokens), tokens });
    if (existing) return existing.promise.then(withCredential);
    const pending = new Set();
    const entry = { promise: refreshOAuthToken(provider, refreshToken, { ...deps, fetch: trackedFetch(deps.fetch, pending) }) };
    tokenFlights.set(key, entry);
    const cleanup = async () => {
      await Promise.allSettled([...pending]);
      if (tokenFlights.get(key) === entry) tokenFlights.delete(key);
    };
    void entry.promise.then(cleanup, cleanup);
    return entry.promise.then(withCredential);
  }

  function trackedFetch(fetch, pending, signal) {
    const track = (promise) => {
      const work = Promise.resolve(promise);
      pending.add(work);
      work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    };
    return async (...args) => {
      signal?.throwIfAborted();
      const response = await track(fetch(...args));
      if (signal?.aborted) {
        void response.body?.cancel?.().catch(() => {});
        signal.throwIfAborted();
      }
      // Inner HTTP helpers can race their own deadlines. The caller's physical
      // permit still owns the underlying headers AND body until they settle.
      return new Proxy(response, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (['json', 'text', 'arrayBuffer', 'blob', 'formData'].includes(property) && typeof value === 'function') {
            return (...params) => track(value.apply(target, params));
          }
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
  }

  function schedulingError(code) {
    return Object.assign(new Error(code), { code });
  }

  // A deadline releases the caller, NOT the physical concurrency permit. A
  // provider ignoring AbortSignal must never allow replacement work to pile up.
  function acquireProbe(signal) {
    if (stopped || signal.aborted) return Promise.reject(signal.reason || schedulingError('service_stopped'));
    if (activeProbes < maxConcurrency) {
      activeProbes += 1;
      return Promise.resolve(releaseProbe);
    }
    if (probeQueue.length >= MAX_QUEUED_PROBES) return Promise.reject(schedulingError('probe_queue_full'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: null };
      entry.abort = () => {
        const index = probeQueue.indexOf(entry);
        if (index >= 0) probeQueue.splice(index, 1);
        reject(signal.reason || schedulingError('service_stopped'));
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      probeQueue.push(entry);
    });
  }

  function releaseProbe() {
    activeProbes -= 1;
    while (probeQueue.length) {
      const entry = probeQueue.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      if (stopped || entry.signal.aborted) {
        entry.reject(entry.signal.reason || schedulingError('service_stopped'));
        continue;
      }
      activeProbes += 1;
      entry.resolve(releaseProbe);
      break;
    }
  }

  function credentialFingerprint(credential) {
    return crypto.createHash('sha256').update(JSON.stringify(credential)).digest('hex');
  }

  function runtimeFor(account, credential) {
    const fingerprint = credentialFingerprint(credential);
    let entry = runtimeAccounts.get(account.id);
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, providerRuntimeState: new Map(), failures: 0 };
    }
    runtimeAccounts.delete(account.id);
    runtimeAccounts.set(account.id, entry);
    while (runtimeAccounts.size > MAX_RUNTIME_ACCOUNTS) runtimeAccounts.delete(runtimeAccounts.keys().next().value);
    return entry;
  }

  function editTimestamp(account) {
    // updatedAt is the optimistic ownership token even when two edits happen in
    // the same millisecond (or the wall clock moves backwards).
    return new Date(Math.max(now(), (Date.parse(account.updatedAt) || 0) + 1)).toISOString();
  }

  function retryDelay(status, failures) {
    if (status === 'notConfigured') return Math.max(intervalMs, 6 * 60 * 60 * 1000);
    if (status === 'unauthorized') return Math.max(intervalMs, Math.min(6 * 60 * 60 * 1000, 30 * 60 * 1000 * 2 ** (failures - 1)));
    const base = ['rateLimited', 'sourceRateLimited'].includes(status) ? intervalMs * 2 : intervalMs;
    return Math.max(intervalMs, Math.min(60 * 60 * 1000, base * 2 ** Math.min(6, failures - 1)));
  }

  function scheduledLater(account, reason) {
    // Timers and repository reads can straddle the due millisecond. A tiny
    // tolerance avoids skipping a healthy account for an entire extra cycle.
    return ['interval', 'startup'].includes(reason)
      && Date.parse(account.nextRefreshAt) > now() + Math.min(1000, intervalMs * 0.01);
  }

  async function runTransaction(work) {
    if (typeof store.transaction === 'function') return store.transaction(work);
    return work(store);
  }

  async function accountWithSnapshot(id) {
    const account = await store.getHubAccount(id);
    if (!account) return null;
    const snapshot = typeof store.getHubAccountSnapshot === 'function'
      ? await store.getHubAccountSnapshot(id)
      : null;
    return { account, snapshot };
  }

  async function snapshotsFor(accounts) {
    const ids = accounts.map((account) => account.id);
    if (typeof store.listHubAccountSnapshots === 'function') {
      return store.listHubAccountSnapshots(ids);
    }
    const snapshots = new Map();
    for (const account of accounts) {
      const snapshot = typeof store.getHubAccountSnapshot === 'function'
        ? await store.getHubAccountSnapshot(account.id)
        : null;
      snapshots.set(account.id, snapshot);
    }
    return snapshots;
  }

  async function listAccounts({ includeCredentialMetadata = false } = {}) {
    const accounts = await store.listHubAccounts();
    const snapshots = await snapshotsFor(accounts);
    const result = [];
    for (const account of accounts) {
      const snapshot = snapshots.get(account.id) || null;
      let metadata = null;
      let credentialConfigured = null;
      if (includeCredentialMetadata) {
        try {
          const envelope = await store.getHubAccountCredential(account.id);
          const decrypted = decryptCredential(envelope, credentialKey);
          metadata = credentialMetadata(decrypted);
          credentialConfigured = credentialIsConfigured(decrypted);
        } catch (error) {
          logger.warn?.(`[hub-accounts] metadata unavailable for ${account.id}: ${error.message}`);
        }
      }
      const visible = publicAccount(account, snapshot);
      result.push({
        ...visible,
        ...(credentialConfigured === null ? {} : { credentialConfigured }),
        ...(metadata ? { credentialMetadata: metadata } : {})
      });
    }
    return result;
  }

  async function getLimitsSummary() {
    const accounts = await store.listHubAccounts();
    const snapshots = await snapshotsFor(accounts);
    const providers = [];
    for (const account of accounts) {
      const snapshot = snapshots.get(account.id) || null;
      if (snapshot?.provider) {
        providers.push({
          ...snapshot.provider,
          authority: 'hub',
          accountId: account.id,
          accountName: snapshot.provider.accountName || account.name || '',
          accountLabel: snapshot.provider.accountLabel || account.label || ''
        });
      }
    }
    return normalizeLimitsSummary({
      updatedAt: new Date(now()).toISOString(),
      refreshMs: intervalMs,
      providers
    });
  }

  async function probeAccountRaw(account, credential, signal, state, fetch) {
    if (account.provider === 'thirdparty') validateHubThirdPartyCredential(credential);
    const runtime = {
      env: Object.create(null),
      homeDir: '',
      platform: 'linux',
      signal,
      now,
      limitsRefreshMs: intervalMs,
      providerRuntimeState: state.providerRuntimeState
    };
    const checkAbort = () => signal.throwIfAborted();
    checkAbort();
    let activeCredential = credential;
    if (shouldRefreshOAuthCredential(account.provider, activeCredential, now())) {
      try {
        activeCredential = (await refreshCredential(account.provider, activeCredential, {
          fetch,
          now,
          signal
        })).credential;
      } catch (error) {
        checkAbort();
        logger.warn?.(`[hub-accounts] ${account.provider}/${account.id} proactive token refresh failed (${error.code || 'error'})`);
      }
    }

    const probeWith = async (candidate) => {
      checkAbort();
      const result = await probe(account.provider, providerOptions(account, candidate), {}, {
        fetch,
        ...runtime
      });
      checkAbort();
      return { candidate, rows: rowsFromProbe(result) };
    };
    let attempt = await probeWith(activeCredential);
    let usable = attempt.rows.find((row) => row.status === 'ok') || attempt.rows[0];
    if ((!usable || usable.status !== 'ok') && usable?.status === 'unauthorized' && credentialRefreshToken(activeCredential)) {
      try {
        const refreshed = await refreshCredential(account.provider, activeCredential, {
          fetch,
          now,
          signal
        });
        activeCredential = refreshed.credential;
        attempt = await probeWith(activeCredential);
        usable = attempt.rows.find((row) => row.status === 'ok') || attempt.rows[0];
      } catch (error) {
        checkAbort();
        logger.warn?.(`[hub-accounts] ${account.provider}/${account.id} token refresh failed (${error.code || 'error'})`);
      }
    }
    if (!usable || usable.status !== 'ok') {
      const error = new Error(`Provider validation failed: ${usable?.status || 'unavailable'}`);
      error.code = usable?.status || 'unavailable';
      error.providerRow = usable || null;
      throw error;
    }
    return { row: usable, credential: activeCredential };
  }

  function probeAccount(account, credential) {
    const key = JSON.stringify([account.id, account.updatedAt, account.name, account.label, credentialFingerprint(credential)]);
    const existing = probeFlights.get(key);
    if (existing) return existing.promise;
    const flight = {};
    probeFlights.set(key, flight);
    flight.promise = runWithProbeDeadline(async ({ signal }) => {
      let release;
      const pending = new Set();
      const fetch = trackedFetch(fetchProvider, pending, signal);
      try {
        release = await acquireProbe(signal);
        signal.throwIfAborted();
        return await probeAccountRaw(account, credential, signal, runtimeFor(account, credential), fetch);
      } finally {
        await Promise.allSettled([...pending]);
        release?.();
        if (probeFlights.get(key) === flight) probeFlights.delete(key);
      }
    }, { deadlineMs: probeTimeoutMs });
    return flight.promise;
  }

  async function refreshOwner(account, executor) {
    const current = typeof store.getHubAccountForUpdate === 'function'
      ? await store.getHubAccountForUpdate(account.id, executor)
      : await store.getHubAccount(account.id, executor);
    if (!current) return null;
    // User edits advance updatedAt. A refresh that started against an older
    // credential or enabled state must not write its late provider result over
    // that newer intent.
    if (account.updatedAt && current.updatedAt !== account.updatedAt) return null;
    if (current.enabled !== account.enabled) return null;
    return current;
  }

  async function refreshOne(id, reason = 'manual') {
    if (stopped) return null;
    const entry = await accountWithSnapshot(id);
    if (!entry || stopped) return null;
    const key = JSON.stringify([id, entry.account.updatedAt]);
    if (refreshFlights.has(key)) return refreshFlights.get(key);
    const promise = refreshEntry(entry, reason).finally(() => {
      if (refreshFlights.get(key) === promise) refreshFlights.delete(key);
    });
    refreshFlights.set(key, promise);
    return promise;
  }

  async function refreshEntry(entry, reason) {
    const { account, snapshot } = entry;
    const attemptAt = new Date(now()).toISOString();
    if (account.enabled === false) {
      return snapshot?.provider || null;
    }
    if (scheduledLater(account, reason)) return null;
    const owned = await runTransaction(async (executor) => {
      if (!await refreshOwner(account, executor)) return false;
      await store.updateHubAccount(account.id, {
        status: 'refreshing',
        lastAttemptAt: attemptAt,
        lastErrorCode: '',
        lastErrorMessage: ''
      }, executor);
      return true;
    });
    if (!owned) return null;
    try {
      const credentialEnvelope = await store.getHubAccountCredential(account.id);
      const credential = decryptCredential(credentialEnvelope, credentialKey);
      if (!credentialIsConfigured(credential)) throw schedulingError('notConfigured');
      const probed = await probeAccount(account, credential);
      const row = probed.row;
      const storedCredential = probed.credential;
      const committed = await runTransaction(async (executor) => {
        const owner = await refreshOwner(account, executor);
        if (!owner) return { stale: true };
        if (JSON.stringify(storedCredential) !== JSON.stringify(credential)) {
          await store.replaceHubAccountCredential(account.id, encryptCredential(storedCredential, credentialKey), executor);
        }
        await store.updateHubAccount(account.id, {
          accountKey: row.accountKey || owner.accountKey || '',
          accountEmail: row.accountEmail || owner.accountEmail || '',
          accountLabel: row.accountLabel || owner.accountLabel || '',
          status: 'ok',
          lastAttemptAt: attemptAt,
          lastSuccessAt: attemptAt,
          lastErrorCode: '',
          lastErrorMessage: '',
          nextRefreshAt: new Date(Date.parse(attemptAt) + intervalMs).toISOString()
        }, executor);
        await store.saveHubAccountSnapshot(account.id, {
          provider: row,
          lastGood: row,
          updatedAt: attemptAt
        }, executor);
        return { stale: false, row };
      });
      if (committed.stale) return null;
      runtimeFor(account, storedCredential).failures = 0;
      await onUpdate?.({ type: 'account-refresh', accountId: account.id, reason });
      return committed.row;
    } catch (error) {
      const status = statusFromError(error);
      const state = runtimeAccounts.get(account.id);
      const failures = (state?.failures || 0) + 1;
      const previous = snapshot?.lastGood || snapshot?.provider || null;
      const failed = normalizeLimitProvider({
        ...(previous || {}),
        provider: account.provider,
        accountKey: account.accountKey || previous?.accountKey || '',
        accountEmail: account.accountEmail || previous?.accountEmail || '',
        accountLabel: account.accountLabel || previous?.accountLabel || '',
        status,
        updatedAt: attemptAt,
        stale: Boolean(previous),
        windows: previous?.windows || []
      });
      const committed = await runTransaction(async (executor) => {
        const owner = await refreshOwner(account, executor);
        if (!owner) return { stale: true };
        await store.updateHubAccount(account.id, {
          status,
          lastAttemptAt: attemptAt,
          lastErrorCode: cleanText(error?.code || status, 64),
          lastErrorMessage: errorMessage(error),
          nextRefreshAt: new Date(now() + retryDelay(status, failures)).toISOString()
        }, executor);
        await store.saveHubAccountSnapshot(account.id, {
          provider: failed,
          lastGood: previous,
          updatedAt: attemptAt
        }, executor);
        return { stale: false, row: failed };
      });
      if (committed.stale) return null;
      if (state) state.failures = failures;
      logger.warn?.(`[hub-accounts] ${account.provider}/${account.id} refresh failed (${status})`);
      await onUpdate?.({ type: 'account-refresh-failed', accountId: account.id, reason });
      return committed.row;
    }
  }

  // A stalled repository call may detach a cycle latch, but every cycle and
  // manual/validation entry still shares probe permits and versioned flights.
  const ceilingOption = Number(refreshCeilingOverride);
  const refreshCeilingMs = Number.isFinite(ceilingOption) && ceilingOption > 0
    ? ceilingOption
    : Math.max(
      60 * 1000,
      Math.floor(intervalMs * 0.8),
      Math.ceil(probeTimeoutMs * (maxConcurrency + 1))
    );

  async function refreshAll(reason = 'interval') {
    if (stopped) return [];
    if (refreshPromise) {
      const stalledCycle = refreshPromise;
      const ageMs = now() - refreshStartedAt;
      if (ageMs <= refreshCeilingMs) return stalledCycle;
      logger.warn?.(
        `[hub-accounts] refresh cycle exceeded ${refreshCeilingMs}ms (age ${ageMs}ms); releasing the latch so limits can resume`
      );
      await onUpdate?.({ type: 'account-refresh-stalled', ageMs, ceilingMs: refreshCeilingMs, reason });
      if (refreshPromise === stalledCycle) {
        refreshPromise = null;
        refreshStartedAt = 0;
      }
    }
    refreshStartedAt = now();
    let cyclePromise;
    cyclePromise = (async () => {
      let accounts = [];
      try {
        accounts = await store.listHubAccounts();
      } catch (err) {
        logger.warn?.(`[hub-accounts] failed to list accounts for refresh: ${err?.message || err}`);
        return [];
      }
      const results = [];
      let cursor = 0;
      async function worker() {
        for (;;) {
          if (stopped) return;
          const index = cursor;
          cursor += 1;
          if (index >= accounts.length) return;
          const account = accounts[index];
          if (account.enabled === false) continue;
          if (scheduledLater(account, reason)) continue;
          try { results[index] = await refreshOne(account.id, reason); }
          catch (error) { logger.warn?.(`[hub-accounts] refresh crashed: ${error.message}`); }
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(maxConcurrency, accounts.length) }, () => worker()));
      } catch (err) {
        logger.warn?.(`[hub-accounts] refresh worker pool error: ${err?.message || err}`);
      }
      return results.filter(Boolean);
    })().catch((err) => {
      logger.warn?.(`[hub-accounts] refreshAll unhandled failure: ${err?.message || err}`);
      return [];
    }).finally(() => {
      if (refreshPromise === cyclePromise) {
        refreshPromise = null;
        refreshStartedAt = 0;
      }
    });
    refreshPromise = cyclePromise;
    return cyclePromise;
  }

  async function addAccount({ provider, name = '', label = '', credential }) {
    const normalizedProvider = providerId(provider);
    const normalizedCredential = credentialObject(credential);
    const id = accountId();
    const account = {
      id,
      provider: normalizedProvider,
      name: cleanText(name, MAX_ACCOUNT_NAME_LENGTH) || `${normalizedProvider}-${id.slice(0, 8)}`,
      label: cleanText(label, MAX_ACCOUNT_LABEL_LENGTH),
      accountKey: '',
      accountEmail: '',
      accountLabel: '',
      enabled: true,
      status: 'pending',
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString()
    };
    const probed = await probeAccount(account, normalizedCredential);
    const row = probed.row;
    const storedCredential = probed.credential;
    const duplicate = typeof store.findHubAccount === 'function'
      ? await store.findHubAccount(normalizedProvider, row.accountKey || '', row.accountEmail || '')
      : null;
    if (duplicate) {
      const error = new Error('This provider account is already registered');
      error.code = 'account_duplicate';
      throw error;
    }
    const envelope = encryptCredential(storedCredential, credentialKey);
    account.accountKey = row.accountKey || '';
    account.accountEmail = row.accountEmail || '';
    account.accountLabel = row.accountLabel || '';
    account.status = 'ok';
    account.lastAttemptAt = account.createdAt;
    account.lastSuccessAt = account.createdAt;
    account.nextRefreshAt = new Date(now() + intervalMs).toISOString();
    await runTransaction((executor) => store.createHubAccount(
      account,
      envelope,
      { provider: row, lastGood: row, updatedAt: account.createdAt },
      executor
    ));
    await onUpdate?.({ type: 'account-added', accountId: id });
    return { ...publicAccount(account, { provider: row }), credentialConfigured: true };
  }

  async function updateAccount(id, patch = {}) {
    const entry = await accountWithSnapshot(id);
    if (!entry) return null;
    const next = {};
    if (patch.name !== undefined) next.name = cleanText(patch.name, MAX_ACCOUNT_NAME_LENGTH);
    if (patch.label !== undefined) next.label = cleanText(patch.label, MAX_ACCOUNT_LABEL_LENGTH);
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.credential !== undefined) {
      const incomingCredential = credentialObject(patch.credential);
      let existingCredential = {};
      if (patch.credentialMode !== 'replace') {
        const envelope = await store.getHubAccountCredential(id);
        existingCredential = decryptCredential(envelope, credentialKey) || {};
      }
      const credential = patch.credentialMode === 'replace'
        ? incomingCredential
        : mergeCredential(existingCredential, incomingCredential, entry.account.provider);
      const probed = await probeAccount({ ...entry.account, ...next }, credential);
      const row = probed.row;
      const storedCredential = probed.credential;
      const envelope = encryptCredential(storedCredential, credentialKey);
      const updatedAt = editTimestamp(entry.account);
      const disabled = (next.enabled ?? entry.account.enabled) === false;
      const publishedRow = disabled
        ? normalizeLimitProvider({ ...row, status: 'disabled', updatedAt, windows: [] })
        : row;
      await runTransaction(async (executor) => {
        if (!await refreshOwner(entry.account, executor)) throw schedulingError('stale_write');
        await store.replaceHubAccountCredential(id, envelope, executor);
        await store.updateHubAccount(id, {
          ...next,
          accountKey: row.accountKey || entry.account.accountKey || '',
          accountEmail: row.accountEmail || entry.account.accountEmail || '',
          accountLabel: row.accountLabel || entry.account.accountLabel || '',
          status: disabled ? 'disabled' : 'ok',
          lastAttemptAt: updatedAt,
          lastSuccessAt: updatedAt,
          lastErrorCode: '',
          lastErrorMessage: '',
          nextRefreshAt: new Date(now() + intervalMs).toISOString(),
          updatedAt
        }, executor);
        await store.saveHubAccountSnapshot(id, {
          provider: publishedRow,
          lastGood: row,
          updatedAt
        }, executor);
      });
      runtimeAccounts.delete(id);
    } else if (Object.keys(next).length) {
      const updatedAt = editTimestamp(entry.account);
      if (next.enabled === false) {
        // Disabling an account must revoke its last-good snapshot immediately;
        // otherwise the central limits aggregate keeps displaying quota until
        // the next scheduled refresh.
        const disabled = normalizeLimitProvider({
          ...(entry.snapshot?.provider || {}),
          provider: entry.account.provider,
          status: 'disabled',
          updatedAt,
          windows: []
        });
        await runTransaction(async (executor) => {
          if (!await refreshOwner(entry.account, executor)) throw schedulingError('stale_write');
          await store.updateHubAccount(id, {
            ...next,
            status: 'disabled',
            lastAttemptAt: updatedAt,
            lastErrorCode: '',
            lastErrorMessage: '',
            nextRefreshAt: new Date(now() + intervalMs).toISOString(),
            updatedAt
          }, executor);
          await store.saveHubAccountSnapshot(id, {
            provider: disabled,
            lastGood: entry.snapshot?.lastGood || null,
            updatedAt
          }, executor);
        });
      } else if (next.enabled === true && entry.account.enabled === false) {
        await runTransaction(async (executor) => {
          if (!await refreshOwner(entry.account, executor)) throw schedulingError('stale_write');
          await store.updateHubAccount(id, {
            ...next,
            status: 'pending',
            lastErrorCode: '',
            lastErrorMessage: '',
            updatedAt
          }, executor);
        });
        await refreshOne(id, 'enabled');
      } else {
        await runTransaction(async (executor) => {
          if (!await refreshOwner(entry.account, executor)) throw schedulingError('stale_write');
          await store.updateHubAccount(id, { ...next, updatedAt }, executor);
        });
      }
    }
    const refreshed = await accountWithSnapshot(id);
    await onUpdate?.({ type: 'account-updated', accountId: id });
    return publicAccount(refreshed.account, refreshed.snapshot);
  }

  async function clearAccountCredential(id) {
    const entry = await accountWithSnapshot(id);
    if (!entry) return null;
    const updatedAt = editTimestamp(entry.account);
    // Clearing keeps the account itself (name/label/enabled/limits identity) but
    // removes every usable secret, so the next refresh reports "not configured"
    // until the owner authorizes again. No probe runs: probing an empty credential
    // would throw and turn a deliberate clear into a 4xx.
    const cleared = normalizeLimitProvider({
      ...(entry.snapshot?.provider || {}),
      provider: entry.account.provider,
      accountKey: '',
      accountEmail: '',
      accountLabel: '',
      status: 'notConfigured',
      stale: false,
      windows: []
    });
    const envelope = encryptCredential({}, credentialKey);
    await runTransaction(async (executor) => {
      if (!await refreshOwner(entry.account, executor)) throw schedulingError('stale_write');
      await store.replaceHubAccountCredential(id, envelope, executor);
      await store.updateHubAccount(id, {
        accountKey: '',
        accountEmail: '',
        accountLabel: '',
        status: 'notConfigured',
        lastErrorCode: '',
        lastErrorMessage: '',
        nextRefreshAt: new Date(now() + intervalMs).toISOString(),
        updatedAt
      }, executor);
      await store.saveHubAccountSnapshot(id, {
        provider: cleared,
        lastGood: null,
        updatedAt
      }, executor);
    });
    runtimeAccounts.delete(id);
    await onUpdate?.({ type: 'account-credential-cleared', accountId: id });
    return true;
  }

  // Re-authorize an existing account in place.
  //
  // The browser sign-in flow completes at the Hub (oauthManager.exchangeSession),
  // then must attach its credential to the account the user is editing rather than
  // create a second one. addAccount's duplicate guard is deliberately skipped for
  // the account's own identity, or re-authorizing would fail with
  // `account_duplicate` against itself.
  async function authorizeAccount(id, { credential, name, label } = {}) {
    const entry = await accountWithSnapshot(id);
    if (!entry) return null;
    const incomingCredential = credentialObject(credential);
    const next = {
      name: name !== undefined && cleanText(name, MAX_ACCOUNT_NAME_LENGTH)
        ? cleanText(name, MAX_ACCOUNT_NAME_LENGTH)
        : entry.account.name,
      label: label !== undefined ? cleanText(label, MAX_ACCOUNT_LABEL_LENGTH) : entry.account.label
    };
    const account = { ...entry.account, ...next, enabled: true };
    const probed = await probeAccount(account, incomingCredential);
    const row = probed.row;
    const storedCredential = probed.credential;
    const duplicate = typeof store.findHubAccount === 'function'
      ? await store.findHubAccount(account.provider, row.accountKey || '', row.accountEmail || '')
      : null;
    if (duplicate && duplicate.id !== id) {
      const error = new Error('This provider account is already registered');
      error.code = 'account_duplicate';
      throw error;
    }
    const updatedAt = editTimestamp(entry.account);
    const envelope = encryptCredential(storedCredential, credentialKey);
    await runTransaction(async (executor) => {
      if (!await refreshOwner(entry.account, executor)) throw schedulingError('stale_write');
      await store.replaceHubAccountCredential(id, envelope, executor);
      await store.updateHubAccount(id, {
        ...next,
        enabled: true,
        accountKey: row.accountKey || '',
        accountEmail: row.accountEmail || '',
        accountLabel: row.accountLabel || '',
        status: 'ok',
        lastAttemptAt: updatedAt,
        lastSuccessAt: updatedAt,
        lastErrorCode: '',
        lastErrorMessage: '',
        nextRefreshAt: new Date(now() + intervalMs).toISOString(),
        updatedAt
      }, executor);
      await store.saveHubAccountSnapshot(id, {
        provider: row,
        lastGood: row,
        updatedAt
      }, executor);
    });
    runtimeAccounts.delete(id);
    const refreshed = await accountWithSnapshot(id);
    await onUpdate?.({ type: 'account-authorized', accountId: id });
    return {
      ...publicAccount(refreshed.account, refreshed.snapshot),
      credentialConfigured: credentialIsConfigured(storedCredential)
    };
  }

  async function deleteAccount(id) {
    const existing = await store.getHubAccount(id);
    if (!existing) return false;
    await store.deleteHubAccount(id);
    runtimeAccounts.delete(id);
    await onUpdate?.({ type: 'account-deleted', accountId: id });
    return true;
  }

  function start() {
    if (timer || stopped) return;
    timer = setInterval(() => { void refreshAll('interval'); }, intervalMs);
    timer.unref?.();
    void refreshAll('startup');
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const entry of probeQueue.splice(0)) {
      entry.signal.removeEventListener('abort', entry.abort);
      entry.reject(schedulingError('service_stopped'));
    }
    await refreshPromise?.catch(() => {});
    await Promise.allSettled([...refreshFlights.values()]);
    runtimeAccounts.clear();
  }

  return {
    addAccount,
    authorizeAccount,
    clearAccountCredential,
    deleteAccount,
    getLimitsSummary,
    listAccounts,
    refreshAccount: (id) => refreshOne(id, 'manual'),
    refreshAll,
    start,
    stop,
    updateAccount,
    supportedProviders: () => [...HUB_MANUAL_PROVIDERS]
  };
}

module.exports = {
  DEFAULT_CONCURRENCY,
  DEFAULT_REFRESH_MS,
  HUB_MANUAL_PROVIDERS,
  MAX_CREDENTIAL_BYTES,
  createHubAccountService,
  providerOptions
};
