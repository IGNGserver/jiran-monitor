'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chokidar = require('chokidar');
const semver = require('semver');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');
const { appVersion } = require('./appVersion');
const { normalizeClientsCsv } = require('./clientTracking');
const { tokscalePackageNamesForPlatform, tokscalePlatformKey } = require('./tokscalePlatform');
const { customPricingPath, tokscaleCacheDirs, tokscaleClientCacheDir } = require('./tokscaleConfig');
const {
  applyPeriodDelta,
  emptyPeriod,
  extractUsageBundleFromTokscale,
  extractUsageFromTokscale,
  mergePeriods,
  normalizeClientName,
  UNATTRIBUTED_USAGE_CLIENT
} = require('./usage');
const {
  collectWslUsage: collectWslUsageImpl,
  collectWslRangeUsage: collectWslRangeUsageImpl,
  emptyWslBundle,
  probeWslState: probeWslStateImpl,
  wslUsageHomes
} = require('./wslUsage');
const { hermesProfileWatchDirs, resolveHermesHome } = require('./hermesProfiles');
const { mergeHistories, parseGraphResult, normalizeHistory } = require('./history');
const { retainDailyHistory, retainLiveDailyHistory } = require('./dailyHistoryArchive');
const {
  classifyClientSyncDetailCode
} = require('./clientSyncStatus');
const {
  clampTimerDelayMs,
  createSelfSyncThrottle,
  createSourceSyncQueue,
  mergeSelfSyncSelection
} = require('./selfSyncThrottle');
const cursorAuth = require('./cursorAuth');
const clientSyncRunners = require('./clientSyncRunners');
const { findSessionFiles, codexSessionFile } = require('./sessionFiles');
const opencodeSession = require('./opencodeSession');
const { buildPromaHistoryGraph, buildPromaPeriods, collectPromaRows } = require('./promaUsage');
const {
  QODER_CLIENT_IDS,
  QODER_SITE_BY_CLIENT_ID,
  buildQoderCnHistoryGraph,
  buildQoderCnPeriods,
  buildQoderCnRangeJson,
  collectQoderCnMainRows,
  collectQoderCnRows,
  collectQoderCnTranscriptRows,
  mergeQoderCnRows,
  qoderDataPaths,
  qoderSourceFingerprint,
  resolveQoderCnPricing
} = require('./qoderCnUsage');
const { LOCAL_USAGE_CLIENT_IDS } = require('./localUsageAdapters');
const { REASONIX_SOURCE_CHECK_ID, resolveReasonixStatsDir } = require('./reasonixPaths');
const {
  createReasonixNativeSessionCache,
  emptyNativeView,
  isReasonixNativeSessionPath,
  isReasonixNativeSessionSidecar,
  reasonixNativeSessionWatchRoots
} = require('./reasonixSessions');
const {
  buildClaudeDesktopHistoryGraph,
  buildClaudeDesktopPeriods,
  buildClaudeDesktopRangeJson,
  collectClaudeDesktopRows,
  desktopSessionWatchDirs
} = require('./claudeDesktopUsage');
const { resolveDeepSeekHarnessSessionsDir } = require('./deepseekHarnessPaths');
const { hashKey } = require('./hashKey');
const { filterPeriodByCustomRange, normalizeCustomRange } = require('./customRange');
const { hostOsInfo, normalizeOsInfo } = require('./osVersion');
const {
  LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
  nextLimitsResetBoundary,
  pruneAttemptedResetBoundaries
} = require('./limitResetBoundary');

function toUnpackedPath(p) {
  // electron-builder asarUnpack stores real files at .../app.asar.unpacked/...
  // require.resolve() returns the .../app.asar/... path, which spawn() can't read.
  const asarSeg = `${path.sep}app.asar${path.sep}`;
  return p && p.includes(asarSeg) ? p.replace(asarSeg, `${path.sep}app.asar.unpacked${path.sep}`) : p;
}

let resolvedTokscaleBinJs = null;
function getTokscaleBinJs() {
  if (resolvedTokscaleBinJs !== null) return resolvedTokscaleBinJs;
  try {
    resolvedTokscaleBinJs = toUnpackedPath(require.resolve('tokscale/bin.js'));
  } catch (_) {
    resolvedTokscaleBinJs = '';
  }
  return resolvedTokscaleBinJs;
}

function nonEmptyEnvPath(env, name, fallback) {
  const value = String(env?.[name] || '').trim();
  return value || fallback;
}

function homeRelativePath(homeDir, relative, platform = process.platform) {
  const join = platform === 'linux' || platform === 'darwin' ? path.posix.join : path.join;
  return join(homeDir, relative);
}

function codexDataHome(homeDir = os.homedir(), env = process.env, platform = process.platform) {
  return nonEmptyEnvPath(env, 'CODEX_HOME', homeRelativePath(homeDir, '.codex', platform));
}

function geminiDataHome(homeDir = os.homedir(), env = process.env, platform = process.platform) {
  return nonEmptyEnvPath(env, 'GEMINI_CLI_HOME', homeRelativePath(homeDir, '.gemini', platform));
}

// Desktop launchers and XDG autostart entries do not necessarily inherit the
// shell environment that started Codex or agy. Tokscale defaults to these same
// locations, but making the fallback explicit keeps the native child process
// independent of the launcher and still preserves an explicitly configured
// CODEX_HOME/GEMINI_CLI_HOME.
function tokscaleEnvironment({ env = process.env, homeDir = os.homedir(), platform = process.platform } = {}) {
  const next = { ...env };
  if (platform === 'linux' && !String(next.HOME || '').trim()) next.HOME = homeDir;
  if (!String(next.CODEX_HOME || '').trim()) next.CODEX_HOME = codexDataHome(homeDir, next, platform);
  if (!String(next.GEMINI_CLI_HOME || '').trim()) next.GEMINI_CLI_HOME = geminiDataHome(homeDir, next, platform);
  return next;
}

function bundledPackageCandidates() {
  return tokscalePackageNamesForPlatform();
}

function locateBundledBinary() {
  const binaryName = process.platform === 'win32' ? 'tokscale.exe' : 'tokscale';
  for (const pkg of bundledPackageCandidates()) {
    try {
      const pkgPath = require.resolve(`${pkg}/package.json`);
      const binPath = toUnpackedPath(path.join(path.dirname(pkgPath), 'bin', binaryName));
      const pkgJson = readJson(pkgPath, {});
      if (fs.existsSync(binPath)) {
        return { source: 'bundled', path: binPath, version: String(pkgJson.version || '0.0.0'), packageName: pkg };
      }
    } catch (_) {}
  }
  return null;
}

function readDownloadedPointer() {
  const currentPath = path.join(sharedDataDir(), 'tokscale', 'current.json');
  const current = readJson(currentPath, null);
  if (!current || typeof current !== 'object') return null;
  if (current.platform && current.platform !== tokscalePlatformKey()) return null;
  if (!semver.valid(current.version)) return null;
  if (typeof current.path !== 'string' || !path.isAbsolute(current.path)) return null;
  try {
    const stat = fs.statSync(current.path);
    if (!stat.isFile()) return null;
    if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) return null;
  } catch (_) {
    return null;
  }
  return {
    source: 'downloaded',
    path: current.path,
    version: current.version,
    installedAt: current.installedAt || '',
    integrity: current.integrity || ''
  };
}

function decideResolver({ downloaded, bundled, shim }) {
  if (downloaded && !bundled) return downloaded;
  if (downloaded && bundled && semver.valid(downloaded.version) && semver.valid(bundled.version) && semver.gt(downloaded.version, bundled.version)) {
    return downloaded;
  }
  return bundled || shim || null;
}

function resolvePlatformBinary() {
  const bundled = locateBundledBinary();
  const downloaded = readDownloadedPointer();
  const shim = { source: 'shim', path: getTokscaleBinJs(), version: null };
  return decideResolver({ downloaded, bundled, shim });
}

