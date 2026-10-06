'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { customPricingPath } = require('./tokscaleConfig');
const { dayKeyOf, monthKeyOf, normalizeTimeZone, startOfDayMs } = require('./fleetTimeZone');
const QODER_DB_SUFFIX = path.join('SharedClientCache', 'cache', 'db', 'local.db');
const QODER_MAIN_DB_NAME = 'main.sqlite';

function defineMeasurementProvenance(row, tokenProvenance, costProvenance) {
  Object.defineProperty(row, 'tokenProvenance', {
    value: tokenProvenance, enumerable: false, configurable: true
  });
  Object.defineProperty(row, 'costProvenance', {
    value: costProvenance, enumerable: false, configurable: true
  });
  return row;
}

// Per-site on-disk layout. Qoder and Qoder CN share a transcript schema (same
// top-level keys, same `message.usage` shape, same model-code family) but not a
// profile root, app-support directory name, or Electron bundle id, so the
// adapter is parameterized by site rather than duplicated.
//
// `profileEnvVar` is the *client's own* relocation variable, and only the CN
// client has one this adapter may trust. The CN runtime exports
// QODERCN_CONFIG_DIR pointing at its own profile, which is how a relocated CN
// profile is found. The international runtime exports QODER_CONFIG_DIR too —
// and on a machine where only Qoder CN is installed it exports it pointing at
// `~/.qoder-cn` (verified 2026-09-26: both variables held the same path). So
// `global` resolves its profile from homeDir alone and accepts only
// Token-Monitor-namespaced overrides; honouring QODER_CONFIG_DIR there would
// bill CN usage to the `qoder` client, which is the same double-attribution
// failure mode `micode` is warned about in clientTracking.js.
//
// Naming: this module predates the international client, so its exported
// symbols are spelled `*QoderCn*`. Those names are historical, not a scope
// limit — every entry point takes `options.site` (`'cn'` | `'global'`, default
// `'cn'`) and resolves its roots, client id and emitted row ids through
// QODER_SITES. Renaming ~260 call sites is a separate mechanical change and is
// deliberately not mixed into the multi-site work.
const QODER_SITES = Object.freeze({
  cn: Object.freeze({
    clientId: 'qodercn',
    profileDirName: '.qoder-cn',
    profileEnvVar: 'QODERCN_CONFIG_DIR',
    appSupportDirNames: Object.freeze(['QoderCN']),
    // `com.qodercn.app.stable` is verified on Linux (Qoder CN 0.4.2, where the
    // previously hardcoded `com.qoder.app.stable` does not exist and this source
    // was therefore never read). `com.qoder.app.stable` is the spelling Qoder CN
    // 0.1.x used *and* the international app's own bundle id — a genuinely
    // shared directory, resolved by the footprint gate in
    // `selectQoderMainDbPaths` rather than by candidate order alone. Declared
    // order still matters: the current spelling is tried first.
    mainBundleIds: Object.freeze(['com.qodercn.app.stable', 'com.qoder.app.stable']),
    dbEnvVar: 'TOKEN_MONITOR_QODER_CN_DB_PATH',
    mainDbEnvVar: 'TOKEN_MONITOR_QODER_CN_MAIN_DB_PATH',
    transcriptsEnvVars: Object.freeze([
      'TOKEN_MONITOR_QODER_CN_TRANSCRIPTS_DIR',
      'TOKEN_MONITOR_QODERCN_TRANSCRIPTS_DIR',
      'TOKEN_MONITOR_QODER_CN_TRANSCRIPTS_PATH'
    ])
  }),
  global: Object.freeze({
    clientId: 'qoder',
    profileDirName: '.qoder',
    profileEnvVar: null,
    appSupportDirNames: Object.freeze(['Qoder']),
    // Unverified for the international desktop app: only its CLI is installed on
    // the reference machine (`~/.config/Qoder/qodercli`, no main.sqlite). The
    // candidate is retained so a machine that does have the desktop build is
    // read, and the shared-id footprint gate keeps a Qoder CN 0.1.x install from
    // being billed to this client.
    mainBundleIds: Object.freeze(['com.qoder.app.stable']),
    dbEnvVar: 'TOKEN_MONITOR_QODER_DB_PATH',
    mainDbEnvVar: 'TOKEN_MONITOR_QODER_MAIN_DB_PATH',
    transcriptsEnvVars: Object.freeze(['TOKEN_MONITOR_QODER_TRANSCRIPTS_DIR'])
  })
});

const QODER_SITE_IDS = Object.freeze(Object.keys(QODER_SITES));

// Bundle ids claimed by more than one site. A directory named after one of them
// proves only that *a* Qoder desktop app ran, not which one, so a site may read
// it only when that site's own footprint (app-support directory or profile
// directory) is present. Derived from QODER_SITES so adding a site that reuses
// an id cannot silently reintroduce cross-attribution.
const SHARED_QODER_MAIN_BUNDLE_IDS = new Set((() => {
  const counts = new Map();
  for (const siteId of QODER_SITE_IDS) {
    for (const bundleId of QODER_SITES[siteId].mainBundleIds) {
      counts.set(bundleId, (counts.get(bundleId) || 0) + 1);
    }
  }
  return [...counts].filter(([, claimedBy]) => claimedBy > 1).map(([bundleId]) => bundleId);
})());

function normalizeQoderSite(value, fallback = 'cn') {
  const site = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(QODER_SITES, site) ? site : fallback;
}

// Reverse index. The collector keys its per-client state by the tracked client
// id while this module resolves roots by site, so one direction is derived from
// the other rather than hand-maintained as a pair that can drift.
const QODER_SITE_BY_CLIENT_ID = Object.freeze(Object.fromEntries(
  QODER_SITE_IDS.map((siteId) => [QODER_SITES[siteId].clientId, siteId])
));
const QODER_CLIENT_IDS = Object.freeze(Object.keys(QODER_SITE_BY_CLIENT_ID));

function normalizeQoderClientId(value, fallback = 'qodercn') {
  const clientId = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(QODER_SITE_BY_CLIENT_ID, clientId) ? clientId : fallback;
}

// The single place an entry point turns caller options into `{site, clientId}`.
// `options.clientId` wins over `options.site`: a caller that already knows the
// tracked id (the collector does) must not be able to ask for one site's roots
// and stamp another site's client id on the rows.
function resolveQoderSiteOptions(options = {}) {
  const byClientId = QODER_SITE_BY_CLIENT_ID[normalizeQoderClientId(options.clientId, '')];
  const siteId = byClientId || normalizeQoderSite(options.site, 'cn');
  return { site: siteId, clientId: QODER_SITES[siteId].clientId };
}

function firstNonEmptyEnv(env, names) {
  for (const name of names) {
    const value = String(env?.[name] || '').trim();
    if (value) return value;
  }
  return '';
}
// Qoder stores internal model codes (model_info.model_key / transcript
// message.model) instead of real model names. The authoritative code→name table
// is the client's own i18n bundle, key `modelSelector.item.<code>`, shipped as
// `<home>/.qoder/.auth/dynamic-texts.json` (verified 2026-09-26 against the
// international client; Qoder CN has no such file, so this table is its only
// source). Two rules keep it useful:
//
//   1. Map to the underlying model a catalog can price, not the marketing
//      label. tokscale resolves display names case-insensitively against
//      models.dev, so a program name prices as nothing: `q35model_preview` is
//      sold as "Qwen3.7-Max-DogFooding" but *is* Qwen3.7-Max, and `dfmodel` is
//      sold as "DeepSeek-Flash" but its own description says DeepSeek-V4.1-Flash.
//   2. Never drop a retired code. Codes are recycled between releases and
//      historical rows keep referencing the old ones, so a deleted entry turns
//      real past usage back into a raw code. `qmodel_preview` is such a row.
//
// Unmapped codes (custom models) pass through unchanged. The routing tiers in
// QODER_CN_ROUTING_TIERS are plan slots, not models, and are excluded from
// pricing separately — they are named here only so they display readably.
const QODER_CN_MODEL_DISPLAY_NAMES = Object.freeze({
  auto: 'Auto',
  cmodel: 'Cantus', // Qoder-branded; no underlying model published, so unpriceable
  dashscope_qmodel: 'Qwen3.7-Plus',
  dashscope_qwen3_coder: 'Qwen3-Coder-Plus',
  dashscope_qwen_max_latest: 'Qwen3-Max',
  dfmodel: 'DeepSeek-V4.1-Flash',
  dmodel: 'DeepSeek-V4-Pro',
  efficient: 'Efficient',
  'experts-auto': 'Auto',
  'experts-ultimate': 'Ultimate',
  gfmodel: 'GLM-5.3-Flash', // Qoder CN 0.1.2 client flash slot
  gm51model: 'GLM-5.2',
  gmodel: 'GLM-5.3',
  kmodel: 'Kimi-K2.8-Preview',
  kmodel_latest: 'Kimi-K3',
  lite: 'Lite',
  mmodel: 'MiniMax-M3',
  performance: 'Performance',
  q35model: 'Qwen3.5-Plus',
  q35model_preview: 'Qwen3.7-Max', // "Qwen3.7-Max-DogFooding" slot
  q36fmodel: 'Qwen3.6-Flash',
  q37fmodel: 'Qwen3.7-Flash',
  qfmodel: 'Qwen3.8-Flash', // the dominant code in current transcripts
  qmodel: 'Qwen3.7-Plus',
  qmodel_38max: 'Qwen3.8-Max',
  qmodel_latest: 'Qwen3.7-Max',
  qmodel_preview: 'Qwen3.8-Max-Preview', // retired code, still in older rows
  'quest-auto': 'Auto',
  'quest-ultimate': 'Ultimate',
  smodel: 'Sonus', // Qoder-branded; no underlying model published, so unpriceable
  ultimate: 'Ultimate'
});
// Plan slots rather than models: the transcript names the tier, not the model
// behind it, so an unrelated catalog entry must not supply a false price. The
// `experts-*` / `quest-*` variants are the same five tiers on other surfaces;
// every caller maps a code to its display name before this set is consulted, so
// they collapse to the base names here and need no entries of their own.
const QODER_CN_ROUTING_TIERS = new Set(['auto', 'ultimate', 'performance', 'efficient', 'lite']);
const QODER_CN_READ_MAX_BYTES = 250 * 1024 * 1024;
const QODER_CN_READ_MAX_ROWS = 100_000;
const QODER_CN_NEGATIVE_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const QODER_CN_READ_BUDGET_ERROR = 'QODER_CN_READ_BUDGET_EXCEEDED';
const QODER_CN_SQLITE_BACKEND_UNAVAILABLE = 'QODER_CN_SQLITE_BACKEND_UNAVAILABLE';
const QODER_CN_USAGE_SQL = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create,
  (SELECT cs.project_name FROM chat_session cs WHERE cs.session_id = chat_message.session_id LIMIT 1) AS project_name
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
ORDER BY gmt_create, rowid
`;
const QODER_CN_NORMALIZED_TIMESTAMP_SQL = `
CASE
  WHEN typeof(gmt_create) = 'text' AND strftime('%s', trim(gmt_create)) IS NOT NULL
    THEN CAST(strftime('%s', trim(gmt_create)) AS REAL) * 1000
  WHEN typeof(gmt_create) = 'text' AND CAST(trim(gmt_create) AS REAL) > 0
    AND CAST(trim(gmt_create) AS REAL) < 1000000000000
    THEN CAST(trim(gmt_create) AS REAL) * 1000
  WHEN typeof(gmt_create) = 'text' AND CAST(trim(gmt_create) AS REAL) >= 1000000000000
    THEN CAST(trim(gmt_create) AS REAL)
  WHEN typeof(gmt_create) = 'text'
    THEN 0
  WHEN CAST(gmt_create AS REAL) > 0 AND CAST(gmt_create AS REAL) < 1000000000000
    THEN CAST(gmt_create AS REAL) * 1000
  ELSE CAST(gmt_create AS REAL)
