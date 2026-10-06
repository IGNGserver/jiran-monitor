'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { URL } = require('node:url');
const {
  PERIODS,
  aggregateDevices,
  aggregateHistory,
  mergeDeviceRecord,
  mergePeriods,
  normalizeDeviceRecord,
  summarizeStats
} = require('../shared/usage');
const { normalizeLimitsSummary } = require('../shared/limits');
const { historyPreview, historyRevision } = require('../shared/history');
const { deviceHistoryRevision } = require('../shared/history');
const {
  emptySubscriptionDocument,
  isStaleSubscriptionWrite,
  subscriptionDocument
} = require('../shared/subscriptionDisplay');
const { CURRENCY_CODES, normalizeCurrency } = require('../shared/currency');
const { currentHubBuild } = require('../shared/hubBuildIdentity');
const { readJsonBody, sendJson, sendNotModifiedIfFresh, sendText } = require('../shared/http');
const {
  AUTHENTICATED_SCOPE,
  createHubAuthPolicy
} = require('../shared/hubAuth');
const { HUB_API_VERSION, hubCapabilities } = require('../shared/hubCapabilities');
const { createFixedWindowRateLimiter } = require('../shared/hubRateLimit');
const { validateDeviceRecordPayload } = require('../shared/wireValidation');
const { dayKeyOf, normalizeTimeZone } = require('../shared/fleetTimeZone');
const { loadDotEnv, parseArgs } = require('../shared/config');
const { tryServeStatic } = require('./static');
const { lookupModelPricing, normalizePromaPricing } = require('../shared/collector');
const { createMySqlPool, createRepository } = require('./repository');
const { createCatalogPricingLookup, pricingNotFound } = require('./pricing-upstream');
const { calculateUsageEventDeltas, summarizeSessions } = require('./usage-events');
const { createHubAccountService } = require('./accountService');
const { createOAuthSessionManager } = require('./oauthService');
const { createOutboundFetch } = require('../shared/outboundFetch');
const { fetchRates, isCacheStale } = require('../shared/exchangeRates');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const PRICE_FIELDS = [
  'inputPricePerMillion',
  'outputPricePerMillion',
  'cacheReadPricePerMillion',
  'cacheWritePricePerMillion'
];
const SSE_WRITE_TIMEOUT_MS = 45 * 1000;
// Any read-credential holder can open long-lived streams; each costs a socket, a
// heartbeat interval and a share of every broadcast. Cap the registry so one
// client cannot exhaust file descriptors or turn a broadcast into a storm.
const DEFAULT_MAX_SSE_CLIENTS = 64;
// Must stay below the account refresh interval so a slow provider cannot consume
// a whole cycle; accountService also enforces it internally.
const DEFAULT_HUB_PROBE_DEADLINE_MS = 60 * 1000;
// Display cap for `/api/sessions`. The shared UI shows 200 rows; the mobile list
// is capped the same way. The full count is reported alongside, so a capped list
// never reads as the whole archive.
const SESSION_LIST_LIMIT = 200;
const RESERVED_DYNAMIC_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function safeDynamicKey(value, fallback = 'unknown') {
  const key = String(value ?? '').trim();
  return key && !RESERVED_DYNAMIC_KEYS.has(key.toLowerCase()) ? key : fallback;
}

function mapNumber(map, key) {
  return hasOwn(map, key) ? number(map[key]) : 0;
}

function errorMessageForApi(error) {
  return String(error?.message || 'request failed')
    .slice(0, 512)
    .replace(/cookie|token|secret|api[_ -]?key|authorization/gi, '[redacted]');
}

// Without a secret the hub cannot tell its own widget from any other caller, so it
// must not expose account identity (email/plan/key) to the network. Binding to
// loopback keeps an unauthenticated hub usable locally while refusing LAN/remote
// reach; set a secret to bind a non-loopback address and accept other devices.
function loadTlsOptions(tls) {
  if (tls && tls.key && tls.cert) {
    return {
      key: tls.key,
      cert: tls.cert,
      ca: tls.ca
    };
  }
  const certPath = String(process.env.TOKEN_MONITOR_TLS_CERT || '').trim();
  const keyPath = String(process.env.TOKEN_MONITOR_TLS_KEY || '').trim();
  const caPath = String(process.env.TOKEN_MONITOR_TLS_CA || '').trim();
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error('TOKEN_MONITOR_TLS_CERT and TOKEN_MONITOR_TLS_KEY must be set together');
  }
  const options = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
  if (caPath) options.ca = fs.readFileSync(caPath);
  return options;
}