function tokscaleCommand() {
  const resolved = resolvePlatformBinary();
  const useDirect = Boolean(resolved && resolved.source !== 'shim');
  const env = tokscaleEnvironment();
  if (useDirect) return { bin: resolved.path, prefixArgs: [], env };
  const shimPath = getTokscaleBinJs();
  return { bin: process.execPath, prefixArgs: shimPath ? [shimPath] : [], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('tokscale produced empty stdout');
  try { return JSON.parse(text); } catch (_) {
    const starts = [text.indexOf('{'), text.indexOf('[')].filter((value) => value >= 0).sort((a, b) => a - b);
    for (const start of starts) {
      try { return JSON.parse(text.slice(start)); } catch (_inner) {}
    }
  }
  throw new Error(`Could not parse tokscale JSON output: ${text.slice(0, 300)}`);
}

// Terminate a timed-out child decisively.
//
// SIGTERM alone is not enough: if the child (or a grandchild that inherited its
// pipes) ignores it, the promise is already rejected so the tick moves on while
// the process keeps burning CPU and its 'data' handlers keep appending to the
// stdout/stderr strings for the life of the parent. That breaks the "one tokscale
// at a time" invariant AGENTS.md relies on, so load ratchets up instead of
// decaying. Escalate to SIGKILL, stop reading, and detach.
function terminateChild(child, options = {}) {
  if (!child || child.killed) return;
  const killTimer = setTimeout(() => {
    try {
      // Negative pid targets the whole process group when the child was spawned
      // detached; fall back to the direct pid otherwise.
      process.kill(child.pid, 'SIGKILL');
    } catch (_) { /* already gone */ }
  }, Number(options.escalateMs) > 0 ? Number(options.escalateMs) : 5000);
  killTimer.unref?.();
  child.once('close', () => clearTimeout(killTimer));
  try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
}

// Drop stdio listeners and any buffered text once a child is abandoned, so a
// surviving process cannot keep growing parent memory.
function abandonChildStreams(child) {
  for (const stream of [child?.stdout, child?.stderr]) {
    try {
      stream?.removeAllListeners('data');
      stream?.destroy();
    } catch (_) { /* ignore */ }
  }
  try { child?.removeAllListeners('close'); } catch (_) { /* ignore */ }
  try { child?.unref?.(); } catch (_) { /* ignore */ }
}

function spawnTokscaleJson(userArgs, commandTimeoutMs) {
  const { bin, prefixArgs, env } = tokscaleCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...prefixArgs, ...userArgs], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChild(child);
      abandonChildStreams(child);
      reject(new Error(`tokscale timed out after ${commandTimeoutMs}ms`));
    }, commandTimeoutMs);
    child.stdout.on('data', (chunk) => { if (!settled) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (!settled) stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(`tokscale exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      try { resolve(parseJsonOutput(stdout)); } catch (error) { reject(error); }
    });
  });
}

// A few tools surface as one umbrella client in our tracked-client list but as
// several client ids inside tokscale. Antigravity is the case today: tokscale 4.x
// reads the CLI (`agy`) from its own parse-local id `antigravity-cli` (no
// `antigravity sync`), separate from the IDE-backed `antigravity`. Widen the
// tokscale --client filter so those sub-source rows aren't filtered out;
// extractUsageFromTokscale's normalizeClientName folds them back into the umbrella
// id.
//
// `--client` is a clap value-enum: an id outside it is a hard usage error (exit
// code 2, empty stdout), NOT a silently dropped filter — one bad id fails the
// whole scan, including every valid client in the same call. So a tracked id
// that tokscale spells differently must be RENAMED here, not merely aliased.
// DeepSeek Harness is that case: its upstream id is the short `dsh` (the long
// spelling is rejected), while the id we persist in settings stays
// `deepseek-harness` for compatibility. normalizeClientName folds `dsh` back, so
// the rename is invisible past this boundary.
const TOKSCALE_CLIENT_RENAMES = { 'deepseek-harness': 'dsh' };

// One tracked client whose usage tokscale splits across two ids. Both of Pi's
// known roots must be requested or one silently stops being scanned:
//   - `pi`  owns ~/.pi/agent/sessions
//   - `omp` owns ~/.omp/agent/sessions (Oh My Pi)
// tokscale 4.13 read both roots under `pi` alone; 4.17 (which added the separate
// `omp` client) would otherwise silently drop every Oh My Pi user's usage. We
// keep the single user-visible `pi` id — the README documents "Pi / Oh My Pi" as
// one row, and the watch path + WSL marker already key .omp under `pi` — so
// normalizeClientName folds `omp` back and the split stays invisible.
const TOKSCALE_CLIENT_ALIASES = {
  antigravity: ['antigravity-cli'],
  pi: ['omp']
};

function tokscaleClientFilter(clients) {
  const ordered = [];
  const seen = new Set();
  for (const raw of String(clients ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    const id = TOKSCALE_CLIENT_RENAMES[raw] || raw;
    if (!seen.has(id)) { seen.add(id); ordered.push(id); }
    for (const alias of TOKSCALE_CLIENT_ALIASES[id] || TOKSCALE_CLIENT_ALIASES[raw] || []) {
      if (!seen.has(alias)) { seen.add(alias); ordered.push(alias); }
    }
  }
  return ordered.join(',');
}

function runTokscale({ clients, flags, commandTimeoutMs }) {
  return spawnTokscaleJson(['--json', '--client', tokscaleClientFilter(clients), '--group-by', 'client,session,model', ...flags], commandTimeoutMs);
}

function runTokscaleGraph({ clients, commandTimeoutMs }) {
  return spawnTokscaleJson(['graph', '--client', tokscaleClientFilter(clients), '--no-spinner'], commandTimeoutMs);
}

// The history graph for one WSL home. `--home` disables env roots upstream, so
// this reads the distro's data and nothing of the host's — the same isolation
// the period scan relies on. Used only on history ticks (see collectHistoryOnce).
function runTokscaleGraphForHome({ clients, home, commandTimeoutMs }) {
  return spawnTokscaleJson(['graph', '--client', tokscaleClientFilter(clients), '--no-spinner', '--home', home], commandTimeoutMs);
}

function lookupModelPricing(modelId, commandTimeoutMs = 15000) {
  const id = String(modelId || '').trim();
  if (!id) return Promise.reject(new Error('lookupModelPricing: modelId is required'));
  return spawnTokscaleJson(['pricing', id, '--json', '--no-spinner'], commandTimeoutMs);
}

const PROMA_PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// catalog it would have fallen back to is already on disk.
const TOKSCALE_PRICING_CATALOG_FILES = ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json'];
const TOKSCALE_MODEL_PRICING_RATE_FIELDS = [
  'input_cost_per_token',
  'input_cost_per_token_above_128k_tokens',
  'input_cost_per_token_above_200k_tokens',
  'input_cost_per_token_above_256k_tokens',
  'input_cost_per_token_above_272k_tokens',
  'output_cost_per_token',
  'output_cost_per_token_above_128k_tokens',
  'output_cost_per_token_above_200k_tokens',
  'output_cost_per_token_above_256k_tokens',
  'output_cost_per_token_above_272k_tokens',
  'cache_creation_input_token_cost',
  'cache_creation_input_token_cost_above_200k_tokens',
  'cache_read_input_token_cost',
  'cache_read_input_token_cost_above_200k_tokens',
  'cache_read_input_token_cost_above_272k_tokens'
];
const TOKSCALE_ROUTING_LABELS = new Set(['auto', 'agent_review']);
const TOKSCALE_TERMINAL_FALLBACK_BLOCKLIST = new Set([
  'auto', 'mini', 'chat', 'base', 'claude', 'anthropic', 'gemini', 'model', 'router', 'default'
]);
const CATALOG_PRICING_FIELDS = [
  'inputCostPerToken',
  'outputCostPerToken',
  'cacheReadInputTokenCost',
  'cacheCreationInputTokenCost'
];

// Parsed catalog, invalidated by every selected candidate's file metadata.
let tokscaleCatalogCache = { revision: '', catalog: null, recheckAtMs: 0 };

function normalizeCatalogModelKey(key) {
  return String(key || '').trim().toLowerCase();
}

function terminalCatalogModelKey(key) {
  const parts = String(key || '').split('/');
  return parts[parts.length - 1] || '';
}

function normalizePricingRate(value, key) {
  const raw = value?.[key];
  if (raw === null || raw === undefined) return undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function normalizeCatalogPricing(value) {
  const pricing = {
    inputCostPerToken: normalizePricingRate(value, 'input_cost_per_token'),
    outputCostPerToken: normalizePricingRate(value, 'output_cost_per_token'),
    cacheReadInputTokenCost: normalizePricingRate(value, 'cache_read_input_token_cost'),
    cacheCreationInputTokenCost: normalizePricingRate(value, 'cache_creation_input_token_cost')
  };
  return pricing.inputCostPerToken !== undefined || pricing.outputCostPerToken !== undefined ? pricing : null;
}

function catalogPricingFingerprint(pricing) {
  return JSON.stringify(CATALOG_PRICING_FIELDS.map((field) => (
    pricing[field] === undefined ? 'missing' : pricing[field]
  )));
}

function pricingCatalogDirs(options = {}) {
  if (Array.isArray(options.catalogDirs)) return options.catalogDirs.map(String).filter(Boolean);
  if (options.configDir) return [options.configDir];
  return tokscaleCacheDirs(options);
}

function inspectPricingCatalogFile(file) {
  try {
    const stat = fs.statSync(file);
    return {
      file,
      state: 'present',
      revision: `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`
    };
  } catch (error) {
    const code = error?.code || 'unknown';
    return { file, state: code === 'ENOENT' ? 'missing' : 'error', revision: `${file}:${code}` };
  }
}

function pricingCatalogSource(name, dirs) {
  if (dirs.length === 0) return { candidates: [], revision: `${name}:missing` };
  const canonical = inspectPricingCatalogFile(path.join(dirs[0] || '', name));
  // Canonical is authoritative whenever it exists or cannot be inspected.
  // Only ENOENT activates upstream's ordered legacy find_map fallback.
  const probes = canonical.state === 'missing'
    ? [canonical, ...dirs.slice(1).map((dir) => inspectPricingCatalogFile(path.join(dir, name)))]
    : [canonical];
  return {
    candidates: probes.filter((entry) => entry.state !== 'missing'),
    revision: probes.map((entry) => entry.revision).join('|')
  };
}

function tokscalePricingCatalogSnapshot(options = {}) {
  const dirs = pricingCatalogDirs(options);
  const files = TOKSCALE_PRICING_CATALOG_FILES.map((name) => pricingCatalogSource(name, dirs));
  return {
    files,
    revision: `${dirs.join('|')}::${files.map((entry) => entry.revision).join('|')}`
  };
}

function parseTokscalePricingCatalogFile(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (!Number.isSafeInteger(doc.timestamp) || doc.timestamp < 0) return null;
  if (!doc.data || typeof doc.data !== 'object' || Array.isArray(doc.data)) return null;
  // Tokscale deserializes the whole HashMap<String, ModelPricing> before using
  // it. A wrong type in any known Option<f64> field makes that source invalid;
  // do not salvage rows from a cache Tokscale itself would reject.
  for (const value of Object.values(doc.data)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const field of TOKSCALE_MODEL_PRICING_RATE_FIELDS) {
      const raw = value[field];
      if (raw !== null && raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw))) {
        return null;
      }
    }
  }
  return doc;
}

// Preserve complete catalog keys. A bare model id may use a terminal-key
// fallback only when every matching entry publishes exactly the same rates;
// otherwise guessing a provider would turn "cost unavailable" into a wrong
// cost. Full exact keys and bare exact keys always win before that fallback.
function tokscalePricingCatalog(options = {}) {
  const snapshot = tokscalePricingCatalogSnapshot(options);
  const nowMs = options.nowMs ?? Date.now();
  if (
    tokscaleCatalogCache.revision === snapshot.revision
    && tokscaleCatalogCache.catalog
    && (!tokscaleCatalogCache.recheckAtMs || nowMs < tokscaleCatalogCache.recheckAtMs)
  ) {
    return tokscaleCatalogCache.catalog;
  }
  const exact = new Map();
  const byTerminal = new Map();
  const nowSeconds = Math.floor(nowMs / 1000);
  let recheckAtMs = 0;
  for (const source of snapshot.files) {
    let doc = null;
    for (const candidate of source.candidates) {
      doc = parseTokscalePricingCatalogFile(candidate.file);
      if (doc) break;
    }
    if (!doc) continue;
    const timestamp = doc?.timestamp;
    if (timestamp > nowSeconds) {
      const eligibleAtMs = timestamp * 1000;
      recheckAtMs = recheckAtMs ? Math.min(recheckAtMs, eligibleAtMs) : eligibleAtMs;
      continue;
    }
    for (const [key, value] of Object.entries(doc.data)) {
      const modelId = normalizeCatalogModelKey(key);
      if (!modelId) continue;
      const pricing = normalizeCatalogPricing(value);
      if (!pricing) continue;
      if (!exact.has(modelId)) exact.set(modelId, pricing);
      const terminal = terminalCatalogModelKey(modelId);
      if (!terminal) continue;
      if (!byTerminal.has(terminal)) byTerminal.set(terminal, []);
      byTerminal.get(terminal).push({ modelId, pricing });
    }
  }
  const catalogRevision = recheckAtMs ? `${snapshot.revision}:before:${recheckAtMs}` : snapshot.revision;
  const catalog = { revision: catalogRevision, exact, byTerminal };
  tokscaleCatalogCache = { revision: snapshot.revision, catalog, recheckAtMs };
  return catalog;
}

function readTokscalePricingCatalog(modelId, options = {}) {
  const key = String(modelId || '').trim().toLowerCase();
  if (!key) return null;
  // Bare router labels never identify the model that actually served usage.
  // A qualified key such as morph/auto remains eligible for exact lookup.
  if (TOKSCALE_ROUTING_LABELS.has(key)) return null;
  const catalog = tokscalePricingCatalog(options);
  const exact = catalog.exact.get(key);
  if (exact) return exact;
  // A provider-scoped id that does not exist exactly must not borrow another
  // provider's terminal match.
  if (key.includes('/')) return null;
  if (TOKSCALE_TERMINAL_FALLBACK_BLOCKLIST.has(key)) return null;
  const candidates = catalog.byTerminal.get(key) || [];
  if (candidates.length === 0) return null;
  const fingerprints = new Set(candidates.map(({ pricing }) => catalogPricingFingerprint(pricing)));
  return fingerprints.size === 1 ? candidates[0].pricing : null;
}

function resetTokscaleCatalogCache() {
  tokscaleCatalogCache = { revision: '', catalog: null, recheckAtMs: 0 };
}

function tokscalePricingCatalogRevision(options = {}) {
  const snapshot = tokscalePricingCatalogSnapshot(options);
  const nowMs = options.nowMs ?? Date.now();
  if (tokscaleCatalogCache.revision !== snapshot.revision || !tokscaleCatalogCache.catalog) {
    return snapshot.revision;
  }
  if (tokscaleCatalogCache.recheckAtMs && nowMs >= tokscaleCatalogCache.recheckAtMs) {
    return `${snapshot.revision}:recheck:${tokscaleCatalogCache.recheckAtMs}`;
  }
  return tokscaleCatalogCache.catalog.revision;
}

const PROMA_PRICING_LOOKUP_TIMEOUT_MS = 3000;
const promaPricingCache = new Map();

function promaPricingRevision() {
  try { return fs.statSync(customPricingPath()).mtimeMs; } catch (_) { return 0; }
}

function normalizePromaPricing(result) {
  const source = result?.pricing;
  if (!source || typeof source !== 'object') return null;
  const pricing = {
    inputCostPerToken: normalizePricingRate(source, 'inputCostPerToken'),
    outputCostPerToken: normalizePricingRate(source, 'outputCostPerToken'),
    cacheReadInputTokenCost: normalizePricingRate(source, 'cacheReadInputTokenCost'),
    cacheCreationInputTokenCost: normalizePricingRate(source, 'cacheCreationInputTokenCost')
  };
  return pricing.inputCostPerToken !== undefined || pricing.outputCostPerToken !== undefined ? pricing : null;
}

async function resolveModelPricing(rows, options = {}) {
  const lookup = options.lookupModelPricing || lookupModelPricing;
  const customRevision = options.pricingRevision ?? promaPricingRevision();
  const nowMs = options.nowMs ?? Date.now();
  const currentRevision = () => `${customRevision}|${tokscalePricingCatalogRevision({ ...options, nowMs })}`;
  let revision = currentRevision();
  // Pricing is supplementary: never let a missing catalog entry hold up the
  // live usage refresh for the normal tokscale command timeout.
  const commandTimeoutMs = options.commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS;
  const pricingByModel = {};
  const normalizeId = options.normalizeModelId || ((value) => String(value || '').trim().toLowerCase());
  const modelIds = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const rawModelId = String(row?.model || '').trim();
    const modelId = normalizeId(rawModelId);
    if (modelId) modelIds.set(modelId, true);
  }
  for (const [modelId] of modelIds) {
    const cached = promaPricingCache.get(modelId);
    if (cached && cached.revision === revision && nowMs - cached.at < PROMA_PRICING_CACHE_TTL_MS) {
      if (cached.pricing) pricingByModel[modelId] = cached.pricing;
      continue;
    }
    let pricing;
    try {
      pricing = normalizePromaPricing(await lookup(modelId, commandTimeoutMs));
    } catch (_) {
      // An unknown model, offline lookup, or custom channel must remain
      // cost-unavailable instead of inheriting an unrelated catalog price —
      // but when the lookup itself failed (timeout/offline), the price the
      // command would have fallen back to is tokscale's local catalog cache,
      // which is on disk without any network round trip.
      pricing = readTokscalePricingCatalog(modelId, options);
      // Parsing a future-dated source adds its time boundary to the catalog
      // revision, so an unavailable result expires when that source becomes
      // eligible even if the file itself does not change.
      revision = currentRevision();
    }
    promaPricingCache.set(modelId, { at: nowMs, revision, pricing });
    if (pricing) pricingByModel[modelId] = pricing;
  }
  return pricingByModel;
}

async function resolvePromaPricing(rows, options = {}) {
  return resolveModelPricing(rows, options);
}

function resetPromaPricingCache() {
  promaPricingCache.clear();
}

// Clients whose usage comes from a local adapter rather than the tokscale scan.
// DeepSeek Harness is deliberately NOT here: tokscale 4.17+ reads its session
// store natively (`--client dsh`), so it flows through the ordinary scan and the
// local parser is gone. Both Qoder sites are here because tokscale's `--client`
// value-enum has no Qoder entry at all — see QODER_SITE_BY_CLIENT_ID.
const LOCAL_PARSED_CLIENTS = new Set(LOCAL_USAGE_CLIENT_IDS);

function collectionDate(now) {
  const value = typeof now === 'function' ? now() : now;
  return value == null ? new Date() : new Date(value);
}

function tokscaleClientsCsv(normalizedClients) {
  return normalizedClients
    ? normalizedClients.split(',').filter((c) => !LOCAL_PARSED_CLIENTS.has(c)).join(',')
    : normalizedClients;
}

function includesLocalClient(normalizedClients, clientId) {
  return Boolean(normalizedClients) && normalizedClients.split(',').includes(clientId);
}

function localTodayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// The IANA zone this device buckets days into. Stamped onto periodWindows so the
// wire is self-describing: the `key` is a device-local day, and a consumer that
// needs to know *which* zone produced it no longer has to guess. Optional — a
// host without Intl or with an unresolved zone simply omits it, and
// normalizePeriodWindows() drops anything that is not a valid zone.
function localTimeZoneName() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' ? zone.trim().slice(0, 128) : '';
  } catch (_) {
    return '';
  }
}

// Stamp each posted snapshot with the UTC instant its today/month windows end
// (next local midnight / next month start, in this device's timezone). The hub
// uses these to expire a frozen snapshot once it goes offline past a day/month
// boundary, instead of counting stale "today" data forever (issue #37).
function computePeriodWindows(now = new Date()) {
  const startOfNextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const timeZone = localTimeZoneName();
  return {
    today: { key: localTodayKey(now), endsAt: startOfNextDay.toISOString() },
    month: { key: monthKey, endsAt: startOfNextMonth.toISOString() },
    ...(timeZone ? { timeZone } : {})
  };
}

function isoFromDate(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function timestampFromSessionId(id) {
  const raw = String(id || '');
  const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (isoMatch) return isoFromDate(isoMatch[0]);
  const localMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})[:-](\d{2})(?:[:-](\d{2}))?/);
  if (!localMatch) return '';
  const [, year, month, day, hour, minute, second = '0'] = localMatch;
  return isoFromDate(new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

function readFileTail(filePath, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function timestampFromJsonLine(line) {
  try {
    const obj = JSON.parse(line);
    return isoFromDate(obj.timestamp || obj.updatedAt || obj.updated_at || obj.createdAt || obj.created_at);
  } catch (_) {
    return '';
  }
}

// Bounded: keys are transcript paths, and a long-running widget/agent sees churn
// in ~/.claude/projects and ~/.codex/sessions, so deleted trees used to leave
// their entries (and cached values) alive for the whole process lifetime.
const PROJECT_PATH_CACHE_MAX = 10_000;
const projectPathCache = new Map();

// Insertion-ordered Map: re-inserting on hit keeps the newest entries at the end,
// so evicting the front is a cheap approximation of LRU.
function cacheSetBounded(cache, key, value, maxEntries) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function projectPathFromJsonl(filePath) {
  let text;
  let cacheKey;
  try {
    const stat = fs.statSync(filePath);
    cacheKey = `${stat.size}:${stat.mtimeMs}`;
    const cached = projectPathCache.get(filePath);
    if (cached?.key === cacheKey) return cached.value;
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = Math.min(256 * 1024, fs.fstatSync(fd).size);
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, 0);
      text = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
      const value = payload.cwd || payload.project_path || payload.projectPath || payload.workingDirectory || payload.working_directory;
      if (typeof value === 'string' && value.trim()) {
        const result = value.trim();
        cacheSetBounded(projectPathCache, filePath, { key: cacheKey, value: result }, PROJECT_PATH_CACHE_MAX);
        return result;
      }
    } catch (_) { /* skip partial or non-JSON lines */ }
  }
  cacheSetBounded(projectPathCache, filePath, { key: cacheKey, value: '' }, PROJECT_PATH_CACHE_MAX);
  return '';
}

function normalizeProjectPath(value) {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const windows = /^[a-z]:\//i.test(normalized) || normalized.startsWith('//');
  const root = normalized === '/' || /^[a-z]:\/$/i.test(normalized);
  if (!root) normalized = normalized.replace(/\/+$/, '');
  return windows ? normalized.toLowerCase() : normalized;
}

function projectIdentity(value) {
  const normalized = normalizeProjectPath(value);
  if (!normalized) return {};
  const root = normalized === '/' || /^[a-z]:\/$/i.test(normalized);
  let displayPath = String(value || '').trim().replace(/\\/g, '/');
  if (!root) displayPath = displayPath.replace(/\/+$/, '');
  const label = root ? (normalized === '/' ? '/' : `${normalized[0].toUpperCase()}:\\`) : displayPath.split('/').pop();
  return { projectId: hashKey('project', normalized), projectLabel: label };
}

// Keyed by path -> { key: `size:mtimeMs`, value }, mirroring projectPathCache.
// The tail timestamp only moves when the transcript grows, so a mtime match lets
// a full-tick decoration skip re-reading every idle session (issue: periodic UI
// stutter once project tracking made this run on every session each tick).
const JSONL_TIMESTAMP_CACHE_MAX = 10_000;
const jsonlTimestampCache = new Map();

function lastJsonlTimestamp(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return ''; }
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = jsonlTimestampCache.get(filePath);
  if (cached?.key === cacheKey) return cached.value;
  const tail = readFileTail(filePath);
  const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let value = '';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const timestamp = timestampFromJsonLine(lines[index]);
    if (timestamp) { value = timestamp; break; }
  }
  if (!value) value = stat.mtime.toISOString();
  cacheSetBounded(jsonlTimestampCache, filePath, { key: cacheKey, value }, JSONL_TIMESTAMP_CACHE_MAX);
  return value;
}

function sessionRefsForPeriods(periods) {
  const refs = new Map();
  for (const period of Object.values(periods || {})) {
    for (const session of Object.values(period?.sessions || {})) {
      if (!session?.client || !session?.sessionId) continue;
      refs.set(`${session.client}:${session.sessionId}`, { client: session.client, sessionId: session.sessionId });
    }
  }
  return refs;
}

function sessionTimestampMap(periods, home = os.homedir(), deps = {}) {
  const refs = sessionRefsForPeriods(periods);
  const metadata = deps.metadataCache || new Map();
  const resolvedSessionKeys = deps.resolvedSessionKeys || new Set();
  const attemptedSessionKeys = deps.attemptedSessionKeys || new Set();
  // Timestamps are always backfilled (the session view sorts by recency); project
  // identity is the part gated by the Projects opt-out (issue #182).
  const resolveProjects = deps.resolveProjects !== false;
  const byClient = new Map();
  for (const ref of refs.values()) {
    const key = `${ref.client}:${ref.sessionId}`;
    if (resolvedSessionKeys.has(key)) continue;
    if (!deps.retryMisses && attemptedSessionKeys.has(key)) continue;
    if (!byClient.has(ref.client)) byClient.set(ref.client, new Set());
    byClient.get(ref.client).add(ref.sessionId);
  }

  const applyFile = (client, sessionId, filePath) => {
    const startedAt = timestampFromSessionId(sessionId);
    const lastUsedAt = lastJsonlTimestamp(filePath) || startedAt;
    const identity = resolveProjects ? projectIdentity(projectPathFromJsonl(filePath)) : {};
    const key = `${client}:${sessionId}`;
    metadata.set(key, { startedAt, lastUsedAt, ...identity });
    if (identity.projectId) resolvedSessionKeys.add(key);
  };

  // OpenCode has no transcript file — its timestamps come from the opencode.db `session` table.
  const opencodeIds = byClient.get('opencode') || new Set();
  if (opencodeIds.size > 0) {
    const readOpencodeMeta = deps.readOpencodeMeta || (deps.scopedHome
      ? (ids) => opencodeSession.readSessionMetaForHome(ids, home, deps.opencodeDeps)
      : (ids) => opencodeSession.readSessionMeta(ids, deps.opencodeDeps));
    for (const [sessionId, meta] of readOpencodeMeta(opencodeIds)) {
      const startedAt = meta.startedAt || '';
      const lastUsedAt = meta.lastUsedAt || startedAt;
      const identity = resolveProjects ? projectIdentity(meta.projectPath) : {};
      const key = `opencode:${sessionId}`;
      if (startedAt || lastUsedAt || identity.projectId) metadata.set(key, { startedAt, lastUsedAt, ...identity });
      if (identity.projectId) resolvedSessionKeys.add(key);
    }
  }

  const claudeFiles = findSessionFiles(path.join(home, '.claude', 'projects'), byClient.get('claude') || []);
  for (const [sessionId, filePath] of claudeFiles) applyFile('claude', sessionId, filePath);

  const codexIds = byClient.get('codex') || new Set();
  const codexRoot = deps.scopedHome ? path.join(home, '.codex') : codexDataHome(home);
  const missingCodexIds = new Set();
  for (const sessionId of codexIds) {
    const filePath = codexSessionFile(home, sessionId, codexRoot);
    if (filePath) applyFile('codex', sessionId, filePath);
    else missingCodexIds.add(sessionId);
  }
  const codexFiles = findSessionFiles(path.join(codexRoot, 'sessions'), missingCodexIds);
  for (const [sessionId, filePath] of codexFiles) applyFile('codex', sessionId, filePath);

  for (const ref of refs.values()) {
    const key = `${ref.client}:${ref.sessionId}`;
    if (resolvedSessionKeys.has(key)) continue;
    if (metadata.has(key)) continue;
    const timestamp = timestampFromSessionId(ref.sessionId);
    if (timestamp) metadata.set(key, { startedAt: timestamp, lastUsedAt: timestamp });
    if (!['claude', 'codex', 'opencode'].includes(ref.client)) resolvedSessionKeys.add(key);
  }
  for (const ref of refs.values()) attemptedSessionKeys.add(`${ref.client}:${ref.sessionId}`);

  return metadata;
}

// Copy freshly decorated identities/timestamps from `today` onto the same session
// in the delta-derived periods. Used on watch ticks, where month/allTime are not
// re-decorated: a session that started today is absent from the anchor, so its
// project label would otherwise be missing from the broader-period breakdown.
function propagateTodayProjects(today, periods) {
  for (const [key, session] of Object.entries(today?.sessions || {})) {
    if (!session) continue;
    for (const period of periods) {
      const target = period?.sessions?.[key];
      if (!target) continue;
      if (session.projectId && !target.projectId) {
        target.projectId = session.projectId;
        target.projectLabel = session.projectLabel;
      }
      if (session.startedAt && (!target.startedAt || Date.parse(session.startedAt) < Date.parse(target.startedAt))) {
        target.startedAt = session.startedAt;
      }
      if (session.lastUsedAt && (!target.lastUsedAt || Date.parse(session.lastUsedAt) > Date.parse(target.lastUsedAt))) {
        target.lastUsedAt = session.lastUsedAt;
      }
    }
  }
}

function applySessionTimestamps(periods, home, deps = {}) {
  const metadata = sessionTimestampMap(periods, home, deps);
  for (const period of Object.values(periods || {})) {
    for (const [key, session] of Object.entries(period?.sessions || {})) {
      const meta = metadata.get(key);
      if (!meta) continue;
      if (meta.startedAt && (!session.startedAt || Date.parse(meta.startedAt) < Date.parse(session.startedAt))) session.startedAt = meta.startedAt;
      if (meta.lastUsedAt && (!session.lastUsedAt || Date.parse(meta.lastUsedAt) > Date.parse(session.lastUsedAt))) session.lastUsedAt = meta.lastUsedAt;
      if (meta.projectId) session.projectId = meta.projectId;
      if (meta.projectLabel) session.projectLabel = meta.projectLabel;
    }
  }
}

// Cursor/antigravity usage only changes when these syncs run, so re-running them
// on every tick is pure overhead. Keep the throttle process-wide: rebuilding a
// collector during a settings change must not grant a second immediate sync.
const selfSyncThrottle = createSelfSyncThrottle();

async function maybeSyncCursor(clientsCsv, logger, options = {}) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('cursor')) return;
  if (!cursorAuth.readActiveAccount()) return;
  const minIntervalMs = options.minIntervalMs ?? selfSyncThrottle.minIntervalForTick(
    options.force === true ? { forceSelfSync: ['cursor'] } : {},
    'cursor'
  );
  if (!selfSyncThrottle.claim('cursor', minIntervalMs)) return;
  const attempt = selfSyncThrottle.beginAttempt('cursor');
  try {
    await cursorAuth.runCursorSync();
    selfSyncThrottle.completeAttempt('cursor', attempt, false);
  } catch (err) {
    if (typeof logger === 'function') logger(`cursor sync failed: ${err.message}`);
    selfSyncThrottle.completeAttempt('cursor', attempt, true, 'sync-failed', {
      failureStage: err?.syncFailureStage,
      detailCode: err?.syncDetailCode || classifyClientSyncDetailCode({ client: 'cursor', text: err?.message }),
      exitCode: err?.syncExitCode
    });
    options.onFailure?.('cursor');
  }
}

// tokscale's antigravity sync reads the IDE's native session roots under
// ~/.gemini/; when none exist there is nothing to sync, so don't spawn at all.
const ANTIGRAVITY_DATA_ROOTS = ['antigravity', 'antigravity-ide', 'antigravity-backup'];

function antigravityDataRoots(home = os.homedir()) {
  return ANTIGRAVITY_DATA_ROOTS.map((name) => path.join(home, '.gemini', name));
}

function antigravityDataPresent(home) {
  const geminiHome = geminiDataHome(home);
  return ANTIGRAVITY_DATA_ROOTS.some((name) => dirExists(path.join(geminiHome, name)));
}

async function maybeSyncAntigravity(clientsCsv, logger, home = os.homedir(), options = {}) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('antigravity')) return { attempted: false, failed: false };
  if (!antigravityDataPresent(home)) return { attempted: false, failed: false };
  const minIntervalMs = options.minIntervalMs ?? selfSyncThrottle.minIntervalForTick(
    options.force === true ? { forceSelfSync: ['antigravity'] } : {},
    'antigravity'
  );
  if (!selfSyncThrottle.claim('antigravity', minIntervalMs)) return { attempted: false, failed: false };
  const attempt = selfSyncThrottle.beginAttempt('antigravity');
  if (typeof options.run === 'function') {
    try {
      await options.run();
      selfSyncThrottle.completeAttempt('antigravity', attempt, false);
      return { attempted: true, failed: false };
    } catch (error) {
      if (typeof logger === 'function') logger(`antigravity sync failed: ${error.message}`);
      const details = {
        failureStage: error?.syncFailureStage,
        detailCode: error?.syncDetailCode || classifyClientSyncDetailCode({ client: 'antigravity', text: error?.message }),
        exitCode: error?.syncExitCode
      };
      selfSyncThrottle.completeAttempt('antigravity', attempt, true, 'sync-failed', {
        ...details
      });
      options.onFailure?.('antigravity');
      return { attempted: true, failed: true, ...details };
    }
  }
  const { bin, prefixArgs, env } = tokscaleCommand();
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (failed, code = '', details = {}) => {
      if (settled) return;
      settled = true;
      selfSyncThrottle.completeAttempt('antigravity', attempt, failed, code, details);
      if (failed) options.onFailure?.('antigravity');
      resolve({ attempted: true, failed, code, ...details });
    };
    const child = spawn(bin, [...prefixArgs, 'antigravity', 'sync'], { env, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      terminateChild(child);
      abandonChildStreams(child);
      settle(true, 'sync-timeout', { failureStage: 'timeout' });
    }, 30000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      settle(true, 'sync-spawn-failed', {
        failureStage: 'spawn',
        detailCode: classifyClientSyncDetailCode({ client: 'antigravity', text: error?.message })
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && typeof logger === 'function') logger(`antigravity sync exited ${code}: ${stderr.trim().slice(0, 200)}`);
      settle(code !== 0, 'sync-exit-error', {
        failureStage: code !== 0 ? 'process-exit' : null,
        detailCode: code !== 0 ? classifyClientSyncDetailCode({ client: 'antigravity', text: stderr }) : null,
        exitCode: code
      });
    });
    child.stdin?.end();
  });
}

// Trae and Warp/Oz are the two clients tokscale reads from a cache IT writes
// (`<config>/tokscale/<client>-cache`), so without a sync they read as `missing`
// forever. They are in SELF_SYNCED_CLIENTS to keep that write path out of the
// watcher (issue #15), which is what makes this runner the only thing that can
// refresh them.
//
// The credential gate is the important half: unlike cursor/antigravity, whose
// auth is a local file the app itself wrote, `tokscale trae login` and `tokscale
// warp login` are INTERACTIVE. Running the sync while unauthenticated would spawn
// a subprocess that cannot succeed on every tick, so status is checked first and
// a machine that has not logged in is skipped in silence (the client then reports
// `missing`, which is the honest state).
async function maybeSyncCachedClient(client, clientsCsv, logger, options = {}) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has(client)) return { attempted: false, failed: false };
  const hasCredentials = typeof options.hasCredentials === 'function'
    ? await options.hasCredentials(client)
    : await clientSyncRunners.hasClientCredentials(client, options);
  if (!hasCredentials) return { attempted: false, failed: false };
  const minIntervalMs = options.minIntervalMs ?? selfSyncThrottle.minIntervalForTick(
    options.force === true ? { forceSelfSync: [client] } : {},
    client
  );
  if (!selfSyncThrottle.claim(client, minIntervalMs)) return { attempted: false, failed: false };
  const attempt = selfSyncThrottle.beginAttempt(client);
  try {
    await clientSyncRunners.runClientSync(client, options);
    selfSyncThrottle.completeAttempt(client, attempt, false);
    return { attempted: true, failed: false };
  } catch (error) {
    if (typeof logger === 'function') logger(`${client} sync failed: ${error.message}`);
    const details = {
      failureStage: error?.syncFailureStage,
      detailCode: error?.syncDetailCode || classifyClientSyncDetailCode({ client, text: error?.message }),
      exitCode: error?.syncExitCode
    };
    selfSyncThrottle.completeAttempt(client, attempt, true, 'sync-failed', { ...details });
    options.onFailure?.(client);
    return { attempted: true, failed: true, ...details };
  }
}

const HISTORY_CAP_DAYS = 370;
const HISTORY_TIMEOUT_MS = 60000;
const DEFAULT_HISTORY_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_INTERVAL_VALUES = new Set([5, 10, 15, 30, 60].map((minutes) => minutes * 60 * 1000));

function normalizeHistoryIntervalMs(value) {
  const parsed = Number(value);
  return HISTORY_INTERVAL_VALUES.has(parsed) ? parsed : DEFAULT_HISTORY_INTERVAL_MS;
}

// tokscale's `graph` output keys its per-client stacks by the id tokscale itself
// uses, which for a renamed client is the upstream spelling (`dsh` for DeepSeek
// Harness, `antigravity-cli` for the Antigravity CLI). The period path already
// folds those through normalizeClientName; the graph path did not, so a renamed
// client surfaced in Trends under its upstream id and split away from the same
// client's period totals. Rewrite the ids once, at the boundary, so every
// consumer of the graph — parseGraphResult, the daily-history archive,
// mergeHistories — sees the id the rest of the device record uses. Idempotent, so
// it is safe on the locally built graphs that already use our ids.
function normalizeGraphClientIds(graph) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.contributions)) return graph;
  for (const row of graph.contributions) {
    if (!row || typeof row !== 'object' || !Array.isArray(row.clients)) continue;
    for (const entry of row.clients) {
      if (!entry || typeof entry !== 'object') continue;
      const normalized = normalizeClientName(entry.client);
      if (normalized) entry.client = normalized;
    }
  }
  return graph;
}