END
`;
const QODER_CN_USAGE_SINCE_SQL = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create,
  (SELECT cs.project_name FROM chat_session cs WHERE cs.session_id = chat_message.session_id LIMIT 1) AS project_name
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
  AND (typeof(gmt_create) != 'text' AND (${QODER_CN_NORMALIZED_TIMESTAMP_SQL}) >= ?
    OR typeof(gmt_create) = 'text' AND (${QODER_CN_NORMALIZED_TIMESTAMP_SQL}) >= ? - 86400000)
ORDER BY gmt_create, rowid
`;

// Fallbacks for Qoder CN versions whose database has no chat_session table:
// the scalar subquery would fail the whole read, so probe once per process and
// use the plain queries instead (sessions then stay unattributed).
const QODER_CN_USAGE_SQL_NO_PROJECT = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
ORDER BY gmt_create, rowid
`;
const QODER_CN_USAGE_SINCE_SQL_NO_PROJECT = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
  AND (typeof(gmt_create) != 'text' AND (${QODER_CN_NORMALIZED_TIMESTAMP_SQL}) >= ?
    OR typeof(gmt_create) = 'text' AND (${QODER_CN_NORMALIZED_TIMESTAMP_SQL}) >= ? - 86400000)
ORDER BY gmt_create, rowid
`;
const QODER_CN_MAIN_USAGE_SQL = `
SELECT m.session_id, m.message_id, m.sequence, m.payload_json, m.created_at,
  s.model AS session_model
FROM chat_session_messages AS m
LEFT JOIN chat_sessions AS s ON s.session_id = m.session_id
ORDER BY m.session_id, m.created_at, m.sequence, m.message_id
`;
// A partially migrated 0.1.x database may not have the session catalog yet.
// The conversation rows remain useful without the optional model join, so
// retain a strict no-session fallback instead of turning that version into a
// false zero-usage result.
const QODER_CN_MAIN_USAGE_SQL_NO_SESSION = `
SELECT m.session_id, m.message_id, m.sequence, m.payload_json, m.created_at
FROM chat_session_messages AS m
ORDER BY m.session_id, m.created_at, m.sequence, m.message_id
`;
const QODER_CN_CHAT_SESSION_PROBE_SQL = `SELECT 1 FROM sqlite_master
WHERE type = 'table' AND name = 'chat_session'
  AND EXISTS (SELECT 1 FROM pragma_table_info('chat_session') WHERE name = 'project_name')
LIMIT 1`;

function normalizeQoderCnProjectLabel(value) {
  // '.' is Qoder CN's "no project" sentinel; keep it unattributed so it does
  // not surface as a phantom project named '.' in the Projects view.
  const label = String(value || '').trim();
  return label === '.' ? '' : label;
}

// Positive capabilities remain cached. Confirmed-absent capabilities use a
// bounded TTL so an in-place Qoder schema migration becomes visible without
// probing every legacy database on every collector tick. Transient probe
// failures are never cached.
const qoderCnChatSessionTableCache = new Map();

// Returns true when chat_session.project_name exists, false when the database
// was read successfully without it, or null when the probe itself failed.
async function probeQoderCnChatSessionTable(dbPath, { run, requireFn } = {}) {
  const probe = QODER_CN_CHAT_SESSION_PROBE_SQL;
  try {
    if (run) {
      const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, probe], {
        encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000, windowsHide: true
      });
      const parsed = JSON.parse(String(result?.stdout || '').trim() || '[]');
      return Array.isArray(parsed) ? parsed.length > 0 : null;
    }
  } catch (_) { /* fall through to node:sqlite */ }
  try {
    const requireFnLocal = requireFn || require;
    const { DatabaseSync } = requireFnLocal('node:sqlite');
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 250');
      return database.prepare(probe).get() !== undefined;
    } finally {
      database.close();
    }
  } catch (_) {
    return null;
  }
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 && number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function sourceId(value) {
  return createHash('sha256').update(path.normalize(String(value || ''))).digest('hex').slice(0, 12);
}

function isQoderCnRoutingTier(value) {
  return QODER_CN_ROUTING_TIERS.has(String(value || '').trim().toLowerCase());
}

function estimatedQoderCnRowCost(row, pricingByModel) {
  // Qoder CN stores routing tiers without the model selected behind them. Do
  // not let an unrelated catalog/custom-pricing entry supply a false price.
  const modelId = String(row?.model || '').trim().toLowerCase();
  if (isQoderCnRoutingTier(modelId)) return null;
  const pricing = pricingByModel?.[modelId];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

const QODER_CN_PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const QODER_CN_PRICING_LOOKUP_TIMEOUT_MS = 3000;
const qoderCnPricingCache = new Map();

function qoderCnPricingRevision() {
  try { return fs.statSync(customPricingPath()).mtimeMs; } catch (_) { return 0; }
}

function normalizeQoderCnPricing(result) {
  const source = result?.pricing;
  if (!source || typeof source !== 'object') return null;
  const pick = (key) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const pricing = {
    inputCostPerToken: pick('inputCostPerToken'),
    outputCostPerToken: pick('outputCostPerToken'),
    cacheReadInputTokenCost: pick('cacheReadInputTokenCost'),
    cacheCreationInputTokenCost: pick('cacheCreationInputTokenCost')
  };
  return pricing.inputCostPerToken !== undefined || pricing.outputCostPerToken !== undefined ? pricing : null;
}

async function resolveQoderCnPricing(rows, options = {}) {
  const lookup = options.lookupModelPricing;
  const revision = options.pricingRevision ?? qoderCnPricingRevision();
  const nowMs = options.nowMs ?? Date.now();
  const commandTimeoutMs = options.commandTimeoutMs || QODER_CN_PRICING_LOOKUP_TIMEOUT_MS;
  const pricingByModel = {};
  const modelIds = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.model || '').trim().toLowerCase())
    .filter((modelId) => modelId && !isQoderCnRoutingTier(modelId)))];
  for (const modelId of modelIds) {
    const cached = qoderCnPricingCache.get(modelId);
    if (cached && cached.revision === revision && nowMs - cached.at < QODER_CN_PRICING_CACHE_TTL_MS) {
      if (cached.pricing) pricingByModel[modelId] = cached.pricing;
      continue;
    }
    let pricing = null;
    try {
      pricing = normalizeQoderCnPricing(await lookup(modelId, commandTimeoutMs));
    } catch (_) {
      // An unknown model, offline lookup, or custom channel must remain
      // cost-unavailable instead of inheriting an unrelated catalog price.
    }
    qoderCnPricingCache.set(modelId, { at: nowMs, revision, pricing });
    if (pricing) pricingByModel[modelId] = pricing;
  }
  return pricingByModel;
}

function resetQoderCnPricingCache() {
  qoderCnPricingCache.clear();
}

function normalizeQoderCnDbRow(row, source = 'local', clientId = 'qodercn') {
  const usage = jsonObject(row?.token_info);
  const prompt = numeric(usage?.prompt_tokens);
  const cached = numeric(usage?.cached_tokens ?? 0);
  const output = numeric(usage?.completion_tokens);
  if (prompt === null || cached === null || output === null || prompt + output === 0) return null;

  const session = String(row?.session_id || row?.request_id || row?.id || row?.row_id || 'unknown');
  const message = String(row?.id || row?.request_id || row?.row_id || `${row?.gmt_create || 0}`);
  const modelInfo = jsonObject(row?.model_info);
  const modelKey = String(modelInfo?.model_key || modelInfo?.modelKey || 'qoder-agent');
  const displayName = Object.prototype.hasOwnProperty.call(QODER_CN_MODEL_DISPLAY_NAMES, modelKey)
    ? QODER_CN_MODEL_DISPLAY_NAMES[modelKey]
    : null;
  const namespace = normalizeQoderClientId(clientId, 'qodercn');
  const normalized = {
    sessionId: `${namespace}:${source}:${session}`,
    messageId: `${namespace}:${source}:${session}:${message}`,
    model: displayName || modelKey,
    projectLabel: normalizeQoderCnProjectLabel(row?.project_name),
    input: Math.max(0, prompt - cached),
    output,
    cacheRead: Math.min(prompt, cached),
    cacheWrite: 0,
    createdAt: timestampMs(row?.gmt_create),
    messages: 1
  };
  defineMeasurementProvenance(normalized, 'exact', 'estimated');
  const stableIdentity = String(row?.request_id || row?.requestId || row?.id || '').trim();
  if (stableIdentity) defineTranscriptIdentity(normalized, [stableIdentity]);
  return normalized;
}