function resolveBindHost(host, secret) {
  const requested = String(host || '').trim() || '0.0.0.0';
  if (secret) return requested;
  return LOOPBACK_HOSTS.has(requested.toLowerCase()) ? requested : '127.0.0.1';
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyUsageRangePayload() {
  return {
    totalTokens: 0,
    costUsd: 0,
    clients: {},
    clientCosts: {},
    clientCredits: {},
    clientEstimated: {},
    clientMeasurements: {},
    estimated: false,
    models: {},
    modelCosts: {},
    clientModels: {},
    clientModelCosts: {}
  };
}

function rangeMeasurements(period = {}) {
  const result = { ...(period.clientMeasurements || {}) };
  const clients = new Set([
    ...Object.keys(period.clients || {}),
    ...Object.keys(period.clientCredits || {})
  ]);
  for (const client of clients) {
    const current = result[client] || {};
    if (!current.tokens) current.tokens = period.clientEstimated?.[client] === true ? 'estimated' : 'unknown';
    if (!current.costUsd) current.costUsd = period.clientEstimated?.[client] === true ? 'estimated' : 'unknown';
    const credits = number(period.clientCredits?.[client]);
    if (credits > 0) {
      current.meters = {
        ...(current.meters || {}),
        credits: { value: credits, provenance: 'exact' }
      };
    }
    result[client] = current;
  }
  return result;
}

function addRangeTokenCost(mapTokens, mapCosts, key, tokens, cost) {
  const id = safeDynamicKey(key);
  mapTokens[id] = mapNumber(mapTokens, id) + tokens;
  mapCosts[id] = mapNumber(mapCosts, id) + cost;
}

// Sum tokscale graph daily history for inclusive calendar day keys.
// History dates are local calendar days (YYYY-MM-DD), same family as the day/month
// tabs — never UTC-shift them. Hour precision is intentionally day-rounded so hub
// custom ranges match desktop tokscale --since/--until totals.
function aggregateHistoryRange(history, from, to, options = {}) {
  const result = emptyUsageRangePayload();
  let startDate = String(options.startDate || '').slice(0, 10);
  let endDate = String(options.endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    // Legacy from/to Instant bounds: map to inclusive calendar days in the
    // caller's zone when one is supplied, else the Hub's calendar.
    const fromDate = from instanceof Date ? from : new Date(from);
    const toDate = to instanceof Date ? to : new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return result;
    const keyOf = (d) => dayKeyOf(d, normalizeTimeZone(options.timeZone));
    startDate = keyOf(fromDate);
    // `to` is exclusive in the ISO API; the last included local day is the calendar
    // day of (to - 1ms), so a full-day [00:00, next-day 00:00) keeps one day key.
    const lastInclusive = new Date(Math.max(fromDate.getTime(), toDate.getTime() - 1));
    endDate = keyOf(lastInclusive);
    if (startDate > endDate) return result;
  }
  result.matchedDays = 0;
  let coveredFrom = '';
  let coveredTo = '';
  for (const day of history?.daily || []) {
    const dayKey = String(day?.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
    if (dayKey < startDate || dayKey > endDate) continue;
    result.matchedDays += 1;
    if (!coveredFrom || dayKey < coveredFrom) coveredFrom = dayKey;
    if (!coveredTo || dayKey > coveredTo) coveredTo = dayKey;
    const tokens = Math.round(number(day.tokens));
    const cost = number(day.cost);
    result.totalTokens += tokens;
    result.costUsd += cost;
    for (const [client, value] of Object.entries(day.perClient || {})) {
      addRangeTokenCost(result.clients, result.clientCosts, client, Math.round(number(value?.tokens ?? value)), number(value?.cost));
    }
    for (const [model, value] of Object.entries(day.perModel || {})) {
      addRangeTokenCost(result.models, result.modelCosts, model, Math.round(number(value?.tokens ?? value)), number(value?.cost));
    }
  }
  // Report what the daily history actually covered. Without this a range that
  // reaches past the rolling window (< HISTORY_CAP_DAYS) returned only the
  // in-window days and presented them as the total for the whole range.
  result.requestedStart = startDate;
  result.requestedEnd = endDate;
  result.coveredFrom = coveredFrom;
  result.coveredTo = coveredTo;
  // A gap exists when the request starts before the oldest covered day. The end
  // cannot gap: daily history always includes today.
  result.truncated = Boolean(coveredFrom && startDate < coveredFrom);
  return result;
}

function parseRangeBound(raw, name) {
  const text = String(raw || '').trim();
  if (!text) {
    const error = new Error(`${name}_required`);
    error.code = 'invalid_range';
    throw error;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${name}_invalid`);
    error.code = 'invalid_range';
    throw error;
  }
  return parsed;
}

function priceSnapshot(event, pricing) {
  if (!pricing) {
    // A missing catalog entry must not turn a known tokscale cost into a false
    // zero. No price exists to snapshot, so the event carries its payload cost
    // and marks the provenance explicitly.
    return {
      ...event,
      priceInputPerMillion: null,
      priceOutputPerMillion: null,
      priceCacheReadPerMillion: null,
      priceCacheWritePerMillion: null,
      pricingSource: 'payload_fallback',
      pricingSnapshotAt: null,
      costUsd: number(event.payloadCostUsd)
    };
  }
  const input = number(pricing.inputPricePerMillion);
  const output = number(pricing.outputPricePerMillion);
  const cacheRead = number(pricing.cacheReadPricePerMillion);
  const cacheWrite = number(pricing.cacheWritePricePerMillion);
  return {
    ...event,
    priceInputPerMillion: input,
    priceOutputPerMillion: output,
    priceCacheReadPerMillion: cacheRead,
    priceCacheWritePerMillion: cacheWrite,
    pricingSource: pricing.source,
    pricingSnapshotAt: pricing.updatedAt,
    costUsd: ((number(event.inputTokens) * input)
      + (number(event.outputTokens) * output)
      + (number(event.cacheReadTokens) * cacheRead)
      + (number(event.cacheWriteTokens) * cacheWrite)) / 1_000_000
  };
}

function normalizePrices(body) {
  const aliases = {
    inputPricePerMillion: ['inputPricePerMillion', 'input_price_per_million'],
    outputPricePerMillion: ['outputPricePerMillion', 'output_price_per_million'],
    cacheReadPricePerMillion: ['cacheReadPricePerMillion', 'cache_read_price_per_million'],
    cacheWritePricePerMillion: ['cacheWritePricePerMillion', 'cache_write_price_per_million']
  };
  const prices = {};
  for (const field of PRICE_FIELDS) {
    const value = aliases[field].map((key) => body?.[key]).find((candidate) => candidate !== undefined);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      const error = new Error(`${field}_must_be_a_non_negative_number`);
      error.code = 'invalid_pricing';
      throw error;
    }
    prices[field] = parsed;
  }
  return prices;
}

function upstreamPrices(result) {
  const pricing = normalizePromaPricing(result);
  if (!pricing) return null;
  return {
    inputPricePerMillion: number(pricing.inputCostPerToken) * 1_000_000,
    outputPricePerMillion: number(pricing.outputCostPerToken) * 1_000_000,
    cacheReadPricePerMillion: number(pricing.cacheReadInputTokenCost) * 1_000_000,
    cacheWritePricePerMillion: number(pricing.cacheCreationInputTokenCost) * 1_000_000
  };
}

function isMissingPricingError(error) {
  return /not found|unknown model|no pricing|unsupported model/i.test(String(error?.message || ''));
}

function createHub({
  port = 17321,
  host = '0.0.0.0',
  secret = '',
  // Internal migration input only. The CLI and documented deployment surface
  // no longer expose split credentials; if present, the old admin key is the
  // only safe candidate for the single owner.
  adminSecret = '',
  viewerSecret = '',
  ingestCredentials = null,
  authPolicy = null,
  staleAfterMs = 10 * 60 * 1000,
  sseHeartbeatMs = 30000,
  repository = null,
  pool = null,
  lookupPricing = lookupModelPricing,
  fallbackPricing = createCatalogPricingLookup(),
  webRoot,
  tls = null,
  allowInsecureHttp = false,
  trustProxy = false,
  authFailureLimit = 30,
  maxSseClients: maxSseClientsOption = DEFAULT_MAX_SSE_CLIENTS,
  ingestRateLimit = 240,
  accountsEnabled = true,
  accountCredentialKey = '',
  accountRefreshMs = 5 * 60 * 1000,
  accountConcurrency = 4,
  accountProbe,
  oauthFetch: injectedOAuthFetch = null,
  // The one calendar the fleet buckets usage days into (IANA name). Unset keeps
  // every device on its own OS zone, which is the pre-fleet behaviour; when set,
  // the Hub advertises it to devices and uses it for its own clock fallbacks.
  fleetTimeZone = '',
  logger = console
} = {}) {
  const ownedPool = !repository && !pool;
  const activePool = pool || (repository ? null : createMySqlPool());
  const store = repository || createRepository(activePool);
  const ownerSecret = String(secret || adminSecret || '').trim();
  const resolvedFleetTimeZone = normalizeTimeZone(
    fleetTimeZone || process.env.TOKEN_MONITOR_FLEET_TIMEZONE || ''
  );
  let auth = authPolicy || createHubAuthPolicy({
    ownerSecret,
    viewerSecret,
    ingestCredentials
  });
  const resolvedAccountCredentialKey = String(
    accountCredentialKey
      || process.env.TOKEN_MONITOR_HUB_CREDENTIAL_KEY
      || secret
      || adminSecret
      || ''
  ).trim();
    const outboundFetch = createOutboundFetch(process.env);
    // Tests inject a fake token endpoint; production keeps the proxy-aware fetch.
    const oauthHttpFetch = typeof injectedOAuthFetch === 'function'
      ? injectedOAuthFetch
      : (accountProbe ? undefined : outboundFetch);
    const accountService = accountsEnabled !== false
    && resolvedAccountCredentialKey
    && typeof store.listHubAccounts === 'function'
    ? createHubAccountService({
      store,
      credentialKey: resolvedAccountCredentialKey,
      refreshMs: accountRefreshMs,
      concurrency: accountConcurrency,
      probe: accountProbe,
      // Hard ceiling for one provider probe. Without it a provider that never
      // answers holds the refresh latch and silently stops all limit refreshes.
      probeDeadlineMs: Number(process.env.TOKEN_MONITOR_HUB_PROBE_DEADLINE_MS)
        || DEFAULT_HUB_PROBE_DEADLINE_MS,
      refreshCeilingOverride: Number(process.env.TOKEN_MONITOR_HUB_REFRESH_CEILING_MS) || null,
      oauthFetch: oauthHttpFetch,
      logger,
      onUpdate: () => {
        invalidateStatsCache();
        void broadcastStats('account-update');
      }
    })
    : null;
  const oauthManager = createOAuthSessionManager();
  const capabilities = hubCapabilities('node-hub', { hubAccounts: Boolean(accountService) });
  const maxSseClients = Math.max(1, Math.floor(Number(maxSseClientsOption) || DEFAULT_MAX_SSE_CLIENTS));
  const authFailures = createFixedWindowRateLimiter({ limit: authFailureLimit, windowMs: 60_000 });
  const ingestRequests = createFixedWindowRateLimiter({ limit: ingestRateLimit, windowMs: 60_000 });
  const bindHost = resolveBindHost(host, auth.configured ? 'configured' : '');
  const tlsOptions = loadTlsOptions(tls);
  const protocol = tlsOptions ? 'https' : 'http';
  const insecureHttpAllowed = allowInsecureHttp === true
    || ['1', 'true', 'yes', 'on'].includes(String(allowInsecureHttp || '').trim().toLowerCase());
  const isTrustProxy = trustProxy === true
    || ['1', 'true', 'yes', 'on'].includes(String(process.env.TOKEN_MONITOR_TRUST_PROXY || '').trim().toLowerCase());
  if (!tlsOptions && !LOOPBACK_HOSTS.has(bindHost) && !insecureHttpAllowed) {
    const error = new Error('A non-loopback Hub must use TLS. Set TOKEN_MONITOR_ALLOW_INSECURE_HTTP=1 only for a trusted LAN or VPN.');
    error.code = 'insecure_hub_transport';
    throw error;
  }
  let statsCache = null;
  let subscriptionsCache = emptySubscriptionDocument();
  // Normalized fleet + aggregate history, shared by /api/stats, /api/history and
  // /api/devices. Never outlives a mutation: `invalidateStatsCache` drops it.
  let recordsBundle = null;
  let recordsBundleInFlight = null;
  // A stale in-flight aggregation must not be allowed to repopulate the cache
  // after a mutation. The generation is advanced by every invalidation.
  let statsCacheGeneration = 0;
  const ingestLocks = new Map();

  async function withDeviceIngestLock(deviceId, work) {
    const previous = ingestLocks.get(deviceId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    ingestLocks.set(deviceId, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (ingestLocks.get(deviceId) === current) ingestLocks.delete(deviceId);
    }
  }

  // Display rates for the dashboard. Fetched at most once per day and kept in
  // memory; a failed fetch falls back to the shared built-in table so cost
  // rendering never breaks because a third-party endpoint is down.
  let displayRates = null;
  let displayRatesFetch = null;

  async function getDisplayRates() {
    const fresh = displayRates && !isCacheStale(displayRates.date);
    if (fresh) return { rates: displayRates.rates, date: displayRates.date, source: displayRates.source };
    if (displayRatesFetch) return displayRatesFetch;
    displayRatesFetch = (async () => {
      try {
        const fetched = await fetchRates({ fetchImpl: oauthHttpFetch });
        displayRates = fetched;
        return { rates: fetched.rates, date: fetched.date, source: fetched.source };
      } catch (error) {
        logger.warn?.(`[hub-rates] live rates unavailable: ${error?.message || error}`);
        const fallback = displayRates || { rates: null, date: null, source: 'built-in' };
        return { rates: fallback.rates, date: fallback.date, source: fallback.source || 'built-in' };
      } finally {
        displayRatesFetch = null;
      }
    })();
    return displayRatesFetch;
  }
  // Coalescing window for the stats aggregation. `statsCache` is invalidated by
  // every mutation (ingest, rename, delete, subscriptions), so the only thing a
  // TTL adds is protection against a burst of identical reads. Without it every
  // /api/stats poll, /api/devices poll and SSE snapshot recomputed the whole
  // fleet synchronously on the single event loop (measured 266 ms at 20 devices,
  // 1564 ms at 50), which stalls the heartbeats and every other request.
  const statsCacheTtlMs = Math.max(0, Number(process.env.TOKEN_MONITOR_HUB_STATS_TTL_MS ?? 1000) || 0);
  let statsCacheAt = 0;
  let statsInFlight = null;

  function invalidateStatsCache() {
    statsCacheGeneration += 1;
    statsCache = null;
    statsCacheAt = 0;
    statsInFlight = null;
    // The normalized fleet + history bundle is derived from the fleet and goes
    // stale with it. Dropping the reference also releases a multi-megabyte
    // retained snapshot immediately rather than at the next rebuild.
    recordsBundle = null;
    recordsBundleInFlight = null;
  }

  async function getSubscriptions() {
    if (typeof store.getSubscriptions === 'function') {
      subscriptionsCache = await store.getSubscriptions();
    }
    return subscriptionsCache;
  }

  // One read of the device fleet, shared by every derived document.
  //
  // `/api/stats`, `/api/history` and `/api/devices` all start from
  // `listDeviceRecords()`, and any ingest/mutation invalidates all three. Without
  // this each endpoint paid its own SELECT plus its own `normalizeDeviceRecord()`
  // pass, and `/api/history` — which does not even look at the periods — paid for
  // a second full fleet read that the stats path had already performed.
  //
  // The bundle only lives as long as the mutation generation does; a write drops
  // it (see `invalidateStatsCache`) so a cached read can never outlive its data.
  async function getFleetRecords() {
    if (recordsBundle) return recordsBundle;
    if (recordsBundleInFlight) return recordsBundleInFlight;
    const generation = statsCacheGeneration;
    const inFlight = (async () => {
      const rawRecords = await store.listDeviceRecords();
      const records = rawRecords.map((record) => normalizeDeviceRecord(record));
      const history = aggregateHistory(records, { normalized: true, fallbackTodayKey: hubDayKey() });
      const bundle = { rawRecords, records, history };
      if (generation === statsCacheGeneration) recordsBundle = bundle;
      return bundle;
    })().finally(() => {
      if (recordsBundleInFlight === inFlight) recordsBundleInFlight = null;
    });
    recordsBundleInFlight = inFlight;
    return inFlight;
  }

  // The fleet aggregate is the expensive part; both shapes derive from one
  // computation. `summarizeStats` is a projection over the same numbers (no
  // re-measurement), so the summary endpoint costs one extra shallow copy rather
  // than a second aggregation.
  async function computeStatsBundle() {
    const { rawRecords, records, history } = await getFleetRecords();
    const stats = aggregateDevices(records, staleAfterMs, Date.now(), { normalized: true });
    const centralLimits = accountService
      ? await accountService.getLimitsSummary()
      : normalizeLimitsSummary({});
    for (const device of stats.devices) delete device.limits;
    stats.limits = centralLimits;
    stats.limitsAuthority = accountService ? 'hub' : 'none';
    stats.staleAfterMs = staleAfterMs;
    stats.historyPreview = historyPreview(history);
    stats.historyRevision = historyRevision(history);
    stats.deviceHistoryRevision = deviceHistoryRevision(rawRecords);
    stats.subscriptionsUpdatedAt = (await getSubscriptions()).updatedAt || '';
    stats.apiVersion = HUB_API_VERSION;
    stats.capabilities = capabilities;
    // The fleet calendar is part of the read contract: clients compute their
    // preset range labels from it so a browser/phone in another zone asks the
    // same question the devices answered.
    if (resolvedFleetTimeZone) stats.fleetTimeZone = resolvedFleetTimeZone;
    return stats;
  }

  async function getStatsBundle() {
    const now = Date.now();
    if (statsCache && statsCacheTtlMs > 0 && now - statsCacheAt < statsCacheTtlMs) {
      return statsCache;
    }
    // Share one computation across concurrent readers instead of stacking them.
    if (statsInFlight) return statsInFlight;
    const generation = statsCacheGeneration;
    const inFlight = computeStatsBundle()
      .then((bundle) => {
        if (generation === statsCacheGeneration) {
          statsCache = bundle;
          statsCacheAt = Date.now();
        }
        return bundle;
      })
      .finally(() => {
        if (statsInFlight === inFlight) statsInFlight = null;
      });
    statsInFlight = inFlight;
    return inFlight;
  }

  // Full shape: every device carries its complete periods (sessions, projects,
  // client×model grain). This is what `/api/stats` has always returned and stays
  // the default so the desktop and web hosts are untouched.
  async function getStats() {
    return getStatsBundle();
  }

  // First-paint shape: the same aggregate and device list, minus the session
  // archive and the per-device client×model grain. `/api/stats/summary` serves it
  // so the mobile client is not forced to download every device's session rows
  // before it can draw a headline number.
  async function getStatsSummary() {
    const bundle = await getStatsBundle();
    if (bundle.__summary) return bundle.__summary;
    const summary = summarizeStats(bundle);
    Object.defineProperty(bundle, '__summary', { value: summary, enumerable: false, configurable: true });
    return summary;
  }

  async function getHistory(deviceId = '') {
    const { rawRecords, history } = await getFleetRecords();
    const scopedDeviceId = String(deviceId || '').trim();
    return scopedDeviceId
      ? aggregateHistoryRangeFromRecords(rawRecords, history, scopedDeviceId)
      : history;
  }

  // `/api/history?deviceId=` is a separate document from the fleet aggregate:
  // `aggregateHistory(records.filter(...))` re-merges one device's history from
  // its stored daily/monthly tiers. The fleet bundle already holds every raw
  // record, so the scoped read reuses that list instead of issuing a second
  // `listDeviceRecords()` (the query that made /api/history cost as much as a
  // full /api/stats rebuild).
  function aggregateHistoryRangeFromRecords(rawRecords, fleetHistory, deviceId) {
    const scoped = rawRecords.filter((record) => String(record?.deviceId || record?.id || '') === deviceId);
    if (scoped.length === rawRecords.length) return fleetHistory;
    return aggregateHistory(scoped.map((record) => normalizeDeviceRecord(record)), { fallbackTodayKey: hubDayKey() });
  }

  async function setSubscriptions(subscriptions, baseUpdatedAt) {
    if (!Array.isArray(subscriptions)) {
      const error = new Error('subscriptions must be an array');
      error.code = 'bad_subscriptions';
      throw error;
    }
    const current = await getSubscriptions();
    if (isStaleSubscriptionWrite(current, baseUpdatedAt)) {
      const error = new Error('stale_write');
      error.code = 'stale_write';
      error.current = current;
      throw error;
    }
    const unsupported = subscriptions.find(
      (entry) => entry?.currency && !CURRENCY_CODES.includes(String(entry.currency).trim().toUpperCase())
    );
    if (unsupported) {
      const error = new Error(`unsupported currency: ${String(unsupported.currency).trim().toUpperCase()}`);
      error.code = 'bad_subscriptions';
      throw error;
    }
    const next = subscriptionDocument(subscriptions, {
      previousUpdatedAt: current.updatedAt,
      currencyApi: { normalizeCurrency }
    });
    if (typeof store.setSubscriptions === 'function') {
      await store.setSubscriptions(next, current.updatedAt);
    }
    subscriptionsCache = next;
    // stats.subscriptionsUpdatedAt is part of the stats payload, so it has to be
    // rebuilt rather than served from the coalescing cache.
    invalidateStatsCache();
    await broadcastStats('subscriptions');
    return subscriptionsCache;
  }

  // The Hub's calendar: the configured fleet zone when one is set, otherwise
  // this host's own zone (the historical behaviour).
  function hubDayKey(date = new Date()) {
    return dayKeyOf(date, resolvedFleetTimeZone);
  }

  function hubMonthKey(date = new Date()) {
    return hubDayKey(date).slice(0, 7);
  }

  function periodToUsageRangePayload(period) {
    return {
      totalTokens: Math.round(number(period?.totalTokens)),
      costUsd: number(period?.costUsd),
      clients: { ...(period?.clients || {}) },
      clientCosts: { ...(period?.clientCosts || {}) },
      // Only the live-period branch can answer this: `usage_events` and the
      // daily history have no credit column until migration 006 lands, so a
      // range served from those sources reports no credits rather than a
      // partial total. Dropping a field the period actually carries would be a
      // silent data loss one level lower down.
      clientCredits: { ...(period?.clientCredits || {}) },
      clientEstimated: { ...(period?.clientEstimated || {}) },
      clientMeasurements: rangeMeasurements(period),
      estimated: period?.estimated === true,
      models: { ...(period?.models || {}) },
      modelCosts: { ...(period?.modelCosts || {}) },
      clientModels: period?.clientModels && typeof period.clientModels === 'object' ? period.clientModels : {},
      clientModelCosts: period?.clientModelCosts && typeof period.clientModelCosts === 'object' ? period.clientModelCosts : {}
    };
  }

  // The Hub's own clock is the *Hub host's*, not the caller's. A browser on the
  // other side of the world asked for its local `from`/`to`, so a legacy request
  // that names only instants may carry its IANA zone (`tz=`) and have the day
  // keys derived in that zone. An absent/invalid zone falls back to the Hub's
  // calendar (the fleet zone when configured), which is the historical behaviour
  // for same-zone callers.
  function normalizeRangeTimeZone(value) {
    return normalizeTimeZone(value);
  }

  function calendarDayKeyInZone(date, timeZone) {
    return dayKeyOf(date, normalizeRangeTimeZone(timeZone) || resolvedFleetTimeZone);
  }

  // The live fallback is for a cold fleet (history empty, no ledger rows). Which
  // live window it may answer with is decided by the *producers'* own
  // periodWindows keys, never by this host's clock: the aggregate `today`/`month`
  // is the sum of each device's own local window, so consulting the server's
  // calendar would refuse a perfectly good window whenever the caller or a
  // device sits in another zone.
  async function liveUsageRangeFromDevices(range) {
    const empty = { ...emptyUsageRangePayload(), source: 'live_periods' };
    if (!range?.ok) return empty;
    const stats = await getStats();
    const devices = Array.isArray(stats?.devices) ? stats.devices : [];
    const producerToday = new Set();
    const producerMonth = new Set();
    for (const device of devices) {
      const day = String(device?.periodWindows?.today?.key || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) producerToday.add(day);
      const month = String(device?.periodWindows?.month?.key || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(month)) producerMonth.add(month);
    }
    const startDate = String(range.startDate || '');
    const endDate = String(range.endDate || '');
    // A pre-periodWindows fleet has no producer windows to key on; keep the
    // historical best-effort behaviour rather than refusing a live window the
    // old contract used to answer. With a fleet calendar configured, "best
    // effort" is that calendar, not this host's zone.
    if (producerToday.size === 0) producerToday.add(hubDayKey());
    if (producerMonth.size === 0) producerMonth.add(hubMonthKey());
    let periodName = null;
    let source = 'live_periods';
    if (range.isSameDay && producerToday.has(startDate)) {
      periodName = 'today';
      source = 'live_today';
    } else if (
      range.coversFullDays
      && startDate.slice(8) === '01'
      && startDate.slice(0, 7) === endDate.slice(0, 7)
      && producerMonth.has(startDate.slice(0, 7))
      && producerToday.has(endDate)
    ) {
      // Full-day span from the first of a producer-reported month through a
      // producer-reported today ≈ the live month window.
      periodName = 'month';
      source = 'live_month';
    }
    if (!periodName) return empty;
    const period = stats?.periods?.[periodName];
    if (!period || number(period.totalTokens) <= 0) return empty;
    return { ...periodToUsageRangePayload(period), source };
  }
  async function getUsageRange(query = {}) {
    const params = query && typeof query === 'object' && !Array.isArray(query)
      ? query
      : {};
    const { normalizeCustomRange } = require('../shared/customRange');
    let range;
    let from;
    let to;

    if (params.startDate || params.endDate || params.since || params.until) {
      range = normalizeCustomRange({
        startDate: params.startDate || params.since,
        endDate: params.endDate || params.until,
        startHour: params.startHour ?? 0,
        endHour: params.endHour ?? 23
      });
      if (!range.ok) {
        const error = new Error(range.error || 'invalid_range');
        error.code = 'invalid_range';
        throw error;
      }
      // A caller that sends both the labels and the instants is stating its own
      // absolute window; use it for the event ledger and head-fill so those
      // sources are not re-derived against the Hub host's clock. `range` still
      // carries the labels, which is what `history_daily` aggregates on.
      if (params.from && params.to) {
        from = parseRangeBound(params.from, 'from');
        to = parseRangeBound(params.to, 'to');
        if (!(from.getTime() < to.getTime())) {
          const error = new Error('from_must_be_before_to');
          error.code = 'invalid_range';
          throw error;
        }
      } else {
        from = new Date(range.startMs);
        to = new Date(range.endMs + 1);
      }
    } else {
      from = parseRangeBound(params.from, 'from');
      to = parseRangeBound(params.to, 'to');
      if (!(from.getTime() < to.getTime())) {
        const error = new Error('from_must_be_before_to');
        error.code = 'invalid_range';
        throw error;
      }
      const timeZone = normalizeRangeTimeZone(params.tz);
      const startDate = calendarDayKeyInZone(from, timeZone);
      const lastInclusive = new Date(Math.max(from.getTime(), to.getTime() - 1));
      const endDate = calendarDayKeyInZone(lastInclusive, timeZone);
      range = normalizeCustomRange({
        startDate,
        endDate,
        startHour: 0,
        endHour: 23
      });
      if (!range.ok) {
        const error = new Error(range.error || 'invalid_range');
        error.code = 'invalid_range';
        throw error;
      }
    }

    // Prefer tokscale graph daily history (same scan family as day/month tabs and
    // Home trends). usage_events attribute deltas by lastUsedAt and can dump
    // all-time counters into recent windows on first ingest / counter reset.
    const historyAgg = aggregateHistoryRange(await getHistory(), from, to, {
      startDate: range.startDate,
      endDate: range.endDate,
      timeZone: resolvedFleetTimeZone
    });
    if (number(historyAgg.matchedDays) > 0 || number(historyAgg.totalTokens) > 0) {
      const { matchedDays, ...payload } = historyAgg;
      const response = {
        from: from.toISOString(),
        to: to.toISOString(),
        startDate: range.startDate,
        endDate: range.endDate,
        startHour: range.startHour,
        endHour: range.endHour,
        source: 'history_daily',
        ...payload
      };
      // The daily history is a rolling window, so a request that reaches further
      // back was silently answered with only the in-window days. Fill the
      // uncovered head from the append-only ledger and say so, instead of
      // presenting a partial total as the whole range.
      if (historyAgg.truncated && historyAgg.coveredFrom && typeof store.aggregateUsageRange === 'function') {
        const uncoveredTo = new Date(`${historyAgg.coveredFrom}T00:00:00.000Z`);
        if (uncoveredTo.getTime() > from.getTime()) {
          try {
            const head = await store.aggregateUsageRange({ from, to: uncoveredTo });
            if (number(head.eventCount) > 0) {
              const merged = { ...emptyUsageRangePayload(), ...payload };
              merged.totalTokens = number(payload.totalTokens) + number(head.totalTokens);
              merged.costUsd = number(payload.costUsd) + number(head.costUsd);
              // `head.clientCredits` is deliberately not merged. Only the
              // ledger-covered head has credits — the daily-history graph has no
              // credit concept — so publishing the head's share as the range's
              // total would repeat exactly the partial-as-whole error this block
              // exists to fix. The answer keeps reporting no credits at all.
              for (const mapName of ['clients', 'clientCosts', 'models', 'modelCosts']) {
                merged[mapName] = { ...(payload[mapName] || {}) };
                for (const [key, value] of Object.entries(head[mapName] || {})) {
                  merged[mapName][key] = number(merged[mapName][key]) + number(value);
                }
              }
              response.totalTokens = merged.totalTokens;
              response.costUsd = merged.costUsd;
              response.clients = merged.clients;
              response.clientCosts = merged.clientCosts;
              response.models = merged.models;
              response.modelCosts = merged.modelCosts;
              response.source = 'history_daily+usage_events';
              response.headSource = 'usage_events';
            }
          } catch (error) {
            logger.warn?.(`[hub-range] head fill failed: ${error?.message || error}`);
          }
        }
      }
      return response;
    }

    const eventsAgg = typeof store.aggregateUsageRange === 'function'
      ? await store.aggregateUsageRange({ from, to })
      : { ...emptyUsageRangePayload(), eventCount: 0 };
    if (number(eventsAgg.eventCount) > 0) {
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        startDate: range.startDate,
        endDate: range.endDate,
        startHour: range.startHour,
        endHour: range.endHour,
        source: 'usage_events',
        totalTokens: Math.round(number(eventsAgg.totalTokens)),
        costUsd: number(eventsAgg.costUsd),
        clients: eventsAgg.clients || {},
        clientCosts: eventsAgg.clientCosts || {},
        clientCredits: eventsAgg.clientCredits || {},
        clientMeasurements: rangeMeasurements({
          clients: eventsAgg.clients,
          clientCredits: eventsAgg.clientCredits
        }),
        models: eventsAgg.models || {},
        modelCosts: eventsAgg.modelCosts || {},
        clientModels: eventsAgg.clientModels || {},
        clientModelCosts: eventsAgg.clientModelCosts || {}
      };
    }

    // Graph history and usage_events can both be empty while live device
    // snapshots still have today/month totals (cold start, history disabled,
    // or first ingest). Reuse those periods for matching full-day windows so
    // custom-range surfaces do not go blank while Day/Month tabs still work.
    const live = await liveUsageRangeFromDevices(range);
    if (number(live.totalTokens) > 0) {
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        startDate: range.startDate,
        endDate: range.endDate,
        startHour: range.startHour,
        endHour: range.endHour,
        source: live.source,
        totalTokens: live.totalTokens,
        costUsd: live.costUsd,
        clients: live.clients,
        clientCosts: live.clientCosts,
        clientCredits: live.clientCredits,
        clientMeasurements: live.clientMeasurements || rangeMeasurements(live),
        models: live.models,
        modelCosts: live.modelCosts,
        clientModels: live.clientModels,
        clientModelCosts: live.clientModelCosts
      };
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      startDate: range.startDate,
      endDate: range.endDate,
      startHour: range.startHour,
      endHour: range.endHour,
      source: 'history_daily',
      ...emptyUsageRangePayload()
    };
  }

  const sseClients = new Set();
  const sseHeartbeats = new Map();
  const sseStates = new Map();
  // Per-client frame shape. `/api/stats/stream?detail=slim` asks for the
  // first-paint projection; a client that omits it keeps receiving the full
  // document it has always received, which is what the shared web/desktop renderer
  // depends on (it reads the session archive and per-device detail straight off the
  // stream and has no re-fetch path). Negotiated per client rather than globally
  // because both kinds can be connected at once.
  const sseShapes = new Map();
  const statsListeners = new Set();

  function sseFormat(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function dropSseClient(res) {
    sseClients.delete(res);
    sseShapes.delete(res);
    const heartbeat = sseHeartbeats.get(res);
    if (heartbeat) clearInterval(heartbeat);
    sseHeartbeats.delete(res);
    const state = sseStates.get(res);
    if (state?.drainTimer) clearTimeout(state.drainTimer);
    if (state?.drainHandler) res.off('drain', state.drainHandler);
    sseStates.delete(res);
    try { res.end(); } catch (_) { /* the socket may already be closed */ }
  }

  function queueLatestSse(state, payload, kind) {
    // Data frames replace either kind of pending frame. Heartbeats are
    // disposable and never replace a pending data snapshot.
    if (!state.pending || kind === 'data' || state.pendingKind !== 'data') {
      state.pending = payload;
      state.pendingKind = kind;
    }
  }

  function writeSse(res, payload, kind = 'data') {
    const state = sseStates.get(res);
    if (!state || !sseClients.has(res)) return false;
    // Registered but still awaiting its first snapshot: writing now would emit an
    // implicit writeHead() with the default content type, so the client would not
    // parse the stream as SSE. Frames are simply skipped until ready; the client
    // receives a fresh snapshot immediately after registration.
    if (state.ready !== true) return false;
    if (state.backpressured) {
      queueLatestSse(state, payload, kind);
      return true;
    }
    try {
      if (res.write(payload)) return true;
    } catch (_) {
      dropSseClient(res);
      return false;
    }
    // `false` means Node reached the writable high-water mark, not that the
    // client is dead. A large but healthy first snapshot commonly crosses it.
    // Wait for drain while keeping only one latest pending frame; only a socket
    // that cannot drain within the bound is removed.
    state.backpressured = true;
    const onDrain = () => {
      if (sseStates.get(res) !== state) return;
      if (state.drainTimer) clearTimeout(state.drainTimer);
      state.drainTimer = null;
      state.drainHandler = null;
      state.backpressured = false;
      const pending = state.pending;
      const pendingKind = state.pendingKind;
      state.pending = null;
      state.pendingKind = null;
      if (pending) writeSse(res, pending, pendingKind);
    };
    state.drainHandler = onDrain;
    res.once('drain', onDrain);
    state.drainTimer = setTimeout(() => dropSseClient(res), SSE_WRITE_TIMEOUT_MS);
    state.drainTimer.unref?.();
    return true;
  }

  // The frame each subscriber asked for, built once per shape per broadcast.
  //
  // A frame is re-sent on every ingest broadcast, so shipping the full snapshot to
  // a phone made each device's tick cost it megabytes. `detail=slim` subscribers
  // get the first-paint projection plus the `historyRevision` /
  // `deviceHistoryRevision` tokens that tell them the omitted documents moved;
  // everyone else keeps the full document.
  async function statsFrames(reason, stats, at) {
    let full = null;
    let slim = null;
    const payloadFor = async (shape) => {
      if (shape !== 'slim') {
        if (full === null) full = sseFormat('stats', { type: 'stats', reason, stats, at });
        return full;
      }
      if (slim === null) {
        slim = sseFormat('stats', { type: 'stats', reason, stats: await getStatsSummary(), at });
      }
      return slim;
    };
    for (const res of sseClients) {
      writeSse(res, await payloadFor(sseShapes.get(res)));
    }
  }

  async function broadcastStats(reason = 'update', statsOverride = null) {
    if (sseClients.size === 0 && statsListeners.size === 0) return;
    const stats = statsOverride || await getStatsBundle();
    const at = new Date().toISOString();
    if (sseClients.size > 0) await statsFrames(reason, stats, at);
    for (const listener of statsListeners) {
      try { listener(stats, reason, at); } catch (_) { /* listener errors must not break ingest */ }
    }
  }

  async function ingest(payload, { includeStats = false } = {}) {
    if (!payload || (!payload.deviceId && !payload.id)) {
      throw new Error('deviceId_required');
    }
    const usagePayload = { ...payload };
    delete usagePayload.limits;
    // A limits-only update describes no usage: it carries provider quota data and
    // nothing else. docs/API.md accepts the flag "for mixed-version compatibility",
    // and usage.js has a mergeDeviceRecord branch for it, but stripping the flag
    // before the merge made that branch unreachable — so a limits-only body was
    // treated as a full update, zeroing the device's periods, deleting its session
    // rows, and making the next real tick look like a counter reset (which then
    // re-added the whole all-time snapshot to the ledger).
    const limitsOnly = payload.limitsOnly === true;
    delete usagePayload.limitsOnly;
    validateDeviceRecordPayload(usagePayload);
    const deviceId = String(usagePayload.deviceId || usagePayload.id);
    const record = await withDeviceIngestLock(deviceId, async () => store.transaction(async (connection) => {
      // The database row lock covers multiple Hub processes; the small process
      // lock above also serializes first-ingest races before a device row exists.
      if (typeof store.lockDevice === 'function') await store.lockDevice(deviceId, connection);
      const existing = await store.getDeviceRecord(deviceId, connection);
      const merged = mergeDeviceRecord(existing, {
        ...usagePayload,
        receivedAt: new Date().toISOString(),
        ...(limitsOnly ? { limitsOnly: true } : {})
      });
      merged.limits = normalizeLimitsSummary({});
      if (limitsOnly) {
        // No usage to record: keep the stored periods/sessions and the ledger
        // untouched. Only the carried-forward attribution may have changed.
        await store.saveDevice(merged, connection);
        return merged;
      }
      // Deltas come from the ingest baseline, not the display snapshot: a
      // transfer rewrites the display snapshot but pins the baseline, so the
      // next upload after a transfer books only genuinely new usage.
      const baselineState = typeof store.getIngestBaseline === 'function'
        ? await store.getIngestBaseline(deviceId, connection)
        : { snapshot: existing, transferred: false };
      const baseline = baselineState?.snapshot || existing;
      const { candidates, events } = calculateUsageEventDeltas(baseline, merged);
      // A transferred device's display snapshot is re-derived, not replaced:
      // previous display + (fresh cumulative - baseline). Without this the
      // device's next full cumulative report would put the transferred history
      // back into the aggregate even though the ledger booked none of it.
      if (baselineState?.transferred) {
        merged.periods = reanchorTransferredPeriods(merged.periods, baseline.periods || {});
      }
      const pricingByModel = await store.getPricing(events.map((event) => event.model), connection);
      const pricedEvents = events.map((event) => priceSnapshot(event, pricingByModel.get(event.model)));
      await store.saveDevice(merged, connection);
      await store.insertUsageEvents(merged.deviceId, pricedEvents, connection);
      await store.replaceSessions(merged.deviceId, summarizeSessions(candidates), connection);
      return merged;
    }));
    invalidateStatsCache();
    // The transaction has committed by now, so the payload IS stored. A failure
    // while building or broadcasting the response must not be reported as a client
    // error: the old code let it fall into the route's catch-all and answer
    // `400 bad_request`, which told agents their data was rejected when it had
    // actually been accepted (so they retried and alerted for the wrong reason).
    let stats = null;
    if (includeStats || sseClients.size > 0 || statsListeners.size > 0) {
      try {
        const bundle = await getStatsBundle();
        stats = bundle;
        await broadcastStats('ingest', bundle);
      } catch (error) {
        logger.warn?.(`[hub-ingest] post-commit stats/broadcast failed: ${error?.message || error}`);
        stats = null;
      }
    }
    if (!includeStats || !stats) return record;
    return { record, stats };
  }

  // A transferred device re-reports cumulative counters that still include the
  // moved history. Its display periods must show only what is left: for every
  // counter, previous display + (fresh - baseline). The same arithmetic the
  // collector's watch ticks use (applyPeriodDelta), applied against the transfer
  // anchor instead of a scan anchor. Never negative — a counter reset simply
  // re-anchors.
  function reanchorTransferredPeriods(periods, anchorPeriods) {
    const reanchored = {};
    for (const periodName of PERIODS) {
      reanchored[periodName] = reanchorPeriodAgainstAnchor(
        periods?.[periodName] || {},
        anchorPeriods?.[periodName] || {}
      );
    }
    return reanchored;
  }

  function reanchorPeriodAgainstAnchor(period, anchor) {
    // Own-null handling: keys the anchor knows were moved to the target and must
    // not reappear in the display, even though the fresh cumulative report still
    // lists them.
    const result = {};
    for (const [key, value] of Object.entries(period)) {
      if (Object.prototype.hasOwnProperty.call(anchor, key) && key !== 'capabilities') continue;
      result[key] = value;
    }
    for (const [key, value] of Object.entries(period)) {
      if (key === 'capabilities' || key === 'estimated' || key === 'sessions' || key === 'projects') continue;
      const anchorValue = anchor[key];
      if (typeof value === 'number') {
        result[key] = Math.max(0, value - (typeof anchorValue === 'number' ? anchorValue : 0));
        continue;
      }
      if (value && typeof value === 'object') {
        result[key] = reanchorPeriodAgainstAnchor(value, anchorValue && typeof anchorValue === 'object' ? anchorValue : {});
      }
    }
    // Sessions/projects keep only entries the anchor did not cover; those are
    // genuinely new and stay as reported.
    for (const mapKey of ['sessions', 'projects']) {
      if (!period[mapKey] || typeof period[mapKey] !== 'object') continue;
      const anchorMap = anchor[mapKey] && typeof anchor[mapKey] === 'object' ? anchor[mapKey] : {};
      const kept = {};
      for (const [key, value] of Object.entries(period[mapKey])) {
        if (Object.prototype.hasOwnProperty.call(anchorMap, key)) continue;
        kept[key] = value;
      }
      result[mapKey] = kept;
    }
    return result;
  }

  // Move a source device's entire recorded history to a target device that
  // already exists. The source keeps its identity and keeps reporting: its
  // display snapshot is cleared and its ingest baseline is pinned to the
  // pre-transfer cumulative counters and flagged `transferred`, so the next
  // upload books only genuinely new usage — in the ledger AND in the display
  // aggregate. Target periods are additively merged (mergePeriods) and target
  // sessions are summed per (client, session) — the ledger rows move wholesale,
  // which is what keeps the custom-range answers unchanged.
  async function transferDeviceData(sourceDeviceId, targetDeviceId) {
    const sourceId = String(sourceDeviceId || '').trim();
    const targetId = String(targetDeviceId || '').trim();
    if (!sourceId) { const e = new Error('source device id required'); e.code = 'device_id_required'; throw e; }
    if (!targetId) { const e = new Error('target device id required'); e.code = 'target_device_id_required'; throw e; }
    if (sourceId === targetId) { const e = new Error('source and target devices must differ'); e.code = 'same_device'; throw e; }
    validateDeviceRecordPayload({ deviceId: sourceId });
    validateDeviceRecordPayload({ deviceId: targetId });

    return withDeviceIngestLock(sourceId, () => withDeviceIngestLock(targetId, () => store.transaction(async (connection) => {
      if (typeof store.lockDevice === 'function') {
        await store.lockDevice(sourceId, connection);
        await store.lockDevice(targetId, connection);
      }
      const sourceRecord = await store.getDeviceRecord(sourceId, connection);
      if (!sourceRecord) { const e = new Error('source device not found'); e.code = 'not_found'; throw e; }
      const targetRecord = await store.getDeviceRecord(targetId, connection);
      if (!targetRecord) { const e = new Error('target device not found'); e.code = 'target_not_found'; throw e; }

      const sourceNormalized = normalizeDeviceRecord(sourceRecord);
      const targetNormalized = normalizeDeviceRecord(targetRecord);

      // 1. The append-only ledger moves wholesale.
      if (typeof store.moveDeviceUsageEvents === 'function') {
        await store.moveDeviceUsageEvents(sourceId, targetId, connection);
      }

      // 2. Sessions merge additively per (client, session) so a session present
      // on both sides sums instead of colliding or overwriting.
      if (typeof store.mergeDeviceSessions === 'function') {
        await store.mergeDeviceSessions(sourceId, targetId, connection);
      }

      // 3. Display periods merge additively; history documents fold together.
      const now = new Date().toISOString();
      const periods = {};
      for (const periodName of PERIODS) {
        periods[periodName] = mergePeriods(
          targetNormalized.periods?.[periodName],
          sourceNormalized.periods?.[periodName]
        );
      }
      const mergedRecord = {
        ...targetNormalized,
        updatedAt: now,
        receivedAt: now,
        periods,
        history: mergeHistoryDocuments(targetNormalized.history, sourceNormalized.history)
      };
      mergedRecord.limits = normalizeLimitsSummary({});
      await store.saveDevice(mergedRecord, connection);

      // 4. The source device is removed by the Hub. Its ledger rows already
      // moved, its display snapshot is folded into the target, and its ingest
      // baseline must go with it: a fresh upload under the same ID then starts
      // from a clean baseline (the operator re-identifies the source device in
      // its own settings). deleteDevice keeps the devices row as a soft-delete
      // tombstone, which is what stops re-ingest from double-counting.
      await store.deleteDevice(sourceId, connection);
      if (typeof store.saveIngestBaseline === 'function') {
        await store.saveIngestBaseline(sourceId, sourceNormalized, { transferred: true }, connection);
      }
      return { source: sourceNormalized, target: targetNormalized, merged: mergedRecord, removedSource: true };
    })));
  }

  // History documents around a transfer.
  //
  // Target side (mergeHistoryDocuments): the source's rows fold into the
  // target's additively — same day keys sum, new day keys append. Summary maps
  // add; non-numeric summary entries (favourite model, streaks) take the
  // target's.
  //
  // Source side: the transfer writes an explicit empty document so the device
  // stops displaying moved history. Its next upload re-derives what is left
  // through reanchorTransferredPeriods, which drops anchor-covered daily rows
  // and keeps genuinely new ones.
  function _emptyHistoryDocument() {
    return { daily: [], monthly: [], summary: {} };
  }

  function mergeHistoryDocuments(a, b) {
    if (!a || (!a.daily?.length && !a.monthly?.length && !Object.keys(a.summary || {}).length)) {
      return b ? coerceHistoryDocument(b) : null;
    }
    if (!b || (!b.daily?.length && !b.monthly?.length && !Object.keys(b.summary || {}).length)) {
      return coerceHistoryDocument(a);
    }
    const target = coerceHistoryDocument(a);
    const incoming = coerceHistoryDocument(b);
    return {
      daily: mergeHistoryRows(target.daily, incoming.daily, 'date'),
      monthly: mergeHistoryRows(target.monthly, incoming.monthly, 'month'),
      summary: mergeHistorySummaries(target.summary, incoming.summary)
    };
  }

  function coerceHistoryDocument(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      daily: Array.isArray(source.daily) ? source.daily.map((row) => ({ ...row })) : [],
      monthly: Array.isArray(source.monthly) ? source.monthly.map((row) => ({ ...row })) : [],
      summary: source.summary && typeof source.summary === 'object' ? { ...source.summary } : {}
    };
  }

  function mergeHistoryRows(targetRows, incomingRows, keyField) {
    const byKey = new Map();
    const numeric = new Set(['tokens', 'cost', 'messages', 'activeTimeMs', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']);
    for (const row of targetRows) {
      const key = String(row?.[keyField] || '');
      if (!key) continue;
      byKey.set(key, { ...row });
    }
    for (const row of incomingRows) {
      const key = String(row?.[keyField] || '');
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...row });
        continue;
      }
      for (const field of numeric) {
        if (row[field] !== undefined || existing[field] !== undefined) {
          existing[field] = (Number(existing[field]) || 0) + (Number(row[field]) || 0);
        }
      }
      for (const mapField of ['perClient', 'perModel']) {
        const targetMap = existing[mapField] && typeof existing[mapField] === 'object' ? existing[mapField] : {};
        const incomingMap = row[mapField] && typeof row[mapField] === 'object' ? row[mapField] : {};
        for (const [name, value] of Object.entries(incomingMap)) {
          const current = targetMap[name] && typeof targetMap[name] === 'object' ? targetMap[name] : {};
          targetMap[name] = {
            ...current,
            tokens: (Number(current.tokens) || 0) + (Number(value?.tokens) || 0),
            cost: (Number(current.cost) || 0) + (Number(value?.cost) || 0)
          };
        }
        existing[mapField] = targetMap;
      }
    }
    return [...byKey.values()].sort((x, y) => String(x[keyField] || '').localeCompare(String(y[keyField] || '')));
  }

  function mergeHistorySummaries(targetSummary, incomingSummary) {
    const merged = { ...targetSummary };
    for (const [key, value] of Object.entries(incomingSummary)) {
      if (typeof value !== 'number' && typeof merged[key] !== 'number') continue;
      merged[key] = (Number(merged[key]) || 0) + (Number(value) || 0);
    }
    return merged;
  }

  async function recordAccountAudit(principal, action, accountId = '', details = null) {
    logger.info?.(`[hub-audit] ${principal?.id || 'unknown'} ${action}${accountId ? ` ${accountId}` : ''}`);
    if (typeof store.appendHubAccountAudit !== 'function') return;
    try {
      await store.appendHubAccountAudit(accountId, action, principal?.id || '', details);
    } catch (error) {
      logger.warn?.(`[hub-account-audit] ${error.message}`);
    }
  }

  function accountErrorStatus(error) {
    if (error?.code === 'account_duplicate') return 409;
    if (error?.code === 'account_not_found') return 404;
    if (['provider_unsupported', 'provider_manual_login_unavailable', 'credential_required', 'credential_invalid', 'credential_too_large'].includes(error?.code)) return 400;
    if (['unauthorized', 'notConfigured', 'rateLimited', 'sourceRateLimited'].includes(error?.code)) return 422;
    if (error?.code === 'unavailable') return 502;
    return 400;
  }

  function accountUnavailable(res) {
    return sendJson(res, 503, {
      error: 'hub_accounts_not_configured',
      message: 'Set TOKEN_MONITOR_SECRET and run the Hub account migration first.'
    });
  }

  async function deleteDevice(deviceId) {
    const deleted = await store.transaction((connection) => store.deleteDevice(deviceId, connection));
    invalidateStatsCache();
    await broadcastStats('delete');
    return deleted;
  }

  async function renameDevice(previousDeviceId, nextDeviceId) {
    const result = await store.transaction((connection) => (
      store.renameDevice(previousDeviceId, nextDeviceId, connection)
    ));
    if (result?.renamed) {
      invalidateStatsCache();
      await broadcastStats('rename');
    }
    return result;
  }

  async function setPricing(model, prices, source = 'manual') {
    const item = await store.upsertPricing(model, prices, source);
    return item;
  }

  async function fetchUpstreamPricing(model) {
    const modelId = String(model || '').trim();
    if (!modelId) {
      const error = new Error('model_required');
      error.code = 'model_required';
      throw error;
    }
    let result;
    let primaryError = null;
    try {
      result = await lookupPricing(modelId);
    } catch (error) {
      primaryError = error;
    }
    let prices = upstreamPrices(result);
    if (!prices) {
      try {
        // tokscale itself reads this public model catalog. Keep its CLI as the
        // primary source, but survive hosts where raw.githubusercontent.com is
        // blocked while models.dev remains reachable.
        prices = upstreamPrices(await fallbackPricing(modelId));
      } catch (fallbackError) {
        if (fallbackError.code === 'pricing_not_found' || isMissingPricingError(fallbackError)) {
          throw pricingNotFound(modelId);
        }
        const error = new Error(`Could not retrieve upstream pricing for ${modelId}: ${primaryError?.message || fallbackError.message}`);
        error.code = 'pricing_lookup_failed';
        throw error;
      }
    }
    if (!prices) {
      throw pricingNotFound(modelId);
    }
    return setPricing(modelId, prices, 'tokscale_upstream');
  }

  async function fetchAllUpstreamPricing() {
    const models = await store.listKnownModels();
    const results = [];
    for (const model of models) {
      try {
        results.push({ model, ok: true, pricing: await fetchUpstreamPricing(model) });
      } catch (error) {
        results.push({ model, ok: false, error: error.code || 'pricing_lookup_failed', message: error.message });
      }
    }
    return results;
  }

  function onStats(listener) {
    statsListeners.add(listener);
    return () => statsListeners.delete(listener);
  }

  async function handleRequest(req, res) {
    if (req.method === 'OPTIONS') return sendText(res, 204, '');
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/rates') {
      return sendJson(res, 200, { ok: true, ...(await getDisplayRates()) });
    }

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        role: 'hub',
        runtime: 'node-hub',
        version: 1,
        apiVersion: HUB_API_VERSION,
        capabilities,
         hubBuild: currentHubBuild('node-hub'),
         deviceCount: await store.countDevices(),
         secretRequired: auth.secretRequired,
         ...(resolvedFleetTimeZone ? { fleetTimeZone: resolvedFleetTimeZone } : {}),
         now: new Date().toISOString()
      });
    }

    // Web UI / PWA assets share the hub port so Docker only needs one publish.
    // Static files stay unauthenticated; every /api/* route still requires the secret.
    if (await tryServeStatic(req, res, webRoot ? { webRoot } : {})) return;

    const authorize = (scope, options = {}) => {
      const result = auth.authorize(req, scope, options);
      if (result.ok) {
        if (options.ingest && options.consumeRateLimit !== false) {
          const limited = ingestRequests.take(result.principal.id);
          if (!limited.ok) {
            sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) });
            return null;
          }
        }
        return result;
      }
      let peer = String(req.socket?.remoteAddress || 'unknown');
      // Forwarded client-IP headers are only trustworthy behind a proxy that
      // overwrites them. The `cf-connecting-ip` branch used to run even when
      // trustProxy was off, so an unauthenticated caller could pick its own
      // rate-limit bucket per request (rotating it also evicted other clients'
      // counters) and the documented auth-failure throttle never fired.
      if (isTrustProxy) {
        const xForwardedFor = req.headers['x-forwarded-for'];
        if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
          const clientIp = xForwardedFor.split(',')[0].trim();
          if (clientIp) peer = clientIp;
        } else if (typeof req.headers['x-real-ip'] === 'string' && req.headers['x-real-ip'].trim()) {
          peer = req.headers['x-real-ip'].trim();
        } else if (typeof req.headers['cf-connecting-ip'] === 'string' && req.headers['cf-connecting-ip'].trim()) {
          peer = req.headers['cf-connecting-ip'].trim();
        }
      }
      const limited = authFailures.take(peer);
      if (!limited.ok) {
        sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) });
        return null;
      }
      sendJson(res, result.status, { error: result.error });
      return null;
    };
    const audit = (principal, action, target = '') => {
      logger.info?.(`[hub-audit] ${JSON.stringify({
        at: new Date().toISOString(),
        principal: principal?.id || 'unknown',
        action,
        target: String(target || '')
      })}`);
    };
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/capabilities') {
      const result = authorize(AUTHENTICATED_SCOPE);
      if (!result) return;
      return sendJson(res, 200, {
         apiVersion: HUB_API_VERSION,
         capabilities,
         authenticated: true
      });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/accounts') {
      const result = authorize(AUTHENTICATED_SCOPE);
      if (!result) return;
      if (!accountService) return accountUnavailable(res);
      const accounts = await accountService.listAccounts({ includeCredentialMetadata: true });
      return sendJson(res, 200, {
        ok: true,
        authority: 'hub',
        providers: accountService.supportedProviders(),
        accounts
      });
    }
    const readRoute = (req.method === 'GET' || req.method === 'HEAD') && (
      [
        '/api/stats',
        '/api/stats/summary',
        '/api/sessions',
        '/api/devices',
        '/api/history',
        '/api/subscriptions',
        '/api/usage/range',
        '/api/pricing',
        '/api/stats/stream'
      ].includes(url.pathname)
      // A device detail is `/api/devices/<id>`; the collection itself stays an
      // exact match above so this prefix cannot swallow it.
      || /^\/api\/devices\/[^/]+$/.test(url.pathname)
    );
    if (readRoute && !authorize(AUTHENTICATED_SCOPE)) return;

    if (req.method === 'GET' && url.pathname === '/api/stats/summary') {
      return sendJson(res, 200, await getStatsSummary());
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') return sendJson(res, 200, await getStats());
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      // Keep this endpoint on the same normalized/staleness boundary as
      // /api/stats. Returning raw ingest snapshots here exposes top-level
      // today/month/allTime fields, which the Android DTO intentionally does
      // not consume, and lets an old snapshot masquerade as today's usage.
      const stats = await getStats();
      return sendJson(res, 200, { devices: stats.devices });
    }
    // One device's full periods, including the session archive and the
    // client×model grain the fleet summary omits. A device detail view needs
    // *one* machine's detail; before this it had to download every machine's.
    if (req.method === 'GET' && /^\/api\/devices\/[^/]+$/.test(url.pathname)) {
      const deviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length));
      const stats = await getStats();
      const device = stats.devices.find((entry) => String(entry.deviceId || '') === deviceId);
      if (!device) return sendJson(res, 404, { error: 'device_not_found', deviceId });
      return sendJson(res, 200, { device });
    }
    // The aggregate session list on its own, so `/api/stats` can stop carrying
    // it for a screen the user may never open. Capped for display, matching the
    // shared UI's session table; the cap is reported rather than implied.
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const stats = await getStats();
      const requested = String(url.searchParams.get('period') || '').trim();
      const periods = requested && PERIODS.includes(requested)
        ? [requested]
        : ['today', 'month', 'allTime'];
      let rows = [];
      for (const periodName of periods) {
        const sessions = stats.periods?.[periodName]?.sessions || {};
        rows = rows.concat(Object.values(sessions).map((session) => ({ ...session, period: periodName })));
      }
      rows.sort((left, right) => String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || '')));
      const shown = rows.slice(0, SESSION_LIST_LIMIT);
      return sendJson(res, 200, { total: rows.length, shown: shown.length, sessions: shown });
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const deviceId = String(url.searchParams.get('deviceId') || '').trim();
      const document = await getHistory(deviceId);
      // The document is derived entirely from stored records (no wall clock), so
      // its revision is a complete identity and a repeat read can be answered
      // without a body. That matters because "re-ask for history" is what the
      // client does when the stream's `historyRevision` moves.
      const etag = `"hist-${historyRevision(document)}${deviceId ? `-${deviceId}` : ''}"`;
      if (sendNotModifiedIfFresh(req, res, etag)) return;
      return sendJson(res, 200, document, { etag });
    }
    if (req.method === 'GET' && url.pathname === '/api/subscriptions') {
      return sendJson(res, 200, { ok: true, ...(await getSubscriptions()) });
    }
    if (req.method === 'PUT' && url.pathname === '/api/subscriptions') {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      try {
        const payload = await readJsonBody(req);
        const stored = await setSubscriptions(payload?.subscriptions, payload?.baseUpdatedAt);
        audit(owner.principal, 'subscriptions.replace');
        return sendJson(res, 200, { ok: true, ...stored });
      } catch (error) {
        if (error.code === 'stale_write') return sendJson(res, 409, { error: 'stale_write', ...error.current });
        if (error.code === 'bad_subscriptions') return sendJson(res, 400, { error: 'bad_request', message: error.message });
        if (error.code === 'payload_too_large') {
          res.shouldKeepAlive = false;
          return sendJson(res, 413, { error: 'payload_too_large', message: error.message }, { connection: 'close' });
        }
        // Storage-side failures are ours, not the caller's: answer 5xx so the agent
        // retries, and keep internal text out of the response.
        if (error.code === 'ER_CON_COUNT_ERROR' || error.code === 'POOL_ENQUEUELIMIT' || error.code === 'PROTOCOL_CONNECTION_LOST') {
          res.shouldKeepAlive = false;
          return sendJson(res, 503, { error: 'hub_busy', message: 'Hub database pool is saturated; retry shortly.' }, { connection: 'close' });
        }
        if (/^(ER_|PROTOCOL_|ECONN|ETIMEDOUT|ENOTFOUND)/.test(String(error.code || ''))) {
          logger.error?.(error);
          return sendJson(res, 503, { error: 'hub_storage_unavailable', message: 'Hub storage is temporarily unavailable.' });
        }
        return sendJson(res, 400, { error: 'bad_request', message: errorMessageForApi(error) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/usage/range') {
      try {
        return sendJson(res, 200, await getUsageRange({
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          startDate: url.searchParams.get('startDate') || url.searchParams.get('since'),
          endDate: url.searchParams.get('endDate') || url.searchParams.get('until'),
          startHour: url.searchParams.get('startHour'),
          endHour: url.searchParams.get('endHour'),
          tz: url.searchParams.get('tz')
        }));
      } catch (error) {
        const status = error.code === 'invalid_range' ? 400 : 500;
        return sendJson(res, status, { error: error.code || 'bad_request', message: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/pricing') return sendJson(res, 200, { pricing: await store.listPricing() });

    if (req.method === 'POST' && url.pathname === '/api/accounts') {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      if (!accountService) return accountUnavailable(res);
      try {
        const body = await readJsonBody(req);
        const account = await accountService.addAccount({
          provider: body?.provider,
          name: body?.name,
          label: body?.label,
          credential: body?.credential
        });
        await recordAccountAudit(owner.principal, 'account.add', account.id, { provider: account.provider });
        return sendJson(res, 201, { ok: true, account });
      } catch (error) {
        return sendJson(res, accountErrorStatus(error), {
          error: error.code || 'account_add_failed',
          message: errorMessageForApi(error)
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/oauth/start') {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      if (!accountService) return accountUnavailable(res);
      try {
        const body = await readJsonBody(req);
        const provider = String(body?.provider || '').trim().toLowerCase();
        const session = oauthManager.startSession(provider);
        return sendJson(res, 200, { ok: true, ...session });
      } catch (error) {
        return sendJson(res, 400, { error: error.code || 'oauth_start_failed', message: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/oauth/exchange') {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      if (!accountService) return accountUnavailable(res);
      try {
        const body = await readJsonBody(req);
        const sessionId = String(body?.sessionId || '').trim();
        const redirectUrl = String(body?.redirectUrl || '').trim();
        const name = String(body?.name || '').trim();
        const label = String(body?.label || '').trim();
        if (!sessionId || !redirectUrl) {
          return sendJson(res, 400, { error: 'invalid_params', message: 'sessionId and redirectUrl are required' });
        }
        const exchanged = await oauthManager.exchangeSession(sessionId, redirectUrl, {
          fetch: oauthHttpFetch
        });
        // `accountId` turns the exchange into an in-place re-authorization of an
        // account the owner is editing; without it this stays the add-a-new-account
        // path. The credential itself is identical either way.
        const targetId = String(body?.accountId || '').trim();
        if (targetId) {
          const account = await accountService.authorizeAccount(targetId, {
            credential: exchanged.credential,
            name,
            label
          });
          if (!account) return sendJson(res, 404, { error: 'account_not_found' });
          await recordAccountAudit(owner.principal, 'account.reauthorize', targetId, { provider: account.provider });
          return sendJson(res, 200, { ok: true, account });
        }
        const account = await accountService.addAccount({
          provider: exchanged.provider,
          name: name || `${exchanged.provider}-${Date.now().toString(36)}`,
          label,
          credential: exchanged.credential
        });
        await recordAccountAudit(owner.principal, 'account.add_oauth', account.id, { provider: account.provider });
        return sendJson(res, 201, { ok: true, account });
      } catch (error) {
        return sendJson(res, accountErrorStatus(error), {
          error: error.code || 'oauth_exchange_failed',
          message: errorMessageForApi(error)
        });
      }
    }

    if (url.pathname.startsWith('/api/accounts/')) {
      const suffix = url.pathname.slice('/api/accounts/'.length);
      const refreshSuffix = '/refresh';
      const credentialSuffix = '/credential';
      const isRefresh = suffix.endsWith(refreshSuffix);
      const isCredential = !isRefresh && suffix.endsWith(credentialSuffix);
      const accountId = decodeURIComponent(
        isRefresh ? suffix.slice(0, -refreshSuffix.length)
          : isCredential ? suffix.slice(0, -credentialSuffix.length)
            : suffix
      );
      if (!accountId) return sendJson(res, 400, { error: 'account_id_required' });
      // Clear an account's stored credential while keeping the account itself, so
      // the owner can re-authorize the same row instead of adding a duplicate.
      if (req.method === 'DELETE' && isCredential) {
        const owner = authorize(AUTHENTICATED_SCOPE);
        if (!owner) return;
        if (!accountService) return accountUnavailable(res);
        try {
          const cleared = await accountService.clearAccountCredential(accountId);
          if (!cleared) return sendJson(res, 404, { error: 'account_not_found' });
          await recordAccountAudit(owner.principal, 'account.credential_cleared', accountId);
          const account = (await accountService.listAccounts({ includeCredentialMetadata: true }))
            .find((item) => item.id === accountId) || null;
          return sendJson(res, 200, { ok: true, account });
        } catch (error) {
          return sendJson(res, accountErrorStatus(error), {
            error: error.code || 'account_credential_clear_failed',
            message: errorMessageForApi(error)
          });
        }
      }
      if (req.method === 'POST' && isRefresh) {
        const owner = authorize(AUTHENTICATED_SCOPE);
        if (!owner) return;
        if (!accountService) return accountUnavailable(res);
        try {
          const account = await accountService.refreshAccount(accountId);
          if (!account) return sendJson(res, 404, { error: 'account_not_found' });
          await recordAccountAudit(owner.principal, 'account.refresh', accountId);
          return sendJson(res, 200, { ok: true, account: (await accountService.listAccounts()).find((item) => item.id === accountId) || null });
        } catch (error) {
          return sendJson(res, accountErrorStatus(error), {
            error: error.code || 'account_refresh_failed',
            message: errorMessageForApi(error)
          });
        }
      }
      if (req.method === 'PATCH') {
        const owner = authorize(AUTHENTICATED_SCOPE);
        if (!owner) return;
        if (!accountService) return accountUnavailable(res);
        try {
          const body = await readJsonBody(req);
          const account = await accountService.updateAccount(accountId, {
            name: body?.name,
            label: body?.label,
            enabled: body?.enabled,
            credentialMode: body?.credentialMode,
            ...(Object.prototype.hasOwnProperty.call(body || {}, 'credential') ? { credential: body.credential } : {})
          });
          if (!account) return sendJson(res, 404, { error: 'account_not_found' });
          await recordAccountAudit(owner.principal, 'account.update', accountId, {
            provider: account.provider,
            credentialReplaced: Object.prototype.hasOwnProperty.call(body || {}, 'credential')
          });
          return sendJson(res, 200, { ok: true, account });
        } catch (error) {
          return sendJson(res, accountErrorStatus(error), {
            error: error.code || 'account_update_failed',
            message: errorMessageForApi(error)
          });
        }
      }
      if (req.method === 'DELETE') {
        const owner = authorize(AUTHENTICATED_SCOPE);
        if (!owner) return;
        if (!accountService) return accountUnavailable(res);
        try {
          const deleted = await accountService.deleteAccount(accountId);
          if (!deleted) return sendJson(res, 404, { error: 'account_not_found' });
          await recordAccountAudit(owner.principal, 'account.delete', accountId);
          return sendJson(res, 200, { ok: true, accountId });
        } catch (error) {
          return sendJson(res, accountErrorStatus(error), {
            error: error.code || 'account_delete_failed',
            message: errorMessageForApi(error)
          });
        }
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/stats/stream') {
      // Register and subscribe BEFORE the first await. Node emits 'close' only
      // once: a client that disconnects while getStats() is still running used to
      // miss the subscription entirely, leaving a dead response in sseClients
      // forever (plus its heartbeat interval). The leak rate was proportional to
      // getStats() latency, so a busy Hub leaked fastest — a probe measured 1500
      // of 1500 aborted connections retained.
      if (sseClients.size >= maxSseClients) {
        // Refuse rather than evict: an existing dashboard should not be dropped to
        // make room for a new one.
        return sendJson(res, 503, {
          error: 'too_many_streams',
          message: `Hub already has ${sseClients.size} live streams (max ${maxSseClients}); retry later.`
        }, { 'retry-after': '30' });
      }
      sseClients.add(res);
      sseShapes.set(res, url.searchParams.get('detail') === 'slim' ? 'slim' : 'full');
      sseStates.set(res, {
        ready: false,
        backpressured: false,
        pending: null,
        pendingKind: null,
        drainHandler: null,
        drainTimer: null
      });
      const cleanup = () => dropSseClient(res);
      // Subscribe on the RESPONSE, not the request. A GET request has already had
      // its (empty) body fully read by the time the handler runs, so 'close' on
      // `req` fires immediately and would tear the stream down before the snapshot
      // is written. `res` emits 'close' when the response finishes or the socket
      // goes away, which is the event this teardown actually needs. The 'error'
      // listener keeps an async write failure to a dying socket from becoming an
      // uncaughtException.
      res.on('close', cleanup);
      res.on('error', cleanup);

      const slim = sseShapes.get(res) === 'slim';
      const snapshot = slim ? await getStatsSummary() : await getStats();
      // The client may have gone away during the await.
      if (res.destroyed || res.writableEnded) {
        dropSseClient(res);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      const streamState = sseStates.get(res);
      if (!streamState || !sseClients.has(res)) return;
      streamState.ready = true;
      if (!writeSse(res, sseFormat('snapshot', { type: 'stats', reason: 'snapshot', stats: snapshot, at: new Date().toISOString() }))) return;
      // Heartbeats intentionally do not query MySQL. Slow reads therefore never
      // delay the fixed 30-second SSE keepalive cadence.
      const heartbeat = setInterval(() => { writeSse(res, ': hb\n\n', 'heartbeat'); }, sseHeartbeatMs);
      sseHeartbeats.set(res, heartbeat);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ingest') {
      if (!authorize(AUTHENTICATED_SCOPE, { ingest: true })) return;
      try {
        const payload = await readJsonBody(req);
        const deviceId = String(payload?.deviceId || payload?.id || '').trim();
        if (!authorize(AUTHENTICATED_SCOPE, { ingest: true, deviceId, consumeRateLimit: false })) return;
        const minimalResponse = /(?:^|,)\s*return=minimal\s*(?:,|$)/i.test(String(req.headers.prefer || ''));
        const result = await ingest(payload, { includeStats: !minimalResponse });
        const fleetField = resolvedFleetTimeZone ? { fleetTimeZone: resolvedFleetTimeZone } : {};
        if (minimalResponse) return sendJson(res, 200, { ok: true, deviceId: result.deviceId, ...fleetField });
        return sendJson(res, 200, { ok: true, deviceId: result.record.deviceId, stats: result.stats, ...fleetField });
      } catch (error) {
        if (error.message === 'deviceId_required') return sendJson(res, 400, { error: 'deviceId_required' });
        if (error.code === 'field_too_long' || error.code === 'too_many_entries' || error.code === 'invalid_payload') {
          return sendJson(res, 400, {
            error: error.code,
            message: error.message,
            ...(error.field ? { field: error.field } : {}),
            ...(error.maxLength ? { maxLength: error.maxLength } : {}),
            ...(error.maxEntries ? { maxEntries: error.maxEntries } : {})
          });
        }
        if (error.code === 'payload_too_large') {
          res.shouldKeepAlive = false;
          return sendJson(res, 413, { error: 'payload_too_large', message: error.message }, { connection: 'close' });
        }
        return sendJson(res, 400, { error: 'bad_request', message: error.message });
      }
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/api/pricing/')) {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      try {
        const model = decodeURIComponent(url.pathname.slice('/api/pricing/'.length));
        if (!model) return sendJson(res, 400, { error: 'model_required' });
        const pricing = await setPricing(model, normalizePrices(await readJsonBody(req)));
        audit(owner.principal, 'pricing.replace', model);
        return sendJson(res, 200, { ok: true, pricing });
      } catch (error) {
        return sendJson(res, 400, { error: error.code || 'bad_request', message: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/pricing/fetch-upstream-all') {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      const results = await fetchAllUpstreamPricing();
      audit(owner.principal, 'pricing.refresh_all');
      return sendJson(res, 200, { results });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/pricing/') && url.pathname.endsWith('/fetch-upstream')) {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      const model = decodeURIComponent(url.pathname.slice('/api/pricing/'.length, -'/fetch-upstream'.length));
      try {
        const pricing = await fetchUpstreamPricing(model);
        audit(owner.principal, 'pricing.refresh', model);
        return sendJson(res, 200, { ok: true, pricing });
      } catch (error) {
        const status = error.code === 'pricing_not_found' || error.code === 'model_required' ? 422 : 502;
        return sendJson(res, status, { error: error.code || 'pricing_lookup_failed', message: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/devices/') && url.pathname.endsWith('/rename')) {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      const previousDeviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length, -'/rename'.length));
      try {
        const body = await readJsonBody(req);
        const nextDeviceId = String(body?.deviceId || '').trim();
        if (!previousDeviceId || !nextDeviceId) return sendJson(res, 400, { error: 'device_id_required' });
        validateDeviceRecordPayload({ deviceId: previousDeviceId });
        validateDeviceRecordPayload({ deviceId: nextDeviceId });
        const result = await renameDevice(previousDeviceId, nextDeviceId);
        if (result?.reason === 'not_found' || result?.reason === 'baseline_missing') {
          return sendJson(res, 404, { error: result.reason });
        }
        if (result?.reason === 'target_exists') return sendJson(res, 409, { error: 'target_exists' });
        if (!result?.renamed) return sendJson(res, 400, { error: result?.reason || 'rename_failed' });
        audit(owner.principal, 'device.rename', `${previousDeviceId}->${nextDeviceId}`);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        if (error.code === 'field_too_long') {
          return sendJson(res, 400, { error: error.code, message: error.message, field: error.field, maxLength: error.maxLength });
        }
        if (error.code === 'payload_too_large') return sendJson(res, 413, { error: error.code, message: error.message });
        return sendJson(res, 400, { error: error.code || 'bad_request', message: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/devices/') && url.pathname.endsWith('/transfer')) {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      const sourceDeviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length, -'/transfer'.length));
      try {
        const body = await readJsonBody(req);
        const targetDeviceId = String(body?.targetDeviceId || '').trim();
        await transferDeviceData(sourceDeviceId, targetDeviceId);
        audit(owner.principal, 'device.transfer', `${sourceDeviceId}->${targetDeviceId}`);
        invalidateStatsCache();
        try {
          const stats = await getStatsBundle();
          await broadcastStats('transfer', stats);
        } catch (error) {
          logger.warn?.(`[hub-transfer] post-commit stats/broadcast failed: ${error?.message || error}`);
        }
        return sendJson(res, 200, { ok: true, sourceDeviceId, targetDeviceId });
      } catch (error) {
        if (error.code === 'device_id_required') return sendJson(res, 400, { error: 'device_id_required' });
        if (error.code === 'target_device_id_required') return sendJson(res, 400, { error: 'target_device_id_required' });
        if (error.code === 'same_device') return sendJson(res, 400, { error: 'same_device' });
        if (error.code === 'not_found') return sendJson(res, 404, { error: 'not_found' });
        if (error.code === 'target_not_found') return sendJson(res, 404, { error: 'target_not_found' });
        if (error.code === 'field_too_long') {
          return sendJson(res, 400, { error: error.code, message: error.message, field: error.field, maxLength: error.maxLength });
        }
        return sendJson(res, 500, { error: 'transfer_failed', message: 'Device data transfer failed.' });
      }
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/devices/')) {
      const owner = authorize(AUTHENTICATED_SCOPE);
      if (!owner) return;
      const deviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length));
      await deleteDevice(deviceId);
      audit(owner.principal, 'device.delete', deviceId);
      return sendJson(res, 200, { ok: true, deviceId });
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  const requestListener = (req, res) => {
    handleRequest(req, res).catch((error) => {
      (logger.error || console.error)(error);
      // A saturated MySQL pool (queueLimit reached) is a capacity problem, not an
      // internal bug: report 503 so clients retry instead of treating it as a
      // malformed request. Never echo raw driver text to the caller.
      const code = error?.code || '';
      if (code === 'ER_CON_COUNT_ERROR' || code === 'POOL_ENQUEUELIMIT' || code === 'PROTOCOL_CONNECTION_LOST') {
        res.shouldKeepAlive = false;
        return sendJson(res, 503, { error: 'hub_busy', message: 'Hub database pool is saturated; retry shortly.' }, { connection: 'close' });
      }
      return sendJson(res, 500, { error: 'internal_error', message: errorMessageForApi(error) });
    });
  };
  const server = tlsOptions
    ? https.createServer(tlsOptions, requestListener)
    : http.createServer(requestListener);

  async function start() {
    // Fail before opening the listening socket when migrations have not run or
    // MySQL credentials are unusable. The Docker entrypoint runs migrations first.
    await store.countDevices();
    if (accountService) await store.listHubAccounts();
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => {
        server.off('error', onError);
        accountService?.start();
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, bindHost);
    });
  }

  async function stop() {
    await accountService?.stop();
    for (const res of [...sseClients]) dropSseClient(res);
    sseClients.clear();
    for (const heartbeat of sseHeartbeats.values()) clearInterval(heartbeat);
    sseHeartbeats.clear();
    sseStates.clear();
    // Drop keep-alive / half-drained sockets so close() cannot hang (e.g. fetch
    // clients that never read a static body, or browsers that linger).
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(() => resolve()));
    if (ownedPool && activePool) await activePool.end();
  }

  function replaceAuthPolicy(nextAuthPolicy) {
    if (!nextAuthPolicy || typeof nextAuthPolicy.authorize !== 'function') {
      throw new TypeError('next Hub auth policy must provide authorize()');
    }
    // Binding safety is decided before listen(). Do not permit a live public
    // server to transition between configured and unauthenticated states.
    if (Boolean(nextAuthPolicy.configured) !== Boolean(auth.configured)) {
      throw new Error('live Hub auth replacement must preserve configured state');
    }
    auth = nextAuthPolicy;
    return auth.summary;
  }

  return {
    start,
    stop,
    server,
    getStats,
    getStatsSummary,
    getHistory,
    getSubscriptions,
    getUsageRange,
    ingest,
    renameDevice,
    deleteDevice,
    onStats,
    setPricing,
    setSubscriptions,
    fetchUpstreamPricing,
    fetchAllUpstreamPricing,
    accountService,
    replaceAuthPolicy,
    bindHost,
    protocol,
    getCachedStats: () => statsCache,
    // Observability for the SSE registry: a monotonic leak here is what made a
    // busy Hub degrade until restart. Exposed for tests and health diagnostics.
    getSseClientCount: () => sseClients.size
  };
}

if (require.main === module) {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.TOKEN_MONITOR_PORT || 17321);
  const host = String(args.host || process.env.TOKEN_MONITOR_HOST || '0.0.0.0');
  const secret = String(args.secret || process.env.TOKEN_MONITOR_SECRET || '').trim();
  const staleAfterMs = Number(args.staleAfterMs || process.env.TOKEN_MONITOR_STALE_AFTER_MS || 10 * 60 * 1000);
  const fleetTimeZone = String(
    args.fleetTimeZone
    || args['fleet-time-zone']
    || process.env.TOKEN_MONITOR_FLEET_TIMEZONE
    || ''
  ).trim();
  const hub = createHub({
    port,
    host,
    secret,
    fleetTimeZone,
    accountCredentialKey: args.accountCredentialKey
      || args['account-credential-key']
      || process.env.TOKEN_MONITOR_HUB_CREDENTIAL_KEY
      || '',
    accountRefreshMs: Number(args.accountRefreshMs
      || args['account-refresh-ms']
      || process.env.TOKEN_MONITOR_HUB_REFRESH_MS
      || 5 * 60 * 1000),
    accountConcurrency: Number(args.accountConcurrency
      || args['account-concurrency']
      || process.env.TOKEN_MONITOR_HUB_ACCOUNT_CONCURRENCY
      || 4),
    allowInsecureHttp: args.allowInsecureHttp || args['allow-insecure-http'] || process.env.TOKEN_MONITOR_ALLOW_INSECURE_HTTP,
    trustProxy: args.trustProxy || args['trust-proxy'] || process.env.TOKEN_MONITOR_TRUST_PROXY,
    staleAfterMs
  });
  hub.start()
    .then(() => {
      console.log(`Jiran hub listening on ${hub.protocol}://${hub.bindHost}:${port}`);

      // A non-loopback bind with no credential is silently rewritten to loopback,
      // which inside a container makes the published port dead while the container
      // reports healthy. Say so loudly instead of leaving it to the operator to
      // notice the 127.0.0.1 in the startup line.
      if (String(process.env.TOKEN_MONITOR_HOST || '').trim() && hub.bindHost !== String(process.env.TOKEN_MONITOR_HOST).trim()) {
        console.warn(
          `[hub-config] TOKEN_MONITOR_HOST=${process.env.TOKEN_MONITOR_HOST} was ignored because no credential is configured; `
          + `bound to ${hub.bindHost}. Set TOKEN_MONITOR_SECRET (docker compose: .env) or the published port will not answer.`
        );
      }

      // Global uncaught exception and unhandled rejection protection.
      //
      // Node's contract is that resuming after an uncaught exception is unsafe:
      // state machines and in-flight callbacks are left undefined. Logging and
      // carrying on turns a self-healing restart (Compose sets
      // restart: unless-stopped) into a silently degraded process that can only
      // be fixed by hand, so exit instead.
      let fatalExitArmed = false;
      process.on('uncaughtException', (err) => {
        console.error(`[hub-fatal] uncaughtException: ${err?.message || err}`);
        if (err?.stack) console.error(err.stack);
        if (fatalExitArmed) return;
        fatalExitArmed = true;
        const timer = setTimeout(() => process.exit(1), 2000);
        timer.unref?.();
        Promise.resolve()
          .then(() => hub.stop())
          .catch(() => {})
          .finally(() => process.exit(1));
      });

      process.on('unhandledRejection', (reason) => {
        console.error(`[hub-warn] unhandledRejection: ${reason?.message || reason}`);
        if (reason?.stack) console.error(reason.stack);
      });

      // Graceful shutdown on SIGTERM / SIGINT
      let shuttingDown = false;
      const gracefulShutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}, shutting down gracefully...`);
        try {
          await hub.stop();
          console.log('Hub stopped cleanly.');
          process.exit(0);
        } catch (stopErr) {
          console.error(`Error stopping hub: ${stopErr?.message || stopErr}`);
          process.exit(1);
        }
      };

      process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
    })
    .catch((error) => { console.error(`Could not start hub: ${error.message}`); process.exitCode = 1; });
}

module.exports = { createHub, normalizePrices, priceSnapshot, resolveBindHost, loadTlsOptions, upstreamPrices, aggregateHistoryRange, emptyUsageRangePayload };