async function collectHistoryOnce(options) {
  const startedAt = Date.now();
  const attemptedAt = new Date(startedAt).toISOString();
  let failureCode = null;
  const reportStatus = (success) => {
    try {
      options.onHistoryStatus?.({
        attemptedAt,
        successAt: success ? new Date().toISOString() : null,
        failureCode,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    } catch (_) {
      // Diagnostic observers must never affect history collection.
    }
  };
  const clients = normalizeClientsCsv(options.clients);
  if (options.historyEnabled === false) return null;
  const histories = [];
  const rawGraphs = [];
  const runGraph = options.runGraph || runTokscaleGraph;
  const capDays = Number.isFinite(options.capDays) ? options.capDays : HISTORY_CAP_DAYS;
  const todayKey = options.todayKey || localTodayKey();
  if (clients) {
    try {
      const graphJson = await runGraph({ clients, commandTimeoutMs: options.commandTimeoutMs || HISTORY_TIMEOUT_MS });
      const normalizedGraph = normalizeGraphClientIds(graphJson);
      rawGraphs.push(normalizedGraph);
      histories.push(normalizeHistory(parseGraphResult(normalizedGraph), { capDays, todayKey }));
    } catch (error) {
      failureCode = 'history-graph-failed';
      if (typeof options.logger === 'function') options.logger(`tokscale graph failed: ${error.message}`);
    }
  }
  if (options.promaGraph) {
    rawGraphs.push(options.promaGraph);
    histories.push(normalizeHistory(parseGraphResult(options.promaGraph), { capDays, todayKey }));
  }
  if (options.claudeDesktopGraph) {
    rawGraphs.push(options.claudeDesktopGraph);
    histories.push(normalizeHistory(parseGraphResult(options.claudeDesktopGraph), { capDays, todayKey }));
  }
  // One graph per locally parsed Qoder client. Each is keyed by its own client
  // id inside the graph, so two sites contribute two independent series.
  for (const qoderGraph of options.qoderGraphs || []) {
    if (!qoderGraph) continue;
    rawGraphs.push(qoderGraph);
    histories.push(normalizeHistory(parseGraphResult(qoderGraph), { capDays, todayKey }));
  }
  if (options.deepseekHarnessGraph) {
    rawGraphs.push(options.deepseekHarnessGraph);
    histories.push(normalizeHistory(parseGraphResult(options.deepseekHarnessGraph), { capDays, todayKey }));
  }
  // WSL homes are folded into the periods by collectUsageOnce, but the host
  // tokscale graph has no idea they exist: without a per-home graph their past
  // days survive only in the local daily-history archive's liveDays overlay and
  // are lost the moment that archive is unavailable or a day was never captured
  // live. Scanning the same graph per discovered home on history ticks makes WSL
  // history as re-derivable as the host's. `--home` is hermetic upstream, so this
  // cannot read Windows-home data by mistake.
  if (options.wslScanEnabled !== false && (options.platform || process.platform) === 'win32') {
    const discoverHomes = options.discoverWslHomes || wslUsageHomes;
    const runWslGraph = options.runWslGraph || runTokscaleGraphForHome;
    let homes = [];
    try {
      homes = discoverHomes() || [];
    } catch (error) {
      failureCode = failureCode || 'history-wsl-discover-failed';
      if (typeof options.logger === 'function') options.logger(`wsl home discovery failed: ${error.message}`);
    }
    for (const home of homes) {
      if (!home) continue;
      try {
        // Serial, like every other tokscale scan: concurrent scans triple peak
        // CPU/IO for no wall-clock win.
        const graphJson = await runWslGraph({
          clients,
          home,
          commandTimeoutMs: options.commandTimeoutMs || HISTORY_TIMEOUT_MS
        });
        const normalizedGraph = normalizeGraphClientIds(graphJson);
        rawGraphs.push(normalizedGraph);
        histories.push(normalizeHistory(parseGraphResult(normalizedGraph), { capDays, todayKey }));
      } catch (error) {
        failureCode = failureCode || 'history-wsl-graph-failed';
        if (typeof options.logger === 'function') options.logger(`tokscale wsl graph failed for ${home}: ${error.message}`);
      }
    }
  }
  if (options.dailyHistoryArchiveEnabled) {
    try {
      const retainedGraph = retainDailyHistory(rawGraphs, {
        ...(options.dailyHistoryArchiveOptions || {}),
        liveDays: options.dailyHistoryLiveDays,
        todayKey,
        capDays,
        writeEnabled: options.dailyHistoryArchiveWriteEnabled
      });
      const retained = normalizeHistory(parseGraphResult(retainedGraph), { capDays, todayKey });
      const result = retained.daily.length || retained.monthly.length ? retained : null;
      reportStatus(failureCode === null);
      return result;
    } catch (error) {
      failureCode = failureCode || 'daily-history-archive-failed';
      if (typeof options.logger === 'function') options.logger(`daily history archive failed: ${error.message}`);
    }
  }
  if (histories.length === 0) {
    reportStatus(false);
    return null;
  }
  const history = histories.length === 1 ? histories[0] : mergeHistories(histories, { todayKey });
  const result = history.daily.length || history.monthly.length ? history : null;
  reportStatus(failureCode === null);
  return result;
}

function shouldIncludeHistory(nowMs, lastHistoryAtMs, historyIntervalMs, force, enabled = true) {
  if (enabled === false) return false;
  if (force) return true;
  return nowMs - (lastHistoryAtMs || 0) >= historyIntervalMs;
}

function cloneQoderCnDiagnostics(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    if (Array.isArray(cloned.usedSources)) cloned.usedSources = [...new Set(cloned.usedSources)];
    return cloned;
  } catch (_) {
    return null;
  }
}

// The per-client read-state objects a Qoder tick reports back through. Callers
// may still pass the historical single-client `qoderCnReadState`; it is read as
// the `qodercn` entry, so an in-flight caller cannot silently lose the fallback
// signal that decides whether a watch tick may reuse the anchor.
function normalizeQoderReadStates(options = {}) {
  const states = new Map();
  const perClient = options.qoderReadStates;
  if (perClient && typeof perClient === 'object') {
    for (const [clientId, state] of Object.entries(perClient)) {
      if (state && typeof state === 'object') states.set(clientId, state);
    }
  }
  if (options.qoderCnReadState && !states.has('qodercn')) states.set('qodercn', options.qoderCnReadState);
  return states;
}

// Same story for the anchored fallback periods: the per-client map wins, and the
// legacy CN-only key still feeds the CN client.
function qoderFallbackPeriodsFor(options = {}, clientId) {
  const perClient = options.qoderFallbackPeriods;
  if (perClient && typeof perClient === 'object' && perClient[clientId]) return perClient[clientId];
  return clientId === 'qodercn' ? (options.qoderCnFallbackPeriods || null) : null;
}

// ...and for the retained history graph a failed read falls back to.
function qoderHistoryFallbackGraphFor(options = {}, clientId) {
  const perClient = options.qoderHistoryFallbackGraphs;
  if (perClient && typeof perClient === 'object' && perClient[clientId]) return perClient[clientId];
  return clientId === 'qodercn' ? (options.qoderCnHistoryFallbackGraph || null) : null;
}

// One Qoder client's usage for this tick. Both sites share the adapter and the
// transcript scan budget (their transcripts are the same shape and the same
// order of size), so the only per-client inputs are the site id and that
// client's own anchored fallback. Clients are read serially, for the same reason
// the tokscale scans are: two concurrent SQLite reads double peak IO for no
// wall-clock win.
async function collectQoderClientUsage(clientId, ctx) {
  const { options, platformValue, collectedAt, allTimeSince, anchorUsed, readState, fallbackPeriods } = ctx;
  const site = QODER_SITE_BY_CLIENT_ID[clientId] || 'cn';
  const log = typeof options.logger === 'function' ? options.logger : null;
  const state = {
    clientId,
    site,
    periods: null,
    rows: null,
    pricing: null,
    periodReadFailed: false,
    diagnostics: null
  };
  // A history tick needs the full source set for its graph. Read that set once
  // here and reuse it for both periods and history; an anchored watch tick
  // without history still reads only today's source window.
  const sinceMs = anchorUsed && !options.includeHistory
    ? new Date(collectedAt.getFullYear(), collectedAt.getMonth(), collectedAt.getDate()).getTime()
    : undefined;
  const sourceOptions = {
    clientId,
    site,
    homeDir: options.homeDir || os.homedir(),
    platform: platformValue,
    env: options.env || process.env,
    logger: options.logger
  };
  const transcriptDiagnostics = {};
  const diagnostics = {
    source: 'none',
    legacyDb: { configured: true, rows: 0, failed: false },
    mainDb: { configured: true, rows: 0, failed: false },
    transcript: transcriptDiagnostics,
    estimated: false,
    fallback: false,
    failureCode: null
  };
  state.diagnostics = diagnostics;
  // The three sources can each fail without the others — a corrupted local.db
  // must not suppress rows from the transcript scan, and vice versa — so each is
  // read in its own try/catch. The period counts as failed only when no source
  // produced rows, which keeps the anchored fallback authoritative.
  let legacyRows = null;
  let mainRows = null;
  let legacyReadFailed = false;
  try {
    legacyRows = await collectQoderCnRows({ ...sourceOptions, sinceMs });
    diagnostics.legacyDb.rows = legacyRows.length;
  } catch (dbErr) {
    legacyReadFailed = true;
    diagnostics.legacyDb.failed = true;
    diagnostics.legacyDb.failureCode = dbErr.code || 'QODER_CN_DB_READ_FAILED';
    diagnostics.failureCode = diagnostics.legacyDb.failureCode;
    if (log) log(`${clientId} legacy parse failed: ${dbErr.message}`);
  }
  let mainReadFailed = false;
  try {
    mainRows = await collectQoderCnMainRows({ ...sourceOptions, sinceMs });
    diagnostics.mainDb.rows = mainRows.length;
  } catch (mainDbErr) {
    mainReadFailed = true;
    diagnostics.mainDb.failed = true;
    diagnostics.mainDb.failureCode = mainDbErr.code || 'QODER_CN_MAIN_DB_READ_FAILED';
    diagnostics.failureCode = diagnostics.failureCode || diagnostics.mainDb.failureCode;
    if (log) log(`${clientId} main sqlite parse failed: ${mainDbErr.message}`);
  }
  let transcriptRows = [];
  try {
    transcriptRows = collectQoderCnTranscriptRows({
      ...sourceOptions,
      sinceMs,
      diagnostics: transcriptDiagnostics,
      maxFiles: options.qoderCnTranscriptMaxFiles,
      maxTotalBytes: options.qoderCnTranscriptMaxBytes,
      maxDepth: options.qoderCnTranscriptMaxDepth,
      maxDurationMs: options.qoderCnTranscriptMaxDurationMs
    });
  } catch (transcriptErr) {
    diagnostics.failureCode = diagnostics.failureCode || transcriptErr.code || 'QODER_CN_TRANSCRIPT_READ_FAILED';
    if (log) log(`${clientId} transcript rows skipped: ${transcriptErr.message}`);
  }
  state.rows = mergeQoderCnRows(
    [...(legacyRows || []), ...(mainRows || [])],
    transcriptRows,
    diagnostics,
    {
      databaseSources: {
        legacy: (legacyRows || []).length > 0,
        main: (mainRows || []).length > 0
      }
    }
  );
  // A transcript scan can find rows that are all superseded by SQLite. Only mark
  // the device estimate/fallback when transcript rows actually contributed to the
  // merged periods; otherwise the UI would label an entirely authoritative SQLite
  // result as estimated.
  const transcriptWasUsed = diagnostics.usedSources.includes('transcript');
  // `main-sqlite` reaches usedSources only when a main row survived the
  // transcript-session suppression inside mergeQoderCnRows, which is exactly the
  // condition under which that store contributed an estimate. Reading
  // `mainRows.length` here instead would label a period estimated when every one
  // of those rows was a transcript duplicate.
  diagnostics.estimated = transcriptWasUsed || diagnostics.usedSources.includes('main-sqlite');
  diagnostics.fallback = legacyReadFailed && mainReadFailed && transcriptWasUsed;
  diagnostics.transcriptRows = transcriptRows.length;
  if (readState) readState.diagnostics = diagnostics;
  try {
    if ((legacyReadFailed || mainReadFailed) && !(state.rows && state.rows.length)) {
      throw new Error(`${clientId} read failed: sqlite source unreadable and no transcript rows`);
    }
    state.pricing = await resolveQoderCnPricing(state.rows, {
      lookupModelPricing: options.lookupModelPricing || lookupModelPricing,
      commandTimeoutMs: options.pricingTimeoutMs,
      pricingRevision: options.pricingRevision
    });
    const json = buildQoderCnPeriods({
      now: collectedAt,
      allTimeSince,
      rows: state.rows,
      pricingByModel: state.pricing,
      clientId
    });
    state.periods = {
      today: extractUsageFromTokscale(json.today),
      month: extractUsageFromTokscale(json.month),
      allTime: extractUsageFromTokscale(json.allTime)
    };
    if (!legacyReadFailed && !mainReadFailed && !diagnostics.transcript?.failureCode) {
      diagnostics.failureCode = null;
    }
  } catch (err) {
    if (log) log(`${clientId} parse failed: ${err.message}`);
    diagnostics.failureCode = diagnostics.failureCode || err.code || 'QODER_CN_PARSE_FAILED';
    state.periodReadFailed = true;
    if (readState) {
      readState.periodFailed = true;
      readState.fallbackUsed = Boolean(fallbackPeriods);
    }
    state.periods = fallbackPeriods || null;
  }
  return state;
}

async function collectUsageOnce(options) {
  const { clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion = appVersion(), agentRuntime = '' } = options;
  // One snapshot, one instant: capture the clock before any tokscale scan and
  // reuse it for the today-window key and updatedAt, so a collection that
  // straddles local midnight cannot pair a day-N today scan with a day-N+1
  // window (issue #37 follow-up). Injectable for tests.
  const collectedAt = collectionDate(options.now);
  const runTokscaleFn = options.runTokscale || runTokscale;
  const collectWsl = options.collectWslUsage || collectWslUsageImpl;
  const probeWslStateFn = options.probeWslState || probeWslStateImpl;
  // Injectable only for the WSL-status gate, so tests can exercise the win32
  // build path on a non-Windows CI box (the real process.platform stays for
  // tokscale binary resolution, which is genuinely platform-bound).
  const platformValue = options.platform || process.platform;
  const osInfo = options.osInfo === undefined
    ? hostOsInfo()
    : normalizeOsInfo(options.osInfo);
  const normalizedClients = normalizeClientsCsv(clients);
  const projectsEnabled = options.projectsEnabled !== false;
  const localSessionMetadataDeps = {
    ...(options.sessionMetadataDeps || {}),
    scopedHome: options.homeDir !== undefined
      ? true
      : Boolean(options.sessionMetadataDeps?.scopedHome),
    metadataCache: new Map(),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set()
  };
  const decorateLocalPeriods = (periods, { retryMisses = false } = {}) => applySessionTimestamps(
    periods,
    options.homeDir || os.homedir(),
    { ...localSessionMetadataDeps, retryMisses, resolveProjects: projectsEnabled }
  );
  // Proma, Claude Desktop and both Qoder sites remain local compatibility
  // adapters. Reasonix aggregate usage is supplied by the same Tokscale path as
  // every other tracked client.
  const localClients = LOCAL_PARSED_CLIENTS;
  const tokscaleClients = tokscaleClientsCsv(normalizedClients);
  const includesProma = normalizedClients.split(',').includes('proma');
  const includesClaudeDesktop = normalizedClients.split(',').includes('claude-desktop');
  const trackedQoderClients = enabledQoderClientIds(normalizedClients);
  const trackedClientSet = new Set(normalizedClients.split(',').filter(Boolean));
  const targetClients = [...new Set(normalizeClientsCsv(options.targetClients).split(',').filter((client) => trackedClientSet.has(client)))];
  const targetRequested = targetClients.length > 0;
  const targetTokscaleClients = targetClients.filter((client) => !localClients.has(client)).join(',');
  const qoderReadStates = normalizeQoderReadStates(options);
  for (const readState of qoderReadStates.values()) {
    readState.periodFailed = false;
    readState.fallbackUsed = false;
    readState.diagnostics = null;
  }
  let today = emptyPeriod();
  let month = emptyPeriod();
  let allTime = emptyPeriod();
  let dailyHistoryLiveDays = options.dailyHistoryLiveDays;
  let todayPartitions = null;
  const anchor = options.todayOnlyAnchor;
  const anchorUsed = Boolean(
    anchor
    && anchor.dateKey === localTodayKey(collectedAt)
    && canTargetTodayPartitions(anchor, targetClients)
  );
  let promaPeriods = null;
  let promaRows = null;
  let promaPricing = null;
  let claudeDesktopPeriods = null;
  let claudeDesktopRows = null;
  let claudeDesktopPricing = null;
  // Per-client state for the locally parsed Qoder sites, keyed by tracked client
  // id. Both installers share one adapter, so everything that used to be a
  // `qoderCn*` scalar is now one entry per enabled client — an anchored tick
  // must be able to retain the CN partition while the international one failed,
  // and vice versa.
  const qoderStates = new Map();
  let antigravitySyncFailed = false;
  const emitProgress = (periods) => {
    if (typeof options.onProgress !== 'function') return;
    let progress = { ...periods };
    if (claudeDesktopPeriods?.today && progress.today) progress.today = mergePeriods(progress.today, claudeDesktopPeriods.today);
    if (claudeDesktopPeriods?.month && progress.month) progress.month = mergePeriods(progress.month, claudeDesktopPeriods.month);
    for (const state of qoderStates.values()) {
      if (state.periods?.today && progress.today) progress = { ...progress, today: mergePeriods(progress.today, state.periods.today) };
      if (state.periods?.month && progress.month) progress = { ...progress, month: mergePeriods(progress.month, state.periods.month) };
    }
    try { options.onProgress({ ...progress, updatedAt: new Date().toISOString() }); } catch (_) {}
  };
  if (normalizedClients) {
    const syncClients = targetRequested ? targetTokscaleClients : tokscaleClients;
    await maybeSyncCursor(syncClients, options.logger, {
      minIntervalMs: selfSyncThrottle.minIntervalForTick(options, 'cursor'),
      onFailure: options.onSelfSyncFailed
    });
    // Trae/Warp read a tokscale-written cache, so this is the only refresh path.
    // Both are credential-gated inside the runner; a failure is logged and the
    // tick continues, because a stale cache is still readable data.
    for (const cachedClient of ['trae', 'warp']) {
      await maybeSyncCachedClient(cachedClient, syncClients, options.logger, {
        minIntervalMs: selfSyncThrottle.minIntervalForTick(options, cachedClient),
        onFailure: options.onSelfSyncFailed,
        hasCredentials: options.hasClientCredentials,
        runSync: options.runClientSync
      });
    }
    const antigravitySync = await maybeSyncAntigravity(syncClients, options.logger, options.homeDir || os.homedir(), {
      minIntervalMs: selfSyncThrottle.minIntervalForTick(options, 'antigravity'),
      run: options.runAntigravitySync,
      onFailure: options.onSelfSyncFailed
    });
    if (antigravitySync?.failed === true) {
      antigravitySyncFailed = true;
      const error = new Error('antigravity sync failed; retaining the last known usage snapshot');
      error.code = 'client-sync-failed';
      error.client = 'antigravity';
      error.syncFailureStage = antigravitySync.failureStage;
      error.syncDetailCode = antigravitySync.detailCode;
      error.syncExitCode = antigravitySync.exitCode;
      // A failed self-sync leaves the cache potentially stale or empty. Do not
      // let the following Tokscale scan turn a known-good today snapshot into
      // zero. Anchored ticks can safely keep the per-client partition; a cold or
      // cross-day full scan has no trustworthy partition to retain, so it must
      // fail the tick and leave the previous published record untouched.
      if (!(anchorUsed && anchor.todayPartitions?.antigravity)) throw error;
      if (typeof options.logger === 'function') options.logger('antigravity sync failed; using the anchored antigravity partition');
    }
    if (includesProma && (!targetRequested || targetClients.includes('proma'))) {
      try {
        promaRows = collectPromaRows();
        promaPricing = await resolvePromaPricing(promaRows, {
          lookupModelPricing: options.lookupModelPricing,
          commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
          pricingRevision: options.pricingRevision
        });
        const promaJson = buildPromaPeriods({ now: collectedAt, allTimeSince, rows: promaRows, pricingByModel: promaPricing });
        promaPeriods = {
          today: extractUsageFromTokscale(promaJson.today),
          month: extractUsageFromTokscale(promaJson.month),
          allTime: extractUsageFromTokscale(promaJson.allTime)
        };
      } catch (err) {
        if (typeof options.logger === 'function') options.logger(`proma parse failed: ${err.message}`);
      }
    }
    if (includesClaudeDesktop && (!targetRequested || targetClients.includes('claude-desktop'))) {
      try {
        claudeDesktopRows = collectClaudeDesktopRows({ homeDir: options.homeDir || os.homedir() });
        claudeDesktopPricing = await resolvePromaPricing(claudeDesktopRows, {
          lookupModelPricing: options.lookupModelPricing,
          commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
          pricingRevision: options.pricingRevision
        });
        const desktopJson = buildClaudeDesktopPeriods({
          now: collectedAt,
          allTimeSince,
          rows: claudeDesktopRows,
          pricingByModel: claudeDesktopPricing
        });
        claudeDesktopPeriods = {
          today: extractUsageFromTokscale(desktopJson.today),
          month: extractUsageFromTokscale(desktopJson.month),
          allTime: extractUsageFromTokscale(desktopJson.allTime)
        };
      } catch (error) {
        if (typeof options.logger === 'function') options.logger(`claude-desktop parse failed: ${error.message}`);
      }
    }
    for (const qoderClientId of trackedQoderClients) {
      if (targetRequested && !targetClients.includes(qoderClientId)) continue;
      qoderStates.set(qoderClientId, await collectQoderClientUsage(qoderClientId, {
        options,
        platformValue,
        collectedAt,
        allTimeSince,
        anchorUsed,
        readState: qoderReadStates.get(qoderClientId) || null,
        fallbackPeriods: qoderFallbackPeriodsFor(options, qoderClientId)
      }));
    }
    if (anchorUsed) {
      // Anchored tick (watch-triggered): every tokscale period scan costs the
      // same full load + filter, so scan only --today and update the broader
      // windows exactly via applyPeriodDelta — one spawn instead of three.
      const scanClients = targetRequested ? targetTokscaleClients : tokscaleClients;
      let freshPartitions = Object.create(null);
      let useTargetedPartitions = targetRequested;
      if (scanClients) {
        const todayJson = await runTokscaleFn({ clients: scanClients, flags: ['--today'], commandTimeoutMs });
        const bundle = extractUsageBundleFromTokscale(todayJson);
        freshPartitions = bundle.byClient;
        const unattributed = freshPartitions[UNATTRIBUTED_USAGE_CLIENT];
        if (targetRequested && periodHasUsage(unattributed)) {
          // A row without a client cannot be replaced safely inside one client
          // partition. Fall back to one all-client today scan for correctness.
          const fullTodayJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--today'], commandTimeoutMs });
          freshPartitions = extractUsageBundleFromTokscale(fullTodayJson).byClient;
          useTargetedPartitions = false;
        } else if (targetRequested) {
          // Empty tokscale output uses the unattributed fallback shape. Keep the
          // anchor's real unattributed partition while clearing the target.
          delete freshPartitions[UNATTRIBUTED_USAGE_CLIENT];
        }
      }
      if (promaPeriods) freshPartitions.proma = promaPeriods.today;
      if (claudeDesktopPeriods) freshPartitions['claude-desktop'] = claudeDesktopPeriods.today;
      for (const [qoderClientId, state] of qoderStates) {
        if (state.periods) freshPartitions[qoderClientId] = state.periods.today;
        if (state.periodReadFailed && anchor.todayPartitions?.[qoderClientId]) {
          // A transient sqlite read failure must not turn that client's existing
          // partition into an empty one or subtract it from month/allTime.
          freshPartitions[qoderClientId] = anchor.todayPartitions[qoderClientId];
        }
      }
      if (antigravitySyncFailed && anchor.todayPartitions?.antigravity) {
        // The cache scan after a failed sync is not a fresh observation. Keep
        // the exact partition that the anchor used for its month/allTime delta.
        freshPartitions.antigravity = anchor.todayPartitions.antigravity;
      }
      todayPartitions = useTargetedPartitions
        ? replaceTodayPartitions(anchor.todayPartitions, freshPartitions, targetClients)
        : completeTodayPartitions(freshPartitions, normalizedClients);
      today = mergeTodayPartitions(todayPartitions);
      month = applyPeriodDelta(anchor.month, today, anchor.today);
      allTime = applyPeriodDelta(anchor.allTime, today, anchor.today);
    } else if (tokscaleClients) {
      // Serial on purpose: concurrent scans triple the peak CPU/IO load, which
      // is what let the issue #15 self-trigger loop spike tokscale past 500% CPU.
      const todayJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--today'], commandTimeoutMs });
      const todayBundle = extractUsageBundleFromTokscale(todayJson);
      today = todayBundle.period;
      todayPartitions = todayBundle.byClient;
      if (typeof options.onProgress === 'function') decorateLocalPeriods({ today });
      emitProgress({ today });
      const monthJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--month'], commandTimeoutMs });
      month = extractUsageFromTokscale(monthJson);
      if (typeof options.onProgress === 'function') decorateLocalPeriods({ today, month });
      emitProgress({ today, month });
      const allTimeJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--since', allTimeSince], commandTimeoutMs });
      allTime = extractUsageFromTokscale(allTimeJson);
    }
    // Always decorate: session timestamps drive the recency sort regardless of the
    // Projects opt-out (issue #182). decorateLocalPeriods gates only project identity
    // on projectsEnabled, so opting out still costs the timestamp backfill and nothing
    // more.
    if (anchorUsed) {
      // Watch tick: `today` is a fresh scan and must be decorated, but month/
      // allTime are derived from the last full-scan anchor and already carry each
      // session's project label + timestamps through applyPeriodDelta. Decorating
      // them again would re-stat every historical session file every few seconds
      // (the perceived UI stutter). Decorate only today, then propagate its freshly
      // resolved identities onto sessions that started today (absent from the anchor).
      decorateLocalPeriods({ today }, { retryMisses: true });
      propagateTodayProjects(today, [month, allTime]);
    } else {
      decorateLocalPeriods({ today, month, allTime }, { retryMisses: true });
    }
    if (promaPeriods && !anchorUsed) {
      today = mergePeriods(today, promaPeriods.today);
      month = mergePeriods(month, promaPeriods.month);
      allTime = mergePeriods(allTime, promaPeriods.allTime);
      todayPartitions = { ...(todayPartitions || {}), proma: promaPeriods.today };
    }
    if (claudeDesktopPeriods && !anchorUsed) {
      today = mergePeriods(today, claudeDesktopPeriods.today);
      month = mergePeriods(month, claudeDesktopPeriods.month);
      allTime = mergePeriods(allTime, claudeDesktopPeriods.allTime);
      todayPartitions = { ...(todayPartitions || {}), 'claude-desktop': claudeDesktopPeriods.today };
    }
    if (!anchorUsed) {
      for (const [qoderClientId, state] of qoderStates) {
        if (!state.periods) continue;
        today = mergePeriods(today, state.periods.today);
        month = mergePeriods(month, state.periods.month);
        allTime = mergePeriods(allTime, state.periods.allTime);
        todayPartitions = { ...(todayPartitions || {}), [qoderClientId]: state.periods.today };
      }
    }
    todayPartitions = completeTodayPartitions(todayPartitions, normalizedClients);
    // Partition metadata is internal but must remain as complete as the public
    // period: a later targeted tick re-merges these sessions into `today`.
    propagateTodayProjects(today, Object.values(todayPartitions));
  }

  // WSL contribution (Windows only; no-op elsewhere). Full tick scans running WSL
  // homes; watch tick reuses the frozen snapshot so the Windows-only delta anchor
  // above stays exact (issue #15). Merged before deriveClientStatus so a client
  // that only exists inside WSL still reports as active.
  //
  // Three WSL refresh modes:
  // 1. refreshWsl (interval anchored tick): scan WSL fresh — the 5-minute interval
  //    is too long to let WSL go stale, but re-scanning tokscale is avoided.
  // 2. wslAnchor (watch anchored tick): reuse the frozen snapshot — WSL is heavy
  //    and watch ticks fire every few seconds.
  // 3. !anchorUsed (full scan): scan WSL as part of the complete rescan.
  const windowsPeriods = { today, month, allTime };
  let wslBundle = emptyWslBundle();
  let wslDetected = [];
  if (normalizedClients && options.wslScanEnabled !== false) {
    if (options.refreshWsl) {
      const wslResult = await collectWsl({
        clients: tokscaleClients,
        trackedClients: normalizedClients,
        allTimeSince,
        now: collectedAt,
        commandTimeoutMs,
        runTokscale: runTokscaleFn,
        resolvePromaPricing: (rows) => resolvePromaPricing(rows, {
          lookupModelPricing: options.lookupModelPricing,
          commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
          pricingRevision: options.pricingRevision
        }),
        lookupModelPricing: options.lookupModelPricing || lookupModelPricing,
        pricingTimeoutMs: options.pricingTimeoutMs,
        logger: options.logger,
        decoratePeriods: (periods, home) => applySessionTimestamps(periods, home, { scopedHome: true, resolveProjects: projectsEnabled })
      });
      wslBundle = wslResult.bundle;
      wslDetected = wslResult.detected;
    } else if (options.wslAnchor) {
      wslBundle = options.wslAnchor;
    } else if (!anchorUsed) {
      const wslResult = await collectWsl({
        clients: tokscaleClients,
        trackedClients: normalizedClients,
        allTimeSince,
        now: collectedAt,
        commandTimeoutMs,
        runTokscale: runTokscaleFn,
        resolvePromaPricing: (rows) => resolvePromaPricing(rows, {
          lookupModelPricing: options.lookupModelPricing,
          commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
          pricingRevision: options.pricingRevision
        }),
        lookupModelPricing: options.lookupModelPricing || lookupModelPricing,
        pricingTimeoutMs: options.pricingTimeoutMs,
        logger: options.logger,
        decoratePeriods: (periods, home) => applySessionTimestamps(periods, home, { scopedHome: true, resolveProjects: projectsEnabled })
      });
      wslBundle = wslResult.bundle;
      wslDetected = wslResult.detected;
    }
  }
  today = mergePeriods(windowsPeriods.today, wslBundle.today);
  month = mergePeriods(windowsPeriods.month, wslBundle.month);
  allTime = mergePeriods(windowsPeriods.allTime, wslBundle.allTime);

  // The renderer intentionally uses the live today period while a day is in
  // progress. Callers that do not defer capture persist the largest complete
  // live snapshot here; startCollector defers it until after transformUsage so
  // the saved value matches the period delivered to the renderer.
  if (
    options.historyEnabled !== false
    && options.dailyHistoryArchiveEnabled
    && options.deferLiveHistoryCapture !== true
  ) {
    try {
      const retainedLive = retainLiveDailyHistory(today, {
        ...(options.dailyHistoryArchiveOptions || {}),
        liveDays: dailyHistoryLiveDays,
        todayKey: localTodayKey(collectedAt),
        writeEnabled: options.dailyHistoryArchiveWriteEnabled
      });
      dailyHistoryLiveDays = retainedLive.liveDays || {};
    } catch (error) {
      if (typeof options.logger === 'function') options.logger(`daily live history archive failed: ${error.message}`);
    }
  }

  // WSL attribution (Windows only; null elsewhere). detected = markers found,
  // withData = clients whose WSL scan or local parser returned tokens. The gap
  // is the diagnostic (e.g. Hermes detected but unreadable over 9P).
  //
  // Like wslBundle, this is FROZEN between full scans: anchored watch ticks
  // (which skip the WSL scan) reuse the snapshot via options.wslStatus instead
  // of re-probing — otherwise every few-second watch tick would spawn wsl.exe
  // and stall the fast refresh path (issue #15's load concern).
  let wslStatus = null;
  if (platformValue === 'win32' && normalizedClients) {
    const reuseFrozen = !options.refreshWsl && options.wslAnchor && options.wslStatus;
    if (options.wslScanEnabled === false) {
      wslStatus = { state: 'disabled', detected: [], withData: [] };
    } else if (reuseFrozen) {
      wslStatus = options.wslStatus;
    } else {
      const probe = probeWslStateFn({});
      if (probe !== 'ok') {
        wslStatus = { state: probe, detected: [], withData: [] };
      } else {
        const withData = Object.keys(wslBundle.allTime.clients || {});
        const state = withData.length > 0 ? 'active' : 'no-data';
        wslStatus = { state, detected: wslDetected, withData };
      }
    }
  }

  // One filesystem probe per tick, shared by the legacy status and the health
  // record below. Probing twice cost a second pass over every client's roots —
  // including the per-workspace walk Copilot needs — and let one snapshot report
  // a directory as both present and absent when it appeared between the two.
  const sourceChecks = clientSourceChecks(normalizedClients, {
    homeDir: options.homeDir,
    platform: platformValue,
    env: options.env || process.env,
    wslDetected: wslStatus?.detected
  });

  const summary = {
    deviceId,
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    ...(osInfo.name ? { osName: osInfo.name } : {}),
    ...(osInfo.version ? { osVersion: osInfo.version } : {}),
    updatedAt: collectedAt.toISOString(),
    agentVersion,
    ...(agentRuntime ? { agentRuntime } : {}),
    projectsEnabled,
    trackedClients: normalizedClients ? normalizedClients.split(',') : [],
    clientStatus: deriveClientStatus(normalizedClients, allTime, { sourceChecks }),
    wslStatus,
    periodWindows: computePeriodWindows(collectedAt),
    historyAvailable: options.historyEnabled !== false,
    today,
    month,
    allTime
  };
  // The CN diagnostics keep their historical wire field so existing Hub
  // consumers are unaffected; `qoderDiagnostics` is the complete per-client
  // picture and is what a machine with both installers must be read through.
  const qoderDiagnostics = {};
  const qoderPeriods = {};
  for (const [qoderClientId, state] of qoderStates) {
    const cloned = cloneQoderCnDiagnostics(state.diagnostics);
    if (cloned) qoderDiagnostics[qoderClientId] = cloned;
    if (state.periods) qoderPeriods[qoderClientId] = state.periods;
  }
  if (qoderDiagnostics.qodercn) summary.qoderCnDiagnostics = qoderDiagnostics.qodercn;
  if (Object.keys(qoderDiagnostics).length > 0) summary.qoderDiagnostics = qoderDiagnostics;
  if (options.reasonixNativeSessionsEnabled === true && trackedClientSet.has('reasonix')) {
    try {
      const nativeCache = options.reasonixNativeSessionCache || createReasonixNativeSessionCache({
        env: options.env || process.env,
        homeDir: options.homeDir || os.homedir(),
        platform: platformValue,
        cwdDir: options.cwdDir || process.cwd(),
        projectIdentity
      });
      const nativeView = nativeCache.getView({ now: collectedAt, projectsEnabled, allTimeSince });
      summary.nativeSessions = nativeView.sessions;
      summary.nativeProjects = nativeView.projects;
    } catch (error) {
      if (typeof options.logger === 'function') options.logger(`reasonix native session scan failed: ${error.message}`);
      const empty = emptyNativeView();
      summary.nativeSessions = empty.sessions;
      summary.nativeProjects = empty.projects;
    }
  }
  if (typeof options.onAnchorComputed === 'function') {
    options.onAnchorComputed({
      windowsPeriods,
      todayPartitions,
      qoderPeriods,
      wslBundle,
      wslStatus,
      ...(summary.nativeSessions ? { nativeSessions: summary.nativeSessions } : {}),
      ...(summary.nativeProjects ? { nativeProjects: summary.nativeProjects } : {})
    });
  }
  if (options.historyEnabled === false) {
    summary.history = null;
  } else if (options.includeHistory) {
    // The history graph needs each Qoder client's full row set. When
    // includeHistory is true, the period read above already disables the
    // anchored since-midnight filter, so reuse that result instead of scanning
    // the transcript tree twice.
    const qoderGraphs = [];
    for (const qoderClientId of trackedQoderClients) {
      const state = qoderStates.get(qoderClientId) || null;
      let graph = null;
      let historyReadFailed = false;
      try {
        // `state.rows` is full whenever includeHistory caused this client to be
        // read above. Reusing it is important: scanning the transcript tree a
        // second time in the history branch used to block the Electron main
        // process and, on non-anchored ticks, discarded the second result.
        let rows = state?.rows;
        if (!rows) {
          const qoderOptions = {
            clientId: qoderClientId,
            site: QODER_SITE_BY_CLIENT_ID[qoderClientId] || 'cn',
            homeDir: options.homeDir,
            platform: platformValue,
            env: options.env || process.env,
            logger: options.logger
          };
          let databaseRows = [];
          let databaseError = null;
          try {
            databaseRows = await collectQoderCnRows(qoderOptions);
          } catch (error) {
            databaseError = error;
          }
          let mainDatabaseRows = [];
          try {
            mainDatabaseRows = await collectQoderCnMainRows(qoderOptions);
          } catch (error) {
            databaseError = databaseError || error;
          }
          let transcriptRows = [];
          try {
            transcriptRows = collectQoderCnTranscriptRows({ ...qoderOptions, diagnostics: {} });
          } catch (error) {
            if (!databaseError) databaseError = error;
          }
          if (databaseError && databaseRows.length === 0 && mainDatabaseRows.length === 0 && transcriptRows.length === 0) throw databaseError;
          rows = mergeQoderCnRows([...databaseRows, ...mainDatabaseRows], transcriptRows, null, {
            databaseSources: {
              legacy: databaseRows.length > 0,
              main: mainDatabaseRows.length > 0
            }
          });
        }
        if (!rows) rows = [];
        const pricing = (!anchorUsed && state?.pricing) ? state.pricing : await resolveQoderCnPricing(rows, {
          lookupModelPricing: options.lookupModelPricing || lookupModelPricing,
          commandTimeoutMs: options.pricingTimeoutMs,
          pricingRevision: options.pricingRevision
        });
        graph = buildQoderCnHistoryGraph({ rows, pricingByModel: pricing, clientId: qoderClientId });
      } catch (err) {
        // A failed history read must not take down the whole tick — the live
        // periods stay authoritative and the failure remains in the local log.
        historyReadFailed = true;
        if (typeof options.logger === 'function') options.logger(`${qoderClientId} history parse failed: ${err.message}`);
      }
      const published = historyReadFailed ? qoderHistoryFallbackGraphFor(options, qoderClientId) : graph;
      if (published) qoderGraphs.push(published);
      if (!historyReadFailed && graph && typeof options.onQoderHistoryGraph === 'function') {
        options.onQoderHistoryGraph(qoderClientId, graph);
      }
    }
    const history = await collectHistoryOnce({
      clients: tokscaleClients,
      promaGraph: includesProma ? buildPromaHistoryGraph({ rows: promaRows || collectPromaRows(), pricingByModel: promaPricing || {} }) : null,
      claudeDesktopGraph: includesClaudeDesktop
        ? buildClaudeDesktopHistoryGraph({
          rows: claudeDesktopRows || collectClaudeDesktopRows({ homeDir: options.homeDir || os.homedir() }),
          pricingByModel: claudeDesktopPricing || {}
        })
        : null,
      qoderGraphs,
      historyEnabled: options.historyEnabled,
      commandTimeoutMs: options.historyTimeoutMs,
      capDays: options.historyCapDays,
      todayKey: localTodayKey(collectedAt),
      runGraph: options.runGraph,
      // WSL history: per-home graph on history ticks, keyed off the same switch
      // and platform the period scan uses. Injectable for tests.
      platform: platformValue,
      wslScanEnabled: options.wslScanEnabled,
      discoverWslHomes: options.discoverWslHomes,
      runWslGraph: options.runWslGraph,
      dailyHistoryArchiveEnabled: options.dailyHistoryArchiveEnabled,
      dailyHistoryArchiveWriteEnabled: options.dailyHistoryArchiveWriteEnabled,
      dailyHistoryArchiveOptions: options.dailyHistoryArchiveOptions,
      dailyHistoryLiveDays,
      onHistoryStatus: options.onHistoryStatus,
      logger: options.logger
    });
    if (history) summary.history = history;
  }
  return summary;
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

// A source can be created after Jiran starts (Qoder CN creates its
// transcript tree on the first session). Watch the nearest existing ancestor
// in that case so the creation event can open the path below it; returning the
// filesystem root would turn a missing, malformed configuration into a broad
// recursive watch, so the root itself is never used as a fallback.
function nearestExistingDirectory(dir) {
  const raw = String(dir || '').trim();
  if (!raw) return null;
  let candidate = path.resolve(raw);
  for (;;) {
    if (dirExists(candidate)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate || parent === path.parse(candidate).root) return null;
    candidate = parent;
  }
}

function nonBlankEnvPath(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function xdgDataHome(home) {
  return nonBlankEnvPath('XDG_DATA_HOME', path.join(home, '.local', 'share'));
}

// Where tokscale looks for captured `codex exec --json` output. Both defaults
// are scanned on every platform — upstream pushes them with no cfg gate, so the
// Application Support one is not a macOS variant of the .config one — and
// TOKSCALE_HEADLESS_DIR replaces the pair rather than adding to it
// (scanner.rs `headless_roots_with_env_strategy`). Neither default follows
// XDG_CONFIG_HOME: upstream spells the .config path as a literal.
//
// `optional` marks a root whose absence carries no information. Nobody has
// these unless they opted into a capture workflow, so the diagnostics panel
// hides them when they are missing rather than showing them struck through
// beside a real "Codex wrote nothing here". A configured root is the opposite:
// the user named that path, so its absence is exactly what they want to see.
function tokscaleHeadlessRoots(home) {
  const configured = nonBlankEnvPath('TOKSCALE_HEADLESS_DIR', null);
  if (configured) return [{ dir: configured, optional: false }];
  return [
    { dir: path.join(home, '.config', 'tokscale', 'headless'), optional: true },
    { dir: path.join(home, 'Library', 'Application Support', 'tokscale', 'headless'), optional: true }
  ];
}

function copilotExporterPath() {
  const configured = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (typeof configured !== 'string') return null;
  const trimmed = configured.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function hasWatchableParent(file) {
  return path.dirname(file) !== path.parse(file).root;
}

// The one derivation of the custom Copilot OTel exporter, shared by the source
// table, the watcher's ignore matcher and the attribution map. It used to exist
// in two places that canonicalised differently before comparing against
// ~/.copilot/otel, and the two answers diverge as soon as any part of that path
// is a symlink — which either leaves the exporter's parent watched with no
// pruning at all, or silently drops the exporter's own events.
//
// tokscale reads exactly the file this env var names (`path.is_file()`, no glob,
// no directory walk), so the watch is pinned to that one file. Anything under
// ~/.copilot/otel is already covered recursively and returns null here.
function copilotExporterWatch(home) {
  const file = copilotExporterPath();
  if (!file || !hasWatchableParent(file)) return null;
  const otelRoot = path.resolve(canonicalWatchPath(path.join(home, '.copilot', 'otel')));
  const canonicalFile = canonicalWatchFilePath(file);
  if (canonicalFile.startsWith(otelRoot + path.sep)) return null;
  return { file, canonicalFile, dir: path.dirname(file) };
}

function clineCliSessionRoot(home) {
  const sessionDataDir = nonBlankEnvPath('CLINE_SESSION_DATA_DIR', null);
  if (sessionDataDir) return sessionDataDir;
  const dataDir = nonBlankEnvPath('CLINE_DATA_DIR', null);
  if (dataDir) return path.join(dataDir, 'sessions');
  const clineDir = nonBlankEnvPath('CLINE_DIR', null);
  if (clineDir) return path.join(clineDir, 'data', 'sessions');
  return path.join(home, '.cline', 'data', 'sessions');
}

function hasCopilotChatSessions(workspaceRoot) {
  try {
    return fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && dirExists(path.join(workspaceRoot, entry.name, 'chatSessions')));
  } catch (_) {
    return false;
  }
}

// Per-client data-dir candidates, keyed by client. Drives the detection-status
// derivation and, after the interval-only/self-synced projections below, the
// chokidar watch list; Antigravity's read-only source roots are added back
// explicitly below.
// The watched roots are tagged with a stable id for local detection and tests.
// One id may cover several equivalent paths: Copilot's workspaceStorage has a
// variant per platform and Kiro's IDE globalStorage has four.
function clientSourceRoots(clientsCsv, options = {}) {
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const byClient = {};
  const add = (client, ...roots) => {
    if (enabled.has(client)) {
      byClient[client] = roots.map(([id, dir, sourcePath, optional]) => ({
        id,
        dir,
        ...(sourcePath ? { sourcePath } : {}),
        ...(optional ? { optional: true } : {})
      }));
    }
  };
  add('claude', ['claude-projects', path.join(home, '.claude', 'projects')], ['claude-transcripts', path.join(home, '.claude', 'transcripts')]);
  const codexHome = nonBlankEnvPath('CODEX_HOME', path.join(home, '.codex'));
  add(
    'codex',
    ['codex-sessions', path.join(codexHome, 'sessions')],
    ['codex-sessions', path.join(codexHome, 'archived_sessions')],
    ...tokscaleHeadlessRoots(home).map(({ dir, optional }) => ['codex-sessions', path.join(dir, 'codex'), null, optional])
  );
  const hermesHome = resolveHermesHome({ env: process.env, homeDir: home });
  add('hermes', ['hermes-home', hermesHome], ...hermesProfileWatchDirs(hermesHome).map((dir) => ['hermes-profile', dir]));
  // Within the default OpenCode data root, Tokscale reads the direct
  // opencode*.db family and the legacy storage/message/*/*.json source. The
  // watcher prunes the rest of this broad app data root below.
  //
  // Only the roots tokscale declares as `PathRoot::XdgData` go through this —
  // opencode, zed and micode (clients.rs), plus the CodeBuddy extension logs it
  // resolves via `dirs::data_local_dir()`. Kiro's CLI database is deliberately
  // NOT one of them: tokscale spells it as a home-relative literal
  // (`{home}/.local/share/kiro-cli/data.sqlite3`, scanner.rs), so following XDG
  // there would watch a directory it never reads. The split is upstream's, not
  // an oversight — check clients.rs before adding or removing a root here.
  const xdgHome = xdgDataHome(home);
  add('opencode', ['opencode-data', path.join(xdgHome, 'opencode')]);
  add('openclaw', ['openclaw-agents', path.join(home, '.openclaw', 'agents')]);
  add('cursor', ['tokscale-cursor-cache', tokscaleClientCacheDir('cursor', {
    homeDir: home,
    env: process.env,
    platform: process.platform
  })]);
  add('antigravity', ['tokscale-antigravity-cache', tokscaleClientCacheDir('antigravity', {
    homeDir: home,
    env: process.env,
    platform: process.platform
  })]);
  // A whitespace-only KIMI_CODE_HOME counts as unset, matching tokscale: it
  // joins `sessions` onto the raw value, so a blank export would resolve to the
  // root-level /sessions and hide the real one.
  const kimiCodeHome = nonBlankEnvPath('KIMI_CODE_HOME', path.join(home, '.kimi-code'));
  add('kimi', ['kimi-sessions', path.join(home, '.kimi', 'sessions')], ['kimi-code-sessions', path.join(kimiCodeHome, 'sessions')]);
  add('qwen', ['qwen-projects', path.join(home, '.qwen', 'projects')]);
  const grokHome = nonBlankEnvPath('GROK_HOME', path.join(home, '.grok'));
  add(
    'grok',
    ['grok-sessions', path.join(grokHome, 'sessions')],
    ['grok-unified-log', path.join(grokHome, 'logs'), path.join(grokHome, 'logs', 'unified.jsonl')]
  );
  // Tokscale 4.5.2 also parses VS Code Copilot Chat JSONL under each
  // workspaceStorage/*/chatSessions directory. Watch the workspaceStorage roots
  // so newly created workspaces are picked up; watchIgnoreMatcher prunes every
  // sibling except chatSessions + workspace.json to keep polling bounded.
  const copilotWorkspaceRoots = [
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    ...(process.platform === 'win32'
      ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'workspaceStorage')]
      : []),
    path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage')
  ];
  const copilotOtelRoot = path.join(home, '.copilot', 'otel');
  const copilotRoots = [
    ['copilot-otel', copilotOtelRoot],
    ['copilot-data', path.join(home, '.copilot'), path.join(home, '.copilot', 'data.db')],
    ...[...new Set(copilotWorkspaceRoots)].map((dir) => ['vscode-workspace-storage', dir])
  ];
  // The parent is the watch root because the exporter file may not exist yet;
  // the exact file is the source. watchAttributionRootsForClients() keeps that
  // parent from becoming a copilot attribution prefix — it is an arbitrary
  // user-chosen directory and can be $HOME.
  const exporter = copilotExporterWatch(home);
  if (exporter) copilotRoots.push(['copilot-otel-exporter', exporter.dir, exporter.file]);
  add('copilot', ...copilotRoots);
  add('pi', ['pi-sessions', path.join(home, '.pi', 'agent', 'sessions')], ['omp-sessions', path.join(home, '.omp', 'agent', 'sessions')]);
  // Zed: tokscale reads the XdgData root on every platform AND the native macOS
  // (Application Support) / Windows (LOCALAPPDATA) roots (see tokscale scanner.rs
  // cfg(macos)/cfg(windows) blocks) — watch all three so native mac/win users get
  // seconds-level refresh and a correct waiting/missing status.
  add(
    'zed',
    ['zed-threads', path.join(xdgHome, 'zed', 'threads')],
    ['zed-threads', path.join(home, 'Library', 'Application Support', 'Zed', 'threads')],
    ['zed-threads', path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Zed', 'threads')]
  );
  // Kilo Code (VS Code ext): tokscale 3.1.3 only scans the Linux .config root and
  // the .vscode-server (remote) root for KiloCode — unlike Cline, it does NOT scan
  // the native macOS Application Support / Windows %APPDATA% roots. Watching those
  // would be dead watches + a false "waiting" status, so we mirror exactly what
  // tokscale reads. (Native mac/win support pending upstream tokscale.)
  add(
    'kilocode',
    ['kilocode-tasks', path.join(home, '.config', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')],
    ['kilocode-tasks', path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')]
  );
  add('commandcode', ['commandcode-projects', path.join(home, '.commandcode', 'projects')]);
  // MiMo Code: tokscale 4.8.0 unions the XDG data dir with orca's hook-sandbox
  // copy (scanner.rs `discover_micode_dbs_in_dirs`), and that copy can hold
  // sessions the XDG one is missing. Watch both so an orca-driven install still
  // refreshes in seconds; the orca root only exists on macOS in practice and a
  // missing dir is dropped by watchClientRootsForClients.
  add(
    'micode',
    ['mimocode-data', path.join(xdgHome, 'mimocode')],
    ['mimocode-orca-data', path.join(home, 'Library', 'Application Support', 'orca', 'mimocode-hooks', 'shared', 'data')]
  );
  const zcodeDbDir = path.join(home, '.zcode', 'cli', 'db');
  add(
    'zcode',
    ['zcode-projects', path.join(home, '.zcode', 'projects')],
    ['zcode-cli-db', zcodeDbDir, path.join(zcodeDbDir, 'db.sqlite')]
  );
  // CodeBuddy (Tencent): tokscale reads the home-relative CLI/WebUI JSONL dir on
  // every platform, plus the IDE / VS Code extension logs under a platform-
  // specific CodeBuddyExtension/Logs root (scanner.rs). Watch both so CLI and
  // IDE usage each refresh in seconds; the shared Code/logs tree is deliberately
  // not watched (too broad for polling — full ticks still scan it). No --home
  // host-DB fallback, so every root is safe to watch cross-platform.
  // Two extension-log roots, because tokscale scans two (scanner.rs). It seeds
  // the list with the home-relative Windows-shaped path on EVERY platform, and
  // only then adds the native `dirs::data_local_dir()` root — so a home carried
  // over from Windows is scanned on macOS/Linux too, and watching only the
  // native one would let the periodic scan see usage the watcher never does.
  //
  // `dirs::data_local_dir()` is %LOCALAPPDATA% on Windows, Application Support
  // on macOS, and the XDG data home on Linux, so the Linux arm follows
  // XDG_DATA_HOME rather than a hardcoded .local/share. Being a `dirs` lookup
  // rather than a path literal is why it does not appear in tokscale's strings.
  //
  // On Windows the two normally resolve to the same directory and the Set
  // collapses them; elsewhere watchClientRootsForClients drops whichever is
  // absent, which is the usual case for the Windows-shaped one.
  const codebuddyExtLogRoots = [
    path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Logs'),
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Logs')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Logs')
        : path.join(xdgHome, 'CodeBuddyExtension', 'Logs')
  ];
  add(
    'codebuddy',
    ['codebuddy-projects', path.join(home, '.codebuddy', 'projects')],
    ...[...new Set(codebuddyExtLogRoots)].map((dir) => ['codebuddy-extension-logs', dir])
  );
  // WorkBuddy (Tencent): watch only the detailed session dir (projects/*.jsonl,
  // the preferred source) — not the whole ~/.workbuddy app home, whose config /
  // auth churn would add polling load and spurious ticks with no usage change.
  // A legacy install with only ~/.workbuddy/workbuddy.db (no projects/) still
  // refreshes via the periodic full tick; the WSL marker stays the broader
  // `.workbuddy` so a db-only WSL home is still scanned.
  add('workbuddy', ['workbuddy-projects', path.join(home, '.workbuddy', 'projects')]);
  // Proma — session transcripts at ~/.proma/agent-sessions/*.jsonl
  add('proma', ['proma-sessions', path.join(home, '.proma', 'agent-sessions')]);
  // tokscale 4.17's longer client tail. Each of these reads one home-relative
  // store, so a single `add()` wires the watcher, the presence check and the
  // attributed refresh lane to the same path. Only the shared, sync-only,
  // exact-file and platform-specific roots carry a comment of their own.
  add('gemini', ['gemini-tmp', path.join(home, '.gemini', 'tmp')]);
  add('roocode', ['roocode-tasks', path.join(home, '.config', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks')]);
  add('amp', ['amp-threads', path.join(home, '.local', 'share', 'amp', 'threads')]);
  add('droid', ['droid-sessions', path.join(home, '.factory', 'sessions')]);
  add('mux', ['mux-sessions', path.join(home, '.mux', 'sessions')]);
  // Kilo CLI, Crush, Goose, Devin CLI and Unsloth Studio each expose one
  // database (or JSON index) directly inside their own data root. Following the
  // Zed `threads/` and Kiro `kiro-cli/` precedent, the watch root is the
  // containing directory — so the database can appear after startup — while the
  // directChildOnly() bounds further down keep the database family and prune the
  // runtime files beside it.
  add('kilo', ['kilo-db', path.join(home, '.local', 'share', 'kilo')]);
  add('crush', ['crush-projects', path.join(home, '.local', 'share', 'crush')]);
  add('goose', ['goose-sessions', path.join(home, '.local', 'share', 'goose', 'sessions')]);
  // Codebuff and Freebuff share one store: both write their chats under
  // ~/.config/manicode/projects, and tokscale separates them by the run's root
  // agent id rather than by location. Only codebuff owns the watch root;
  // freebuff's root is a presence check filtered out of the watch list (see
  // INTERVAL_ONLY_SOURCE_CHECK_IDS), so chokidar is never handed one tree twice.
  add('codebuff', ['codebuff-projects', path.join(home, '.config', 'manicode', 'projects')]);
  add('freebuff', ['freebuff-projects', path.join(home, '.config', 'manicode', 'projects')]);
  // Trae and Warp are API-backed: tokscale materializes their usage into its own
  // config dir with `tokscale trae|warp sync`, exactly like the cursor and
  // antigravity caches. Their roots are therefore presence checks rather than
  // watch targets (SELF_SYNCED_CLIENTS) — the sync is what changes the numbers,
  // and watching the file it just wrote would re-trigger forever (issue #15).
  add('trae', ['trae-cache', tokscaleClientCacheDir('trae', { homeDir: home, env: process.env, platform: process.platform })]);
  add('warp', ['warp-cache', tokscaleClientCacheDir('warp', { homeDir: home, env: process.env, platform: process.platform })]);
  add('gjc', ['gjc-sessions', path.join(home, '.gjc', 'agent', 'sessions')]);
  add('jcode', ['jcode-sessions', path.join(home, '.jcode', 'sessions')]);
  add('junie', ['junie-sessions', path.join(home, '.junie', 'sessions')]);
  add('opencodereview', ['opencodereview-sessions', path.join(home, '.opencodereview', 'sessions')]);
  add('devin-cli', ['devin-cli-db', path.join(home, '.local', 'share', 'devin', 'cli')]);
  // Devin Desktop journals ACP events into a per-platform app dir. macOS
  // (Application Support) is the canonical root; tokscale also seeds the two
  // home-relative `.config` spellings on every platform (the Zed/CodeBuddy
  // pattern), so list all three — watchClientRootsForClients drops whichever is
  // absent, which off macOS is everything but these.
  add(
    'devin-desktop',
    ['devin-desktop-events', path.join(home, 'Library', 'Application Support', 'Devin', 'User', 'acp-events')],
    ['devin-desktop-events', path.join(home, '.config', 'Devin', 'User', 'acp-events')],
    ['devin-desktop-events', path.join(home, '.config', 'devin', 'User', 'acp-events')]
  );
  add('senpi', ['senpi-sessions', path.join(home, '.senpi', 'agent', 'sessions')]);
  add('augment', ['augment-sessions', path.join(home, '.augment', 'sessions')]);
  add('kimchi', ['kimchi-sessions', path.join(home, '.config', 'kimchi', 'harness', 'sessions')]);
  add('prime-agent', ['prime-agent-sessions', path.join(home, '.prime', 'agent', 'sessions')]);
  add('cherrystudio', ['cherrystudio-projects', path.join(home, '.config', 'CherryStudio', '.claude', 'projects')]);
  // MiniMax Code is captured by tokscale's own `headless` workflow, and this is
  // the directory that capture writes — a real data input, not one of the
  // sync-only mirrors above, so it is safe to watch.
  add('mcode', ['mcode-headless', path.join(home, '.config', 'tokscale', 'headless', 'mcode')]);
  add('fx', ['fx-sessions', path.join(home, '.fx', 'sessions')]);
  add('lmstudio', ['lmstudio-logs', path.join(home, '.lmstudio', 'server-logs')]);
  add('unsloth', ['unsloth-db', path.join(home, '.unsloth', 'studio')]);
  add('hindsight', ['hindsight-usage', path.join(home, '.hindsight', 'usage')]);
  // DeepSeek Harness — default JSONL session store at ~/.dsh/sessions, or the
  // sessions directory under DSH_HOME when the upstream override is set. Usage
  // itself is read by tokscale (`--client dsh`); this watch root only mirrors
  // the directory tokscale reads so an append still refreshes in seconds.
  add('deepseek-harness', ['deepseek-harness-sessions', resolveDeepSeekHarnessSessionsDir({ homeDir: home, env: process.env })]);
  add('claude-desktop', ...desktopSessionWatchDirs({ homeDir: home, includeMissing: true }).map((dir) => ['claude-desktop-sessions', dir]));
  // Qoder / Qoder CN — legacy SQLite, the desktop main.sqlite conversation
  // store, and the transcript tree. Both installers share one on-disk schema but
  // not a profile root, app-support directory or bundle id, so the
  // site-parameterized descriptor supplies each tracked client its own roots.
  // Each exact-file source carries its own sourcePath so an unrelated cache file
  // cannot target that client's refresh lane.
  for (const [qoderClientId, qoderSite] of Object.entries(QODER_SITE_BY_CLIENT_ID)) {
    if (!enabled.has(qoderClientId)) continue;
    const qoderPaths = qoderDataPaths({ site: qoderSite, homeDir: home, platform, env });
    add(
      qoderClientId,
      ...qoderPaths.dbPaths.map((dbPath) => [`${qoderClientId}-db`, path.dirname(dbPath), dbPath]),
      ...(qoderPaths.mainDbPaths || []).map((dbPath) => [`${qoderClientId}-main-db`, path.dirname(dbPath), dbPath]),
      ...(qoderPaths.transcriptRoots || []).map((root) => [`${qoderClientId}-transcripts`, root])
    );
  }
  add('reasonix', [
    REASONIX_SOURCE_CHECK_ID,
    resolveReasonixStatsDir({ env: process.env, homeDir: home, platform: process.platform, cwdDir: process.cwd() })
  ]);
  // Kiro (AWS): tokscale reads home-relative roots — the sessions tree used by
  // both CLI and IDE, the Kiro IDE globalStorage root (native macOS / Linux /
  // Windows), and the kiro-cli sqlite dir. None falls back to a host-absolute
  // path under --home (unlike Zed), so every root remains a valid source and
  // presence signal. The globalStorage kind is deliberately interval-only in
  // clientWatchCandidates() because real trees can contain tens of thousands of
  // files; the sessions and sqlite roots retain seconds-level refresh.
  //
  // Note the deliberate Kiro-vs-kiro casing asymmetry below (do not "fix" it to
  // list both cases everywhere): tokscale scans both `Kiro` and `kiro` cased
  // globalStorage roots, but watchPathsForClients filters by dirExists, so the
  // COST of listing both differs by filesystem:
  //   - Linux/WSL (case-sensitive): a missing variant is filtered out at zero
  //     cost, and a real lowercase build is genuinely distinct — so list BOTH
  //     `.config/Kiro` and `.config/kiro` (free insurance for the case ambiguity
  //     that tokscale scanning both already signals exists in the wild).
  //   - macOS/Windows (case-insensitive): `Kiro` and `kiro` resolve to the SAME
  //     dir, so both would pass dirExists and double-watch one directory with no
  //     functional gain — so list only the canonical `Kiro` (it already resolves
  //     a lowercase install on these filesystems). Same reason zed lists one case.
  // Usage counting is unaffected either way: full scans run tokscale, which reads
  // every root; the watch list only governs refresh latency + the presence dot.
  // (APPDATA || home AppData\Roaming mirrors how cline resolves the Windows root.)
  add(
    'kiro',
    ['kiro-sessions', path.join(home, '.kiro', 'sessions')],
    ['kiro-ide-globalstorage', path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(home, '.config', 'kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-cli-data', path.join(home, '.local', 'share', 'kiro-cli')],
    ['kiro-cli-data', path.join(home, 'Library', 'Application Support', 'kiro-cli')]
  );
  add(
    'cline',
    ['cline-tasks', path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-cli-sessions', clineCliSessionRoot(home)]
  );
  return byClient;
}

// The Qoder clients are the only local sources whose transcript root may not
// exist yet but must still become live without waiting for the periodic full
// scan. Keep the real source root for attribution and pair it with the nearest
// existing watch ancestor. The ignore policy below allows only the path toward
// that source, so watching a home-level ancestor does not turn into a broad
// recursive scan. Keyed by client id because each site owns its own roots and
// must not trigger the other's refresh lane.
function qoderWatchPairsByClient(clientsCsv, options = {}) {
  const sourceRoots = clientSourceRoots(clientsCsv, options);
  const pairsByClient = {};
  for (const clientId of Object.keys(QODER_SITE_BY_CLIENT_ID)) {
    const roots = sourceRoots[clientId] || [];
    const pairs = [];
    for (const root of roots) {
      // The DB descriptor watches its parent directory but identifies the exact
      // file as `sourcePath`. Treating `dir` as the source makes every unrelated
      // file in that client's cache directory one of its events, while using only
      // the file path would lose the ability to notice a DB created after
      // startup.
      const sourcePath = root.sourcePath ? path.resolve(root.sourcePath) : null;
      const source = sourcePath || path.resolve(root.dir);
      const watchCandidate = path.resolve(root.dir);
      const watch = dirExists(watchCandidate)
        ? watchCandidate
        : nearestExistingDirectory(path.dirname(source));
      if (!watch) continue;
      pairs.push({ source, sourcePath, watch });
    }
    const seen = new Set();
    const unique = pairs.filter((pair) => {
      const key = `${pair.source}\0${pair.watch}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length > 0) pairsByClient[clientId] = unique;
  }
  return pairsByClient;
}

// Sources that remain part of collection, health, and diagnostics but are too
// broad — or too redundant — for a persistent recursive watcher. Kiro
// globalStorage accepts every `.chat`, `.json`, and extensionless file at any
// depth in tokscale, so a real tree can require thousands of native directory
// watches; after descriptor exhaustion the same tree becomes an even more
// expensive 2-second polling watch. Freebuff's root id names the SAME directory
// codebuff already watches, and one tree must not get two chokidar watches (the
// failure the nested copilot-otel child is filtered for). Regular interval ticks
// (five minutes by default), manual refreshes, and hourly full reconciliation
// still scan both through their unchanged clients.
const INTERVAL_ONLY_SOURCE_CHECK_IDS = new Set(['kiro-ide-globalstorage', 'freebuff-projects']);

// The watcher only ever wants paths, so it keeps its original shape rather than
// learning about check ids it would immediately discard.
function clientWatchCandidates(clientsCsv, options = {}) {
  const byClient = {};
  for (const [client, roots] of Object.entries(clientSourceRoots(clientsCsv, options))) {
    // The Copilot data root already keeps its `otel/` child through the
    // matcher below. Keep that child as a diagnostic/source check, but do not
    // hand both nested paths to chokidar or it may install two native watches
    // over the same tree.
    byClient[client] = roots
      .filter((root) => (
        !(client === 'copilot' && root.id === 'copilot-otel')
        && !INTERVAL_ONLY_SOURCE_CHECK_IDS.has(root.id)
      ))
      .map((root) => root.dir);
  }
  return byClient;
}

// Clients whose dirs are tokscale caches written only by our own maybeSync* calls.
// Trae and Warp are the same shape as Cursor and Antigravity — `tokscale trae
// sync` / `tokscale warp sync` fill a cache under the tokscale config dir, and
// nothing else writes it. Watching them turns every tick into the trigger for
// the next one (issue #15), so they keep presence-check-only roots here rather
// than in the watch list.
const SELF_SYNCED_CLIENTS = new Set(['cursor', 'antigravity', 'trae', 'warp']);

// The Antigravity CLI's parse-local data dir (honors GEMINI_CLI_HOME like tokscale).
// It belongs to the umbrella `antigravity` client but, unlike that client's IDE
// sync cache, is written by `agy` and never by us — so it is both watchable and a
// real presence signal, sharing this single source of truth.
function antigravityCliDataDir() {
  const geminiHome = process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
  return path.join(geminiHome, 'antigravity-cli', 'conversations');
}

// Watch roots that feed a self-sync, keyed by client. Antigravity's IDE cache is
// written by our sync and must stay watch-excluded, but the native session roots
// are read-only inputs to that sync (tokscale only ever readdir/stats them —
// every write it makes lands in its own cache dir). Watching those gives the
// collector an event to target without recreating the issue #15
// cache-write -> watcher -> sync loop, and an event here is what earns the sync
// its short source-event floor.
//
// The parse-local antigravity-cli dir is deliberately not in here even though it
// shares the umbrella client id: tokscale reads it directly, so a CLI write has
// nothing to re-sync and must not pay for the subprocess.
function selfSyncSourceRootsForClients(clientsCsv) {
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const rootsByClient = {};
  if (enabled.has('antigravity')) {
    const sourceRoots = [...new Set(antigravityDataRoots().filter(dirExists))];
    if (sourceRoots.length > 0) rootsByClient.antigravity = sourceRoots;
  }
  return rootsByClient;
}

function watchClientRootsForClients(clientsCsv, options = {}) {
  const rootsByClient = {};
  const qoderPairsByClient = qoderWatchPairsByClient(clientsCsv, options);
  for (const [client, dirs] of Object.entries(clientWatchCandidates(clientsCsv, options))) {
    if (QODER_SITE_BY_CLIENT_ID[client]) continue;
    if (SELF_SYNCED_CLIENTS.has(client)) continue;
    const existing = [...new Set(dirs.filter(dirExists))];
    if (existing.length > 0) rootsByClient[client] = existing;
  }
  for (const [client, pairs] of Object.entries(qoderPairsByClient)) {
    rootsByClient[client] = [...new Set(pairs.map((pair) => pair.watch))];
  }
  for (const [client, dirs] of Object.entries(selfSyncSourceRootsForClients(clientsCsv, options))) {
    rootsByClient[client] = [...new Set([...(rootsByClient[client] || []), ...dirs])];
  }
  // The Antigravity CLI writes parse-local SQLite that tokscale reads directly,
  // so it is also safe to watch and shares the umbrella client id. The filter
  // expands that id to antigravity-cli when the targeted scan runs.
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const antigravityCliDir = antigravityCliDataDir();
  if (enabled.has('antigravity') && dirExists(antigravityCliDir)) {
    rootsByClient.antigravity = [...new Set([...(rootsByClient.antigravity || []), antigravityCliDir])];
  }
  if (enabled.has('reasonix')) {
    const nativeRoots = reasonixNativeSessionWatchRoots();
    const existingNativeRoots = nativeRoots.filter(dirExists);
    if (existingNativeRoots.length > 0) {
      rootsByClient.reasonix = [...new Set([...(rootsByClient.reasonix || []), ...existingNativeRoots])];
    }
  }
  return rootsByClient;
}

function watchPathsForClients(clientsCsv, options = {}) {
  return [...new Set(Object.values(watchClientRootsForClients(clientsCsv, options)).flat())];
}

// The same roots, but as attribution prefixes rather than watch targets. The two
// differ in exactly one place: a custom Copilot exporter has to be *watched* by
// its parent directory (the file can appear later), while attributing by that
// parent would be wrong — it is an arbitrary user-chosen path, and one pointing
// at a file in $HOME would make every other client's event also target copilot,
// turning each targeted scan into a two-client scan. The exact file attributes
// instead. The parent survives only when another copilot source already owns it
// (an exporter written straight into ~/.copilot), so `otel/` keeps its prefix.
// Takes the watch roots when the caller already has them: setupWatchers() needs
// both maps from one probe, and deriving them from two separate dirExists sweeps
// would let a directory created between the two land in one map and not the
// other — the same "two derivations of one thing" trap the exporter had.
function watchAttributionRootsForClients(clientsCsv, watchRoots = null, options = {}) {
  const rootsByClient = watchRoots || watchClientRootsForClients(clientsCsv, options);
  const qoderPairsByClient = qoderWatchPairsByClient(clientsCsv, options);
  let attributionRoots = rootsByClient;
  for (const [client, pairs] of Object.entries(qoderPairsByClient)) {
    const sources = [...new Set(pairs.flatMap((pair) => {
      if (!pair.sourcePath) return [pair.source];
      // The DB parent is intentionally not an attribution prefix: the watcher
      // keeps only the exact DB and its SQLite sidecars, so unrelated cache
      // files must not target this Qoder client.
      const source = canonicalWatchFilePath(pair.sourcePath);
      return [source, `${source}-wal`, `${source}-shm`];
    }))];
    if (sources.length > 0) attributionRoots = { ...attributionRoots, [client]: sources };
  }
  const exporter = copilotExporterWatch(options.homeDir || os.homedir());
  if (!exporter || !attributionRoots.copilot) return attributionRoots;
  const exporterDir = path.resolve(exporter.dir);
  const ownedByOtherSource = new Set(
    (clientSourceRoots(clientsCsv, options).copilot || [])
      .filter((root) => root.id !== 'copilot-otel-exporter')
      .map((root) => path.resolve(root.dir))
  );
  const copilot = rootsByClient.copilot
    .filter((root) => path.resolve(root) !== exporterDir || ownedByOtherSource.has(exporterDir));
  copilot.push(exporter.canonicalFile);
  return { ...attributionRoots, copilot: [...new Set(copilot)] };
}

function clientsForWatchPath(filePath, rootsByClient) {
  if (!filePath) return [];
  const resolved = path.resolve(filePath);
  const matched = [];
  for (const [client, roots] of Object.entries(rootsByClient || {})) {
    if (roots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    })) matched.push(client);
  }
  return matched;
}

// Inside a Hermes home dir tokscale only reads the SQLite db; the rest is the
// Desktop App runtime (hermes-agent/node_modules/venv, logs, cache — 150k+ files
// for some users). A plain recursive watch of ~/.hermes pegged CPU at 100%+
// (issue #38). Watching the db files directly instead would miss the WAL/SHM
// sidecars Hermes creates after startup (no seconds-level refresh on a cold
// start), so we keep watching the dir but hand chokidar an `ignored` matcher
// that prunes everything under a Hermes home except the db family. chokidar
// never recurses into an ignored dir (so the runaway poll is gone), yet a
// newly created state.db-wal is still seen on the next top-level readdir.
const HERMES_DB_FILES = new Set(['state.db', 'state.db-wal', 'state.db-shm']);
// OpenCode discovers only direct opencode.db / opencode-<channel>.db files.
// WAL/SHM are not database inputs to tokscale, but they are the live-write
// signals that must remain watched so a transaction committed before a
// checkpoint refreshes the usage view.
const OPENCODE_DB_WATCH_PATTERN = /^opencode(?:-[A-Za-z0-9._-]+)?\.db(?:-(?:wal|shm))?$/;
// MiMo Code keeps a multi-gigabyte log/ tree alongside its SQLite state files.
// A plain recursive watch of ~/.local/share/mimocode storms the watcher (every
// SQLite WAL/SHM transaction is a chokidar event, the log dir holds thousands
// of rotated files). Tokscale discovers mimocode.db and
// mimocode-<channel>.db directly under each data root; the sidecars are not
// parsed but must stay watched so a write through WAL/SHM triggers a refresh.
// Keep the home dir watched but ignore everything except that direct db family.
// The home root itself stays watched so a freshly created database or sidecar
// still surfaces on the next top-level readdir.
const MICODE_DB_WATCH_PATTERN = /^mimocode(?:-[A-Za-z0-9._-]+)?\.db(?:-(?:wal|shm))?$/;
// Kiro CLI and Zed expose one SQLite database at a known path. Keep their
// parent dirs watched so the database can appear after startup, but do not
// recurse through the application data trees around them.
const KIRO_DB_WATCH_PATTERN = /^data\.sqlite3(?:-(?:wal|shm))?$/;
const ZED_DB_WATCH_PATTERN = /^threads\.db(?:-(?:wal|shm))?$/;
const COPILOT_DB_WATCH_PATTERN = /^data\.db(?:-(?:wal|shm))?$/;
const ZCODE_DB_WATCH_PATTERN = /^db\.sqlite(?:-(?:wal|shm))?$/;
// The same shape for the tokscale 4.17 tail. Goose and UnsLoth each open one
// database in a dir that also holds logs/state (Goose's sessions/ dir, UnsLoth's
// studio/ dir), so only the database family may survive the bound. Kilo CLI's
// dir is narrower but shares the same treatment.
const KILO_DB_WATCH_PATTERN = /^kilo\.db(?:-(?:wal|shm))?$/;
const GOOSE_DB_WATCH_PATTERN = /^sessions\.db(?:-(?:wal|shm))?$/;
const UNSLOTH_DB_WATCH_PATTERN = /^studio\.db(?:-(?:wal|shm))?$/;
const DEVIN_CLI_DB_WATCH_PATTERN = /^sessions\.db(?:-(?:wal|shm))?$/;
// Crush keeps its whole session index in one JSON document next to its other
// state files. The WAL/SHM names cannot occur for a JSON file, but the shared
// pattern shape keeps the intent legible.
const CRUSH_PROJECTS_WATCH_PATTERN = /^projects\.json$/;
const GROK_UNIFIED_LOG_FILE = 'unified.jsonl';
// Tokscale scans only these two CodeBuddy extension log subtrees. Keep their
// recursive layout intact, but prune unrelated siblings under Logs before
// chokidar allocates watches for them.
const CODEBUDDY_EXTENSION_SOURCE_DIRS = new Set(['CodeBuddyIDE', 'VSCode']);
// Which parts of an Antigravity IDE home are worth an event. Not "what tokscale
// parses" — tokscale gets the token data over RPC from the running language
// server and only reads `brain/`+`conversations/` to enumerate session ids.
// These are the paths the IDE touches while a turn is in progress, so they are
// what tells us the synced cache went stale. The rest of the home is runtime and
// cache material (bin/, builtin/, crashes/, antigravity_state.pbtxt …) that
// would make every background write a scan trigger.
const ANTIGRAVITY_SOURCE_DIRS = new Set(['annotations', 'brain', 'conversations']);
const ANTIGRAVITY_SOURCE_FILES = new Set(['agyhub_summaries_proto.pb']);
// `brain/` is watched one level deep only. Its children are per-session working
// dirs holding plans, uploads and screenshots — on a 26-session home that is
// ~508 directories and ~780 files for ~4 changes a week, while the actual
// per-turn signal is `conversations/<id>.db-wal`. Recursing costs an inotify
// descriptor per directory on Linux, which is what makes the ENOSPC fallback to
// polling (sticky for the process) more likely, and once polling that whole tree
// gets stat'd every interval — the Hermes runaway of issue #38 in miniature.
// Watching `brain/` itself still catches a new session directory appearing.
const ANTIGRAVITY_SHALLOW_SOURCE_DIRS = new Set(['brain']);

// A watch policy answers one question about one source root: given a path
// inside it, does this source want the event? It never sees the root itself,
// which is always kept, so `parts` is a non-empty relative path already split.
//
// Roots overlap. An explicit CODEX_HOME can sit inside another client's data
// root, a custom Copilot exporter can name a file inside OpenCode's, and two
// clients can resolve to the same directory outright. chokidar's `ignored` is
// global to the instance, so every root containing a path shares one answer for
// it, and the only safe one is the union of what they read: prune when EVERY
// containing root declines the path, keep it as soon as one wants it.
//
// This replaced an ordered chain of per-client branches in which the first
// matching root answered for all of them, so overlap resolved by declaration
// order rather than by what tokscale reads. A bounded root pruned an
// equally-rooted recursive source out of existence, two bounded roots resolved
// by whichever branch was written first, and the exporter needed its own checks
// hoisted above the chain to survive a broader root declared over it.
const KEEP_EVERYTHING = () => false;
const EMPTY_SET = new Set();

// Tokscale opens one exact database directly under this root instead of walking
// it. Keep the direct children it names — including the WAL/SHM sidecars, which
// are the live-write signal even though tokscale never parses them as databases
// — so a database created later is still discovered, and never recurse into the
// runtime files beside it.
function directChildOnly(isSource) {
  return (parts) => parts.length > 1 || !isSource(parts[0]);
}

// Every source root of every tracked client, paired with its policy. Bounded
// roots are counted so a client set with nothing to prune can skip the matcher
// entirely rather than hand chokidar a predicate that always answers false.
function watchPolicyEntries(clientsCsv, options = {}) {
  const candidates = clientWatchCandidates(clientsCsv, options);
  const qoderPairsByClient = qoderWatchPairsByClient(clientsCsv, options);
  // canonicalWatchPath must be applied here too: chokidar reports events under
  // whatever root it was handed, so a matcher built on the uncanonicalised path
  // would stop matching on Windows and silently un-prune the Hermes runtime
  // (issue #38) while the watch itself still worked.
  const canonicalRoot = (dir) => path.resolve(canonicalWatchPath(dir));
  const entries = [];
  const claimed = new Map();
  let boundedCount = 0;
  // Same-root duplicates within one client (Kiro's cased globalStorage spellings,
  // Zed's per-platform roots) collapse here. Duplicates ACROSS clients must not:
  // two policies on one directory is precisely the overlap the union resolves,
  // which is why `claimed` is keyed per client — an identical path under two
  // clients would otherwise let the bounded one swallow the recursive one, the
  // very failure this table replaced.
  const bound = (client, dirs, policy) => {
    if (!claimed.has(client)) claimed.set(client, new Set());
    const seen = claimed.get(client);
    for (const dir of dirs) seen.add(dir);
    for (const root of new Set(dirs.map(canonicalRoot))) {
      entries.push({ root, prefix: root + path.sep, policy });
      boundedCount += 1;
    }
  };
  const withBasename = (client, basename) =>
    (candidates[client] || []).filter((dir) => path.basename(dir) === basename);

  // Hermes: the SQLite trio is the only source, at any depth. Each explicit
  // watch root — the home AND every profile dir under it — is kept by the
  // matcher itself, so a profile's own database still reports.
  bound('hermes', candidates.hermes || [], (parts) => !HERMES_DB_FILES.has(parts[parts.length - 1]));

  bound('copilot', withBasename('copilot', '.copilot'), (parts) => {
    if (parts[0] === 'otel') return false;
    if (parts.length === 1) return !COPILOT_DB_WATCH_PATTERN.test(parts[0]);
    return true;
  });
  bound('copilot', withBasename('copilot', 'workspaceStorage'), (parts) => {
    if (parts.length === 1) return false; // workspace hash dir
    if (parts[1] === 'chatSessions') return false;
    if (parts.length === 2 && parts[1] === 'workspace.json') return false;
    return true;
  });
  // Tokscale ingests exactly the file COPILOT_OTEL_FILE_EXPORTER_PATH names
  // (`path.is_file()`, no glob), but that file need not exist yet, so its parent
  // is what gets watched. The parent is an arbitrary user-chosen directory and
  // can be $HOME — everything in it except that one file is pruned, and
  // watchAttributionRootsForClients keeps it from becoming a copilot prefix.
  const exporter = copilotExporterWatch(os.homedir());
  if (exporter) bound('copilot', [exporter.dir], (_parts, resolved) => resolved !== exporter.canonicalFile);

  const antigravityEnabled = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).includes('antigravity');
  bound('antigravity', antigravityEnabled ? antigravityDataRoots() : [], (parts) => {
    if (parts.length === 1) {
      return !ANTIGRAVITY_SOURCE_DIRS.has(parts[0]) && !ANTIGRAVITY_SOURCE_FILES.has(parts[0]);
    }
    const firstChild = parts[0];
    if (!ANTIGRAVITY_SOURCE_DIRS.has(firstChild)) return true;
    // brain/<session> is kept (a new session shows up there); brain/<session>/**
    // is not — see ANTIGRAVITY_SHALLOW_SOURCE_DIRS.
    if (ANTIGRAVITY_SHALLOW_SOURCE_DIRS.has(firstChild)) return parts.length > 2;
    return false;
  });

  const reasonixEnabled = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).includes('reasonix');
  bound(
    'reasonix',
    reasonixEnabled ? reasonixNativeSessionWatchRoots().filter(dirExists) : [],
    (_parts, resolved) => {
      if (isReasonixNativeSessionSidecar(resolved)) return false;
      try {
        if (fs.statSync(resolved).isDirectory()) return false;
      } catch (_) {
        // A removed sidecar is still delivered by chokidar; other removed
        // files do not need to invalidate the native-session cache.
      }
      return true;
    }
  );

  // Command Code recursively stores session transcripts below projects/, but
  // checkpoint streams use the same JSONL suffix and are explicitly skipped by
  // Tokscale. Keep directories for traversal and ordinary JSONL files (including
  // removed paths), while pruning checkpoints and unrelated project metadata.
  bound('commandcode', candidates.commandcode || [], (_parts, resolved) => {
    const name = path.basename(resolved);
    if (name.endsWith('.jsonl') && !name.endsWith('.checkpoints.jsonl')) return false;
    try {
      if (fs.statSync(resolved).isDirectory()) return false;
    } catch (_) {
      // Removed transcript paths are handled by the suffix check above.
    }
    return true;
  });

  bound('opencode', candidates.opencode || [], (parts) => {
    if (parts.length === 1) {
      // Keep the root's readdir visible for newly created channel DBs, but
      // do not descend into unrelated app files or directories.
      return parts[0] !== 'storage' && !OPENCODE_DB_WATCH_PATTERN.test(parts[0]);
    }
    if (parts[0] !== 'storage') return true;
    if (parts.length === 2) return parts[1] !== 'message';
    if (parts[1] !== 'message') return true;
    // Tokscale's legacy OpenCode source is storage/message/*/*.json. Keep
    // the message root, one session directory, and its direct JSON files;
    // prune deeper runtime trees before chokidar allocates more watches.
    if (parts.length === 3) return false;
    if (parts.length === 4) return !parts[3].endsWith('.json');
    return true;
  });

  // Tokscale reads only direct children of each MiMo root, so log/* and every
  // other recursive subtree is pruned before chokidar descends into it.
  bound('micode', candidates.micode || [], directChildOnly((name) => MICODE_DB_WATCH_PATTERN.test(name)));
  // The dual-source Grok scanner derives exactly logs/unified.jsonl from each
  // Grok home.
  bound('grok', withBasename('grok', 'logs'), directChildOnly((name) => name === GROK_UNIFIED_LOG_FILE));
  // ZCode v2 is a direct SQLite path, not a recursive project source.
  bound('zcode', withBasename('zcode', 'db'), directChildOnly((name) => ZCODE_DB_WATCH_PATTERN.test(name)));
  bound('kiro', withBasename('kiro', 'kiro-cli'), directChildOnly((name) => KIRO_DB_WATCH_PATTERN.test(name)));
  bound('zed', withBasename('zed', 'threads'), directChildOnly((name) => ZED_DB_WATCH_PATTERN.test(name)));
  // The single-database roots from the tokscale 4.17 tail. Each watches its own
  // data dir so the database can appear after startup, but only the database
  // family (plus Goose/Devin's SQLite WAL/SHM sidecars) is a source — the logs,
  // caches and state files beside it must not each become a scan trigger.
  bound('kilo', withBasename('kilo', 'kilo'), directChildOnly((name) => KILO_DB_WATCH_PATTERN.test(name)));
  bound('crush', withBasename('crush', 'crush'), directChildOnly((name) => CRUSH_PROJECTS_WATCH_PATTERN.test(name)));
  bound('goose', withBasename('goose', 'sessions'), directChildOnly((name) => GOOSE_DB_WATCH_PATTERN.test(name)));
  bound('devin-cli', withBasename('devin-cli', 'cli'), directChildOnly((name) => DEVIN_CLI_DB_WATCH_PATTERN.test(name)));
  bound('unsloth', withBasename('unsloth', 'studio'), directChildOnly((name) => UNSLOTH_DB_WATCH_PATTERN.test(name)));
  bound('codebuddy', withBasename('codebuddy', 'Logs'), (parts) => !CODEBUDDY_EXTENSION_SOURCE_DIRS.has(parts[0]));

  // If a Qoder source was absent at startup, its watch root is an ancestor
  // rather than the source itself. Keep only the ancestor chain and the source
  // subtree; every sibling remains ignored. When the source already exists the
  // same policy reduces to KEEP_EVERYTHING for that source root. An exact DB
  // source also keeps SQLite's WAL/SHM sidecars; the event handler drops SHM
  // writes caused by our own read-only opens, while WAL writes remain a live
  // data signal.
  for (const pairs of Object.values(qoderPairsByClient)) {
    for (const pair of pairs) {
      const root = canonicalRoot(pair.watch);
      const source = pair.sourcePath
        ? canonicalWatchFilePath(pair.sourcePath)
        : canonicalRoot(pair.source);
      const sourceSidecars = pair.sourcePath
        ? new Set([
          source,
          `${source}-wal`,
          `${source}-shm`
        ])
        : null;
      entries.push({
        root,
        prefix: root + path.sep,
        policy: (_parts, resolved) => {
          const current = path.resolve(canonicalWatchPath(resolved));
          return !(
            sourceSidecars?.has(current)
            || current === source
            || current.startsWith(source + path.sep)
            || source.startsWith(current + path.sep)
          );
        }
      });
      boundedCount += 1;
    }
  }

  // Everything left is a recursive transcript tree: tokscale walks it, so every
  // path inside it is a potential source. Copilot is excluded wholesale because
  // each of its roots is bounded above, the Qoder clients because every one of
  // their roots just got its own bounded policy, and the self-synced cache roots
  // are never handed to chokidar in the first place. The parse-local Antigravity
  // CLI dir is added back explicitly — it shares the umbrella client id but is
  // written by `agy`, not by our sync.
  const recursive = [
    ...Object.entries(candidates)
      .filter(([client]) => client !== 'copilot'
        && !QODER_SITE_BY_CLIENT_ID[client]
        && !SELF_SYNCED_CLIENTS.has(client))
      .flatMap(([client, dirs]) => dirs.filter((dir) => !(claimed.get(client) || EMPTY_SET).has(dir))),
    ...(antigravityEnabled && dirExists(antigravityCliDataDir()) ? [antigravityCliDataDir()] : [])
  ];
  for (const root of new Set(recursive.map(canonicalRoot))) {
    entries.push({ root, prefix: root + path.sep, policy: KEEP_EVERYTHING });
  }
  return { entries, boundedCount };
}

function watchIgnoreMatcher(clientsCsv, options = {}) {
  const { entries, boundedCount } = watchPolicyEntries(clientsCsv, options);
  if (boundedCount === 0) return undefined;
  return (target) => {
    const resolved = path.resolve(target);
    let contained = false;
    for (const { root, prefix, policy } of entries) {
      // A watch root is a source in its own right — a Hermes profile dir inside
      // the Hermes home, the parent of a database created later — so it survives
      // whatever the roots around it would say about a path at that depth.
      if (resolved === root) return false;
      if (!resolved.startsWith(prefix)) continue;
      contained = true;
      if (!policy(path.relative(root, resolved).split(path.sep), resolved)) return false;
    }
    return contained; // a path under no source root at all is never ignored
  };
}

// Which source roots each tracked client actually has on disk, one entry per
// check id with same-kind paths collapsed by OR. clientDataDirPresence() is
// derived from this rather than computed beside it, so the presence dot in the
// UI and the health record can never disagree about what was found.
function sourceRootExists(root) {
  if (root.sourcePath) return fileExists(root.sourcePath);
  return root.id === 'vscode-workspace-storage'
    ? hasCopilotChatSessions(root.dir)
    : dirExists(root.dir);
}

// `dir` is what the diagnostics panel prints, so for an exact-file source it has
// to be the file `exists` actually answered for. Printing the watch parent while
// `exists` probed a file inside it makes the panel report a directory that is
// plainly there as missing — the one question the panel exists to answer. The
// watch root stays available to the watcher through clientWatchCandidates(),
// which reads clientSourceRoots() directly; `sourcePath` rides along so a reveal
// can tell a file from a directory without stat-ing it again.
function evaluatedClientSourceRoots(clientsCsv, options = {}) {
  return Object.fromEntries(Object.entries(clientSourceRoots(clientsCsv, options)).map(([client, roots]) => [
    client,
    roots.map((root) => ({
      id: root.id,
      dir: root.sourcePath || root.dir,
      ...(root.sourcePath ? { sourcePath: root.sourcePath } : {}),
      ...(root.optional ? { optional: true } : {}),
      exists: sourceRootExists(root)
    }))
  ]));
}

function clientSourceChecks(clientsCsv, options = {}) {
  const checks = {};
  const push = (client, id, exists) => {
    const list = checks[client] || (checks[client] = []);
    const found = list.find((entry) => entry.id === id);
    if (found) found.exists = found.exists || exists;
    else list.push({ id, exists });
  };
  for (const [client, roots] of Object.entries(evaluatedClientSourceRoots(clientsCsv, options))) {
    checks[client] = checks[client] || [];
    for (const { id, exists } of roots) push(client, id, exists);
  }
  // antigravity's watch candidate is only the IDE sync cache, which our own sync
  // writes. Its two real sources are separate checks so a health record can say
  // "the IDE is installed but the cache was never written" rather than collapse
  // all three into one boolean. A source-only or CLI-only install with no
  // countable usage yet must read `waiting`, not `missing`; the sync cache stays
  // a valid presence signal for snapshots taken before either of the others
  // existed.
  if (Object.prototype.hasOwnProperty.call(checks, 'antigravity')) {
    push('antigravity', 'antigravity-ide-source', antigravityDataPresent(os.homedir()));
    push('antigravity', 'antigravity-cli-data', dirExists(antigravityCliDataDir()));
  }
  // A client installed only inside WSL has no host directory, but its usage is
  // merged into the same periods — so without this its source reads `missing`
  // while the very same snapshot counts its tokens. The WSL marker is a source
  // that exists; it just lives in a filesystem this process reaches through
  // `wsl.exe` rather than through `fs`.
  for (const client of options.wslDetected || []) {
    if (Object.prototype.hasOwnProperty.call(checks, client)) push(client, 'wsl-home', true);
  }
  return checks;
}

// Every directory a tracked client's usage can come from on this machine, keyed
// by client as {id, dir, exists} — the path-level table behind
// clientSourceChecks(), before same-id roots are collapsed into one boolean.
//
// Only the diagnostics panel wants this shape: a user asking "is it looking
// where I installed it" needs the paths, and a check id cannot answer that. The
// self-synced clients are why it is not simply clientSourceRoots(): that table
// holds antigravity's *sync cache*, which is ours and says nothing about which
// Antigravity is installed — the IDE session roots and the CLI's own data dir
// are the ones that answer it, and they are checks without being watch roots.
// What the diagnostics panel should list, which is not everything probed. An
// optional root that is absent is dropped here, in the main process, so the
// flag never crosses IPC: the renderer flattens cached sources to
// `exists: false, pending: true` while a re-probe is in flight, and any
// visibility rule that reads `exists` downstream of that would blink an
// existing capture directory out of the panel and back on every snapshot.
// Deciding it where `exists` is still the answer to a real stat() is the only
// place the question can be asked once.
//
// clientDiagnosticRoots() stays faithful for callers that want every probed
// root — the reveal handler picks from it and selects on `exists` itself.
function visibleDiagnosticRoots(clientsCsv, options = {}) {
  return Object.fromEntries(Object.entries(clientDiagnosticRoots(clientsCsv, options)).map(([client, roots]) => [
    client,
    roots.filter((root) => !(root.optional === true && root.exists !== true))
  ]));
}

function clientDiagnosticRoots(clientsCsv, options = {}) {
  const byClient = evaluatedClientSourceRoots(clientsCsv, options);
  if (byClient.antigravity) {
    byClient.antigravity.unshift(
      ...antigravityDataRoots().map((dir) => ({ id: 'antigravity-ide-source', dir, exists: dirExists(dir) })),
      { id: 'antigravity-cli-data', dir: antigravityCliDataDir(), exists: dirExists(antigravityCliDataDir()) }
    );
  }
  return byClient;
}

// Whether each tracked client has at least one data directory on disk. Takes
// pre-computed checks when the caller already has them: a tick derives the
// legacy status and the health record from one probe, so the two cannot
// disagree about a directory created between two scans of the same snapshot.
function clientDataDirPresence(clientsCsv, options = {}) {
  const presence = {};
  for (const [client, checks] of Object.entries(options.sourceChecks || clientSourceChecks(clientsCsv, options))) {
    presence[client] = checks.some((check) => check.exists);
  }
  return presence;
}

// Pure detection-status derivation, given the two existing signals per client:
// `active`  — tokscale read all-time usage for it,
// `waiting` — its data directory exists but no usage was found,
// `missing` — no data directory on disk.
function statusFromSignals(clients, presence, usageClients) {
  const status = {};
  for (const client of clients) {
    if (Number(usageClients?.[client] || 0) > 0) status[client] = 'active';
    else if (presence?.[client]) status[client] = 'waiting';
    else status[client] = 'missing';
  }
  return status;
}

function deriveClientStatus(clientsCsv, allTimePeriod, options = {}) {
  const clients = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return statusFromSignals(clients, clientDataDirPresence(clientsCsv, options), allTimePeriod?.clients || {});
}

// The frozen wslAnchor is only valid to merge into a preview period when it was
// captured in the same calendar window: today only if the anchor is from today,
// month only if from the same month. Otherwise a cross-day / cross-month full
// scan would briefly add the previous period's WSL usage to the preview before
// the final fresh scan corrects it. Returns the WSL period to merge, or null.
// True when a WSL scan produced any usable usage. A per-home tokscale failure is
// swallowed inside collectWslUsage (it logs and contributes nothing), so its
// bundle can be empty even though the distro holds data. Used to avoid replacing a
// good frozen snapshot with that empty bundle.
function wslBundleHasUsage(bundle) {
  if (!bundle || typeof bundle !== 'object') return false;
  for (const periodName of ['today', 'month', 'allTime']) {
    const period = bundle[periodName];
    if (!period || typeof period !== 'object') continue;
    if (Number(period.totalTokens) > 0) return true;
    if (Number(period.costUsd) > 0) return true;
    if (period.clients && Object.keys(period.clients).length > 0) return true;
    if (period.sessions && Object.keys(period.sessions).length > 0) return true;
  }
  return false;
}

function wslPeriodsForPreview(wslAnchor, anchorDateKey, todayKey) {
  if (!wslAnchor) return { today: null, month: null };
  const key = anchorDateKey || '';
  return {
    today: key === todayKey ? wslAnchor.today : null,
    month: key.slice(0, 7) === todayKey.slice(0, 7) ? wslAnchor.month : null
  };
}

function completeTodayPartitions(partitions, clientsCsv) {
  const completed = { ...(partitions || {}) };
  for (const client of normalizeClientsCsv(clientsCsv).split(',').filter(Boolean)) {
    if (!Object.prototype.hasOwnProperty.call(completed, client)) completed[client] = emptyPeriod();
  }
  return completed;
}

function replaceTodayPartitions(current, fresh, targetClients) {
  const next = { ...(current || {}) };
  for (const client of targetClients || []) next[client] = emptyPeriod();
  for (const [client, period] of Object.entries(fresh || {})) next[client] = period;
  return next;
}

function mergeTodayPartitions(partitions) {
  return mergePeriods(...Object.values(partitions || {}));
}

function periodHasUsage(period) {
  if (!period) return false;
  return Number(period.totalTokens || 0) > 0
    || Number(period.costUsd || 0) > 0
    || Object.keys(period.sessions || {}).length > 0;
}

function canTargetTodayPartitions(anchor, targetClients) {
  if (!targetClients?.length) return true;
  return Boolean(
    anchor?.todayPartitions
    && !periodHasUsage(anchor.todayPartitions[UNATTRIBUTED_USAGE_CLIENT])
    && targetClients.every((client) => Object.prototype.hasOwnProperty.call(anchor.todayPartitions, client))
  );
}

function configFingerprint(clientsCsv, allTimeSince, projectsEnabled = true, qoderSourceKey = '') {
  // Deterministic string that captures the config inputs anchor correctness
  // depends on. When this changes, the persisted anchor is invalidated.
  // `qoderSourceKey` covers every enabled locally parsed Qoder client (see
  // qoderSourceFingerprintForClients), which is why the part is labelled with
  // the family rather than with the CN client alone.
  const qoder = String(qoderSourceKey || '').trim();
  const qoderPart = qoder ? `|qoder:${normalizeQoderSourceKey(qoder)}` : '';
  return `${normalizeClientsCsv(clientsCsv)}|${allTimeSince}|projects:${projectsEnabled !== false ? 'on' : 'off'}${qoderPart}`;
}

// A Qoder source key is either an already-structured fingerprint
// (`<site>|db:…|mainDb:…|transcripts:…`, several joined with ';') or a bare
// database path from a caller that has not resolved one yet. Only the bare path
// needs normalising, and resolving unconditionally would be a bug: path.resolve
// folds in the process cwd, so a structured key that merely stopped starting
// with `db:` would invalidate the persisted anchor on every launch from a
// different directory. `|` cannot appear in a Windows path and never does in
// these roots, so it is a safe discriminator.
function normalizeQoderSourceKey(key) {
  return key.includes('|') ? key : path.resolve(key);
}

// Anchor-invalidation inputs for the locally parsed Qoder clients. Both cover
// every enabled client in QODER_CLIENT_IDS order and join with ';', so enabling
// the international client — or relocating either profile — changes the string
// and forces a full rescan instead of deriving month/allTime from an anchor that
// never contained the new source. A Qoder-CN-only install produces exactly the
// single value it did before this generalization, so upgrading does not cost an
// existing user a spurious full scan.
function enabledQoderClientIds(clientsCsv) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  return QODER_CLIENT_IDS.filter((clientId) => enabled.has(clientId));
}

function qoderDbPathsForClients(clientsCsv, options = {}) {
  return enabledQoderClientIds(clientsCsv)
    .map((clientId) => qoderDataPaths({
      clientId,
      homeDir: options.homeDir,
      platform: options.platform || process.platform,
      env: options.env || process.env
    }).dbPaths[0] || '')
    .filter(Boolean)
    .join(';');
}

function qoderSourceFingerprintForClients(clientsCsv, options = {}) {
  return enabledQoderClientIds(clientsCsv)
    .map((clientId) => qoderSourceFingerprint({
      clientId,
      homeDir: options.homeDir,
      platform: options.platform || process.platform,
      env: options.env || process.env
    }))
    .join(';');
}

// The persisted anchor switched from a single `qoderCnPeriods` snapshot to a
// per-client `qoderPeriods` map when the international client was added. Read
// the legacy key back as the CN entry so an anchor written by the previous
// version still stands in for a failed CN read instead of being discarded.
function restoreAnchorQoderPeriods(saved) {
  if (!saved || typeof saved !== 'object') return null;
  if (saved.qoderPeriods && typeof saved.qoderPeriods === 'object') return saved.qoderPeriods;
  return saved.qoderCnPeriods ? { qodercn: saved.qoderCnPeriods } : null;
}

// The one place that decides whether a persisted anchor may be reused, shared by
// startCollector and by the widget's cold-start seed. Two consumers with two
// copies of these rules is how they drift, and a drifted copy shows the previous
// configuration's totals as if they were current.
//
// Returns null when the anchor is unusable at all. Otherwise `capturedAtMs` is
// the moment it was written, or null when that moment cannot be trusted: the
// collector still reuses the periods then and simply forces a full scan, while
// a seed has nothing to stand on and declines.
function collectorAnchorTrust(saved, options = {}) {
  const { clients = '', allTimeSince = '', projectsEnabled = true, qoderSourceKey = '', now = new Date() } = options;
  if (!saved || saved.dateKey !== localTodayKey(now)) return null;
  if (!saved.today || !saved.month || !saved.allTime) return null;
  if (saved.configFingerprint !== configFingerprint(clients, allTimeSince, projectsEnabled, qoderSourceKey)) return null;
  const parsed = Date.parse(saved.fullScanAt || '');
  const capturedAtMs = Number.isFinite(parsed) && parsed <= now.getTime() ? parsed : null;
  return { capturedAtMs };
}

// Force a full scan at least this often even when the anchor is otherwise
// valid, so a long-running session periodically rescans month/allTime
// and picks up any changes that the delta-derivation might miss.
const FULL_SCAN_INTERVAL_MS = 60 * 60 * 1000;

// Escape hatch for filesystems that never deliver native events — network
// mounts, some FUSE drivers, container bind mounts. chokidar has its own
// CHOKIDAR_USEPOLLING override, but that is chokidar's surface, not ours: it
// is undocumented for our users and can change with a dependency bump, so
// support asks would have no stable answer. Resolved here rather than in each
// entry point so the widget and the headless agent cannot drift apart.
// Tri-state on purpose: unset must fall through to the caller's value, which
// is why parseBoolean's fallback semantics don't fit. The default is native on
// every platform — chokidar 4 has no per-platform backend left to differ on,
// and the failure cases it cannot cover are handled by the watch-descriptor
// fallback below rather than by pre-emptively polling everywhere.
//
// Returns undefined when unset, which is what keeps that tri-state readable to
// callers that need to tell "no opinion" from an explicit "never poll".
function watchPollingEnvOverride(env = process.env) {
  const raw = String(env.TOKEN_MONITOR_WATCH_POLLING ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function resolveWatchUsePolling(preferred, env = process.env) {
  const override = watchPollingEnvOverride(env);
  if (override !== undefined) return override;
  if (typeof preferred === 'boolean') return preferred;
  return false;
}

// Kernel watch descriptors are a per-user budget shared with every other
// watcher on the machine (inotify on Linux, file descriptors on macOS/BSD), and
// editors are the usual heavy consumer — a busy Linux desktop can hand us
// ENOSPC on startup through no fault of ours. chokidar reports that
// asynchronously on the watcher, so without this the watch would just stop
// delivering events and live mode would silently decay to hourly
// reconciliation. Polling needs no descriptors at all, which makes it the
// correct degraded mode rather than merely a slower one. An explicit
// TOKEN_MONITOR_WATCH_POLLING=0 opts out: with native events now the default
// everywhere, suppressing this fallback is the only thing that direction of the
// override still does.
const WATCH_DESCRIPTOR_ERROR_CODES = new Set(['ENOSPC', 'EMFILE', 'ENFILE']);

// Windows only: libuv asserts that the filename ReadDirectoryChangesW hands
// back starts with the directory string it was given, and calls abort() when it
// does not (src/win/fs-event.c). An 8.3 short path such as C:\Users\RUNNER~1\…
// is reported back in its long form and trips exactly that assert, taking the
// whole process down. That is a native abort, so handleWatchError can never see
// it and the polling fallback cannot save us — the only guard is to hand
// chokidar the canonical long path in the first place. Junctions reach the same
// assert by the same route. Identity off Windows, so watch roots elsewhere stay
// byte-identical to the paths tokscale reads.
function canonicalWatchPath(dir) {
  if (process.platform !== 'win32') return dir;
  try { return fs.realpathSync.native(dir); }
  catch (_) { return dir; }
}

// The exporter file may not exist when the watcher starts, so canonicalise its
// existing parent and append the original basename instead of realpathing the
// file itself. This keeps exact-file matching in the same path space as the
// canonical directory root handed to chokidar on Windows.
function canonicalWatchFilePath(file) {
  return path.join(path.resolve(canonicalWatchPath(path.dirname(file))), path.basename(file));
}

function watcherOptions(usePolling, ignored) {
  return {
    ignoreInitial: true,
    persistent: true,
    ...(usePolling
      ? { usePolling: true, interval: 2000, binaryInterval: 5000 }
      : { usePolling: false }),
    ...(ignored ? { ignored } : {}),
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }
  };
}

function isQoderSelfWatchEvent(filePath, rootsByClient = {}) {
  // Both the legacy local.db and the desktop main.sqlite use the SQLite `-shm`
  // sidecar suffix. Read-only opens can recreate it, so it is not a data event.
  // Checked across every Qoder client: the sidecar of one site's database is just
  // as much a self-inflicted event as the other's.
  if (!filePath || !path.basename(filePath).toLowerCase().endsWith('-shm')) return false;
  const resolved = path.resolve(filePath);
  return Object.keys(QODER_SITE_BY_CLIENT_ID)
    .flatMap((clientId) => rootsByClient[clientId] || [])
    .some((root) => resolved.startsWith(path.resolve(root) + path.sep));
}

function startCollector(options) {
  const {
    clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion, agentRuntime,
    historyIntervalMs = 15 * 60 * 1000, historyEnabled = true, watchEnabled,
    watchTriggersCollection = true, intervalRequiresActivity = false,
    wslRefreshIntervalMs = 60 * 1000,
    onUpdate, onPreview, onError, onDiagnosticEvent, logger
  } = options;
  // Normalized once, at the edge. These arrive straight from CLI flags and env
  // vars (TOKEN_MONITOR_WATCH_DEBOUNCE_MS, TOKEN_MONITOR_INTERVAL_MS) by way of
  // a bare Number(), so Infinity and past-32-bit values reach us intact — and
  // setTimeout rewrites those to 1ms, turning the debounce's mid-tick re-arm and
  // the interval loop into spins. Clamping here means no timer below can
  // reintroduce that by forgetting.
  const watchDebounceMs = clampTimerDelayMs(options.watchDebounceMs, 1500);
  const intervalMs = clampTimerDelayMs(options.intervalMs, 5 * 60 * 1000);
  const historyRetryMs = clampTimerDelayMs(options.historyRetryMs, 60 * 1000);
  const watchUsePolling = resolveWatchUsePolling(options.watchUsePolling);
  const watchNativeForced = watchPollingEnvOverride() === false;
  const trackedClients = new Set(normalizeClientsCsv(clients).split(',').filter(Boolean));
  const reasonixNativeSessionsEnabled = options.reasonixNativeSessionsEnabled === true;
  const reasonixNativeSessionCache = reasonixNativeSessionsEnabled && trackedClients.has('reasonix')
    ? options.reasonixNativeSessionCache || createReasonixNativeSessionCache({
      env: options.env || process.env,
      homeDir: options.homeDir || os.homedir(),
      platform: options.platform || process.platform,
      cwdDir: options.cwdDir || process.cwd(),
      projectIdentity
    })
    : null;
  const deviceOsInfo = options.osInfo === undefined
    ? hostOsInfo()
    : normalizeOsInfo(options.osInfo);
  const log = logger || (() => {});
  const normalizedClients = normalizeClientsCsv(clients);
  const qoderSourceOptions = {
    homeDir: options.homeDir,
    platform: options.platform || process.platform,
    env: options.env || process.env
  };
  const qoderDbPaths = qoderDbPathsForClients(normalizedClients, {
    ...qoderSourceOptions
  });
  const qoderSourceKey = qoderSourceFingerprintForClients(normalizedClients, {
    ...qoderSourceOptions
  });
  let tickInFlight = false;
  let tickPending = false;
  let pendingForceHistory = false;
  let pendingRolloverHistoryRetry = false;
  let pendingForceSelfSync = null;
  let pendingSourceSelfSync = null;
  // null until something is actually pending. Tracked separately from the
  // force-sync flags on purpose: a coalesced replay must stay a full scan
  // unless *every* tick folded into it asked for today-only, and deriving that
  // from a force flag would let a manual refresh quietly become a warm scan.
  let pendingTodayOnly = null;
  // null means no pending scope yet; true means an all-client replay; otherwise
  // this Set is the union of targeted today-only requests waiting behind the
  // active tick. A broader request can upgrade this scope but never narrow it.
  let pendingTargetClients = null;
  let pendingActivityRevision = null;
  let lastHistoryAt = 0;
  let lastHistoryAttemptAt = 0;
  let lastHistorySuccessAt = 0;
  let lastHistoryFailureCode = null;
  let lastHistoryScanDurationMs = null;
  let rolloverHistoryPending = false;
  let rolloverHistoryRetryTimer = null;
  // Last full-scan snapshot; lets watch ticks scan only --today and derive
  // month/allTime exactly (applyPeriodDelta). Reset by every full tick.
  // anchor holds Windows-only periods; wslAnchor is the WSL contribution. WSL is
  // not watched (a 9P watch is unreliable and heavy), so it is refreshed on the
  // interval tick and, at most once per wslRefreshIntervalMs, on an anchored
  // watch tick — otherwise WSL-only work would sit up to a full interval behind
  // the seconds-level host refresh.
  let anchor = null;
  let wslAnchor = null;
  let wslStatusAnchor = null;
  let lastWslScanAt = 0;
  // Keep the highest complete live day in this collector even when another
  // process owns the shared archive. A watch tick can then hand its value to a
  // later full/history tick instead of losing it at the tick boundary.
  let liveDailyHistoryDays = {};
  // Retained per Qoder client so one site's failed history read can fall back to
  // its own last good graph without borrowing the other site's series.
  const qoderHistoryGraphs = {};
  let lastFullScanAt = 0;
  let pendingWaiters = [];
  let debounceTimer = null;
  let intervalTimer = null;
  let stopped = false;
  let lastTickAttemptAt = 0;
  let lastTickSuccessAt = 0;
  let lastTickFailureAt = 0;
  let lastTickDurationMs = null;
  let lastTickScope = 'full';
  let lastTickReasonCode = null;
  let lastTickFailureCode = null;
  let watchFallbackCode = null;
  let lastWatchFailureCode = null;
  let tickHadFailure = false;
  const scheduledWatchClients = new Set();
  let scheduledWatchNeedsFullScan = false;
  // Source events waiting on the shared throttle, and the timer that comes back
  // for them. Built here rather than at module scope because its timer has to
  // die with this collector; the throttle it reads deadlines from is shared, so
  // a rebuild inherits the floors it must not reset. `retryMs` mirrors the watch
  // debounce so a catch-up displaced by an in-flight tick lands just after it.
  const sourceSyncQueue = createSourceSyncQueue({
    throttle: selfSyncThrottle,
    retryMs: watchDebounceMs,
    isBusy: () => tickInFlight,
    // The tick that carried this event already scanned against the stale cache,
    // so the catch-up has to rescan the same clients behind the sync.
    onDue: (sourceSelfSync) => runTick('source-sync', {
      todayOnly: true,
      targetClients: sourceSelfSync,
      sourceSelfSync
    })
  });
  const selfSyncedClients = normalizeClientsCsv(clients).split(',').filter((client) => SELF_SYNCED_CLIENTS.has(client));
  let activityRevision = 0;
  let collectedActivityRevision = 0;
  let initialCollectionComplete = false;
  const watchers = [];
  let watchedDirectoryKey = null;
  // Sticky: once the kernel has refused us watch descriptors, every later
  // rebuild (a client gaining or losing a data directory) stays on polling for
  // the rest of the process. Retrying native events on each rebuild would just
  // rediscover the same exhausted budget.
  let watchDescriptorFallback = false;

  function emitDiagnosticEvent(event) {
    try {
      onDiagnosticEvent?.(event);
    } catch (_) {
      // Diagnostics observers must never affect collection or watcher state.
    }
  }

  function tickReasonCode(reason) {
    const value = String(reason || '').trim().toLowerCase();
    if (value.startsWith('watch:')) return 'watch-event';
    if (value.startsWith('client:')) return 'targeted-client';
    if (value === 'source-sync') return 'source-sync';
    if (value === 'coalesced') return 'coalesced';
    if (value === 'interval') return 'interval';
    if (value === 'manual') return 'manual';
    return 'other';
  }

  function tickScopeCode(tickOptions = {}) {
    if (tickOptions.todayOnly === true && Array.isArray(tickOptions.targetClients) && tickOptions.targetClients.length > 0) {
      return 'targeted';
    }
    return tickOptions.todayOnly === true ? 'today' : 'full';
  }

  function timestampOrNull(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0
      ? new Date(Number(value)).toISOString()
      : null;
  }

  function cloneDiagnosticValue(value) {
    if (value === null || value === undefined) return value ?? null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  // On-disk anchor: persist full-scan snapshots so the collector can reuse
  // month/allTime across restarts. On the first interval tick the anchor is
  // valid for today and configFingerprint matches, only --today is scanned
  // and month/allTime are derived via applyPeriodDelta.
  const anchorPath = path.join(sharedDataDir(), 'collector-anchor.json');
  if (options.anchorPersistenceEnabled !== false) {
    try {
      const saved = readJson(anchorPath, null);
      const trust = collectorAnchorTrust(saved, {
        clients,
        allTimeSince,
        projectsEnabled: options.projectsEnabled,
        qoderSourceKey: qoderSourceKey || qoderDbPaths
      });
      if (trust) {
        anchor = {
          dateKey: saved.dateKey,
          today: saved.today,
          month: saved.month,
          allTime: saved.allTime,
          qoderPeriods: restoreAnchorQoderPeriods(saved),
          // Per-client partitions are deliberately rebuilt by the first
          // anchored all-client tick after restart. Persisted partitions
          // could be stale for clients that changed while the app was down.
          todayPartitions: null
        };
        // Don't restore a persisted WSL snapshot when WSL scanning is now off —
        // the configFingerprint intentionally ignores the toggle (host periods
        // stay valid), so without this gate a warm-scan preview would briefly
        // re-merge the old WSL totals before the first full tick clears them.
        wslAnchor = options.wslScanEnabled !== false ? (saved.wslBundle || null) : null;
        wslStatusAnchor = options.wslScanEnabled !== false ? (saved.wslStatus || null) : null;
        // An untrustworthy capture time leaves lastFullScanAt at 0, which forces
        // a full scan on the first interval tick (see loop()).
        if (trust.capturedAtMs !== null) lastFullScanAt = trust.capturedAtMs;
      }
    } catch (_) {}
  }

  function resolveWaiters(waiters, result) {
    for (const resolve of waiters) resolve(result);
  }

  function clearRolloverHistoryRetry() {
    if (rolloverHistoryRetryTimer) clearTimeout(rolloverHistoryRetryTimer);
    rolloverHistoryRetryTimer = null;
  }

  function settleRolloverHistoryAttempt(success, retryAttempt) {
    if (!rolloverHistoryPending) return;
    if (success || retryAttempt) {
      rolloverHistoryPending = false;
      clearRolloverHistoryRetry();
      return;
    }
    if (rolloverHistoryRetryTimer || stopped) return;
    rolloverHistoryRetryTimer = setTimeout(() => {
      rolloverHistoryRetryTimer = null;
      if (stopped || !rolloverHistoryPending) return;
      // One targeted retry closes a transient midnight graph failure without
      // making every few-second watch event pay for another History scan. A
      // second failure falls back to the normal History interval.
      void runTick('history-rollover-retry', {
        forceHistory: true,
        rolloverHistoryRetry: true,
        todayOnly: true
      });
    }, historyRetryMs);
  }

  async function performTick(reason, tickOptions = {}) {
    const tickStartedAt = Date.now();
    const collectedAt = collectionDate(options.now);
    const todayKey = localTodayKey(collectedAt);
    // The previous live DAY becomes durable history at local midnight. Finalize
    // it before publishing the new day, even when the normal History interval
    // is not due yet, so fixed ranges never wait for the next scheduled graph.
    const localDayRolledOver = Boolean(anchor?.dateKey && anchor.dateKey !== todayKey);
    if (localDayRolledOver && historyEnabled) rolloverHistoryPending = true;
    const includeHistory = shouldIncludeHistory(
      collectedAt.getTime(),
      lastHistoryAt,
      historyIntervalMs,
      Boolean(tickOptions.forceHistory) || localDayRolledOver,
      historyEnabled
    );
    if (includeHistory) {
      lastHistoryAt = collectedAt.getTime();
      lastHistoryAttemptAt = tickStartedAt;
    }
    let historyScanSucceeded = !includeHistory;
    const requestedTargetClients = [...new Set(normalizeClientsCsv(tickOptions.targetClients).split(',').filter(Boolean))];
    const targetAnchorReady = canTargetTodayPartitions(anchor, requestedTargetClients);
    const anchored = Boolean(tickOptions.todayOnly && anchor && anchor.dateKey === todayKey);
    const wslPlatform = (options.platform || process.platform) === 'win32';
    // WSL has no watcher, so a watch tick may refresh it once the throttle has
    // elapsed; the interval tick asks for it explicitly. Full ticks scan it
    // unconditionally (see collectUsageOnce's !anchorUsed branch).
    const wslRefreshDue = wslPlatform
      && anchored
      && wslRefreshIntervalMs > 0
      && tickStartedAt - lastWslScanAt >= wslRefreshIntervalMs;
    const refreshWsl = Boolean(tickOptions.refreshWsl) || wslRefreshDue;
    const hadPreviousFailure = tickHadFailure;
    lastTickAttemptAt = tickStartedAt;
    lastTickReasonCode = tickReasonCode(reason);
    lastTickScope = tickScopeCode(tickOptions);
    try {
      let captured = null;
      // One read state per enabled Qoder client: an anchored tick must be able
      // to tell a failed CN read apart from a failed international one, because
      // each site keeps its own partition to retain.
      const qoderReadStates = {};
      for (const qoderClientId of enabledQoderClientIds(clients)) {
        qoderReadStates[qoderClientId] = { periodFailed: false };
      }
      const summary = await collectUsageOnce({
        ...options,
        clients,
        allTimeSince,
        commandTimeoutMs,
        deviceId,
        agentVersion,
        agentRuntime,
        osInfo: deviceOsInfo,
        now: collectedAt,
        includeHistory,
        // Capture after the runtime's transformUsage hook so the archive uses
        // the same today period that the user actually sees. The process-local
        // liveDays overlay is passed into any graph scan that happens first.
        deferLiveHistoryCapture: true,
        dailyHistoryLiveDays: liveDailyHistoryDays,
        onHistoryStatus: includeHistory ? (status) => {
          lastHistoryAttemptAt = Date.parse(status.attemptedAt) || lastHistoryAttemptAt;
          const successAt = Date.parse(status.successAt);
          if (Number.isFinite(successAt)) lastHistorySuccessAt = successAt;
          lastHistoryFailureCode = status.failureCode || null;
          lastHistoryScanDurationMs = status.durationMs;
          historyScanSucceeded = Boolean(status.successAt && !status.failureCode);
        } : null,
        forceSelfSync: tickOptions.forceSelfSync ?? null,
        sourceSelfSync: tickOptions.sourceSelfSync ?? null,
        reasonixNativeSessionsEnabled,
        reasonixNativeSessionCache,
        // Both selections name clients whose pending source event this tick has
        // already consumed — the queue's drain for one, its acknowledgement for
        // the other — so either is a legitimate restore.
        onSelfSyncFailed: (kind) => sourceSyncQueue.restore(
          mergeSelfSyncSelection(tickOptions.sourceSelfSync, tickOptions.acknowledgedSourceSync) || [],
          kind
        ),
        targetClients: anchored && targetAnchorReady ? requestedTargetClients : [],
        todayOnlyAnchor: anchored ? anchor : null,
        wslAnchor: anchored ? wslAnchor : null,
        wslStatus: anchored ? wslStatusAnchor : null,
        refreshWsl: anchored ? refreshWsl : false,
        qoderFallbackPeriods: anchor?.qoderPeriods || null,
        qoderHistoryFallbackGraphs: qoderHistoryGraphs,
        qoderReadStates,
        onAnchorComputed: (x) => { captured = x; },
        onQoderHistoryGraph: (clientId, graph) => { qoderHistoryGraphs[clientId] = graph; },
        onProgress: (partial) => {
          if (!partial.today) return;
          try {
            if (typeof onPreview === 'function') {
              // Frozen WSL snapshot, gated so a cross-day/cross-month full scan
              // doesn't merge a stale period's WSL usage into the preview.
              const wsl = wslPeriodsForPreview(wslAnchor, anchor?.dateKey, todayKey);
              // A Qoder client whose read failed with no fallback to stand on
              // keeps its anchored today partition in the preview, so one
              // transient sqlite failure cannot blank that client mid-warm-scan.
              let qoderAnchorToday = null;
              for (const [clientId, readState] of Object.entries(qoderReadStates)) {
                if (!readState.periodFailed || readState.fallbackUsed) continue;
                const partition = anchor?.todayPartitions?.[clientId];
                if (!partition) continue;
                qoderAnchorToday = qoderAnchorToday
                  ? mergePeriods(qoderAnchorToday, partition)
                  : partition;
              }
              const anyQoderPeriodFailed = Object.values(qoderReadStates)
                .some((readState) => readState.periodFailed);
              const preview = {
                deviceId, hostname: os.hostname(),
                platform: `${process.platform}-${process.arch}`,
                ...(deviceOsInfo.name ? { osName: deviceOsInfo.name } : {}),
                ...(deviceOsInfo.version ? { osVersion: deviceOsInfo.version } : {}),
                updatedAt: partial.updatedAt,
                agentVersion, agentRuntime,
                trackedClients: (clients || '').split(',').filter(Boolean),
                // Merge the frozen WSL snapshot into today (as month/allTime do
                // below) so the today card keeps its WSL contribution during a
                // warm scan instead of dropping to host-only until the final tick.
                // The upstream wsl.today guard is preserved: non-WSL machines
                // keep the identity pass-through instead of a normalize round
                // trip on this shared preview path.
                today: qoderAnchorToday
                  ? mergePeriods(partial.today, qoderAnchorToday, wsl.today)
                  : (wsl.today ? mergePeriods(partial.today, wsl.today) : partial.today)
              };
              // Only include month/allTime when actually scanned. During warm
              // full scans the main.js handler carries the previous values
              // forward for omitted fields, so these cards don't flash empty.
              if (partial.month && !anyQoderPeriodFailed) {
                preview.month = wsl.month
                  ? mergePeriods(partial.month, wsl.month)
                  : partial.month;
              }
              if (partial.allTime && !anyQoderPeriodFailed) {
                preview.allTime = wslAnchor
                  ? mergePeriods(partial.allTime, wslAnchor.allTime)
                  : partial.allTime;
              }
              // Only derive clientStatus when allTime is available; warm
              // scans carry the previous status forward in main.js.
              if (partial.allTime && !anyQoderPeriodFailed) {
                preview.clientStatus = deriveClientStatus(clients, partial.allTime);
              }
              onPreview(preview);
            }
          } catch (_) {
            // Progressive push errors must not abort the remaining period scans.
            // The final onUpdate will report the complete data.
          }
        }
      });
      if (stopped) return;
      // Record when WSL was actually scanned so the next watch tick respects the
      // refresh throttle. A full tick scans it; an anchored tick only when asked.
      if (wslPlatform && options.wslScanEnabled !== false && (!anchored || refreshWsl)) {
        lastWslScanAt = Date.now();
      }
      // Any Qoder client that could not be read leaves this tick's month/allTime
      // partial, so the result must not be frozen as a full-scan anchor and the
      // next watch tick has to be a full one.
      const anyQoderPeriodFailed = Object.values(qoderReadStates)
        .some((readState) => readState.periodFailed);
      if (includeHistory) {
        settleRolloverHistoryAttempt(
          historyScanSucceeded,
          tickOptions.rolloverHistoryRetry === true
        );
      }
      if (!anchored && captured) {
        anchor = {
          dateKey: todayKey,
          today: captured.windowsPeriods.today,
          month: captured.windowsPeriods.month,
          allTime: captured.windowsPeriods.allTime,
          todayPartitions: captured.todayPartitions,
          qoderPeriods: captured.qoderPeriods,
          ...(captured.nativeSessions ? { nativeSessions: captured.nativeSessions } : {}),
          ...(captured.nativeProjects ? { nativeProjects: captured.nativeProjects } : {})
        };
        // A per-home tokscale failure (9P timeout, distro stopping mid-scan) is
        // swallowed inside collectWslUsage, which returns a partial/empty bundle.
        // Freezing that as the new anchor drops the WSL share of every card until
        // the next full scan, so keep the last good snapshot when the fresh scan
        // produced nothing but the previous one had usage.
        const freshWslHasUsage = wslBundleHasUsage(captured.wslBundle);
        const anchoredWslHasUsage = wslBundleHasUsage(wslAnchor);
        if (freshWslHasUsage || !anchoredWslHasUsage) {
          wslAnchor = captured.wslBundle;
          wslStatusAnchor = captured.wslStatus || null;
        } else {
          options.logger?.('wsl scan returned no usage; keeping the previous snapshot');
        }
        if (!anyQoderPeriodFailed) lastFullScanAt = Date.now();
        if (options.anchorPersistenceEnabled !== false) {
          try {
            // Atomic: a concurrent reader at startup must never see a truncated
            // file (readJson would return null and force an expensive full rescan).
            // This path is shared by the widget and a headless agent on the same
            // machine, so the temp name has to be unique per writer.
            writeJsonAtomic(anchorPath, {
              dateKey: anchor.dateKey,
              today: anchor.today,
              month: anchor.month,
              allTime: anchor.allTime,
              qoderPeriods: anchor.qoderPeriods,
              wslBundle: wslAnchor,
              wslStatus: wslStatusAnchor,
              ...(anchor.nativeSessions ? { nativeSessions: anchor.nativeSessions } : {}),
              ...(anchor.nativeProjects ? { nativeProjects: anchor.nativeProjects } : {}),
              configFingerprint: configFingerprint(
                clients,
                allTimeSince,
                options.projectsEnabled,
                qoderSourceKey || qoderDbPaths
              ),
              fullScanAt: new Date(lastFullScanAt).toISOString()
            });
          } catch (_) {}
        }
      } else if (anchored && captured) {
        // Keep the rolling per-client today partitions fresh for targeted
        // watch ticks. WSL stays independently frozen between interval ticks.
        if (captured.todayPartitions) anchor.todayPartitions = captured.todayPartitions;
        // Each client's own snapshot advances independently: one site's failed
        // read must not freeze the other site's month/allTime derivation, and
        // must not let a partial today partition become its delta base.
        for (const [qoderClientId, readState] of Object.entries(qoderReadStates)) {
          const capturedPeriods = captured.qoderPeriods?.[qoderClientId];
          const anchoredPeriods = anchor.qoderPeriods?.[qoderClientId];
          if (readState.periodFailed || !capturedPeriods?.today || !anchoredPeriods) continue;
          anchor.qoderPeriods = {
            ...anchor.qoderPeriods,
            [qoderClientId]: {
              today: capturedPeriods.today,
              month: applyPeriodDelta(anchoredPeriods.month, capturedPeriods.today, anchoredPeriods.today),
              allTime: applyPeriodDelta(anchoredPeriods.allTime, capturedPeriods.today, anchoredPeriods.today)
            }
          };
        }
        if (captured.nativeSessions) anchor.nativeSessions = captured.nativeSessions;
        if (captured.nativeProjects) anchor.nativeProjects = captured.nativeProjects;
        if (refreshWsl) {
          wslAnchor = captured.wslBundle;
          wslStatusAnchor = captured.wslStatus || null;
        }
      }
      if (anyQoderPeriodFailed) scheduledWatchNeedsFullScan = true;
      const transformedSummary = await onUpdate?.(summary, reason);
      const visibleSummary = transformedSummary && typeof transformedSummary === 'object'
        ? transformedSummary
        : summary;
      if (historyEnabled !== false && options.dailyHistoryArchiveEnabled) {
        try {
          const visibleAt = visibleSummary.updatedAt || summary.updatedAt;
          const visibleDate = visibleAt ? new Date(visibleAt) : new Date();
          const visibleDateKey = Number.isFinite(visibleDate.getTime())
            ? localTodayKey(visibleDate)
            : todayKey;
          const retainedLive = retainLiveDailyHistory(visibleSummary.today, {
            ...(options.dailyHistoryArchiveOptions || {}),
            liveDays: liveDailyHistoryDays,
            todayKey: visibleDateKey,
            // Watch ticks update the in-memory maximum on every refresh, but
            // only full/history ticks write it. This avoids a disk write for
            // every few-second watch event without dropping the value before
            // the next tick or local-day rollover.
            writeEnabled: !anchored || includeHistory
              || anchor?.dateKey !== visibleDateKey
              ? options.dailyHistoryArchiveWriteEnabled
              : false
          });
          liveDailyHistoryDays = retainedLive.liveDays || {};
        } catch (error) {
          log(`daily live history archive failed: ${error.message}`);
        }
      }
      const tickFinishedAt = Date.now();
      lastTickSuccessAt = tickFinishedAt;
      lastTickDurationMs = Math.max(0, tickFinishedAt - tickStartedAt);
      lastTickFailureCode = null;
      tickHadFailure = false;
      if (hadPreviousFailure) {
        emitDiagnosticEvent({
          subsystem: 'collector',
          code: 'collector-recovered',
          durationMs: lastTickDurationMs
        });
      }
      if (!anchored) setupWatchers();
      if (Number.isFinite(tickOptions.activityRevision)) {
        collectedActivityRevision = Math.max(collectedActivityRevision, tickOptions.activityRevision);
        initialCollectionComplete = true;
      }
      return true;
    } catch (error) {
      if (stopped) return;
      if (includeHistory) {
        settleRolloverHistoryAttempt(false, tickOptions.rolloverHistoryRetry === true);
      }
      const tickFinishedAt = Date.now();
      lastTickFailureAt = tickFinishedAt;
      lastTickDurationMs = Math.max(0, tickFinishedAt - tickStartedAt);
      lastTickFailureCode = 'tick-failed';
      tickHadFailure = true;
      emitDiagnosticEvent({
        subsystem: 'collector',
        code: 'collector-tick-failed',
        scope: lastTickScope,
        durationMs: lastTickDurationMs
      });
      // takeWatchClients() already drained the pending set, so the clients this
      // tick was meant to cover are gone. Force the next tick to scan all of
      // them in every mode: in live mode the next watch event would otherwise
      // target only its own client and leave the failed one serving the stale
      // anchor partition until the 5–30 minute interval reconciles it, which
      // breaks the seconds-level freshness live mode promises.
      scheduledWatchNeedsFullScan = true;
      if (onError) onError(error, reason); else log(`collector tick failed (${reason}): ${error.message}`);
      return false;
    }
  }

  function mergePendingTargetScope(tickOptions) {
    const todayOnly = tickOptions.todayOnly === true;
    const targets = [...new Set(normalizeClientsCsv(tickOptions.targetClients).split(',').filter(Boolean))];
    if (!todayOnly || targets.length === 0) {
      pendingTargetClients = true;
      return;
    }
    if (pendingTargetClients === true) return;
    if (!(pendingTargetClients instanceof Set)) pendingTargetClients = new Set();
    for (const client of targets) pendingTargetClients.add(client);
  }

  async function runTick(reason, tickOptions = {}) {
    const tickActivityRevision = Number.isFinite(tickOptions.activityRevision)
      ? tickOptions.activityRevision
      : activityRevision;
    const effectiveTickOptions = { ...tickOptions, activityRevision: tickActivityRevision };
    if (tickInFlight) {
      tickPending = true;
      pendingForceHistory = pendingForceHistory || Boolean(tickOptions.forceHistory);
      pendingRolloverHistoryRetry = pendingRolloverHistoryRetry
        || Boolean(tickOptions.rolloverHistoryRetry);
      pendingForceSelfSync = mergeSelfSyncSelection(pendingForceSelfSync, tickOptions.forceSelfSync);
      pendingSourceSelfSync = mergeSelfSyncSelection(pendingSourceSelfSync, tickOptions.sourceSelfSync);
      pendingTodayOnly = pendingTodayOnly === null
        ? Boolean(tickOptions.todayOnly)
        : pendingTodayOnly && Boolean(tickOptions.todayOnly);
      mergePendingTargetScope(tickOptions);
      pendingActivityRevision = pendingActivityRevision === null
        ? tickActivityRevision
        : Math.max(pendingActivityRevision, tickActivityRevision);
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    tickInFlight = true;
    try {
      const initialResult = await performTick(reason, {
        ...effectiveTickOptions,
        acknowledgedSourceSync: sourceSyncQueue.acknowledge(effectiveTickOptions.forceSelfSync)
      });
      while (tickPending && !stopped) {
        const forceHistory = pendingForceHistory;
        const rolloverHistoryRetry = pendingRolloverHistoryRetry;
        const forceSelfSync = pendingForceSelfSync;
        const sourceSelfSync = pendingSourceSelfSync;
        const todayOnly = pendingTodayOnly === true;
        const targetClients = todayOnly && pendingTargetClients instanceof Set
          ? [...pendingTargetClients]
          : [];
        const activityRevision = pendingActivityRevision;
        const waiters = pendingWaiters;
        pendingWaiters = [];
        tickPending = false;
        pendingForceHistory = false;
        pendingRolloverHistoryRetry = false;
        pendingForceSelfSync = null;
        pendingSourceSelfSync = null;
        pendingTodayOnly = null;
        pendingTargetClients = null;
        pendingActivityRevision = null;
        const acknowledgedSourceSync = sourceSyncQueue.acknowledge(forceSelfSync);
        const result = await performTick('coalesced', {
          forceHistory,
          rolloverHistoryRetry,
          forceSelfSync,
          sourceSelfSync,
          acknowledgedSourceSync,
          todayOnly,
          targetClients,
          ...(activityRevision === null ? {} : { activityRevision })
        });
        resolveWaiters(waiters, result === true);
      }
      return initialResult === true;
    } finally {
      tickInFlight = false;
      if (stopped && pendingWaiters.length > 0) {
        const waiters = pendingWaiters;
        pendingWaiters = [];
        resolveWaiters(waiters, false);
      }
    }
  }

  function recordWatchClients(eventClients) {
    if (Array.isArray(eventClients)) {
      if (eventClients.length === 0) scheduledWatchNeedsFullScan = true;
      else for (const client of eventClients) scheduledWatchClients.add(client);
    }
  }

  function takeWatchClients(additionalClients = []) {
    const targetClients = scheduledWatchNeedsFullScan
      ? []
      : [...new Set([...scheduledWatchClients, ...additionalClients])];
    scheduledWatchClients.clear();
    scheduledWatchNeedsFullScan = false;
    return targetClients;
  }

  function scheduleTick(reason, eventClients) {
    if (stopped) return;
    recordWatchClients(eventClients);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Re-arm instead of queueing onto the in-flight tick: the coalesce path
      // would re-run immediately on completion, stacking scans back-to-back.
      if (tickInFlight) { scheduleTick(reason); return; }
      // A raw source event means that client's synced cache may now be stale, so
      // its sync drops to the short floor instead of waiting out the idle
      // cadence. Its cache is deliberately outside the watcher, so a sync here
      // cannot create the issue #15 self-trigger loop.
      runTick(reason, {
        todayOnly: true,
        targetClients: takeWatchClients(),
        sourceSelfSync: sourceSyncQueue.takeDue()
      });
    }, watchDebounceMs);
  }

  // chokidar's close() returns a promise, but only after an O(N) synchronous
  // pass that walks every watched entry and closes every fs.watch handle inline,
  // so on a tree the size of ~/.claude/projects it blocks the caller for as long
  // as that takes. Callers that must not overlap an old watcher with a new one
  // (mode switches) pay that cost; the quit path skips it via
  // stop({ skipCloseWatchers }) and lets the descriptors go with the process.
  function closeWatchers() {
    for (const watcher of watchers) {
      try { watcher.close(); } catch (_) {}
    }
    watchers.length = 0;
  }

  function handleWatchError(error) {
    log(`chokidar error: ${error.message}`);
    if (stopped || watchUsePolling || watchNativeForced || watchDescriptorFallback) return;
    if (!WATCH_DESCRIPTOR_ERROR_CODES.has(error?.code)) return;
    watchDescriptorFallback = true;
    watchFallbackCode = error.code;
    emitDiagnosticEvent({
      subsystem: 'watcher',
      code: 'watcher-polling-fallback',
      detailCode: error.code
    });
    log(`Native file events unavailable (${error.code}); falling back to 2s polling.`);
    // Rebuilding from inside chokidar's own error emit would close the watcher
    // mid-dispatch, so hand it to the next tick of the loop instead.
    setImmediate(() => {
      if (stopped) return;
      watchedDirectoryKey = null;
      setupWatchers();
    });
  }

  function setupWatchers() {
    if (!watchEnabled) return;
    // Canonicalise before anything derives from these roots, so the paths handed
    // to chokidar and the paths clientsForWatchPath matches against are the same
    // strings. Resolving only one of the two would silently break attribution.
    // One dirExists sweep feeds both maps: probing twice would let a directory
    // created between the sweeps land in the watch list and not the attribution
    // list, or the reverse.
    const watchRoots = watchClientRootsForClients(clients, qoderSourceOptions);
    const rootsByClient = Object.fromEntries(
      Object.entries(watchRoots)
        .map(([client, dirs]) => [client, dirs.map(canonicalWatchPath)])
    );
    // Watch targets and attribution prefixes are the same list everywhere except
    // a custom Copilot exporter, whose parent must be watched without becoming a
    // copilot prefix. Canonicalised through the same function so both still
    // compare equal to the paths chokidar reports.
    const attributionRootsByClient = Object.fromEntries(
      Object.entries(watchAttributionRootsForClients(clients, watchRoots, qoderSourceOptions))
        .map(([client, dirs]) => [client, dirs.map(canonicalWatchPath)])
    );
    // A subset of the same roots, matched separately so a write to a client's
    // parse-local data cannot pass for a write to its self-sync source.
    const sourceSyncRootsByClient = Object.fromEntries(
      Object.entries(selfSyncSourceRootsForClients(clients))
        .map(([client, dirs]) => [client, dirs.map(canonicalWatchPath)])
    );
    const dirs = [...new Set(Object.values(rootsByClient).flat())];
    const directoryKey = dirs.join('\0');
    if (directoryKey === watchedDirectoryKey) return;
    closeWatchers();
    if (dirs.length === 0) {
      watchedDirectoryKey = directoryKey;
      lastWatchFailureCode = null;
      log('No watchable client data directories found; relying on fallback interval only.');
      return;
    }
    const usePolling = watchUsePolling || watchDescriptorFallback;
    try {
      const ignored = watchIgnoreMatcher(clients, qoderSourceOptions);
      const watcher = chokidar.watch(dirs, watcherOptions(usePolling, ignored));
      watcher.on('all', (event, filePath) => {
        // The quit path leaves the watcher open (see stop), so events can still
        // arrive after the collector is done with them.
        if (stopped) return;
        // Our own read-only opens of a Qoder database recreate its SQLite
        // wal-index (local.db-shm), so watching that sidecar re-triggers the
        // watch loop forever — confirmed: 142 events/5min with Qoder CN fully
        // stopped, dropping to 0 after this filter. The real data signal lives
        // in local.db / local.db-wal, so drop *-shm events under the Qoder
        // clients' roots only. (hermes/micode may share this pattern upstream —
        // out of scope here, their watch behaviour is left untouched.)
        if (isQoderSelfWatchEvent(filePath, rootsByClient)) return;
        activityRevision += 1;
        if (tickPending) {
          pendingActivityRevision = pendingActivityRevision === null
            ? activityRevision
            : Math.max(pendingActivityRevision, activityRevision);
        }
        const eventClients = clientsForWatchPath(filePath, attributionRootsByClient);
        if (
          reasonixNativeSessionCache
          && isReasonixNativeSessionSidecar(filePath)
          && isReasonixNativeSessionPath(
            filePath,
            typeof reasonixNativeSessionCache.sessionRoots === 'function'
              ? reasonixNativeSessionCache.sessionRoots()
              : reasonixNativeSessionWatchRoots()
          )
        ) {
          reasonixNativeSessionCache.invalidate(filePath);
        }
        for (const client of clientsForWatchPath(filePath, sourceSyncRootsByClient)) {
          sourceSyncQueue.record(client);
        }
        if (watchTriggersCollection) {
          scheduleTick(
            `watch:${event}:${path.basename(filePath || '')}`,
            eventClients
          );
        } else recordWatchClients(eventClients);
      });
      watcher.on('error', handleWatchError);
      watchers.push(watcher);
      watchedDirectoryKey = directoryKey;
      lastWatchFailureCode = null;
      for (const dir of dirs) log(`Watching ${dir} (${usePolling ? 'polling 2s' : 'native events'})`);
    } catch (error) {
      watchedDirectoryKey = null;
      lastWatchFailureCode = 'watcher-rebuild-failed';
      emitDiagnosticEvent({ subsystem: 'watcher', code: 'watcher-rebuild-failed' });
      log(`Cannot watch ${dirs.join(', ')}: ${error.message}`);
    }
  }

  function loop() {
    if (stopped) return;
    const activityRevisionAtStart = activityRevision;
    // Native watchers are an optimization, not the source of truth. Always
    // retain the hourly reconciliation path for missed events, newly created
    // client directories, WSL-only activity, and cross-day metadata refreshes.
    const fullScanDue = lastFullScanAt === 0 || Date.now() - lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
    if (
      intervalRequiresActivity &&
      initialCollectionComplete &&
      !fullScanDue &&
      activityRevisionAtStart <= collectedActivityRevision
    ) {
      intervalTimer = setTimeout(loop, intervalMs);
      return;
    }
    // Full scan at least once per FULL_SCAN_INTERVAL_MS so the anchor
    // does not drift from reality over a long-running session.
    // lastFullScanAt === 0 means no valid timestamp exists (cold start,
    // unparseable, or future timestamp) — force a full scan immediately.
    const anchorToday = Boolean(!fullScanDue && anchor && anchor.dateKey === localTodayKey());
    const sourceSelfSync = intervalRequiresActivity ? sourceSyncQueue.takeDue() : null;
    // Smart mode carries the clients its watch events named since the last tick
    // and unions the self-synced ones on top regardless. Their tokscale cache
    // dirs are deliberately unwatched to avoid a self-triggering loop, so a sync
    // can refresh what tokscale reads without any event naming the client it
    // belongs to. Antigravity's source roots are watched and do name it, but that
    // tracks the IDE writing rather than the sync landing, so targeting alone
    // would still miss the sync output.
    const targetClients = intervalRequiresActivity ? takeWatchClients(selfSyncedClients) : [];
    runTick('interval', {
      ...(anchorToday ? { todayOnly: true, refreshWsl: true, targetClients } : {}),
      ...(sourceSelfSync ? { sourceSelfSync } : {}),
      activityRevision: activityRevisionAtStart
    }).finally(() => {
      if (stopped) return;
      intervalTimer = setTimeout(loop, intervalMs);
    });
  }

  // Stays synchronous and never returns a promise: startMode() and friends rely
  // on stop() having severed the old collector by the time it returns. Setting
  // `stopped` is what does the severing, so a watcher left alive by
  // skipCloseWatchers still cannot drive a tick.
  function stop(options = {}) {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (intervalTimer) { clearTimeout(intervalTimer); intervalTimer = null; }
    clearRolloverHistoryRetry();
    sourceSyncQueue.stop();
    if (!options.skipCloseWatchers) closeWatchers();
    watchedDirectoryKey = null;
  }

  function getDiagnostics() {
    const watchMode = !watchEnabled
      ? 'disabled'
      : (watchUsePolling || watchDescriptorFallback ? 'polling' : 'native');
    const state = stopped
      ? 'stopped'
      : tickInFlight
        ? 'running'
        : lastTickFailureCode
          ? 'failed'
          : 'idle';
    return {
      state,
      collectionMode: watchTriggersCollection ? 'live' : intervalRequiresActivity ? 'smart' : 'interval',
      intervalMs,
      watchDebounceMs,
      watchEnabled,
      watchMode,
      watchFallbackCode,
      lastWatchFailureCode,
      tickInFlight,
      tickPending,
      lastTickReasonCode,
      lastTickScope,
      lastTickAttemptAt: timestampOrNull(lastTickAttemptAt),
      lastTickSuccessAt: timestampOrNull(lastTickSuccessAt),
      lastTickFailureAt: timestampOrNull(lastTickFailureAt),
      lastTickDurationMs,
      lastFullScanAt: timestampOrNull(lastFullScanAt),
      lastHistoryAttemptAt: timestampOrNull(lastHistoryAttemptAt),
      lastHistorySuccessAt: timestampOrNull(lastHistorySuccessAt),
      lastHistoryFailureCode,
      lastHistoryScanDurationMs,
      lastFailureCode: lastTickFailureCode,
      wslStatus: cloneDiagnosticValue(wslStatusAnchor)
    };
  }

  setupWatchers();
  loop();

  // A rescan of one tool. Was cursor-only because a Cursor sign-in was the only
  // caller; the machinery underneath was always per-client, so the guard was a
  // narrower contract than the implementation. `targetClients` keeps the scan to
  // the partition being asked about instead of every client's today.
  function refreshClient(clientId, refreshOptions = {}) {
    const normalized = String(clientId || '').trim().toLowerCase();
    if (!normalized || !trackedClients.has(normalized)) {
      throw new TypeError(`Unsupported targeted usage client: ${normalized || '(empty)'}`);
    }
    return runTick(`client:${normalized}`, {
      todayOnly: true,
      targetClients: [normalized],
      // Only the self-synced clients have a sync to force; naming any other here
      // would be read by nothing.
      forceSelfSync: refreshOptions.forceSync === true && SELF_SYNCED_CLIENTS.has(normalized) ? [normalized] : null
    });
  }

  return {
    getDiagnostics,
    refreshClient,
    stop,
    tick: (reason = 'manual', tickOptions = {}) => runTick(reason, tickOptions)
  };
}


/**
 * The Qoder adapter timestamps its reads against "now", so a past window needs the
 * clock at the end of that window rather than the wall clock — otherwise a range
 * that ends today and a range that ended last month read the same sources with the
 * same freshness rule and only the row window differs.
 */
function rangeEndAsNow(options, range) {
  if (typeof options.now === 'function') return options.now();
  if (options.now) return new Date(options.now);
  const endMs = Number(range?.endMs);
  return Number.isFinite(endMs) && endMs > 0 ? new Date(endMs) : new Date();
}

async function collectCustomRangeOnce(options = {}) {
  const range = normalizeCustomRange(options.range || options);
  if (!range.ok) {
    const error = new Error(`Invalid custom range: ${range.error}`);
    error.code = range.error;
    throw error;
  }
  const clients = options.clients;
  const commandTimeoutMs = options.commandTimeoutMs;
  const projectsEnabled = options.projectsEnabled !== false;
  const runTokscaleFn = options.runTokscale || runTokscale;
  const normalizedClients = normalizeClientsCsv(clients);
  const tokscaleClients = tokscaleClientsCsv(normalizedClients);
  const includesProma = includesLocalClient(normalizedClients, 'proma');
  const includesClaudeDesktop = includesLocalClient(normalizedClients, 'claude-desktop');
  const homeDir = options.homeDir || os.homedir();
  let period = emptyPeriod();

  if (tokscaleClients) {
    const flags = ['--since', range.since, '--until', range.until];
    const json = await runTokscaleFn({ clients: tokscaleClients, flags, commandTimeoutMs });
    period = extractUsageFromTokscale(json);
  }

  if (includesProma) {
    try {
      const { buildTokscaleJson } = require('./promaUsage');
      const promaRows = collectPromaRows();
      const promaPricing = await resolvePromaPricing(promaRows, {
        lookupModelPricing: options.lookupModelPricing,
        commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
        pricingRevision: options.pricingRevision
      });
      const rangedRows = promaRows.filter((row) => {
        if (!row.createdAt) return false;
        return row.createdAt >= range.startMs && row.createdAt <= range.endMs;
      });
      const promaPeriod = extractUsageFromTokscale(buildTokscaleJson({}, {
        rows: rangedRows,
        pricingByModel: promaPricing,
        includeUndated: false
      }));
      period = mergePeriods(period, promaPeriod);
    } catch (err) {
      if (typeof options.logger === 'function') options.logger(`proma custom-range parse failed: ${err.message}`);
    }
  }

  if (includesClaudeDesktop) {
    try {
      const desktopRows = collectClaudeDesktopRows({ homeDir });
      const desktopPricing = await resolvePromaPricing(desktopRows, {
        lookupModelPricing: options.lookupModelPricing,
        commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
        pricingRevision: options.pricingRevision
      });
      const desktopJson = buildClaudeDesktopRangeJson(range, { rows: desktopRows, pricingByModel: desktopPricing });
      period = mergePeriods(period, extractUsageFromTokscale(desktopJson));
    } catch (err) {
      if (typeof options.logger === 'function') options.logger(`claude-desktop custom-range parse failed: ${err.message}`);
    }
  }

  // Both Qoder sites are read by this project's own adapter rather than by
  // tokscale, so a custom range has to call the adapter too — otherwise Qoder
  // shows up in 今日 / 本月 / 全部 and nowhere in 昨日 / 本周, which is the same
  // tool measured two ways. The row set is already dated, so the window is exact
  // and the estimate provenance survives into the answer.
  const qoderClients = enabledQoderClientIds(normalizedClients);
  const collectQoderUsage = options.collectQoderClientUsage || collectQoderClientUsage;
  for (const qoderClientId of qoderClients) {
    try {
      const state = await collectQoderUsage(qoderClientId, {
        options,
        // `collectUsageOnce` computes this once per tick; the range path has no
        // tick, so it derives the same value from its own options.
        platformValue: options.platform || process.platform,
        collectedAt: rangeEndAsNow(options, range),
        allTimeSince: range.since,
        anchorUsed: false,
        readState: null,
        fallbackPeriods: null
      });
      if (!state?.rows?.length) continue;
      const qoderJson = buildQoderCnRangeJson(range, {
        rows: state.rows,
        pricingByModel: state.pricing,
        clientId: qoderClientId
      });
      period = mergePeriods(period, extractUsageFromTokscale(qoderJson));
    } catch (err) {
      if (typeof options.logger === 'function') options.logger(`${qoderClientId} custom-range parse failed: ${err.message}`);
    }
  }

  if (!tokscaleClients && !includesProma && !includesClaudeDesktop && !qoderClients.length) {
    return { range, period: emptyPeriod(), updatedAt: new Date().toISOString() };
  }

  const localSessionMetadataDeps = {
    ...(options.sessionMetadataDeps || {}),
    metadataCache: new Map(),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set()
  };
  applySessionTimestamps(
    { custom: period },
    homeDir,
    { ...localSessionMetadataDeps, retryMisses: true, resolveProjects: projectsEnabled }
  );

  // Sessions the source tool already pruned come back here exactly as they do on
  // the fixed tabs: without this, a day whose tool cleaned up after itself reads
  // lower in 昨日 / 本周 than in 本月 — the same day measured two ways. Membership
  // is the archived day bucket, de-duplication the shared `client:sessionId` key,
  // and the hour filter below still runs, so a partial window gains nothing.
  if (options.sessionUsageArchiveEnabled !== false) {
    try {
      // Required here rather than at module scope, like the Proma and Claude
      // Desktop adapters below: the archive is only touched by a range answer, and
      // the Hub bundles this file for a path it never runs itself (its own ranges
      // come from stored events). The new edge is declared in
      // `scripts/hub-build-manifest.js`, which pins the Hub's dependency closure.
      const archiveModule = require('./sessionUsageArchive');
      const readArchive = options.readSessionUsageArchive || archiveModule.readSessionUsageArchive;
      const archive = options.sessionUsageArchive || readArchive({ env: options.env || process.env });
      archiveModule.applySessionUsageArchiveRange(period, archive, range);
    } catch (error) {
      if (typeof options.logger === 'function') options.logger(`session archive range restore failed: ${error.message}`);
    }
  }

  // Running distros answer a calendar window exactly as they answer the fixed
  // periods. Skipping this made 昨日 / 本周 / any custom range read lower than
  // 今日 / 本月 / 全部 on a Windows host whose work happens in WSL — the same
  // day measured twice and reported as one number.
  if (normalizedClients && options.wslScanEnabled !== false) {
    const collectWslRange = options.collectWslRangeUsage || collectWslRangeUsageImpl;
    try {
      const wslPeriod = await collectWslRange({
        clients: tokscaleClients,
        trackedClients: normalizedClients,
        range,
        now: new Date(),
        commandTimeoutMs,
        runTokscale: runTokscaleFn,
        logger: options.logger,
        decoratePeriods: (periods, home) => applySessionTimestamps(periods, home, {
          scopedHome: true,
          resolveProjects: projectsEnabled
        }),
        promaRangePeriod: async (rows) => {
          const { buildTokscaleJson } = require('./promaUsage');
          const pricingByModel = await resolvePromaPricing(rows, {
            lookupModelPricing: options.lookupModelPricing,
            commandTimeoutMs: options.pricingTimeoutMs
              ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
            pricingRevision: options.pricingRevision
          });
          return extractUsageFromTokscale(buildTokscaleJson({}, { rows, pricingByModel }));
        }
      });
      period = mergePeriods(period, wslPeriod);
    } catch (error) {
      // A failed WSL pass must not void the host answer, exactly as in the
      // period scan — but say so, because the range is now knowingly partial.
      if (typeof options.logger === 'function') options.logger(`wsl custom-range scan failed: ${error.message}`);
    }
  }

  period = filterPeriodByCustomRange(period, range, { projectsEnabled });
  return {
    range: {
      startDate: range.startDate,
      endDate: range.endDate,
      startHour: range.startHour,
      endHour: range.endHour,
      startMs: range.startMs,
      endMs: range.endMs,
      since: range.since,
      until: range.until,
      isSameDay: range.isSameDay,
      coversFullDays: range.coversFullDays
    },
    period,
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  terminateChild,
  abandonChildStreams,
  applySessionTimestamps,
  projectIdentity,
  projectPathFromJsonl,
  collectHistoryOnce,
  collectUsageOnce,
  collectCustomRangeOnce,
  clientDataDirPresence,
  clientDiagnosticRoots,
  visibleDiagnosticRoots,
  clientSourceChecks,
  clientSourceRoots,
  clientsForWatchPath,
  clientWatchCandidates,
  computePeriodWindows,
  collectorAnchorTrust,
  configFingerprint,
  enabledQoderClientIds,
  qoderDbPathsForClients,
  qoderSourceFingerprintForClients,
  deriveClientStatus,
  selfSyncSourceRootsForClients,
  watchAttributionRootsForClients,
  wslPeriodsForPreview,
  statusFromSignals,
  decideResolver,
  DEFAULT_HISTORY_INTERVAL_MS,
  HISTORY_INTERVAL_VALUES,
  LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
  localTodayKey,
  nextLimitsResetBoundary,
  normalizeHistoryIntervalMs,
  sessionTimestampMap,
  locateBundledBinary,
  lookupModelPricing,
  normalizePromaPricing,
  pruneAttemptedResetBoundaries,
  readDownloadedPointer,
  resolvePlatformBinary,
  resolvePromaPricing,
  readTokscalePricingCatalog,
  resetTokscaleCatalogCache,
  tokscalePricingCatalog,
  resetPromaPricingCache,
  resolveWatchUsePolling,
  selfSyncThrottle,
  isQoderSelfWatchEvent,
  shouldIncludeHistory,
  startCollector,
  TOKSCALE_CLIENT_ALIASES,
  normalizeGraphClientIds,
  tokscaleClientFilter,
  tokscaleCommand,
  tokscaleEnvironment,
  watcherOptions,
  watchIgnoreMatcher,
  watchPathsForClients
};