function qoderAppSupportDir(home, platform, env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'win32') {
    return (typeof env.APPDATA === 'string' && env.APPDATA.length > 0)
      ? env.APPDATA
      : path.join(home, 'AppData', 'Roaming');
  }
  const xdg = env.XDG_CONFIG_HOME;
  return (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(home, '.config');
}

function qoderDataPaths(options = {}) {
  const { site: siteId } = resolveQoderSiteOptions(options);
  const site = QODER_SITES[siteId];
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  // Electron callers may provide a host-plus-architecture label (for example
  // `darwin-arm64`) while Node's platform APIs use the host family alone.
  // Normalize at the shared descriptor boundary so parser, watcher, and anchor
  // callers cannot silently resolve different roots.
  const platform = String(options.platform || process.platform).split('-')[0];
  const appSupport = qoderAppSupportDir(home, platform, env);

  const explicitDb = firstNonEmptyEnv(env, [site.dbEnvVar]);
  const explicitMainDb = firstNonEmptyEnv(env, [site.mainDbEnvVar]);
  // See QODER_SITES: only a site that names its own client variable may read
  // it, so `global` never resolves through the ambient QODER_CONFIG_DIR.
  const configuredHome = site.profileEnvVar ? String(env[site.profileEnvVar] || '').trim() : '';
  const profileHome = configuredHome ? path.resolve(configuredHome) : path.join(home, site.profileDirName);
  const explicitTranscripts = firstNonEmptyEnv(env, site.transcriptsEnvVars);
  const transcriptRoot = explicitTranscripts
    ? path.resolve(explicitTranscripts)
    : path.join(profileHome, 'projects');
  const mainDbPaths = explicitMainDb
    ? [path.resolve(explicitMainDb)]
    : site.mainBundleIds.map((bundleId) => path.join(appSupport, bundleId, QODER_MAIN_DB_NAME));
  // Directories whose presence proves *this* site is installed. Used only to
  // decide whether a bundle id shared with the other site may be read; an
  // explicit TOKEN_MONITOR_*_MAIN_DB_PATH is an operator decision and skips it.
  const siteFootprintDirs = explicitMainDb
    ? []
    : [
      ...site.appSupportDirNames.map((name) => path.join(appSupport, name)),
      profileHome
    ];
  return {
    site: siteId,
    clientId: site.clientId,
    // Candidates are returned even when absent. The watcher needs the dirname
    // of a database that does not exist yet so a later install still triggers
    // a targeted refresh, and the evidence probe reports `not_present` per
    // candidate; readers gate on existence themselves.
    dbPaths: explicitDb
      ? [path.resolve(explicitDb)]
      : site.appSupportDirNames.map((name) => path.join(appSupport, name, QODER_DB_SUFFIX)),
    mainDbPaths,
    gatedMainDbPaths: explicitMainDb
      ? []
      : site.mainBundleIds
        .filter((bundleId) => SHARED_QODER_MAIN_BUNDLE_IDS.has(bundleId))
        .map((bundleId) => path.join(appSupport, bundleId, QODER_MAIN_DB_NAME)),
    siteFootprintDirs,
    // The legacy SQLite source, the desktop message store and the transcript
    // tree are separate roots, but they are one adapter from the collector's
    // point of view. Keep all three in this descriptor so source status,
    // watcher attribution and anchor invalidation cannot drift apart again.
    transcriptRoots: [transcriptRoot]
  };
}

// The Qoder CN descriptor. Kept as its own name because every existing caller
// (collector watch roots, anchor fingerprint, evidence probe) is CN-specific,
// and because a function called `...CnDataPaths` must not silently honour a
// `site: 'global'` argument.
function qoderCnDataPaths(options = {}) {
  return qoderDataPaths({ ...options, site: 'cn' });
}

// A descriptor lists bundle-id *candidates* because the watcher needs the
// dirname of a database that does not exist yet. A reader, on the other hand,
// must not read two candidates that both exist, and must not read a candidate
// that only proves the *other* site is installed:
//
//   - first existing candidate wins, in declaration order, so a machine that
//     kept both an old and a current bundle directory is read once;
//   - a candidate whose bundle id is shared with the other site (see
//     SHARED_QODER_MAIN_BUNDLE_IDS) additionally requires this site's own
//     footprint on disk. Without that gate an international-only machine would
//     bill `com.qoder.app.stable` to `qodercn`, and a Qoder CN 0.1.x-only
//     machine would bill it to `qoder`.
//
// Returns [] when nothing is readable; callers already treat an empty list as
// "source absent".
function selectQoderMainDbPaths(paths) {
  const candidates = Array.isArray(paths?.mainDbPaths) ? paths.mainDbPaths : [];
  const gated = new Set(Array.isArray(paths?.gatedMainDbPaths) ? paths.gatedMainDbPaths : []);
  const footprints = Array.isArray(paths?.siteFootprintDirs) ? paths.siteFootprintDirs : [];
  let footprintPresent = null;
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    if (gated.has(candidate)) {
      if (footprintPresent === null) {
        footprintPresent = footprints.some((dir) => dir && fs.existsSync(dir));
      }
      if (!footprintPresent) continue;
    }
    return [candidate];
  }
  return [];
}

// Anchor-reuse key for one site's source set. The site id is part of the key so
// a collector that tracks both Qoder and Qoder CN cannot reuse one site's anchor
// for the other, and so a future profile relocation invalidates the anchor.
function qoderSourceFingerprint(options = {}) {
  const paths = options.dataPaths || qoderDataPaths(options);
  const dbs = (paths.dbPaths || []).map((value) => path.resolve(value)).join(',');
  const mainDbs = (paths.mainDbPaths || []).map((value) => path.resolve(value)).join(',');
  const transcripts = (paths.transcriptRoots || []).map((value) => path.resolve(value)).join(',');
  return `${paths.site}|db:${dbs}|mainDb:${mainDbs}|transcripts:${transcripts}`;
}

function qoderCnSourceFingerprint(options = {}) {
  return qoderSourceFingerprint({ ...options, site: 'cn' });
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function positiveIntegerOrZero(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function readBudgetError(kind, limit, cause) {
  const error = new Error(`qodercn sqlite read budget exceeded (${kind} limit ${limit})`, cause ? { cause } : undefined);
  error.code = QODER_CN_READ_BUDGET_ERROR;
  return error;
}

function isReadBudgetError(error) {
  return error?.code === QODER_CN_READ_BUDGET_ERROR
    || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function isMissingSqliteCli(error) {
  return error?.code === 'ENOENT'
    || /(?:sqlite3|spawn).*\b(?:enoent|not found|cannot find)\b/i.test(String(error?.message || error));
}

function isMissingNodeSqlite(error) {
  return error?.code === 'MODULE_NOT_FOUND'
    || /node:sqlite.*(?:not available|cannot find|unknown built-in|module)/i.test(String(error?.message || error));
}

function boundedRows(iterable, { maxReadBytes, maxReadRows, countBytes }) {
  const rows = [];
  let bytes = 2; // JSON array brackets; commas are counted as rows are appended.
  for (const row of iterable) {
    if (rows.length >= maxReadRows) throw readBudgetError('rows', maxReadRows);
    if (countBytes) {
      const serialized = JSON.stringify(row);
      bytes += Buffer.byteLength(serialized, 'utf8') + (rows.length > 0 ? 1 : 0);
      if (bytes > maxReadBytes) throw readBudgetError('bytes', maxReadBytes);
    }
    rows.push(row);
  }
  return rows;
}

async function readQoderCnDbRows(dbPath, options = {}) {
  const run = options.execFile || execFileAsync;
  const sinceMs = options.sinceMs;
  const nowMs = options.nowMs ?? Date.now();
  const negativeSchemaCacheTtlMs = positiveIntegerOrZero(
    options.negativeSchemaCacheTtlMs,
    QODER_CN_NEGATIVE_SCHEMA_CACHE_TTL_MS
  );
  const maxReadBytes = positiveInteger(options.maxReadBytes, QODER_CN_READ_MAX_BYTES);
  const maxReadRows = positiveInteger(options.maxReadRows, QODER_CN_READ_MAX_ROWS);
  const cachedProbe = qoderCnChatSessionTableCache.get(dbPath);
  let probed = cachedProbe?.hasProject;
  const negativeCacheFresh = cachedProbe?.hasProject === false
    && nowMs - cachedProbe.at < negativeSchemaCacheTtlMs;
  if (probed === undefined || (probed === false && !negativeCacheFresh)) {
    probed = await probeQoderCnChatSessionTable(dbPath, { run, requireFn: options.requireFn });
    if (probed !== null) qoderCnChatSessionTableCache.set(dbPath, { hasProject: probed, at: nowMs });
  }
  const withProject = probed === true;
  const sql = sinceMs
    ? (withProject ? QODER_CN_USAGE_SINCE_SQL : QODER_CN_USAGE_SINCE_SQL_NO_PROJECT)
    : (withProject ? QODER_CN_USAGE_SQL : QODER_CN_USAGE_SQL_NO_PROJECT);
  const cliArgs = sinceMs
    ? ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql.replace('?', String(sinceMs)).replace('?', String(sinceMs))]
    : ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql];
  try {
    const result = await run('sqlite3', cliArgs, {
      encoding: 'utf8', maxBuffer: maxReadBytes, timeout: 30_000, windowsHide: true
    });
    const stdout = String(result?.stdout || '').trim();
    if (Buffer.byteLength(stdout, 'utf8') > maxReadBytes) throw readBudgetError('bytes', maxReadBytes);
    const parsed = JSON.parse(stdout || '[]');
    return boundedRows(Array.isArray(parsed) ? parsed : [], { maxReadBytes, maxReadRows, countBytes: false });
  } catch (cliError) {
    if (isReadBudgetError(cliError)) {
      const error = cliError.code === QODER_CN_READ_BUDGET_ERROR
        ? cliError
        : readBudgetError('bytes', maxReadBytes, cliError);
      if (typeof options.logger === 'function') options.logger(error.message);
      throw error;
    }
    try {
      const requireFn = options.requireFn || require;
      const { DatabaseSync } = requireFn('node:sqlite');
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        database.exec('PRAGMA busy_timeout = 250');
        const statement = database.prepare(withProject
          ? (sinceMs ? QODER_CN_USAGE_SINCE_SQL : QODER_CN_USAGE_SQL)
          : (sinceMs ? QODER_CN_USAGE_SINCE_SQL_NO_PROJECT : QODER_CN_USAGE_SQL_NO_PROJECT));
        const iterator = sinceMs ? statement.iterate(sinceMs, sinceMs) : statement.iterate();
        return boundedRows(iterator, { maxReadBytes, maxReadRows, countBytes: true });
      } finally {
        database.close();
      }
    } catch (nodeError) {
      if (isReadBudgetError(nodeError)) {
        if (typeof options.logger === 'function') options.logger(nodeError.message);
        throw nodeError;
      }
      // Fail loudly instead of silently returning empty usage. The collector
      // logs the error and retains its last complete snapshot when available.
      const message = `qodercn sqlite read failed: sqlite3 CLI: ${cliError.message}; node:sqlite: ${nodeError.message}`;
      if (typeof options.logger === 'function') options.logger(message);
      const wrapped = new Error(message, { cause: nodeError });
      if (isMissingSqliteCli(cliError) && isMissingNodeSqlite(nodeError)) {
        wrapped.code = QODER_CN_SQLITE_BACKEND_UNAVAILABLE;
      }
      throw wrapped;
    }
  }
}

async function readQoderCnMainDbRows(dbPath, options = {}) {
  const run = options.execFile || execFileAsync;
  const maxReadBytes = positiveInteger(options.maxReadBytes, QODER_CN_READ_MAX_BYTES);
  const maxReadRows = positiveInteger(options.maxReadRows, QODER_CN_READ_MAX_ROWS);
  const queries = [QODER_CN_MAIN_USAGE_SQL, QODER_CN_MAIN_USAGE_SQL_NO_SESSION];
  const cliErrors = [];

  for (const sql of queries) {
    try {
      const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql], {
        encoding: 'utf8', maxBuffer: maxReadBytes, timeout: 30_000, windowsHide: true
      });
      const stdout = String(result?.stdout || '').trim();
      if (Buffer.byteLength(stdout, 'utf8') > maxReadBytes) throw readBudgetError('bytes', maxReadBytes);
      const parsed = JSON.parse(stdout || '[]');
      return boundedRows(Array.isArray(parsed) ? parsed : [], { maxReadBytes, maxReadRows, countBytes: false });
    } catch (cliError) {
      if (isReadBudgetError(cliError)) {
        const error = cliError.code === QODER_CN_READ_BUDGET_ERROR
          ? cliError
          : readBudgetError('bytes', maxReadBytes, cliError);
        if (typeof options.logger === 'function') options.logger(error.message);
        throw error;
      }
      cliErrors.push(cliError);
    }
  }

  const nodeErrors = [];
  try {
    const requireFn = options.requireFn || require;
    const { DatabaseSync } = requireFn('node:sqlite');
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 250');
      for (const sql of queries) {
        try {
          return boundedRows(database.prepare(sql).iterate(), {
            maxReadBytes, maxReadRows, countBytes: true
          });
        } catch (nodeError) {
          if (isReadBudgetError(nodeError)) {
            if (typeof options.logger === 'function') options.logger(nodeError.message);
            throw nodeError;
          }
          nodeErrors.push(nodeError);
        }
      }
    } finally {
      database.close();
    }
  } catch (nodeError) {
    if (isReadBudgetError(nodeError)) throw nodeError;
    nodeErrors.push(nodeError);
  }

  const cliError = cliErrors.at(-1) || new Error('sqlite3 query failed');
  const nodeError = nodeErrors.at(-1) || new Error('node:sqlite query failed');
  const message = `qodercn main sqlite read failed: sqlite3 CLI: ${cliError.message}; node:sqlite: ${nodeError.message}`;
  if (typeof options.logger === 'function') options.logger(message);
  const wrapped = new Error(message, { cause: nodeError });
  if (cliErrors.length > 0 && cliErrors.every(isMissingSqliteCli) && isMissingNodeSqlite(nodeError)) {
    wrapped.code = QODER_CN_SQLITE_BACKEND_UNAVAILABLE;
  }
  throw wrapped;
}

function estimateQoderCnValueTokens(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return estimateQoderCnContentTokens({ content: value });
  return estimateQoderCnContentTokens({ content: [{ content: value }] });
}

function estimateQoderCnMainPayloadTokens(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  const role = String(payload.role || '').trim().toLowerCase();
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const topText = typeof payload.text === 'string' ? payload.text : '';
  let tokens = role === 'user'
    ? estimateQoderCnValueTokens(topText)
    : role === 'assistant' ? estimateQoderCnValueTokens(topText) : 0;

  // In main.sqlite the top-level text is the assembled visible response. Its
  // `type: text` parts are fragments of that same response (their lengths differ
  // slightly because the app inserts separators), so count one representation
  // only. If a future build omits the assembled field, fall back to the parts.
  if (role === 'user' && !topText) {
    for (const part of parts) {
      if (typeof part?.text === 'string') tokens += estimateQoderCnValueTokens(part.text);
    }
  }
  if (role !== 'assistant') return tokens;

  let hasAssembledText = Boolean(topText);
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const type = String(part.type || '').trim().toLowerCase();
    if (type === 'text' && hasAssembledText) continue;
    if (typeof part.text === 'string') tokens += estimateQoderCnValueTokens(part.text);
    if (type !== 'tool' || !part.tool || typeof part.tool !== 'object') continue;
    // Tool input is model output; tool response and explicit question answers
    // become context for later requests in the same turn. The three fields are
    // all bounded by the SQLite result budget before this function sees them.
    tokens += estimateQoderCnValueTokens(part.tool.input);
    tokens += estimateQoderCnValueTokens(part.tool.response);
    tokens += estimateQoderCnValueTokens(part.tool.userQuestionAnswers);
  }
  return tokens;
}

function qoderCnMainHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function normalizeQoderCnMainMessage(row, source, state, contentTokens, clientId = 'qodercn') {
  const payload = jsonObject(row?.payload_json ?? row?.payload);
  if (!payload) return null;
  const rawSession = String(row?.session_id || row?.sessionId || 'unknown');
  const rawMessage = String(row?.message_id || row?.messageId || '').trim();
  const sequence = String(row?.sequence ?? '').trim();
  const messageKey = rawMessage || `${sequence || 'message'}:${timestampMs(row?.created_at)}`;
  const namespace = normalizeQoderClientId(clientId, 'qodercn');
  const sessionId = `${namespace}:main:${source}:${qoderCnMainHash(rawSession)}`;
  const modelKey = String(
    row?.session_model || payload.model || payload.modelName || payload.model_name || 'qoder-agent'
  ).trim() || 'qoder-agent';
  const model = Object.prototype.hasOwnProperty.call(QODER_CN_MODEL_DISPLAY_NAMES, modelKey)
    ? QODER_CN_MODEL_DISPLAY_NAMES[modelKey]
    : modelKey;
  const createdAt = timestampMs(
    payload.timestamp ?? payload.createdAt ?? payload.created_at ?? row?.created_at
  );
  const normalized = {
    sessionId,
    messageId: `${sessionId}:${qoderCnMainHash(messageKey)}`,
    model,
    projectLabel: normalizeQoderCnProjectLabel(row?.project_name || row?.projectLabel),
    // Standard LLM API request model: each request sends the cumulative session context.
    input: Math.max(0, Number(state.cumulativeTokens) || 0),
    output: Math.max(0, Math.trunc(Number(contentTokens) || 0)),
    cacheRead: 0,
    cacheWrite: 0,
    createdAt,
    messages: 1,
    estimated: true
  };
  defineMeasurementProvenance(normalized, 'estimated', 'estimated');
  if (rawMessage) defineTranscriptIdentity(normalized, [rawMessage]);
  // `unknown` is this module's placeholder for a row with no session column; it
  // must not become a join key, or every such row would suppress every other.
  if (rawSession && rawSession !== 'unknown') defineSourceSession(normalized, rawSession);
  return normalized;
}

async function collectQoderCnMainRows(options = {}) {
  // The descriptor is the single authority for both roots and client id, so a
  // caller that hands in its own `dataPaths` cannot end up reading one site's
  // database and stamping another site's client id on the rows.
  const paths = options.dataPaths || qoderDataPaths(options);
  const clientId = normalizeQoderClientId(paths.clientId, resolveQoderSiteOptions(options).clientId);
  // An explicit `mainDbPaths` is a caller-supplied list (tests inject a stub
  // reader against a virtual path), so it is used verbatim; only the
  // descriptor-derived candidate list goes through existence + footprint
  // selection.
  const mainDbPaths = Array.isArray(options.mainDbPaths)
    ? options.mainDbPaths
    : selectQoderMainDbPaths(paths);
  const readMainDbRows = options.readMainDbRows || readQoderCnMainDbRows;
  const sinceMs = options.sinceMs;
  const rows = [];

  for (const dbPath of mainDbPaths) {
    if (!options.readMainDbRows && !fs.existsSync(dbPath)) continue;
    const source = sourceId(`main:${dbPath}`);
    const dbRows = await readMainDbRows(dbPath, { ...options });
    const sessions = new Map();
    for (const dbRow of dbRows) {
      const payload = jsonObject(dbRow?.payload_json ?? dbRow?.payload);
      if (!payload) continue;
      const role = String(payload.role || '').trim().toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      const sessionKey = `${source}\0${String(dbRow?.session_id || dbRow?.sessionId || 'unknown')}`;
      const state = sessions.get(sessionKey) || { cumulativeTokens: 0 };
      const contentTokens = estimateQoderCnMainPayloadTokens(payload);
      if (role === 'assistant') {
        const createdAt = timestampMs(
          payload.timestamp ?? payload.createdAt ?? payload.created_at ?? dbRow?.created_at
        );
        if (sinceMs === undefined || createdAt >= sinceMs) {
          const normalized = normalizeQoderCnMainMessage(dbRow, source, state, contentTokens, clientId);
          if (normalized) rows.push(normalized);
        }
      }
      state.cumulativeTokens += contentTokens;
      sessions.set(sessionKey, state);
    }
  }

  const unique = new Map();
  for (const row of rows) unique.set(row.messageId, row);
  return unique.size === rows.length ? rows : [...unique.values()];
}

async function collectQoderCnRows(options = {}) {
  const paths = options.dataPaths || qoderDataPaths(options);
  const clientId = normalizeQoderClientId(paths.clientId, resolveQoderSiteOptions(options).clientId);
  const dbPaths = Array.isArray(options.dbPaths) ? options.dbPaths : paths.dbPaths;
  const readDbRows = options.readDbRows || readQoderCnDbRows;
  const sinceMs = options.sinceMs;
  const rows = [];

  for (const dbPath of dbPaths) {
    if (!options.readDbRows && !fs.existsSync(dbPath)) continue;
    const source = sourceId(dbPath);
    const dbRows = await readDbRows(dbPath, { ...options, sinceMs });
    for (const dbRow of dbRows) {
      const row = normalizeQoderCnDbRow(dbRow, source, clientId);
      if (row) rows.push(row);
    }
  }

  const unique = new Map();
  for (const row of rows) unique.set(row.messageId, row);
  return [...unique.values()];
}

function buildTokscaleJson(startMs, rows, pricingByModel, includeUndated = false, clientId = 'qodercn', window = null) {
  const client = normalizeQoderClientId(clientId, 'qodercn');
  // A fleet-calendar window arrives as zone day/month keys instead of an epoch
  // start: a row belongs to the calendar day it falls on in the active zone,
  // which is exact even when that day's midnight is not the machine's.
  const todayKey = String(window?.todayKey || '');
  const monthKey = String(window?.monthKey || '');
  const timeZone = normalizeTimeZone(window?.timeZone);
  const grouped = new Map();
  for (const row of rows) {
    // Mirrors promaUsage: dated rows must fall inside the window, undated rows
    // count only for allTime (includeUndated) — never for today/month.
    // An undated row can only be placed in the unbounded all-time window.
    if (!row.createdAt) {
      if ((startMs || todayKey || monthKey) && !includeUndated) continue;
    } else if (todayKey || monthKey) {
      const key = dayKeyOf(new Date(row.createdAt), timeZone);
      if (todayKey ? key !== todayKey : key.slice(0, 7) !== monthKey) continue;
    } else if (startMs && row.createdAt < startMs) {
      continue;
    }
    const key = `${row.sessionId}\0${row.model}`;
    if (!grouped.has(key)) grouped.set(key, {
      ...row, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, credits: 0,
      startedAt: 0, lastUsedAt: 0, cost: 0,
      tokenProvenance: 'exact', costProvenance: 'exact'
    });
    const group = grouped.get(key);
    if (row.tokenProvenance === 'estimated' || row.estimated === true) group.tokenProvenance = 'estimated';
    if (row.costProvenance === 'estimated') group.costProvenance = 'estimated';
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += row.messages;
    // Only the transcript parser sets `credits`; a SQLite row omits the key, so
    // a mixed-source group sums the transcript share and nothing else. That is
    // correct rather than a gap — the databases hold no credit meter to add.
    const credits = Number(row.credits);
    if (Number.isFinite(credits) && credits > 0) group.credits += credits;
    const cost = estimatedQoderCnRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }

  const entries = [...grouped.values()].map((row) => {
    const entry = {
    client, mergedClients: null, sessionId: row.sessionId, model: row.model, provider: client,
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    reasoning: 0, messageCount: row.messages, cost: row.cost, credits: row.credits,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    projectLabel: row.projectLabel || '', performance: null,
    ...(row.estimated === true ? { estimated: true } : {})
    };
    return defineMeasurementProvenance(
      entry,
      row.tokenProvenance || (row.estimated === true ? 'estimated' : 'exact'),
      row.costProvenance || 'estimated'
    );
  });
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model', entries,
    totalInput: sum('input'), totalOutput: sum('output'), totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'), totalMessages: sum('messageCount'), totalCost: sum('cost'), processingTimeMs: 0,
    ...(entries.some((entry) => entry.estimated === true) ? { estimated: true } : {})
  };
}

function buildQoderCnPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const timeZone = normalizeTimeZone(options.timeZone);
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const pricingByModel = options.pricingByModel;
  const clientId = resolveQoderSiteOptions(options).clientId;
  return {
    today: buildTokscaleJson(0, rows, pricingByModel, false, clientId, { todayKey: dayKeyOf(now, timeZone), timeZone }),
    month: buildTokscaleJson(0, rows, pricingByModel, false, clientId, { monthKey: monthKeyOf(now, timeZone), timeZone }),
    allTime: buildTokscaleJson(timestampMs(options.allTimeSince), rows, pricingByModel, true, clientId)
  };
}

function localDateKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * One calendar window over already-collected Qoder rows.
 *
 * `buildQoderCnPeriods` answers the fixed today / month / allTime windows, which
 * is why 昨日 / 本周 and any custom range used to report nothing for both Qoder
 * sites: the tick path never handed its row set to a window-aware builder. Rows
 * carry `createdAt`, so the window is exact; undated rows stay out, because a row
 * that cannot be placed in time cannot be credited to a range (the fixed all-time
 * window still counts them). `buildTokscaleJson` keeps propagating the row-level
 * `estimated` flag, so the range answer carries the same provenance mark as 今日.
 */
function buildQoderCnRangeJson(range, options = {}) {
  const clientId = normalizeQoderClientId(options.clientId, 'qodercn');
  const startMs = Number(range?.startMs) || 0;
  const endMs = Number(range?.endMs) || 0;
  const rows = (Array.isArray(options.rows) ? options.rows : [])
    .filter((row) => row && row.createdAt >= startMs && (!endMs || row.createdAt <= endMs));
  return buildTokscaleJson(startMs, rows, options.pricingByModel, false, clientId);
}

function buildQoderCnHistoryGraph(options = {}) {
  const client = resolveQoderSiteOptions(options).clientId;
  const timeZone = normalizeTimeZone(options.timeZone);
  const days = new Map();
  for (const row of options.rows || []) {
    const date = row.createdAt ? dayKeyOf(new Date(row.createdAt), timeZone) : '';
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = { client, modelId: row.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 0 };
      day.clients.push(model);
    }
    const cost = estimatedQoderCnRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.cost += cost === null ? 0 : cost;
    model.messages += row.messages;
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

const QODER_CN_TRANSCRIPT_MAX_BYTES = 256 * 1024 * 1024;
const QODER_CN_TRANSCRIPT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const QODER_CN_TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
const QODER_CN_TRANSCRIPT_MAX_FILES = 5_000;
const QODER_CN_TRANSCRIPT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const QODER_CN_TRANSCRIPT_MAX_DEPTH = 8;
const QODER_CN_TRANSCRIPT_MAX_DURATION_MS = 30_000;
const QODER_CN_CJK_RE = /[\u{1100}-\u{11FF}\u{2E80}-\u{9FFF}\u{A960}-\u{A97F}\u{AC00}-\u{D7FF}\u{F900}-\u{FAFF}\u{FF00}-\u{FF60}\u{FF66}-\u{FF9D}\u{20000}-\u{3FFFD}]/u;
const QODER_CN_TRANSCRIPT_BUDGET_CODES = Object.freeze({
  files: 'QODER_CN_TRANSCRIPT_FILE_LIMIT',
  bytes: 'QODER_CN_TRANSCRIPT_BYTE_LIMIT',
  depth: 'QODER_CN_TRANSCRIPT_DEPTH_LIMIT',
  duration: 'QODER_CN_TRANSCRIPT_TIME_LIMIT'
});

// Since the 0.1.x rewrite the desktop client's agent runtime appends one JSON
// line per event to ~/.qoder-cn/projects/<project>/<session>.jsonl
// (Claude-Code-style transcripts). Complete assistant events represent one
// model request. Their message.usage.credits field is optional for backwards
// compatibility, so it must never be used as the request-count gate; the
// cumulative total on a Result event is deliberately ignored. The cloud quota
// API only exposes cumulative totals, so these transcripts are the only
// per-model usage source.
//
// The client zeroes every token field in usage (input_tokens, output_tokens,
// cache_* are 0 across all rows, main.sqlite context snapshots also report
// totalTokens: 0), and the credits unit has no official token conversion
// (docs.qoder.cn: credits are Qoder's own metered unit per request). To keep
// this client's rows in token units like every other client, tokens are
// ESTIMATED from the transcript's actual conversation content:
//   - every message's content (text/thinking/tool_use/tool_result) is counted
//     with a blended heuristic: CJK chars / 1.5 + other chars / 4 per token;
//   - each billed request's input = cumulative content tokens of the session
//     so far (the context re-sent upstream), output = the request's own
//     content tokens;
//   - system-prompt/tool-schema overhead is not in transcripts, so totals are
//     a slight underestimate.
// Cross-check: implied cost lands at ~10-17K tokens/credit for Qwen-Max and
// ~196K tokens/credit for GLM-Flash (flash models are far cheaper per token),
// which is self-consistent with Qoder's credit pricing.
function estimateQoderCnContentTokens(message) {
  const content = message.content;
  let cjk = 0;
  let other = 0;
  const bump = (value) => {
    for (const ch of value) {
      if (QODER_CN_CJK_RE.test(ch)) cjk++;
      else other++;
    }
  };
  if (typeof content === 'string') bump(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string') bump(block.text);
      if (typeof block.thinking === 'string') bump(block.thinking);
      if (block.input !== undefined) bump(typeof block.input === 'string' ? block.input : JSON.stringify(block.input));
      if (block.content !== undefined) bump(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
    }
  }
  return Math.ceil((cjk / 1.5) + (other / 4));
}

function transcriptScanNow(options = {}) {
  if (typeof options.now === 'function') {
    const value = Number(options.now());
    if (Number.isFinite(value)) return value;
  }
  if (Number.isFinite(Number(options.now))) return Number(options.now);
  return Date.now();
}

function transcriptScanLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function transcriptDiagnostics(options = {}) {
  const diagnostics = {
    rootExists: false,
    rootsFound: 0,
    candidateFiles: 0,
    readFiles: 0,
    readBytes: 0,
    recognizedEvents: 0,
    ignoredEvents: 0,
    badJsonLines: 0,
    oversizedFiles: 0,
    oversizedLines: 0,
    readErrors: 0,
    duplicateRows: 0,
    lastDataAt: null,
    source: 'none',
    usedSources: [],
    estimated: false,
    truncated: false,
    failureCode: null,
    maxFiles: transcriptScanLimit(options.maxFiles, QODER_CN_TRANSCRIPT_MAX_FILES),
    maxTotalBytes: transcriptScanLimit(options.maxTotalBytes ?? options.maxBytes, QODER_CN_TRANSCRIPT_MAX_TOTAL_BYTES),
    maxDepth: transcriptScanLimit(options.maxDepth, QODER_CN_TRANSCRIPT_MAX_DEPTH),
    maxDurationMs: transcriptScanLimit(options.maxDurationMs, QODER_CN_TRANSCRIPT_MAX_DURATION_MS)
  };
  return diagnostics;
}

function publishTranscriptDiagnostics(options, diagnostics) {
  if (options.diagnostics && typeof options.diagnostics === 'object') {
    for (const [key, value] of Object.entries(diagnostics)) {
      if (Array.isArray(value)) options.diagnostics[key] = [...value];
      else options.diagnostics[key] = value;
    }
  }
  return diagnostics;
}

function transcriptBudgetError(code, diagnostics) {
  const error = new Error(`qodercn transcript scan budget exceeded (${code})`);
  error.code = code;
  error.diagnostics = { ...diagnostics, usedSources: [...diagnostics.usedSources] };
  return error;
}

function checkTranscriptBudget(diagnostics, startedAt, options = {}) {
  if (transcriptScanNow(options) - startedAt > diagnostics.maxDurationMs) {
    diagnostics.failureCode = QODER_CN_TRANSCRIPT_BUDGET_CODES.duration;
    diagnostics.truncated = true;
    if (options.failHardOnBudget) {
      throw transcriptBudgetError(diagnostics.failureCode, diagnostics);
    }
    return false;
  }
  return true;
}

function listTranscriptFiles(dir, options = {}) {
  const out = [];
  const stack = [{ dir, depth: 0 }];
  const diagnostics = options.diagnostics;
  const startedAt = options.startedAt ?? transcriptScanNow(options);
  while (stack.length > 0) {
    if (!checkTranscriptBudget(diagnostics, startedAt, options)) {
      break;
    }
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      diagnostics.readErrors += 1;
      if (current.depth === 0) {
        diagnostics.failureCode = 'QODER_CN_TRANSCRIPT_ROOT_READ_FAILED';
        throw error;
      }
      continue;
    }
    for (const entry of entries) {
      if (!checkTranscriptBudget(diagnostics, startedAt, options)) {
        break;
      }
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= diagnostics.maxDepth) {
          diagnostics.failureCode = QODER_CN_TRANSCRIPT_BUDGET_CODES.depth;
          diagnostics.truncated = true;
          throw transcriptBudgetError(diagnostics.failureCode, diagnostics);
        }
        stack.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        diagnostics.candidateFiles += 1;
        if (diagnostics.candidateFiles > diagnostics.maxFiles) {
          diagnostics.failureCode = QODER_CN_TRANSCRIPT_BUDGET_CODES.files;
          diagnostics.truncated = true;
          throw transcriptBudgetError(diagnostics.failureCode, diagnostics);
        }
        out.push(full);
      }
    }
  }
  return out;
}

function transcriptEventTimestamp(event, message) {
  return timestampMs(event?.timestamp ?? event?.createdAt ?? event?.created_at
    ?? message?.timestamp ?? message?.createdAt ?? message?.created_at);
}

function transcriptEventModel(event, message, fallback = '') {
  return String(
    message?.model || message?.modelName || message?.model_name
      || event?.model || event?.modelName || event?.model_name
      || event?.modelKey || event?.model_key
      || event?.data?.model || event?.data?.modelName || event?.data?.model_name
      || event?.data?.modelKey || event?.data?.model_key
      || event?.data?.content?.model || event?.data?.content?.modelName
      || event?.data?.content?.model_key || event?.data?.content?.modelKey
      || message?.usage?.model || fallback || 'unknown'
  ).trim() || 'unknown';
}

function transcriptEventIdentity(event, message) {
  for (const value of [
    event?.requestId, event?.request_id, event?.messageId, event?.message_id,
    event?.id, event?.uuid, message?.requestId, message?.request_id,
    message?.messageId, message?.message_id, message?.id, message?.uuid,
    message?.usage?.requestId, message?.usage?.request_id
  ]) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function defineTranscriptIdentity(row, identities) {
  const values = [...new Set((Array.isArray(identities) ? identities : [identities])
    .map((value) => String(value || '').trim()).filter(Boolean))];
  if (values.length === 0) return row;
  // The identity is an internal de-duplication aid. It must not become a new
  // wire field containing an upstream request id until that field's privacy and
  // compatibility contract is reviewed.
  Object.defineProperty(row, 'sourceIdentities', {
    value: values,
    enumerable: false,
    configurable: true
  });
  return row;
}

// The raw upstream session id a row was derived from. Like `sourceIdentities`
// this is an internal de-duplication aid and stays non-enumerable, so it can
// never reach the wire or a diagnostics dump as a session identifier.
//
// Producers: `normalizeQoderCnMainMessage` (the desktop `main.sqlite` store) and
// the transcript parser. `normalizeQoderCnDbRow` deliberately does NOT set it —
// the legacy `local.db` carries an exact `token_info` and must keep its
// precedence, so "database row with a source session" means "main.sqlite row".
function defineSourceSession(row, session) {
  const value = String(session || '').trim();
  if (!value) return row;
  Object.defineProperty(row, 'sourceSession', {
    value,
    enumerable: false,
    configurable: true
  });
  return row;
}

function qoderCnRowSourceSession(row) {
  return typeof row?.sourceSession === 'string' ? row.sourceSession : '';
}

function processTranscriptLine(line, state) {
  const { diagnostics, buckets, projectLabel, sessionId, sinceMs } = state;
  if (!line) return;
  if (Buffer.byteLength(line, 'utf8') > QODER_CN_TRANSCRIPT_MAX_LINE_BYTES) {
    diagnostics.oversizedLines += 1;
    diagnostics.ignoredEvents += 1;
    return;
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch (_) {
    diagnostics.badJsonLines += 1;
    diagnostics.ignoredEvents += 1;
    return;
  }
  const message = event?.message;
  // Session init/system records carry the model while complete assistant
  // records generally do not. Capture that declaration before filtering out
  // records that have no message body, then let later assistant rows inherit
  // it through state.modelKey.
  const declaredModel = transcriptEventModel(event, message);
  if (declaredModel !== 'unknown') state.modelKey = declaredModel;
  // The same goes for the session id: it is declared by every record, but only
  // assistant records become rows. Capture it before the body filter so the
  // first bucket of the file can already join against the desktop store.
  // Subagent transcripts declare their *parent* session id (verified on Qoder CN
  // 0.4.2: all 7 subagent files matched their parent directory), which is the
  // value `main.sqlite` keys on, so the event field is authoritative and the
  // path-derived `state.sessionKey` is only a fallback for records without one.
  const declaredSession = String(event?.sessionId || event?.session_id || '').trim();
  if (declaredSession) state.rawSession = declaredSession;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    diagnostics.ignoredEvents += 1;
    return;
  }
  const messageTokens = estimateQoderCnContentTokens(message);
  const messageRole = String(message.role || '').trim().toLowerCase();
  const eventType = String(event?.type || '').trim().toLowerCase();
  const usage = message.usage && typeof message.usage === 'object' ? message.usage : event.usage;
  const rawInputTokens = Number(usage?.input_tokens ?? usage?.inputTokens);
  const rawOutputTokens = Number(usage?.output_tokens ?? usage?.outputTokens);
  const rawCacheReadTokens = Number(usage?.cache_read_input_tokens ?? usage?.cacheReadInputTokens);
  const rawCacheWriteTokens = Number(usage?.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens);
  const hasExactTokens = Number.isFinite(rawInputTokens) && rawInputTokens > 0;
  const credits = Number(usage?.credits);
  const timestamp = transcriptEventTimestamp(event, message);
  const identity = transcriptEventIdentity(event, message);
  const terminalEvent = new Set(['result', 'progress', 'system', 'status', 'user']);
  const isAssistant = !terminalEvent.has(eventType)
    && (messageRole === 'assistant' || (!messageRole && eventType === 'assistant'));
  const hasUsageBlock = Boolean(usage && typeof usage === 'object');
  // In Qoder transcripts, a complete LLM turn is marked by an assistant event with a `usage` block.
  // Thinking and text chunks emitted during the turn also have role === 'assistant' but have no `usage`.
  // Under standard LLM API request semantics, each complete turn's prompt input is the cumulative session context.
  if (isAssistant && (!Number.isFinite(credits) || credits >= 0) && timestamp > 0) {
    const isCompletedRequest = hasUsageBlock || state.hasUsageSeen !== true;
    if (isCompletedRequest) {
      const date = new Date(timestamp);
      const dayKey = dayKeyOf(date, state.timeZone);
      const modelKey = transcriptEventModel(event, message, state.modelKey);
      const key = JSON.stringify([dayKey, modelKey, projectLabel, sessionId, identity || '']);
      const bucket = buckets.get(key) || {
        dayKey,
        modelKey,
        projectLabel,
        sessionId,
        sourceSession: state.rawSession || state.sessionKey || '',
        input: 0,
        output: 0,
        requests: 0,
        credits: 0,
        sourceIdentities: new Set()
      };
      if (sinceMs === undefined || timestamp >= sinceMs) {
        if (hasExactTokens) {
          bucket.input += rawInputTokens;
          bucket.output += (Number.isFinite(rawOutputTokens) && rawOutputTokens > 0) ? rawOutputTokens : (state.turnOutputTokens || messageTokens);
          if (Number.isFinite(rawCacheReadTokens) && rawCacheReadTokens > 0) bucket.cacheRead = (bucket.cacheRead || 0) + rawCacheReadTokens;
          if (Number.isFinite(rawCacheWriteTokens) && rawCacheWriteTokens > 0) bucket.cacheWrite = (bucket.cacheWrite || 0) + rawCacheWriteTokens;
        } else {
          // Standard LLM API request model: each request sends the cumulative session context.
          bucket.input += Math.max(0, state.cumulativeTokens);
          bucket.output += (state.turnOutputTokens || messageTokens);
        }
        bucket.requests += 1;
        if (Number.isFinite(credits)) bucket.credits += credits;
        if (identity) bucket.sourceIdentities.add(identity);
        diagnostics.recognizedEvents += 1;
        diagnostics.estimated = true;
        if (!diagnostics.lastDataAt || timestamp > Date.parse(diagnostics.lastDataAt)) {
          diagnostics.lastDataAt = new Date(timestamp).toISOString();
        }
        buckets.set(key, bucket);
      } else {
        diagnostics.ignoredEvents += 1;
      }
      state.turnOutputTokens = 0;
    } else {
      state.turnOutputTokens = (state.turnOutputTokens || 0) + messageTokens;
    }
  } else {
    diagnostics.ignoredEvents += 1;
  }
  if (hasUsageBlock) state.hasUsageSeen = true;
  state.cumulativeTokens += messageTokens;
}

function transcriptProjectLabel(root, filePath) {
  const relative = path.relative(root, filePath);
  const first = relative.split(path.sep)[0];
  return normalizeQoderCnProjectLabel(first);
}

function transcriptSessionId(filePath, dayKey = '', clientId = 'qodercn') {
  const suffix = sourceId(filePath);
  return `${normalizeQoderClientId(clientId, 'qodercn')}:transcript:${dayKey || 'session'}:${suffix}`;
}

// The raw upstream session id a transcript file belongs to, derived from its
// location: a top-level `<session>.jsonl` is named after its session, and a
// `<session>/subagents/agent-*.jsonl` belongs to the session directory that
// owns it. Used only as the fallback when the records themselves do not declare
// `sessionId`, and as the join key that lets `mergeQoderCnRows` recognise a
// desktop `main.sqlite` session the transcript tree already covers.
function transcriptRawSessionId(root, filePath) {
  const parts = path.relative(root, filePath).split(path.sep);
  const subagents = parts.lastIndexOf('subagents');
  if (subagents > 0) return parts[subagents - 1];
  return parts[parts.length - 1].replace(/\.jsonl$/, '');
}

function dirExistsForQoder(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

// Keep the public collector synchronous for the existing collector/test seams,
// but never materialize a whole transcript in the Electron main process. The
// file size and total-byte checks happen before opening it; reading only the
// stat-sized snapshot also prevents a writer that appends during a scan from
// turning one bounded read into an unbounded one. StringDecoder preserves UTF-8
// characters split across chunk boundaries.
function streamTranscriptFile(filePath, stat, state, diagnostics, startedAt, options = {}) {
  const decoder = new StringDecoder('utf8');
  const chunkSize = Math.min(QODER_CN_TRANSCRIPT_READ_CHUNK_BYTES, Math.max(1, Number(stat.size) || 1));
  const buffer = Buffer.allocUnsafe(chunkSize);
  let fileRemaining = Math.max(0, Math.trunc(Number(stat.size) || 0));
  let pendingLine = '';
  let discardingOversizedLine = false;
  let descriptor;

  const consumeText = (text) => {
    let remaining = text;
    while (remaining) {
      if (discardingOversizedLine) {
        const newline = remaining.indexOf('\n');
        if (newline < 0) return;
        remaining = remaining.slice(newline + 1);
        discardingOversizedLine = false;
        continue;
      }

      pendingLine += remaining;
      remaining = '';
      let newline;
      while ((newline = pendingLine.indexOf('\n')) >= 0) {
        if (!checkTranscriptBudget(diagnostics, startedAt, options)) {
          break;
        }
        const line = pendingLine.slice(0, newline);
        pendingLine = pendingLine.slice(newline + 1);
        processTranscriptLine(line.endsWith('\r') ? line.slice(0, -1) : line, state);
      }
      if (Buffer.byteLength(pendingLine, 'utf8') > QODER_CN_TRANSCRIPT_MAX_LINE_BYTES) {
        diagnostics.oversizedLines += 1;
        diagnostics.ignoredEvents += 1;
        pendingLine = '';
        discardingOversizedLine = true;
      }
    }
  };

  try {
    descriptor = fs.openSync(filePath, 'r');
    while (fileRemaining > 0) {
      if (!checkTranscriptBudget(diagnostics, startedAt, options)) {
        break;
      }
      const requested = Math.min(buffer.length, fileRemaining);
      const bytesRead = fs.readSync(descriptor, buffer, 0, requested, null);
      if (!bytesRead) break;
      fileRemaining -= bytesRead;
      diagnostics.readBytes += bytesRead;
      consumeText(decoder.write(buffer.subarray(0, bytesRead)));
      if (!checkTranscriptBudget(diagnostics, startedAt, options)) {
        break;
      }
    }
    consumeText(decoder.end());
    if (!discardingOversizedLine && pendingLine) {
      checkTranscriptBudget(diagnostics, startedAt, options);
      processTranscriptLine(pendingLine, state);
    }
  } finally {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch (_) { /* best effort */ }
  }
}

function collectQoderCnTranscriptRows(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const sinceMs = typeof options.sinceMs === 'number' ? options.sinceMs : undefined;
  const paths = options.dataPaths || qoderDataPaths({ ...options, homeDir });
  const clientId = normalizeQoderClientId(paths.clientId, resolveQoderSiteOptions(options).clientId);
  const roots = Array.isArray(options.transcriptRoots)
    ? options.transcriptRoots
    : (paths.transcriptRoots || [path.join(homeDir, QODER_SITES[paths.site || 'cn'].profileDirName, 'projects')]);
  const diagnostics = transcriptDiagnostics(options);
  const startedAt = transcriptScanNow(options);
  const buckets = new Map();
  try {
    for (const rawRoot of roots) {
      if (!checkTranscriptBudget(diagnostics, startedAt, options)) {
        break;
      }
      const rootValue = String(rawRoot || '').trim();
      if (!rootValue) continue;
      const root = path.resolve(rootValue);
      if (!dirExistsForQoder(root)) continue;
      diagnostics.rootExists = true;
      diagnostics.rootsFound += 1;
      const files = listTranscriptFiles(root, { ...options, diagnostics, startedAt });
      for (const filePath of files) {
        if (!checkTranscriptBudget(diagnostics, startedAt, options)) {
          break;
        }
        let stat;
        try { stat = fs.statSync(filePath); } catch (_) { diagnostics.readErrors += 1; continue; }
        if (!stat.isFile() || stat.size <= 0) {
          diagnostics.ignoredEvents += 1;
          continue;
        }
        if (stat.size > QODER_CN_TRANSCRIPT_MAX_BYTES) {
          diagnostics.oversizedFiles += 1;
          diagnostics.ignoredEvents += 1;
          continue;
        }
        if (diagnostics.readBytes + stat.size > diagnostics.maxTotalBytes) {
          diagnostics.failureCode = QODER_CN_TRANSCRIPT_BUDGET_CODES.bytes;
          diagnostics.truncated = true;
          throw transcriptBudgetError(diagnostics.failureCode, diagnostics);
        }
        const relative = path.relative(root, filePath);
        const dayHint = relative.split(path.sep).find((part) => /^\d{4}-\d{2}-\d{2}$/.test(part)) || '';
        const state = {
          cumulativeTokens: 0,
          // Tokens already attributed to a row — as some earlier request's output
          // or as context billed up to. See `processTranscriptLine`.
          countedTokens: 0,
          diagnostics,
          buckets,
          projectLabel: transcriptProjectLabel(root, filePath),
          sessionId: transcriptSessionId(filePath, dayHint, clientId),
          sessionKey: transcriptRawSessionId(root, filePath),
          rawSession: '',
          sinceMs,
          timeZone: normalizeTimeZone(options.timeZone)
        };
        try {
          streamTranscriptFile(filePath, stat, state, diagnostics, startedAt, options);
          diagnostics.readFiles += 1;
        } catch (error) {
          if (error?.code && String(error.code).startsWith('QODER_CN_TRANSCRIPT_')) throw error;
          diagnostics.readErrors += 1;
        }
      }
    }
  } catch (error) {
    publishTranscriptDiagnostics(options, diagnostics);
    if (error?.code && String(error.code).startsWith('QODER_CN_TRANSCRIPT_')) throw error;
    diagnostics.failureCode = diagnostics.failureCode || 'QODER_CN_TRANSCRIPT_READ_FAILED';
    const wrapped = new Error(`qodercn transcript read failed (${diagnostics.failureCode})`, { cause: error });
    wrapped.code = diagnostics.failureCode;
    wrapped.diagnostics = { ...diagnostics, usedSources: [...diagnostics.usedSources] };
    throw wrapped;
  }
  const rows = [];
  const timeZone = normalizeTimeZone(options.timeZone);
  for (const bucket of buckets.values()) {
    // A bucket is a whole calendar day, so its synthetic instant is local noon
    // in the active zone. The candidates cover every legal offset: the UTC
    // midnight reference lands outside the day for UTC+14, the UTC noon
    // reference for UTC-12; whichever names the day is the one to noon-shift.
    const dayRefs = [
      Date.parse(`${bucket.dayKey}T00:00:00.000Z`),
      Date.parse(`${bucket.dayKey}T12:00:00.000Z`)
    ];
    const dayRef = dayRefs.find((ms) => dayKeyOf(new Date(ms), timeZone) === bucket.dayKey) ?? dayRefs[0];
    const createdAt = startOfDayMs(dayRef, timeZone) + 12 * 60 * 60 * 1000;
    if (!Number.isFinite(createdAt)) continue;
    const displayName = Object.prototype.hasOwnProperty.call(QODER_CN_MODEL_DISPLAY_NAMES, bucket.modelKey)
      ? QODER_CN_MODEL_DISPLAY_NAMES[bucket.modelKey]
      : bucket.modelKey;
    const sessionSource = bucket.sessionId.split(':').pop();
    const sessionId = transcriptSessionId(sessionSource, bucket.dayKey, clientId);
    const identity = [...bucket.sourceIdentities][0] || '';
    const identitySuffix = identity
      ? createHash('sha256').update(identity).digest('hex').slice(0, 12)
      : 'anonymous';
    const row = {
      sessionId,
      messageId: `${sessionId}:${bucket.modelKey}:${identitySuffix}`,
      model: displayName,
      projectLabel: bucket.projectLabel,
      input: bucket.input,
      output: bucket.output,
      cacheRead: 0,
      cacheWrite: 0,
      createdAt,
      messages: bucket.requests,
      // A genuine 0: an identity-less or non-billable request really did spend
      // no credit, which is different from a source that never reports credits
      // (the SQLite adapters, which omit the key entirely).
      credits: bucket.credits,
      estimated: true
    };
    defineMeasurementProvenance(row, 'estimated', 'estimated');
    defineTranscriptIdentity(row, [...bucket.sourceIdentities]);
    defineSourceSession(row, bucket.sourceSession);
    rows.push(row);
  }
  diagnostics.source = rows.length > 0 ? 'transcript' : 'none';
  diagnostics.usedSources = rows.length > 0 ? ['transcript'] : [];
  publishTranscriptDiagnostics(options, diagnostics);
  return options.returnDiagnostics ? { rows, diagnostics } : rows;
}

function qoderCnRowIdentities(row) {
  return Array.isArray(row?.sourceIdentities) ? row.sourceIdentities : [];
}

function qoderCnRowFallbackKey(row) {
  return `${localDateKey(row?.createdAt) || 'undated'}|${String(row?.model || '').trim().toLowerCase()}|${normalizeQoderCnProjectLabel(row?.projectLabel)}`;
}

// SQLite and transcript rows are often version-specific, but a user can have
// both sources during an upgrade. Prefer the legacy DB for an explicitly shared
// request identity; when an older transcript has no identity, use a documented
// same-day/model/project precedence instead of silently concatenating a likely
// duplicate. Rows from non-overlapping buckets remain additive.
//
// On top of that per-request rule sits a per-session rule for the desktop
// `main.sqlite` store. It holds the desktop UI's own copy of a conversation and
// carries no usage columns at all, so its rows are pure content estimates —
// while the transcript tree holds the agent's append-only log for the very same
// session, estimated the same way but also covering CLI-only sessions and
// subagent runs. Verified on Qoder CN 0.4.2 (2026-09-26): every one of the 7
// `chat_sessions` rows appears as a transcript session, against 15 transcript
// sessions overall, i.e. the desktop store is a strict subset. The two sources
// share the raw session id but have disjoint internal identities, so the
// request-level dedup below cannot see the overlap and would bill it twice. A
// main row whose session the transcript tree covers is therefore dropped, and
// the transcript estimate wins. Legacy `local.db` rows are exempt because they
// carry an exact `token_info`; they are also the only database rows without a
// `sourceSession`, which is what makes the two sources distinguishable here.
//
// Two fail-open edges are accepted deliberately: a transcript scan truncated by
// its file/byte/duration budget reports fewer covered sessions, and an anchored
// today-only scan compares today's rows on both sides, so a message whose two
// timestamps straddle local midnight could survive one tick. Both over-count by
// at most a message and are corrected by the next full scan.
function mergeQoderCnRows(dbRows = [], transcriptRows = [], diagnostics = null, options = {}) {
  const databaseRows = Array.isArray(dbRows) ? dbRows : [];
  const transcript = Array.isArray(transcriptRows) ? transcriptRows : [];
  const transcriptSessions = new Set();
  for (const row of transcript) {
    const session = qoderCnRowSourceSession(row);
    if (session) transcriptSessions.add(session);
  }
  let suppressedMainRows = 0;
  const effectiveDatabaseRows = transcriptSessions.size === 0
    ? databaseRows
    : databaseRows.filter((row) => {
      const session = qoderCnRowSourceSession(row);
      if (!session || !transcriptSessions.has(session)) return true;
      suppressedMainRows += 1;
      return false;
    });
  const mainContributed = effectiveDatabaseRows.some((row) => qoderCnRowSourceSession(row) !== '');
  const databaseSources = options.databaseSources && typeof options.databaseSources === 'object'
    ? [
      ...(options.databaseSources.legacy ? ['sqlite'] : []),
      // A caller reports `main` when it *read* main rows; the source only counts
      // as used when a row survived the transcript suppression above.
      ...(options.databaseSources.main && mainContributed ? ['main-sqlite'] : [])
    ]
    : (effectiveDatabaseRows.length > 0 ? ['sqlite'] : []);
  const merged = [...effectiveDatabaseRows];
  const identities = new Set(merged.flatMap(qoderCnRowIdentities));
  const fallbackKeys = new Set(merged.map(qoderCnRowFallbackKey));
  const databaseFallbackKeysWithoutIdentity = new Set(
    effectiveDatabaseRows
      .filter((row) => qoderCnRowIdentities(row).length === 0)
      .map(qoderCnRowFallbackKey)
  );
  const acceptedTranscriptRows = [];
  let duplicates = 0;
  for (const row of transcript) {
    const rowIds = qoderCnRowIdentities(row);
    const fallbackKey = qoderCnRowFallbackKey(row);
    // If either source lacks a comparable identity, a matching day/model/
    // project bucket cannot prove that the rows are distinct. SQLite is the
    // authoritative legacy source in that case; only rows with distinct,
    // stable identities remain additive across the two sources.
    const ambiguousFallback = fallbackKeys.has(fallbackKey)
      && (rowIds.length === 0 || databaseFallbackKeysWithoutIdentity.has(fallbackKey));
    if (rowIds.some((identity) => identities.has(identity)) || ambiguousFallback) {
      duplicates += 1;
      continue;
    }
    merged.push(row);
    acceptedTranscriptRows.push(row);
    for (const identity of rowIds) identities.add(identity);
  }
  if (diagnostics && typeof diagnostics === 'object') {
    diagnostics.duplicateRows = Number(diagnostics.duplicateRows || 0) + duplicates;
    diagnostics.suppressedMainRows = Number(diagnostics.suppressedMainRows || 0) + suppressedMainRows;
    const transcriptUsed = acceptedTranscriptRows.length > 0;
    const databaseUsed = effectiveDatabaseRows.length > 0;
    diagnostics.source = merged.length > 0
      ? (databaseUsed && transcriptUsed ? 'sqlite+transcript' : databaseUsed ? 'sqlite' : 'transcript')
      : 'none';
    diagnostics.usedSources = [
      ...databaseSources,
      ...(transcriptUsed ? ['transcript'] : [])
    ];
  }
  return merged;
}

module.exports = {
  buildQoderCnRangeJson,
  QODER_CN_READ_BUDGET_ERROR,
  QODER_CN_SQLITE_BACKEND_UNAVAILABLE,
  QODER_CN_TRANSCRIPT_BUDGET_CODES,
  QODER_CN_MODEL_DISPLAY_NAMES,
  QODER_SITES,
  QODER_SITE_IDS,
  QODER_SITE_BY_CLIENT_ID,
  QODER_CLIENT_IDS,
  SHARED_QODER_MAIN_BUNDLE_IDS,
  buildQoderCnHistoryGraph,
  buildQoderCnPeriods,
  collectQoderCnMainRows,
  collectQoderCnRows,
  collectQoderCnTranscriptRows,
  estimateQoderCnContentTokens,
  mergeQoderCnRows,
  normalizeQoderCnMainMessage,
  normalizeQoderCnDbRow,
  normalizeQoderClientId,
  normalizeQoderSite,
  qoderCnDataPaths,
  qoderCnSourceFingerprint,
  qoderDataPaths,
  qoderSourceFingerprint,
  readQoderCnMainDbRows,
  readQoderCnDbRows,
  resolveQoderCnPricing,
  resolveQoderSiteOptions,
  resetQoderCnPricingCache,
  selectQoderMainDbPaths,
  resetQoderCnChatSessionProbe() { qoderCnChatSessionTableCache.clear(); }
};
