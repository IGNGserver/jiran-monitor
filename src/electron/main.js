'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, powerMonitor, screen, session, shell } = require('electron');
// The native downloader is needed only after the user requests an update.
let autoUpdater;
const { defaultDeviceId, loadDotEnv, parseBoolean, pidFileCandidates, sharedDataDir, normalizeHubUrl } = require('../shared/config');
const {
  CredentialStore,
  credentialSettingsForRenderer,
  hasCredentialSettings,
  persistSettingsAndCredentials,
  stripCredentialSettings,
  writePrivateJsonAtomic
} = require('../shared/credentialStore');
const { installSafeStdout } = require('../shared/safeStdio');
// Only the staging-dir cleanup is still wired: the manual npm check / download / reset
// actions left with the settings surface that had no buttons for them.
const { cleanupStaleStaging } = require('../shared/tokscaleUpdater');
const { appVersion } = require('../shared/appVersion');
const motionPreferenceApi = require('./motionPreference');

// Install EPIPE suppression before anything that might log. Without this,
// a closed parent pipe turns the next log call into an unhandled 'error'
// event and Electron pops a "JavaScript error in the main process" dialog.
installSafeStdout();
const {
  TRACKED_CLIENTS
} = require('../shared/clientTracking');
const { collectCustomRangeOnce, lookupModelPricing } = require('../shared/collector');
const { createDeviceRuntime } = require('../shared/deviceRuntime');
const { createRequestRouter } = require('./desktopRequestRouter');
const {
  normalizeInitialRendererViewState,
  initialRendererViewStateQuery
} = require('./viewState');
const { createAppMenu } = require('./appMenu');
const { createApplicationTray, TRAY_ICON_PATH } = require('./tray');
const { requireSafeHubTransport } = require('../shared/hubTransport');
const { isAllowedCodexLoginUrl } = require('../shared/codexLogin');
const { isAllowedVerificationUrl } = require('../shared/copilotDeviceFlow');
// The native menu, tray and dialogs localize from the same catalog the shared UI
// renders. The main process used to keep its own copy, which silently lost every
// `menu.*`/`nav.*` string the redesign added. The catalog is an ES module; Node
// 22.12+ (and therefore Electron's bundled Node) requires it directly.
const { SUPPORTED_LOCALES, resolveLocale, t: translate } = require('../shared-ui/core/i18n.js');
// Same formatter the dashboard uses, so the tray tooltip never disagrees with it.
const { formatCompact: formatCompactTokens } = require('../shared-ui/core/format.js');

const {
  appUpdateInstallSupport,
  checkLatestRelease,
  deriveAppUpdateAvailability,
  downloadedAppUpdateMatchesLatest,
  GITHUB_REPO,
  installFailureErrorKind,
  mergeLatestReleaseMetadata,
  shouldSkipAppUpdateCheck,
  updateInstallQuitPolicy
} = require('../shared/appUpdater');
const semver = require('semver');
const { normalizeCurrency, resolveEffectiveRates, configureRates } = require('../shared/currency');
const { fetchRates, isCacheStale } = require('../shared/exchangeRates');
const { aggregateDevices, aggregateHistory } = require('../shared/usage');
const { fetchBufferedWithTimeout, fetchWithTimeout } = require('../shared/http');
const { postSyncPayload } = require('../shared/syncPayload');
const { renameDeviceOnHub, readDeviceIdentity, writeDeviceIdentity } = require('../shared/deviceIdentity');
// Collection cadence is no longer configurable — see src/shared/collectorConfig.js.
const { createSyncUploadSink } = require('../shared/syncUploadSink');
const { createSyncSummaryTransformer } = require('../shared/syncSummary');
const { learnFleetTimeZone, normalizeTimeZone, resolveFleetTimeZone } = require('../shared/fleetTimeZone');
const { mergedLocalAllTimeSessions } = require('../shared/localSessions');
const { historyPreview, historyRevision } = require('../shared/history');
const { readSessionDetail } = require('../shared/sessionDetail');
const linuxAutostart = require('./linuxAutostart');
const { classifyStreamFailure } = require('./syncConnection');
const { composeLocalSyncStats, reattachLocalNativeView } = require('./syncDisplayStats');
const {
  cacheable: cacheableDesktopSnapshot,
  emptyDesktopSnapshotCache,
  readDesktopSnapshotCache,
  writeDesktopSnapshotCache
} = require('./desktopSnapshotCache');
const { normalizeSyncUploadIntervalMs } = require('../shared/syncUploadScheduler');
const { createUpdateInstallQuitGuard, observeUpdateInstallHandoff } = require('./updateInstallQuit');
const {
  classifySettingsChange,
  envelopeFromSettings,
  usageConfigFromSettings
} = require('./runtimeConfig');
const { runManualDeviceRefresh } = require('./deviceRuntimeCoordinator');
const { applyWindowsChrome } = require('./windowsChrome');
const { applyWindowsAccentBlur } = require('./windowsBackdrop');
const { applyMacosNativeWindowButtons } = require('./macosWindowChrome');
const {
  normalizeWindowsBackdropMode,
  windowsSurfaceProfile
} = require('./windowsBackdropMode');
const {
  MACOS_GLASS_VIBRANCY,
  MACOS_GLASS_LIQUID,
  normalizeMacosGlassStyle,
  effectiveMacosGlassStyle,
  macosLiquidGlassAvailable
} = require('./macosGlassMode');
const {
  applyMacosGlass,
  clearMacosGlass,
  macosLiquidGlassSupported
} = require('./macosGlassNative');
const { configureLinuxDisplayBackend } = require('./linuxDisplay');
const { migrateLegacyUserData } = require('./userDataMigration');
const { migrateLegacySharedData } = require('../shared/sharedDataMigration');

if (!app.isPackaged) loadDotEnv();
configureLinuxDisplayBackend({ app, platform: process.platform, env: process.env, argv: process.argv });

const APP_NAME = 'Jiran';
// Install/directory identity (userData anchor); the user-visible name is
// localized through the `brand.name` i18n key — zh shows 计然.
// Release pages for the current repo plus the pre-rename `token-monitor-suite`,
// so cached updater metadata and in-app links keep working across the 计然 migration.
const RELEASE_URL_PREFIXES = [
  'https://github.com/IGNGserver/jiran/releases/',
  'https://github.com/IGNGserver/token-monitor-suite/releases/'
];
const WIN_ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icons', 'icon.ico');
const PNG_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const APP_ICON_PATH = process.platform === 'win32' && fs.existsSync(WIN_ICON_PATH)
  ? WIN_ICON_PATH
  : PNG_ICON_PATH;

// A normal desktop window: big enough that the shared UI's sidebar layout has
// room (its narrowest breakpoint is 860px), with a floor the user cannot drag
// under and a ceiling that still leaves the desktop usable.
const DEFAULT_WINDOW = { width: 1180, height: 780 };
const WINDOW_LIMITS = { minWidth: 900, minHeight: 600, maxWidth: 2560, maxHeight: 1600 };
const ZOOM_LIMITS = { min: 0.7, max: 1.6, step: 0.1 };
// The shared UI is also served to browsers by the Hub, where its CSP allows
// inline styles because the view templates carry per-row colours and bar widths
// as `style` attributes. The desktop renderer loads the same code, so
// `style-src` must match or every bar, swatch and share meter renders unstyled.
// `script-src` deliberately stays strict: no inline script is used anywhere.
// `img-src` gains `file:` because the packaged client icons resolve from the
// app's asset tree rather than an HTTP route.
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: file:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');
const HUB_MODE_VALUES = new Set(['local', 'client']);
const LANGUAGE_VALUES = new Set(['auto', ...SUPPORTED_LOCALES]);
const HUB_REQUEST_TIMEOUT_MS = 15 * 1000;
// Deliberate: the desktop app reaches the Hub and the rate source with the plain
// runtime fetch, i.e. it does NOT follow HTTP(S)_PROXY. The operator decision was
// that a workstation's proxy must not silently become the sync path; only the
// per-provider quota collectors (shared/outboundFetch) honour proxy env today.
// The Docker Hub emits a heartbeat every 30 seconds by default. Allow two
// missed beats before treating a half-open stream as disconnected.
const SSE_IDLE_TIMEOUT_MS = 90 * 1000;
const SSE_RETRY_BASE_MS = 1000;
const SSE_RETRY_MAX_MS = 30 * 1000;
const SYNC_REST_POLL_MS = 60 * 1000;
const SYNC_RECOVERY_TIMEOUT_MS = 20 * 1000;
// View ids the shared UI knows; the app menu navigates by these. `accounts` and
// `management` stay accepted because they are still reachable from persisted
// view state and older native calls — the renderer redirects both to `settings`.
const SHARED_UI_VIEW_IDS = new Set(['overview', 'usage', 'devices', 'limits', 'trends', 'accounts', 'management', 'settings']);

let mainWindow = null;
let applicationTray = null;
let refreshApplicationTrayMenu = () => {};
let settingsPath = null;
let settings = null;
let persistedSettingsSnapshot = null;
let credentialStore = null;
let credentialStorageErrorShown = false;
let deviceIdentity = null;
let rendererViewState = normalizeInitialRendererViewState();
let initialWindowCreated = false;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.igng.tokenmonitor');
// 计然 / Jiran rename: Electron derives userData from app.getName(), so the profile must be
// carried over from the legacy `Token Monitor` folder before anything reads it.
migrateLegacyUserData({ appDataDir: app.getPath('appData'), appName: APP_NAME });
// Same directory-name change applies to the shared runtime state (device identity,
// archives, tokscale cache): merge the legacy folder forward before any read/write.
migrateLegacySharedData();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

const HOME_LIMIT_ACCOUNT_COUNT_DEFAULT = 3;
const HOME_LIMIT_ACCOUNT_COUNT_MAX = 12;
// Runtime state the main process owns. The renderer neither reads them nor may
// write them: a stray write would silently discard a restored window or an
// update decision. tests/electron/settingsMigration.test.js pins both halves.
const INTERNAL_ONLY_SETTING_KEYS = Object.freeze([
  'windowBounds', 'lastViewState', 'lastPostedDeviceId', 'appUpdate'
]);

const LEGACY_LOCAL_LIMIT_SETTING_KEYS = Object.freeze([
  'claudeWebCookie',
  'opencodeCookie',
  'opencodeProfiles',
  'openrouterProfiles',
  'deepseekApiKey',
  'minimaxApiKey',
  'copilotApiToken',
  'copilotEnterpriseHost',
  'zaiApiKey',
  'zaiTeamApiKey',
  'zaiTeamOrganizationId',
  'zaiTeamProjectId',
  'volcengineAccessKeyId',
  'volcengineSecretAccessKey',
  'volcengineRegion',
  'qoderCookie',
  'qoderSite',
  'qoderCookieMode',
  'cursorManualAccountConfigured',
  'kimiApiKey',
  'kimiWebAccessToken',
  'ollamaCookie',
  'codexManagedAccounts',
  'mimoManagedAccounts'
]);

// Keys that no longer have any surface to write them. A retired key must be
// dropped on the way IN (settings.json) and on the way BACK (an IPC patch from an
// old renderer or preload), or it silently keeps shaping runtime behaviour.
const RETIRED_SETTING_KEYS = Object.freeze([
  // Window/widget era.
  'windowBehavior', 'alwaysOnTop', 'floatingBubbleEnabled', 'floatingBubbleTrigger',
  'floatingBubbleContent', 'floatingBubbleCustomLayout', 'floatingBubbleBounds', 'showTrayIcon',
  'trayMode', 'startInTray', 'trayContent', 'trayCustomLayout',
  'showTrayProviderBadge', 'windowToggleShortcut', 'edgeDrawerEnabled',
  // Device-side quota probing: the Hub owns accounts and publishes the limits.
  'limitsEnabled', 'limitProviders',
  // The retired service-status panel.
  'serviceProviderDisplayOrder', 'hiddenServiceProviders', 'serviceStatusRefreshMs',
  // Borderless-widget geometry and the pre-SSE local poll cadence.
  'refreshMs', 'glassOpacity', 'glassBlur',
  // Client selection: every wired harness is tracked, so a persisted subset (and
  // its migration marker) must not linger, and neither may the tool-list display
  // preferences or the untracked-client usage archive that fed them.
  'clients', 'migratedDefaultClients',
  'clientDisplayOrder', 'hiddenClients', 'pinnedClients', 'archivedClientUsage',
  // Collection cadence: fixed by src/shared/collectorConfig.js now, so no
  // settings.json value or IPC patch may narrow what is collected.
  'projectsEnabled', 'historyEnabled', 'historyIntervalMs',
  'sessionUsageArchiveEnabled', 'wslScanEnabled', 'allTimeSince',
  'collectionMode', 'collectionIntervalMs', 'watchEnabled', 'watchDebounceMs',
  'syncUploadIntervalMs',
  // Features retired together with the settings surface that reached them.
  'discordRpcEnabled', 'exportAutoEnabled', 'exportDir', 'exportIntervalMs',
  'customModelPricing', 'automaticAppUpdates',
  // Display / ordering preferences no view reads any more.
  'viewDisplayOrder', 'hiddenViews', 'homeModuleOrder', 'hiddenHomeModules',
  'themeColors', 'vendorColors', 'showLiveDot', 'showToolIcons', 'titleIconOnly',
  'showCompactTotalTokens', 'showHomeLimitBars', 'showHomeLimitProviderNames',
  'showLimitSource', 'showLimitUsed', 'maskLimitAccountEmails',
  'limitProviderOrder', 'homeLimitProviderOrder', 'hiddenHomeLimitProviders'
]);

const UI_FLAG_PREFIX = 'token-monitor.';
function isUiFlagKey(key) {
  return String(key || '').startsWith(UI_FLAG_PREFIX);
}

function withoutInternalOnlyKeys(value) {
  const clean = { ...(value || {}) };
  for (const key of INTERNAL_ONLY_SETTING_KEYS) delete clean[key];
  return clean;
}

function withoutRetiredKeys(value) {
  const clean = { ...(value || {}) };
  for (const key of RETIRED_SETTING_KEYS) delete clean[key];
  return clean;
}

function stripLegacyLocalLimitSettings(value) {
  const clean = { ...(value || {}) };
  for (const key of LEGACY_LOCAL_LIMIT_SETTING_KEYS) delete clean[key];
  return clean;
}

function hasLegacyLocalLimitSettings(value) {
  return LEGACY_LOCAL_LIMIT_SETTING_KEYS.some((key) => Object.hasOwn(value || {}, key));
}

function normalizeHomeLimitAccountCount(value) {
  const count = Math.trunc(Number(value));
  if (!Number.isFinite(count)) return HOME_LIMIT_ACCOUNT_COUNT_DEFAULT;
  return Math.max(1, Math.min(HOME_LIMIT_ACCOUNT_COUNT_MAX, count));
}

function defaultSettings() {
  const envHubUrl = normalizeHubUrl(process.env.TOKEN_MONITOR_HUB_URL || '');
  return {
    // Connection (the settings page's 连接 group).
    hubMode: envHubUrl ? 'client' : 'local',
    hubUrl: envHubUrl,
    secret: process.env.TOKEN_MONITOR_SECRET || '',
    allowInsecureHubHttp: parseBoolean(process.env.TOKEN_MONITOR_ALLOW_INSECURE_HTTP, false),
    // Keep the configured value empty when no explicit ID was supplied. The
    // hostname remains the runtime fallback when the usage envelope is built,
    // which lets the settings UI show its placeholder instead of persisting a
    // value the user never chose.
    deviceId: normalizeDeviceIdValue(process.env.TOKEN_MONITOR_DEVICE_ID, ''),
    // Display (the settings page's 显示 group) plus the browser preferences the
    // shared UI persists through its prefs channel.
    theme: 'system',
    systemGlass: true,
    macosGlassStyle: macosLiquidGlassAvailable({ platform: process.platform, osRelease: os.release() })
      ? MACOS_GLASS_LIQUID
      : MACOS_GLASS_VIBRANCY,
    windowsBackdrop: 'mica',
    reduceMotion: 'system',
    language: 'auto',
    currency: normalizeCurrency(process.env.TOKEN_MONITOR_CURRENCY || 'USD'),
    currencyRates: {},
    heatmapMetric: 'cost',
    homeActiveDaysWindow: 'all',
    homeLimitAccountCount: HOME_LIMIT_ACCOUNT_COUNT_DEFAULT,
    // Behaviour (the settings page's 行为 group) and the tray's pause switch.
    startAtLogin: false,
    closeToTray: parseBoolean(process.env.TOKEN_MONITOR_CLOSE_TO_TRAY, true),
    startHidden: parseBoolean(process.env.TOKEN_MONITOR_START_HIDDEN, true),
    collectionPaused: parseBoolean(process.env.TOKEN_MONITOR_COLLECTION_PAUSED, false),
    // Main-process-owned runtime state, never offered to the renderer.
    windowBounds: null,
    lastViewState: { period: 'today', breakdown: 'tool' },
    lastPostedDeviceId: '',
    zoomFactor: 1,
    appUpdate: {
      lastCheckedAt: null,
      lastKnownLatest: null,
      dismissedVersion: null
    }
  };
}



function normalizeHeatmapMetric(value, fallback = 'cost') {  const next = String(value || '').trim();
  if (next === 'tokens' || next === 'cost') return next;
  return fallback === 'tokens' ? 'tokens' : 'cost';
}

function normalizeHomeActiveDaysWindow(value, fallback = 'all') {
  const next = String(value || '').trim();
  if (next === 'year') return 'year';
  if (next === 'all') return 'all';
  return fallback === 'year' ? 'year' : 'all';
}

const THEME_VALUES = new Set(['system', 'light', 'dark']);
function normalizeThemeChoice(value, fallback = 'system') {
  const raw = String(value || '').trim().toLowerCase();
  if (THEME_VALUES.has(raw)) return raw;
  return THEME_VALUES.has(fallback) ? fallback : 'system';
}


// The device id is the Hub's row key and part of local file names, so only
// path/URL-unsafe characters are replaced. Case is preserved deliberately:
// rewriting "Work-PC" to "work-pc" would register a second device upstream.
function normalizeDeviceIdValue(value, fallback = '') {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || fallback;
}





function electronUsageConfig(errorPrefix) {
  return usageConfigFromSettings(settings, {
    agentVersion: appVersion(),
    agentRuntime: 'electron-widget',
    commandTimeoutMs: 120 * 1000,
    defaultDeviceId: defaultDeviceId(),
    dailyHistoryArchiveWriteEnabled: () => !isExternalAgentActive(),
    onError: (error, reason) => console.log(`[${errorPrefix}] ${reason}: ${error.message}`),
    logger: (message) => console.log(`[${errorPrefix}] ${message}`)
  });
}


function electronDeviceEnvelope() {
  return envelopeFromSettings(settings, {
    defaultDeviceId: defaultDeviceId(),
    agentVersion: appVersion(),
    agentRuntime: 'electron-widget'
  });
}








function normalizeHubMode(value, fallback = 'local') {
  const next = String(value || '').trim();
  const safeFallback = HUB_MODE_VALUES.has(fallback) ? fallback : 'local';
  return HUB_MODE_VALUES.has(next) ? next : safeFallback;
}

function normalizeLanguageSetting(value, fallback = 'auto') {
  const raw = String(value || '').replace(/_/g, '-').trim();
  const lower = raw.toLowerCase();
  if (lower === 'auto') return 'auto';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  if (lower === 'zh-tw' || lower.startsWith('zh-hant') || /-(tw|hk|mo)\b/i.test(raw)) return 'zh-TW';
  if (lower === 'zh-cn' || lower.startsWith('zh-hans') || /-(cn|sg|my)\b/i.test(raw)) return 'zh-CN';
  return LANGUAGE_VALUES.has(raw) ? raw : fallback;
}

function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, Number(n.toFixed(2))));
}

function isBoundsOnScreen(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  try {
    const display = screen.getDisplayMatching({
      x: bounds.x, y: bounds.y, width: bounds.width || 1, height: bounds.height || 1
    });
    const wa = display.workArea;
    return bounds.x + bounds.width > wa.x &&
      bounds.x < wa.x + wa.width &&
      bounds.y + bounds.height > wa.y &&
      bounds.y < wa.y + wa.height;
  } catch (_) { return false; }
}

function restoredBounds() {
  const saved = settings?.windowBounds;
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return null;
  const width = Math.min(WINDOW_LIMITS.maxWidth, Math.max(WINDOW_LIMITS.minWidth, saved.width));
  const height = Math.min(WINDOW_LIMITS.maxHeight, Math.max(WINDOW_LIMITS.minHeight, saved.height));
  if (!isBoundsOnScreen({ ...saved, width, height })) return { width, height };
  return { x: saved.x, y: saved.y, width, height };
}

let persistBoundsTimer = null;

function stopPersistBoundsTimer() {
  if (persistBoundsTimer) clearTimeout(persistBoundsTimer);
  persistBoundsTimer = null;
}


// Load settings once and, on that first load, seed the in-memory view state
// from the persisted snapshot so a cold start reopens the last-used view.
function ensureSettingsLoaded() {
  if (settings) return settings;
  settings = readSettings();
  ensureDesktopSnapshotCacheLoaded();
  ensureDeviceIdentityLoaded();
  // Bare hub host/IP defaults to http://
  {
    const normalizedHubUrl = normalizeHubUrl(settings.hubUrl);
    if (normalizedHubUrl !== (settings.hubUrl || '')) {
      settings.hubUrl = normalizedHubUrl;
      saveSettings();
    }
  }
  // Discard cached release metadata from older builds that queried upstream.
  // The pre-rename repo stays valid: GitHub 301-redirects it, and cached records
  // were written with the old htmlUrl before IGNGserver/jiran existed.
  if (settings.appUpdate?.lastKnownLatest?.htmlUrl && !RELEASE_URL_PREFIXES.some((prefix) => settings.appUpdate.lastKnownLatest.htmlUrl.startsWith(prefix))) {
    settings.appUpdate = { ...settings.appUpdate, lastKnownLatest: null, lastCheckedAt: null, dismissedVersion: null };
    saveSettings();
  }
  persistedSettingsSnapshot = cloneSettingsSnapshot(settings);
  rendererViewState = normalizeInitialRendererViewState(settings.lastViewState, rendererViewState);
  return settings;
}

function updateRendererViewState(patch) {
  const previous = rendererViewState;
  rendererViewState = normalizeInitialRendererViewState({
    ...rendererViewState,
    ...(patch || {})
  }, rendererViewState);
  const changed = previous.period !== rendererViewState.period
    || previous.breakdown !== rendererViewState.breakdown;
  if (changed && settings) {
    settings.lastViewState = { ...rendererViewState };
    saveSettings();
  }
  return rendererViewState;
}














function persistBoundsSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  stopPersistBoundsTimer();
  persistBoundsTimer = setTimeout(() => {
    persistBoundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const next = mainWindow.getBounds();
    const prev = settings.windowBounds || {};
    // A normal window keeps its position and size across restarts.
    if (prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) return;
    settings.windowBounds = { x: next.x, y: next.y, width: next.width, height: next.height };
    try {
      saveSettings();
    } catch (error) {
      console.log(`[window] could not persist bounds: ${error.message}`);
    }
  }, 300);
}

function applyZoomFactor(target = mainWindow) {
  if (!target || target.isDestroyed()) return;
  target.webContents.setZoomFactor(clampZoom(settings.zoomFactor));
}

function setZoomFactor(value) {
  const next = clampZoom(value);
  if (next === clampZoom(settings.zoomFactor)) return;
  settings.zoomFactor = next;
  saveSettings();
  applyZoomFactor();
}

function adjustZoom(delta) {
  setZoomFactor(clampZoom(settings.zoomFactor) + delta);
}

function normalizeCurrencyOverrides(value) {
  const out = {};
  if (value && typeof value === 'object') {
    for (const [code, raw] of Object.entries(value)) {
      const key = normalizeCurrency(code, '');
      const num = Number(raw);
      // normalizeCurrency falls back to 'USD' for unknown codes; excluding 'USD'
      // drops both unknown codes and any attempt to override the USD base (always 1).
      if (key !== 'USD' && Number.isFinite(num) && num > 0) out[key] = num;
    }
  }
  return out;
}

function ensureCredentialStore() {
  if (!credentialStore) credentialStore = new CredentialStore(app.getPath('userData'));
  return credentialStore;
}

function reportCredentialStorageError(context, error) {
  const detail = error?.message || String(error || 'Unknown error');
  console.error(`[credentials] ${context}: ${detail}`);
  if (credentialStorageErrorShown || !app.isReady()) return;
  credentialStorageErrorShown = true;
  try {
    dialog.showErrorBox(
      'Credential storage error',
      `${nativeShellText('brand.name')} could not safely access credentials.json (${context}). The save was stopped and previous data was restored where possible. Check the file's JSON and permissions, then restart the app.\n\n${detail}`
    );
  } catch (_) {}
}

function loadCredentialSettings(saved) {
  try {
    const store = ensureCredentialStore();
    store.migrateLegacySettings(saved);
    store.clearRemovedHubCredentials();
    store.clearLegacyLocalLimitCredentials();
    const stored = store.settingsCredentials();
    // Cleanup is intentionally independent from the migration marker. If the
    // first cleanup write fails after credentials.json was committed, retry on
    // every startup until no credential keys remain in settings.json.
    if (hasCredentialSettings(saved)) {
      try {
        writePrivateJsonAtomic(settingsPath, stripCredentialSettings(saved));
      } catch (error) {
        reportCredentialStorageError('could not remove migrated credentials from settings.json', error);
      }
    }
    return stored;
  } catch (error) {
    reportCredentialStorageError('could not load credentials.json', error);
    return {};
  }
}

function invalidateLegacyLocalLimitCredentialFiles() {
  const legacyPaths = [
    path.join(app.getPath('userData'), 'mimo-credentials'),
    path.join(app.getPath('userData'), 'managed-codex-homes')
  ];
  for (const legacyPath of legacyPaths) {
    try {
      fs.rmSync(legacyPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[credentials] Could not remove legacy local credential path ${legacyPath}: ${error.message}`);
    }
  }
}

function sanitizeSavedSettings(saved) {
  const sanitized = stripLegacyLocalLimitSettings(saved);
  if (hasLegacyLocalLimitSettings(saved)) {
    try {
      writePrivateJsonAtomic(settingsPath, stripCredentialSettings(sanitized));
    } catch (error) {
      reportCredentialStorageError('could not remove legacy local account settings', error);
    }
  }
  return sanitized;
}

function invalidateLegacyLocalLimitData() {
  try {
    ensureCredentialStore().clearLegacyLocalLimitCredentials();
  } catch (error) {
    reportCredentialStorageError('could not invalidate legacy local credentials', error);
  }
  invalidateLegacyLocalLimitCredentialFiles();
}

function readSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const defaults = defaultSettings();
    let saved = {};
    try {
      const loaded = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      saved = !loaded || typeof loaded !== 'object' || Array.isArray(loaded) ? {} : loaded;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[settings] Could not load settings.json: ${error.message}`);
    }
    if (process.platform !== 'win32') {
      try {
        const stat = fs.lstatSync(settingsPath);
        if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(settingsPath, 0o600);
      } catch (_) {}
    }
    const rawSaved = saved;
    saved = sanitizeSavedSettings(rawSaved);
    const storedCredentials = loadCredentialSettings(saved);
    if (!saved.secret && defaults.secret) delete saved.secret;
    const merged = { ...defaults, ...saved, ...storedCredentials };
    // Migrate older configs that predate hubMode: infer from hubUrl. Legacy
    // Host mode is intentionally mapped to local because the app no longer
    // embeds or exposes a Hub server.
    if (saved.hubMode === undefined) {
      merged.hubMode = (saved.hubUrl && String(saved.hubUrl).trim()) ? 'client' : 'local';
    }
    if (String(merged.hubMode || '').trim() === 'host') merged.hubMode = 'local';
    delete merged.hubHostPort;
    delete merged.hubHostSecret;
    delete merged.hubHostAdminSecret;
    delete merged.hubAccountCredentialKey;
    merged.homeLimitAccountCount = normalizeHomeLimitAccountCount(merged.homeLimitAccountCount);
    merged.heatmapMetric = normalizeHeatmapMetric(merged.heatmapMetric);
    merged.homeActiveDaysWindow = normalizeHomeActiveDaysWindow(merged.homeActiveDaysWindow);
    merged.reduceMotion = motionPreferenceApi.normalize(merged.reduceMotion);
    // A desktop build before this normalization persisted the glass switch as the
    // string 'off', which every consumer reads as "glass on" (`=== false`).
    merged.systemGlass = parseBoolean(merged.systemGlass, true);
    merged.theme = normalizeThemeChoice(merged.theme);
    merged.deviceId = normalizeDeviceIdValue(merged.deviceId, '');
    merged.windowsBackdrop = normalizeWindowsBackdropMode(merged.windowsBackdrop);
    merged.macosGlassStyle = normalizeMacosGlassStyle(merged.macosGlassStyle);
    merged.collectionPaused = parseBoolean(merged.collectionPaused, false);
    merged.closeToTray = parseBoolean(merged.closeToTray, true);
    merged.startHidden = parseBoolean(merged.startHidden, true);
    if (saved.lastViewState !== undefined) {
      merged.lastViewState = normalizeInitialRendererViewState(saved.lastViewState);
    }
    merged.hubMode = normalizeHubMode(merged.hubMode);
    merged.language = normalizeLanguageSetting(merged.language);
    merged.currency = normalizeCurrency(merged.currency);
    merged.currencyRates = normalizeCurrencyOverrides(merged.currencyRates);
    delete merged.hubAdminSecret;
    merged.allowInsecureHubHttp = parseBoolean(merged.allowInsecureHubHttp, false);
    // Retired keys are dropped rather than migrated: nothing reads them now, and
    // leaving them in settings.json would imply they still do something — most
    // importantly a stale collector-cadence or client-selection value that would
    // otherwise keep narrowing collection behind a UI that cannot show it.
    invalidateLegacyLocalLimitData();
    // Retired keys are dropped rather than migrated: nothing reads them now, and
    // leaving them in settings.json would imply they still do something — most
    // importantly a stale collector-cadence or client-selection value that would
    // otherwise keep narrowing collection behind a UI that cannot show it.
    return withoutRetiredKeys(merged);
  }
  catch (_error) {
    return defaultSettings();
  }
}

function cloneSettingsSnapshot(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function saveSettings(options = {}) {
  const previousSettings = cloneSettingsSnapshot(persistedSettingsSnapshot || settings);
  try {
    persistSettingsAndCredentials({
      store: ensureCredentialStore(),
      settingsPath,
      settings,
      previousSettings
    });
    persistedSettingsSnapshot = cloneSettingsSnapshot(settings);
    return true;
  } catch (error) {
    settings = previousSettings;
    reportCredentialStorageError('could not persist settings', error);
    if (options.throwOnError) throw error;
    return false;
  }
}

function linuxAutostartOptions() {
  // AppImage exposes a stable image path through APPIMAGE. Native packages
  // such as .deb do not, so use Electron's installed executable path instead
  // of process.execPath when available (the latter can be a transient AppImage
  // mount path during startup).
  if (process.platform !== 'linux') return {};
  const appImagePath = String(process.env.APPIMAGE || '').trim();
  if (appImagePath) return { appPath: appImagePath };
  try {
    const executablePath = String(app.getPath('exe') || '').trim();
    if (executablePath) return { appPath: executablePath };
  } catch (_) { /* app.getPath('exe') may be unavailable before ready */ }
  return { appPath: process.execPath };
}

// A login-item launch carries this argument so the window stays in the tray; it is
// deliberately separate from the retired `--started-at-login` marker, which is only
// recognised on read for entries older builds left behind.
const HIDDEN_LAUNCH_ARG = '--hidden';

function hiddenLaunchRequested() {
  return process.argv.includes(HIDDEN_LAUNCH_ARG);
}

function loginItemEnabledHere() {
  if (!app.isPackaged) return false;
  // Electron login items only cover macOS/Windows; on Linux we manage an XDG
  // autostart entry ourselves. AppImage and native package builds use
  // different executable-path sources.
  if (process.platform === 'linux') return linuxAutostart.autostartSupported(linuxAutostartOptions());
  return true;
}

function currentLoginItemState() {
  if (!loginItemEnabledHere()) return false;
  if (process.platform === 'linux') return linuxAutostart.isAutostartEnabled(linuxAutostartOptions());
  try { return Boolean(app.getLoginItemSettings().openAtLogin); }
  catch (_) { return false; }
}

function electronLoginItemPath() {
  try {
    const executablePath = String(app.getPath('exe') || '').trim();
    if (executablePath) return executablePath;
  } catch (_) { /* app.getPath('exe') may be unavailable before ready */ }
  return String(process.execPath || '').trim();
}

function applyLoginItem(startAtLogin) {
  if (!loginItemEnabledHere()) return false;
  if (process.platform === 'linux') {
    return linuxAutostart.setAutostartEnabled(Boolean(startAtLogin), {
      ...linuxAutostartOptions(),
      hidden: Boolean(startAtLogin && settings.startHidden !== false)
    });
  }
  // `openAsHidden` is macOS-only; Windows takes the launch argument instead. Both
  // mean "a sign-in launch stays in the tray", which is the default the product
  // wants, while a double-click from the icon still shows the window.
  const executablePath = electronLoginItemPath();
  app.setLoginItemSettings({
    openAtLogin: Boolean(startAtLogin),
    ...(executablePath ? { path: executablePath } : {}),
    ...(process.platform === 'darwin'
      ? { openAsHidden: Boolean(startAtLogin && settings.startHidden !== false) }
      : { args: startAtLogin && settings.startHidden !== false ? [HIDDEN_LAUNCH_ARG] : [] })
  });
  return currentLoginItemState();
}

function syncLoginItemSettingFromOs() {
  if (!settings) return;
  const actual = currentLoginItemState();
  if (settings.startAtLogin === actual) return;
  if (settings.startAtLogin === true && actual === false) {
    // A stale registration is common after a portable/installed executable is
    // moved or upgraded. Repair it against the current executable path, but do
    // not erase the user's requested state merely because the OS read-back was
    // temporarily false.
    const repaired = applyLoginItem(true);
    if (repaired === true) return;
    console.warn('[settings] login-item registration could not be confirmed; keeping the requested state');
    return;
  }
  settings.startAtLogin = actual;
  saveSettings();
}

function ensureDeviceIdentityLoaded() {
  if (deviceIdentity) return deviceIdentity;
  const shared = readDeviceIdentity();
  const legacyDeviceId = String(settings?.lastPostedDeviceId || '').trim();
  const lastPostedDeviceId = shared.lastPostedDeviceId || legacyDeviceId;
  deviceIdentity = { version: 1, lastPostedDeviceId };
  if (lastPostedDeviceId && shared.lastPostedDeviceId !== lastPostedDeviceId) {
    try { writeDeviceIdentity(lastPostedDeviceId); }
    catch (error) { console.log(`[identity] migration write failed: ${error.message}`); }
  }
  if (settings && settings.lastPostedDeviceId !== lastPostedDeviceId) {
    settings.lastPostedDeviceId = lastPostedDeviceId;
  }
  return deviceIdentity;
}

const syncSummaryTransformer = createSyncSummaryTransformer({
  canWriteSessionUsageArchive: () => !isExternalAgentActive(),
  // The archive is keyed by the active fleet calendar; the transformer resolves
  // it per transform so a zone learned from the Hub takes effect without a
  // restart (a change also drops its in-memory copy).
  timeZone: () => resolveFleetTimeZone(),
  onArchiveError: (error, operation) => console.log(`[session-archive] ${operation} failed: ${error.message}`)
});

function summaryForSync(summary, reason, meta) {
  return syncSummaryTransformer.transform(summary, reason, meta);
}



function applyWindowSettings() {
  if (!mainWindow) return;
  // A normal window has no per-setting chrome to apply: it is never always-on-top,
  // never click-through, and always focusable. Zoom is applied separately by
  // applyZoomFactor(). Kept as a named function because several settings paths
  // call it and one of them may grow a real window preference again.
  if (typeof mainWindow.setResizable === 'function') mainWindow.setResizable(true);
}

// The window surface and its caption glyphs have to equal the surface the
// stylesheet paints, not a remembered grey: these are the live token pairs
// (`--bg` light #f5f5f5 / dark #141414, `--text` #242424 / #ffffff).
const NATIVE_SURFACE = Object.freeze({
  light: { background: '#f5f5f5', glyph: '#242424' },
  dark: { background: '#141414', glyph: '#ffffff' }
});

// Setting `themeSource` first is what lets the system-drawn parts — scrollbars,
// context menus, the macOS menu bar — agree with a forced in-app theme, and it is
// also how the resolved surface below reads the user's choice back.
function resolveNativeSurface(source = settings) {
  nativeTheme.themeSource = source?.theme === 'light' || source?.theme === 'dark' ? source.theme : 'system';
  return NATIVE_SURFACE[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
}

// The Windows material follows the operator's choice, but only on builds where
// Electron can apply a background material; every caller needs the same platform
// and OS-release pair, so it is resolved here once.
function windowsSurfaceFor({ systemGlass = nativeBlurEnabled(), source = settings } = {}) {
  return windowsSurfaceProfile({
    platform: process.platform,
    osRelease: os.release(),
    systemGlass,
    backdropMode: source?.windowsBackdrop
  });
}

function windowsTitleBarOverlayOptions(source = settings) {
  const surface = resolveNativeSurface(source);
  const glass = nativeBlurEnabled(source);
  const nativeBackdrop = windowsSurfaceFor({ systemGlass: glass, source }).nativeBackdrop;
  return {
    // In native-backdrop (Mica/Acrylic) and glass mode, keeping the overlay
    // background transparent lets the window material flow behind the caption controls.
    color: (glass || nativeBackdrop) ? '#00000000' : surface.background,
    symbolColor: surface.glyph,
    height: 36
  };
}

function applyWindowsTitleBarOverlay(target = mainWindow, source = settings) {
  if (process.platform !== 'win32' || !target || target.isDestroyed?.()) return;
  if (typeof target.setTitleBarOverlay !== 'function') return;
  try { target.setTitleBarOverlay(windowsTitleBarOverlayOptions(source)); } catch (_) {}
}

// A native-backdrop window is painted by DWM, so only the flat window gets a
// solid background colour.
function applyNativeTheme(target = mainWindow, source = settings) {
  const surface = resolveNativeSurface(source);
  const glass = nativeBlurEnabled(source);
  if (target && !target.isDestroyed?.() && typeof target.setBackgroundColor === 'function') {
    if (!glass && !windowsSurfaceFor({ source }).nativeBackdrop) {
      try { target.setBackgroundColor(surface.background); } catch (_) {}
    } else {
      try { target.setBackgroundColor('#00000000'); } catch (_) {}
    }
  }
  applyWindowsTitleBarOverlay(target, source);
}

function nativeBlurEnabled(source = settings) {
  return source?.systemGlass !== false;
}

function macosGlassStyleFor(source = settings) {
  const candidate = effectiveMacosGlassStyle(source, {
    platform: process.platform,
    osRelease: os.release()
  });
  if (candidate !== MACOS_GLASS_LIQUID) return MACOS_GLASS_VIBRANCY;
  return macosLiquidGlassSupported() ? MACOS_GLASS_LIQUID : MACOS_GLASS_VIBRANCY;
}

function macosLiquidGlassIsAvailable() {
  return macosLiquidGlassAvailable({
    platform: process.platform,
    osRelease: os.release()
  }) && macosLiquidGlassSupported();
}

function keepNativeBlurActive() {
  if (!mainWindow) return;
  if (!nativeBlurEnabled()) return;
  if (
    process.platform === 'darwin'
    && macosGlassStyleFor() === MACOS_GLASS_VIBRANCY
    && typeof mainWindow.setVisualEffectState === 'function'
  ) {
    mainWindow.setVisualEffectState('active');
  }
}

function applyNativeMaterialToWindow(win, source = settings) {
  if (!win || win.isDestroyed?.()) return;
  const enabled = nativeBlurEnabled(source);
  if (process.platform === 'darwin') {
    const style = enabled ? macosGlassStyleFor(source) : null;
    if (style === MACOS_GLASS_LIQUID && applyMacosGlass(win, style)) {
      if (typeof win.setVibrancy === 'function') win.setVibrancy(null);
      if (typeof win.setVisualEffectState === 'function') win.setVisualEffectState('inactive');
      return;
    }
    clearMacosGlass(win);
    if (typeof win.setVibrancy === 'function') {
      win.setVibrancy(enabled ? 'hud' : null);
      if (typeof win.setVisualEffectState === 'function') {
        win.setVisualEffectState(enabled ? 'active' : 'inactive');
      }
    }
  }
  // Windows: backgroundMaterial is locked in at window creation. setBackgroundMaterial('none')
  // does not restore layered-window transparency once DWM SystemBackdrop has been engaged,
  // so toggling is handled by rebuildWindow() instead.
}

function applyNativeMaterial(source = settings) {
  applyNativeMaterialToWindow(mainWindow, source);
}

function withHistoryPreview(stats, devices) {
  const history = aggregateHistory(devices);
  stats.historyPreview = historyPreview(history);
  stats.historyRevision = historyRevision(history);
  return stats;
}

function desktopSnapshotCachePath() {
  return path.join(app.getPath('userData'), 'desktop-stats-cache.json');
}

function ensureDesktopSnapshotCacheLoaded() {
  if (desktopSnapshotCacheLoaded) return desktopSnapshotCache;
  desktopSnapshotCacheLoaded = true;
  desktopSnapshotCache = readDesktopSnapshotCache(desktopSnapshotCachePath()) || emptyDesktopSnapshotCache();

  // Restore only the read model. The collector still starts normally and will
  // replace these values after its first successful tick; cached records never
  // become upload credentials or a second collection lifecycle.
  if (desktopSnapshotCache.local) {
    localDevice = desktopSnapshotCache.local.device || null;
    lastCollectedDevice = localDevice;
    localStats = desktopSnapshotCache.local.stats || null;
    localStatsLive = false;
  }
  if (desktopSnapshotCache.hub) {
    latestHubStats = desktopSnapshotCache.hub.stats || null;
    latestHubStatsLive = false;
  }
  return desktopSnapshotCache;
}

function queueDesktopSnapshotCacheWrite() {
  if (desktopSnapshotCacheWriteTimer !== null) return;
  desktopSnapshotCacheWriteTimer = setTimeout(() => {
    desktopSnapshotCacheWriteTimer = null;
    try {
      ensureDesktopSnapshotCacheLoaded();
      desktopSnapshotCache = writeDesktopSnapshotCache(desktopSnapshotCachePath(), desktopSnapshotCache);
    } catch (error) {
      // Cache persistence is best effort. A permission failure must not stop
      // collection, Hub reconnect, or settings access.
      console.warn(`[snapshot-cache] write failed: ${error.message}`);
    }
  }, 250);
  desktopSnapshotCacheWriteTimer.unref?.();
}

function flushDesktopSnapshotCache() {
  if (desktopSnapshotCacheWriteTimer !== null) {
    clearTimeout(desktopSnapshotCacheWriteTimer);
    desktopSnapshotCacheWriteTimer = null;
  }
  if (!desktopSnapshotCacheLoaded || !desktopSnapshotCache) return;
  try {
    desktopSnapshotCache = writeDesktopSnapshotCache(desktopSnapshotCachePath(), desktopSnapshotCache);
  } catch (error) {
    console.warn(`[snapshot-cache] final write failed: ${error.message}`);
  }
}

function cacheLocalSnapshot({ history = null } = {}) {
  ensureDesktopSnapshotCacheLoaded();
  if (!localStats && !lastCollectedDevice) return;
  const capturedAt = new Date().toISOString();
  desktopSnapshotCache.local = {
    capturedAt,
    stats: cacheableDesktopSnapshot(localStats || localDeviceStats(lastCollectedDevice)),
    device: cacheableDesktopSnapshot(lastCollectedDevice || localDevice),
    history: cacheableDesktopSnapshot(history)
  };
  queueDesktopSnapshotCacheWrite();
}

function cacheHubSnapshot({ history = null } = {}) {
  ensureDesktopSnapshotCacheLoaded();
  if (!latestHubStats) return;
  const previous = desktopSnapshotCache.hub || {};
  desktopSnapshotCache.hub = {
    capturedAt: new Date().toISOString(),
    stats: cacheableDesktopSnapshot(latestHubStats),
    device: null,
    history: cacheableDesktopSnapshot(history) || previous.history || null
  };
  queueDesktopSnapshotCacheWrite();
}

// Local-mode stats for one device (or none). The device's own periodWindows
// names the calendar its today/month are keyed in — the fleet zone once this
// device has aligned — so the renderer computes preset windows in the same one.
function localDeviceStats(device) {
  const stats = withHistoryPreview(
    aggregateDevices(device ? [device] : [], 0),
    device ? [device] : []
  );
  const zone = normalizeTimeZone(device?.periodWindows?.timeZone);
  if (zone) stats.fleetTimeZone = zone;
  return stats;
}

function emptyDesktopStats() {
  return localDeviceStats(null);
}

function localFallbackStats() {
  if (localStats) return localStats;
  if (lastCollectedDevice) {
    return reattachLocalNativeView(
      localDeviceStats(lastCollectedDevice),
      lastCollectedDevice
    );
  }
  return emptyDesktopStats();
}

function desktopStatsFallback() {
  ensureDesktopSnapshotCacheLoaded();
  if (settings?.hubMode === 'client' && latestHubStats) {
    return injectLocalDeviceStatus(composeLocalSyncStats(latestHubStats, lastCollectedDevice));
  }
  return localFallbackStats();
}

function desktopSnapshotMeta() {
  ensureDesktopSnapshotCacheLoaded();
  const local = desktopSnapshotCache.local;
  const hub = desktopSnapshotCache.hub;
  const clientMode = settings?.hubMode === 'client';
  const localAvailable = Boolean(localStats || lastCollectedDevice || local);
  const hubAvailable = Boolean(latestHubStats || hub);
  let source = 'empty';
  if (!clientMode) source = localStatsLive ? 'local-live' : (localAvailable ? 'local-cache' : 'empty');
  else if (latestHubStatsLive) source = localStatsLive ? 'hub-live+local-live' : 'hub-live';
  else if (hubAvailable) source = localStatsLive ? 'hub-cache+local-live' : 'hub-cache';
  else if (localStatsLive) source = 'local-live';
  else if (localAvailable) source = 'local-cache';
  return {
    source,
    mode: clientMode ? 'client' : 'local',
    localAvailable,
    hubAvailable,
    localLive: localStatsLive,
    hubLive: latestHubStatsLive,
    localCapturedAt: local?.capturedAt || null,
    hubCapturedAt: hub?.capturedAt || null,
    cacheUpdatedAt: desktopSnapshotCache.updatedAt || null
  };
}

let mode = 'idle';
let deviceRuntimeHandle = null;
let localDevice = null;
let localStats = null;
let sseAbortController = null;
let sseRetryTimer = null;
let sseIdleTimer = null;
let sseIdleController = null;
let streamConnected = false;
let streamFailure = null;
let sseGeneration = 0;
let sseAttempt = 0;
let sseLastConnectAttemptAt = null;
let sseLastEventAt = null;
let sseLastHeartbeatAt = null;
let sseNextRetryAt = null;
let syncRestPollTimer = null;
let syncUploadSchedulerHandle = null;
let syncRecoveryPromise = null;
let syncRecoveryForceStreamRequested = false;
let syncNetworkPollTimer = null;
let lastNetworkOnline = null;
let restBootstrapAbortController = null;
const syncHealth = {
  local: { state: 'idle', lastSuccessAt: null, lastFailureAt: null, failureCode: null },
  upload: { state: 'idle', lastAttemptAt: null, lastSuccessAt: null, failureCode: null, status: null, consecutiveFailures: 0, nextRetryAt: null, pendingRevision: null, inFlightAgeMs: 0 },
  rest: { state: 'idle', lastSuccessAt: null, lastFailureAt: null, failureCode: null, status: null },
  stream: { state: 'offline', attempt: 0, lastEventAt: null, lastHeartbeatAt: null, nextRetryAt: null, failureCode: null, status: null }
};
let lastCollectedDevice = null;
let latestHubStats = null;
let latestHubStatsLive = false;
let latestStats = null;
let localStatsLive = false;
let desktopSnapshotCache = null;
let desktopSnapshotCacheLoaded = false;
let desktopSnapshotCacheWriteTimer = null;
const AGENT_PID_PATHS = pidFileCandidates();
let modeQueue = Promise.resolve();
let modeGeneration = 0;

function stableSyncFailureCode(error, fallback = 'sync_failed') {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 408) return 'request_timeout';
  if (status === 429) return 'rate_limited';
  if (Number.isInteger(status) && status >= 500) return 'hub_server_error';
  const code = String(error?.code || error?.cause?.code || '').trim().toLowerCase();
  if (code === 'request_timeout' || code === 'etimedout' || code === 'timeout') return 'request_timeout';
  if (code === 'econnrefused') return 'refused';
  if (code === 'enotfound' || code === 'eai_again') return 'dns';
  if (code === 'enetunreach' || code === 'ehostunreach') return 'unreachable';
  if (code === 'abort_err' || code === 'aborted' || code === 'aborterror') return 'aborted';
  return code.replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || fallback;
}

function syncHealthSnapshot() {
  const upload = syncUploadSchedulerHandle?.getDiagnostics?.() || syncHealth.upload;
  const stream = {
    ...syncHealth.stream,
    attempt: sseAttempt,
    lastConnectAttemptAt: sseLastConnectAttemptAt,
    lastEventAt: sseLastEventAt,
    lastHeartbeatAt: sseLastHeartbeatAt,
    nextRetryAt: sseNextRetryAt
  };
  return {
    mode,
    snapshot: desktopSnapshotMeta(),
    local: { ...syncHealth.local },
    upload: { ...upload },
    rest: { ...syncHealth.rest },
    stream,
    // These aliases make the two high-value timestamps easy to consume while
    // keeping the channel-specific objects extensible for diagnostics UIs.
    lastUploadSuccessAt: upload.lastSuccessAt || null,
    lastStreamEventAt: sseLastEventAt,
    nextUploadRetryAt: upload.nextRetryAt || null,
    nextStreamRetryAt: sseNextRetryAt
  };
}

function publishSyncHealth() {
  sendPush({ event: 'sync-health', data: { health: syncHealthSnapshot() } });
}

function updateSyncHealth(channel, patch = {}) {
  if (!syncHealth[channel]) return;
  syncHealth[channel] = { ...syncHealth[channel], ...patch };
  publishSyncHealth();
}

function effectiveHubConfig() {
  if (settings?.hubMode !== 'client') return { url: null, secret: '' };
  const url = normalizeHubUrl(settings.hubUrl);
  return {
    url: url ? requireSafeHubTransport(url, { allowInsecureHttp: settings.allowInsecureHubHttp === true }) : null,
    secret: settings.secret || ''
  };
}

async function requestHubAccount(pathname, options = {}) {
  const config = effectiveHubConfig();
  if (!config.url) throw Object.assign(new Error('Hub is not configured'), { code: 'hub_not_configured' });
  if (!config.secret) throw Object.assign(new Error('Hub secret is not configured'), { code: 'hub_secret_not_configured' });
  const headers = {
    authorization: `Bearer ${config.secret}`,
    ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {})
  };
  const response = await fetchBufferedWithTimeout(fetch, `${config.url.replace(/\/$/, '')}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  }, HUB_REQUEST_TIMEOUT_MS);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || body.message || `Hub request failed (${response.status})`);
    Object.assign(error, {
      code: body.code || 'hub_request_failed',
      status: response.status,
      responseBody: body
    });
    throw error;
  }
  return body;
}

function parseHubAccountCredential(request = {}) {
  if (request.credential !== undefined) return request.credential;
  const raw = String(request.credentialText || '').trim();
  if (!raw) throw Object.assign(new Error('A credential is required'), { code: 'credential_required' });
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { value: raw };
  }
}

function safeEffectiveHubConfig() {
  try {
    return { ok: true, ...effectiveHubConfig() };
  } catch (error) {
    return {
      ok: false,
      url: null,
      secret: '',
      error
    };
  }
}

function isExternalAgentActive() {
  for (const agentPidPath of AGENT_PID_PATHS) {
    try {
      const raw = fs.readFileSync(agentPidPath, 'utf8').trim();
      const pid = parseInt(raw, 10);
      if (!pid || pid === process.pid) continue;
      process.kill(pid, 0);
      return true;
    } catch (_) { /* try the next candidate */ }
  }
  return false;
}

async function postToHub(summary, context = {}) {
  const config = safeEffectiveHubConfig();
  if (!config.ok) {
    const error = new Error('Hub transport configuration is unavailable');
    error.code = config.error?.code || 'hub_transport_unavailable';
    throw error;
  }
  const { url: hubUrl, secret } = config;
  if (!hubUrl) {
    const error = new Error('Hub is not configured');
    error.code = 'hub_not_configured';
    throw error;
  }
  const stale = ensureDeviceIdentityLoaded().lastPostedDeviceId;
  if (stale && stale !== summary.deviceId) {
    // Move the ingest baseline and immutable ledger identity before posting the
    // new snapshot. Falling through after a conflict would merge two unrelated
    // installations or replay the full cumulative counter, so non-404 failures
    // deliberately block this upload.
    await renameDeviceOnHub(fetch, hubUrl, secret, stale, summary.deviceId, {
      signal: context.signal,
      timeoutMs: HUB_REQUEST_TIMEOUT_MS
    });
  }
  const url = `${hubUrl.replace(/\/$/, '')}/api/ingest`;
  const { response } = await postSyncPayload(fetch, url, {
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    summary,
    signal: context.signal,
    timeoutMs: HUB_REQUEST_TIMEOUT_MS,
    logger: (message) => console.log(`[sync] ${message}`)
  });
  if (!response.ok) {
    const error = new Error(`Hub ingest failed (${response.status})`);
    error.status = response.status;
    error.code = stableSyncFailureCode(error, 'hub_ingest_failed');
    throw error;
  }
  if (settings.lastPostedDeviceId !== summary.deviceId || deviceIdentity?.lastPostedDeviceId !== summary.deviceId) {
    settings.lastPostedDeviceId = summary.deviceId;
    deviceIdentity = { version: 1, lastPostedDeviceId: summary.deviceId };
    try { writeDeviceIdentity(summary.deviceId); }
    catch (error) { console.log(`[identity] state write failed: ${error.message}`); }
    saveSettings();
  }
  try {
    const payload = await response.json();
    // The Hub is the one place the fleet calendar is configured; remember what
    // it advertised so the next collector tick buckets in it. A local state-write
    // failure must not turn an accepted upload into a reported sync failure.
    try {
      if (payload && typeof payload === 'object') learnFleetTimeZone(payload.fleetTimeZone);
    } catch (error) {
      console.log(`[fleet-timezone] could not record the Hub calendar: ${error.message}`);
    }
    return payload;
  } catch (error) {
    const invalid = new Error('Hub returned an invalid ingest response');
    invalid.code = 'hub_invalid_response';
    invalid.cause = error;
    throw invalid;
  }
}

function stopSyncCollector(options = {}) {
  if (deviceRuntimeHandle) { try { deviceRuntimeHandle.stop(options); } catch (_) {} }
  deviceRuntimeHandle = null;
  if (syncUploadSchedulerHandle) {
    try { syncUploadSchedulerHandle.stop(); } catch (_) {}
    syncUploadSchedulerHandle = null;
  }
  updateSyncHealth('upload', {
    state: 'idle',
    nextRetryAt: null,
    pendingRevision: null,
    inFlightAgeMs: 0
  });
}

function startSyncCollector(options) {
  options = options || {};
  stopSyncCollector();
  if (settings.collectionPaused) {
    updateSyncHealth('local', { state: 'paused', failureCode: null });
    return;
  }
  mode = 'sync';
  updateSyncHealth('local', { state: 'collecting', failureCode: null });
  // A headless agent on this machine already collects and posts this device's
  // usage, and beforeEnqueue() below refuses every upload in that state. Starting
  // the runtime anyway spawns a second full scan set (tokscale + a chokidar watch
  // over the same trees) whose records are all discarded — measured at roughly
  // doubling this machine's collector CPU. The gate is read once here; a later
  // agent start/stop is picked up by the next mode transition or runtime refresh.
  if (isExternalAgentActive()) {
    updateSyncHealth('local', { state: 'relay', failureCode: null });
    publishSyncHealth();
    return;
  }
  // The first upload in client mode is held behind the authenticated startup
  // probe. This keeps the order deterministic (connectivity check -> collect ->
  // upload) without delaying local collection or the cached dashboard.
  const startupProbe = Promise.resolve(options.startupProbe || { ok: true, code: 'not_required' })
    .catch((error) => ({ ok: false, code: stableSyncFailureCode(error, 'hub_connectivity_failed') }));
  const syncUploadSink = createSyncUploadSink({
    intervalMs: normalizeSyncUploadIntervalMs(),
    flushTimeoutMs: HUB_REQUEST_TIMEOUT_MS,
    upload: async (summary, context) => {
      await startupProbe;
      updateSyncHealth('upload', { state: 'uploading', failureCode: null, status: null });
      try {
        const result = await postToHub(summary, context);
        updateSyncHealth('upload', {
          state: 'ok',
          lastSuccessAt: new Date().toISOString(),
          failureCode: null,
          status: null,
          consecutiveFailures: 0
        });
        return result;
      } catch (error) {
        updateSyncHealth('upload', {
          state: stableSyncFailureCode(error) === 'aborted' ? 'aborted' : 'error',
          lastFailureAt: new Date().toISOString(),
          failureCode: stableSyncFailureCode(error),
          status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null
        });
        throw error;
      }
    },
    onError: (error) => console.log(`[sync-collector] post failed (${stableSyncFailureCode(error)}): ${error.message}`),
    beforeEnqueue: (visibleSummary) => {
      if (isExternalAgentActive()) {
        syncSummaryTransformer.reloadSessionUsageArchive();
        return false;
      }
      lastCollectedDevice = { ...visibleSummary, receivedAt: new Date().toISOString() };
      localStats = reattachLocalNativeView(
        localDeviceStats(lastCollectedDevice),
        lastCollectedDevice
      );
      localStatsLive = true;
      cacheLocalSnapshot();
      const displayStats = composeLocalSyncStats(latestHubStats, lastCollectedDevice);
      if (displayStats) {
        sendPush({ event: 'stats', data: { type: 'stats', reason: 'local', stats: displayStats, at: new Date().toISOString() } });
      }
      updateSyncHealth('local', { state: 'ok', lastSuccessAt: new Date().toISOString(), failureCode: null });
      return true;
    }
  });
  syncUploadSchedulerHandle = syncUploadSink;
  deviceRuntimeHandle = createDeviceRuntime({
    envelope: electronDeviceEnvelope(),
    transformUsage: summaryForSync,
    usageOptions: electronUsageConfig('sync-collector'),
    sink: syncUploadSink,
    onError: (error, reason) => console.log(`[sync-collector] ${reason}: ${error.message}`)
  });
  publishSyncHealth();
}

// Detection status is about this machine's local files, so stamp the freshly
// collected local clientStatus AND wslStatus onto the local device in whatever
// stats we hand the renderer. This keeps the 采集 tags + WSL panel correct in
// sync mode without depending on the Hub being redeployed to preserve these fields.
function injectLocalDeviceStatus(stats) {
  if (!stats || !Array.isArray(stats.devices)) return stats;
  if (lastCollectedDevice) {
    const device = stats.devices.find((entry) => entry.deviceId === lastCollectedDevice.deviceId);
    if (device) {
      if (lastCollectedDevice.clientStatus) device.clientStatus = lastCollectedDevice.clientStatus;
      if (lastCollectedDevice.wslStatus) device.wslStatus = lastCollectedDevice.wslStatus;
    }
  }
  // syncPayload drops the unbounded allTime.sessions from uploads (#118), so a hub
  // aggregate carries no all-time session detail and the TOTAL session view would fall back
  // to a model list. Rebuild the list — the hub's cross-device month sessions as the
  // immediate baseline (present on the first frame, before this restart's first local scan),
  // then this machine's own full all-time sessions once collected (free, in-process). Carry
  // it as a display-only sibling instead of mutating periods.allTime.sessions: the exporter
  // writes periods verbatim under a lossless contract, so the export must keep the true
  // aggregate. The renderer overlays this onto periods.allTime for the session view.
  // Only sync mode needs this: in local mode periods.allTime.sessions already holds the
  // full native list, so building the sibling there would just ship the unbounded map twice.
  if (mode !== 'local' && stats.periods?.allTime) {
    stats.allTimeSessionsView = mergedLocalAllTimeSessions(stats.periods, lastCollectedDevice);
  }
  return stats;
}






// Coalesce stats pushes.
//
// Each push cloned the record three times and serialized a ~1.3 MB
// structured-clone IPC message,
// and the producer runs on every collector tick (watch ticks re-arm every 1.5s).
// Nothing here needs sub-frame latency, so keep the newest stats and lightweight
// event separately and flush on a short trailing timer. The history revision is
// captured across the whole coalesced window.
const PUSH_COALESCE_MS = 200;
let pendingPush = null;
let pendingStatsPush = null;
let pendingPushTimer = null;
let pendingPushHistoryRevision = null;
let statsPushDeferred = false;

function sendPush(payload) {
  if (payload?.data?.stats) {
    pendingPushHistoryRevision ??= statsHistoryRevision(latestStats);
    pendingStatsPush = payload;
  } else {
    pendingPush = payload;
  }
  if (pendingPushTimer !== null) return;
  pendingPushTimer = setTimeout(flushPush, PUSH_COALESCE_MS);
  pendingPushTimer.unref?.();
}

function flushPush() {
  pendingPushTimer = null;
  const statsPayload = pendingStatsPush;
  pendingStatsPush = null;
  const otherPayload = pendingPush;
  pendingPush = null;
  if (!statsPayload && !otherPayload) return;
  const previousHistoryRevision = pendingPushHistoryRevision;
  pendingPushHistoryRevision = null;
  for (let payload of [statsPayload, otherPayload]) {
    if (!payload) continue;
    if (payload?.data?.stats) {
      injectLocalDeviceStatus(payload.data.stats);
      latestStats = payload.data.stats;
      payload = {
        ...payload,
        data: {
          ...payload.data,
          snapshot: desktopSnapshotMeta()
        }
      };
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Closing to the tray or minimizing hides the document, so no renderer can
      // use these full snapshots until the window returns. Keep latestStats in the
      // main process and replay it once, instead of cloning it over IPC per tick.
      if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
        statsPushDeferred = true;
      } else {
        if (payload.event === 'stats') statsPushDeferred = false;
        try { mainWindow.webContents.send('stats:push', payload); } catch (_) {}
      }
    }
  }
  // `previousHistoryRevision` is still consumed by the caller's diffing; a change
  // no longer has a second window to notify, since the trends view now renders
  // inside the main window from the same stats push.
  void previousHistoryRevision;
}

// Deliver anything still queued, e.g. before quitting or before a synchronous
// reader asks for latestStats.
function flushPendingPush() {
  if (pendingPushTimer !== null) {
    clearTimeout(pendingPushTimer);
    pendingPushTimer = null;
  }
  if (pendingStatsPush || pendingPush) flushPush();
}

function replayDeferredStatsPush() {
  if (!statsPushDeferred || !mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return;
  // A tick queued just before reveal may contain a newer snapshot than
  // latestStats. Flushing first also avoids sending the same stats twice.
  flushPendingPush();
  try {
    if (statsPushDeferred && latestStats) {
      mainWindow.webContents.send('stats:push', {
        event: 'stats',
        data: { type: 'stats', stats: latestStats, at: new Date().toISOString(), snapshot: desktopSnapshotMeta() }
      });
    }
    mainWindow.webContents.send('stats:push', { event: 'sync-health', data: { health: syncHealthSnapshot() } });
    statsPushDeferred = false;
  } catch (_) {}
}

function statsHistoryRevision(stats) {
  const revision = String(stats?.historyRevision || '').trim();
  if (revision) return revision;
  // Compatibility with an older remote hub that has not shipped revisions yet.
  return JSON.stringify(stats?.historyPreview || null);
}

let rateCache = null;            // { rates, date, source, fetchedAt }
let effectiveRates = null;       // { CODE: number }
let rateRefreshTimer = null;

function exchangeRateCachePath() {
  return path.join(app.getPath('userData'), 'exchange-rates.json');
}

function readRateCache() {
  try { return JSON.parse(fs.readFileSync(exchangeRateCachePath(), 'utf8')); }
  catch (_) { return null; }
}

function writeRateCache(data) {
  try { fs.writeFileSync(exchangeRateCachePath(), JSON.stringify(data)); }
  catch (_) {}
}

function applyEffectiveRates() {
  effectiveRates = resolveEffectiveRates(rateCache?.rates || {}, settings?.currencyRates || {});
  configureRates(effectiveRates);          // main process's own currency module
  return effectiveRates;
}

async function refreshExchangeRates({ force = false } = {}) {
  if (rateCache === null) rateCache = readRateCache();
  if (force || isCacheStale(rateCache)) {
    try {
      const result = await fetchRates();
      rateCache = { rates: result.rates, date: result.date, source: result.source, fetchedAt: Date.now() };
      writeRateCache(rateCache);
    } catch (_) { /* silent: keep last cache / built-in defaults */ }
  }
  applyEffectiveRates();
  pushSettingsToRenderer();
}


function sendStatus(connected, extra) {
  streamConnected = Boolean(connected);
  if (!streamConnected && settings?.hubMode === 'client') latestHubStatsLive = false;
  streamFailure = streamConnected ? null : ((extra && extra.reason) ? { reason: extra.reason, detail: extra.detail ?? null } : streamFailure);
  const streamApplicable = mode === 'sync' && settings?.hubMode === 'client';
  syncHealth.stream = {
    ...syncHealth.stream,
    state: !streamApplicable ? 'not_applicable' : (streamConnected ? 'live' : (extra?.state || 'offline')),
    failureCode: !streamApplicable || streamConnected ? null : (extra?.reason || syncHealth.stream.failureCode),
    status: extra?.status ?? syncHealth.stream.status
  };
  const statusPayload = { connected: streamConnected, mode, health: syncHealthSnapshot(), ...(extra || {}) };
  sendPush({ event: 'status', data: statusPayload });
  // A dedicated channel so the shared UI can subscribe to connection state
  // without parsing the coalesced stats push stream.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('stream:status', statusPayload); } catch (_) {}
  }
}

function stopLocalCollector(options = {}) {
  if (deviceRuntimeHandle) { try { deviceRuntimeHandle.stop(options); } catch (_) {} }
  deviceRuntimeHandle = null;
  // Keep the last persisted local snapshot available while a new collector is
  // starting. This makes a cold client-mode launch render before the first
  // tokscale scan or Hub request completes.
  const cached = ensureDesktopSnapshotCacheLoaded()?.local;
  localDevice = cached?.device || null;
  lastCollectedDevice = localDevice || lastCollectedDevice;
  localStats = cached?.stats || null;
  localStatsLive = false;
}

function startLocalCollector() {
  stopLocalCollector();
  // Pausing keeps the window, cache and stream alive; only the collectors stop, so
  // a paused device still shows its last good numbers instead of an empty app.
  if (settings.collectionPaused) {
    mode = 'local';
    updateSyncHealth('local', { state: 'paused', failureCode: null });
    sendStatus(false, { reason: 'paused' });
    return;
  }
  mode = 'local';
  updateSyncHealth('local', { state: 'collecting', failureCode: null });
  sendStatus(false, { reason: 'collecting' });
  deviceRuntimeHandle = createDeviceRuntime({
    envelope: electronDeviceEnvelope(),
    transformUsage: summaryForSync,
    usageOptions: electronUsageConfig('collector'),
    progressive: true,
    onRecord: (summary, meta) => {
      const reason = meta.reason;
      const visibleSummary = summary;
      localDevice = { ...visibleSummary, receivedAt: new Date().toISOString() };
      lastCollectedDevice = localDevice;
      // aggregateDevices() drops the Reasonix native view (it is a wire-record
      // whitelist), so reattach it here — otherwise local mode, the default, has
      // no Reasonix sessions or projects at all while sync mode does.
      localStats = reattachLocalNativeView(
        localDeviceStats(localDevice),
        localDevice
      );
      localStatsLive = true;
      cacheLocalSnapshot();
      sendPush({ event: 'stats', data: { type: 'stats', reason, stats: localStats, at: new Date().toISOString() } });
      updateSyncHealth('local', { state: 'ok', lastSuccessAt: new Date().toISOString(), failureCode: null });
      sendStatus(true, { reason });
    },
    onError: (error, reason) => {
      updateSyncHealth('local', {
        state: 'error',
        lastFailureAt: new Date().toISOString(),
        failureCode: stableSyncFailureCode(error, reason || 'collection_failed')
      });
      sendStatus(false, { reason: 'network', detail: stableSyncFailureCode(error, reason || 'collection_failed'), state: 'collecting' });
    }
  });
}

function clearSyncRestPoll() {
  if (syncRestPollTimer) clearTimeout(syncRestPollTimer);
  syncRestPollTimer = null;
}

function scheduleStreamRetry(options = {}) {
  if (sseRetryTimer || mode !== 'sync' || settings?.hubMode !== 'client') return;
  const currentGeneration = options.generation ?? sseGeneration;
  if (currentGeneration !== sseGeneration) return;
  sseAttempt = Math.max(1, sseAttempt + 1);
  const exponential = Math.min(SSE_RETRY_MAX_MS, SSE_RETRY_BASE_MS * (2 ** (sseAttempt - 1)));
  const delayMs = Number.isFinite(Number(options.delayMs))
    ? Math.max(0, Number(options.delayMs))
    : Math.floor(Math.random() * exponential);
  sseNextRetryAt = new Date(Date.now() + delayMs).toISOString();
  syncHealth.stream = {
    ...syncHealth.stream,
    state: 'backoff',
    attempt: sseAttempt,
    nextRetryAt: sseNextRetryAt
  };
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    sseNextRetryAt = null;
    if (currentGeneration !== sseGeneration || mode !== 'sync' || settings?.hubMode !== 'client') return;
    void startStatsStream({ generation: currentGeneration }).catch(() => {});
  }, delayMs);
  sseRetryTimer.unref?.();
  publishSyncHealth();
}

function clearSseIdleWatchdog(controller = null) {
  if (controller && sseIdleController !== controller) return;
  if (sseIdleTimer) clearTimeout(sseIdleTimer);
  sseIdleTimer = null;
  sseIdleController = null;
}

function armSseIdleWatchdog(controller, onTimeout) {
  clearSseIdleWatchdog();
  sseIdleController = controller;
  sseIdleTimer = setTimeout(() => {
    sseIdleTimer = null;
    sseIdleController = null;
    onTimeout();
  }, SSE_IDLE_TIMEOUT_MS);
  sseIdleTimer.unref?.();
}

function stopStatsStream() {
  sseGeneration += 1;
  if (sseAbortController) { try { sseAbortController.abort(); } catch (_) {} }
  sseAbortController = null;
  clearSseIdleWatchdog();
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
  clearSyncRestPoll();
  sseNextRetryAt = null;
  streamConnected = false;
  syncHealth.stream = { ...syncHealth.stream, state: 'offline', nextRetryAt: null };
}

function parseSseChunk(chunk) {
  let event = 'message';
  const dataLines = [];
  let comment = false;
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(':')) {
      comment = true;
      continue;
    }
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return comment ? { event: 'heartbeat', data: null } : null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch (_) { return null; }
}

async function fetchHubStatsSnapshot(options = {}) {
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const config = safeEffectiveHubConfig();
  if (!config.ok) {
    const error = new Error('Hub transport configuration is unavailable');
    error.code = config.error?.code || 'hub_transport_unavailable';
    if (isCurrent()) {
      updateSyncHealth('rest', { state: 'error', lastFailureAt: new Date().toISOString(), failureCode: error.code });
    }
    throw error;
  }
  const { url: hubUrl, secret } = config;
  if (!hubUrl) {
    const error = new Error('Hub is not configured');
    error.code = 'hub_not_configured';
    if (isCurrent()) {
      updateSyncHealth('rest', { state: 'blocked', lastFailureAt: new Date().toISOString(), failureCode: error.code });
    }
    throw error;
  }
  const url = `${hubUrl.replace(/\/$/, '')}/api/stats`;
  try {
    const response = await fetchBufferedWithTimeout(fetch, url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      ...(options.signal ? { signal: options.signal } : {})
    }, HUB_REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      const error = new Error(`Hub stats request failed (${response.status})`);
      error.status = response.status;
      error.code = stableSyncFailureCode(error, 'hub_read_failed');
      throw error;
    }
    const stats = await response.json();
    if (!isCurrent()) return null;
    latestHubStats = stats;
    latestHubStatsLive = true;
    cacheHubSnapshot();
    updateSyncHealth('rest', { state: 'ok', lastSuccessAt: new Date().toISOString(), failureCode: null, status: null });
    return injectLocalDeviceStatus(composeLocalSyncStats(stats, lastCollectedDevice));
  } catch (error) {
    if (isCurrent()) {
      updateSyncHealth('rest', {
        state: 'error',
        lastFailureAt: new Date().toISOString(),
        failureCode: stableSyncFailureCode(error, 'hub_read_failed'),
        status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null
      });
    }
    throw error;
  }
}

function stopRestBootstrap() {
  if (restBootstrapAbortController) {
    try { restBootstrapAbortController.abort(); } catch (_) {}
  }
  restBootstrapAbortController = null;
}

function startClientRestBootstrap(generation) {
  stopRestBootstrap();
  const controller = new AbortController();
  restBootstrapAbortController = controller;
  const isCurrent = () => generation === modeGeneration
    && settings?.hubMode === 'client'
    && restBootstrapAbortController === controller;
  if (isCurrent()) {
    updateSyncHealth('rest', { state: 'connecting', failureCode: null, status: null });
  }
  return fetchHubStatsSnapshot({ signal: controller.signal, isCurrent }).then((stats) => {
    if (!stats || !isCurrent()) return { ok: false, superseded: true, code: 'startup_probe_superseded' };
    sendPush({ event: 'stats', data: { type: 'stats', reason: 'rest-bootstrap', transport: 'rest', mode, stats, at: new Date().toISOString() } });
    return { ok: true, stats };
  }).catch((error) => {
    if (!isCurrent() || stableSyncFailureCode(error) === 'aborted') {
      return { ok: false, superseded: true, code: 'startup_probe_aborted' };
    }
    const code = stableSyncFailureCode(error, 'hub_connectivity_failed');
    console.log(`[rest] startup bootstrap failed (${code})`);
    return {
      ok: false,
      code,
      status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null
    };
  }).finally(() => {
    if (restBootstrapAbortController === controller) restBootstrapAbortController = null;
  });
}

function scheduleRestFallbackPoll(generation = sseGeneration) {
  if (syncRestPollTimer || mode !== 'sync' || settings?.hubMode !== 'client') return;
  syncRestPollTimer = setTimeout(async () => {
    syncRestPollTimer = null;
    if (generation !== sseGeneration || streamConnected || mode !== 'sync') return;
    try {
      const stats = await fetchHubStatsSnapshot();
      if (generation === sseGeneration && !streamConnected) {
        sendPush({ event: 'stats', data: { type: 'stats', reason: 'rest-fallback', transport: 'rest', mode, stats, at: new Date().toISOString() } });
      }
    } catch (_) {
      // Keep the fallback bounded and quiet; the stream retry remains the
      // primary recovery path and owns the user-visible backoff diagnostics.
    } finally {
      if (generation === sseGeneration && !streamConnected) scheduleRestFallbackPoll(generation);
    }
  }, SYNC_REST_POLL_MS);
  syncRestPollTimer.unref?.();
}

async function startStatsStream(options = {}) {
  stopStatsStream();
  const currentGeneration = sseGeneration;
  if (options.resetSnapshot) {
    // Reset the live marker while retaining the last Hub snapshot as an
    // offline read model. A reconnect must not blank the dashboard.
    ensureDesktopSnapshotCacheLoaded();
    latestHubStats = desktopSnapshotCache?.hub?.stats || null;
    latestHubStatsLive = false;
  }
  if (options.resetBackoff || options.resetSnapshot) sseAttempt = 0;
  const config = safeEffectiveHubConfig();
  if (!config.ok) {
    mode = 'sync';
    sendStatus(false, { reason: 'network', detail: config.error?.code || 'hub_transport_unavailable', state: 'blocked' });
    scheduleRestFallbackPoll(currentGeneration);
    return { ok: false, code: config.error?.code || 'hub_transport_unavailable' };
  }
  const { url: hubUrl, secret } = config;
  if (!hubUrl) {
    mode = 'sync';
    sendStatus(false, { reason: 'network', detail: 'hub_not_configured', state: 'blocked' });
    return { ok: false, code: 'hub_not_configured' };
  }
  mode = 'sync';
  clearSyncRestPoll();
  const url = `${hubUrl.replace(/\/$/, '')}/api/stats/stream`;
  const controller = new AbortController();
  let idleTimedOut = false;
  sseAbortController = controller;
  sseLastConnectAttemptAt = new Date().toISOString();
  syncHealth.stream = {
    ...syncHealth.stream,
    state: 'connecting',
    attempt: sseAttempt,
    nextRetryAt: null
  };
  publishSyncHealth();
  const isCurrent = () => currentGeneration === sseGeneration && sseAbortController === controller;
  const timeoutStream = () => {
    if (!isCurrent()) return;
    idleTimedOut = true;
    try { controller.abort(new Error('SSE idle timeout')); } catch (_) { controller.abort(); }
  };
  try {
    const response = await fetchWithTimeout(fetch, url, {
      headers: { accept: 'text/event-stream', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      signal: controller.signal
    }, HUB_REQUEST_TIMEOUT_MS);
    if (!isCurrent()) return { ok: false, superseded: true };
    if (!response.ok || !response.body) {
      const failure = classifyStreamFailure({ status: response.status });
      sendStatus(false, { ...failure, status: response.status });
      scheduleStreamRetry({ generation: currentGeneration });
      scheduleRestFallbackPoll(currentGeneration);
      return { ok: false, status: response.status };
    }
    // A successful connection is a recovery boundary. Do not carry a long
    // outage's exponential delay into the next disconnect after the stream has
    // already come back.
    sseAttempt = 0;
    sseNextRetryAt = null;
    syncHealth.stream = {
      ...syncHealth.stream,
      attempt: 0,
      nextRetryAt: null,
      failureCode: null,
      status: null
    };
    sendStatus(true, { state: 'live' });
    armSseIdleWatchdog(controller, timeoutStream);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (!isCurrent()) return { ok: false, superseded: true };
      if (done) break;
      if (value) armSseIdleWatchdog(controller, timeoutStream);
      buffer += decoder.decode(value, { stream: true });
      let frame;
      while ((frame = buffer.match(/\r?\n\r?\n/)) !== null) {
        const chunk = buffer.slice(0, frame.index);
        buffer = buffer.slice(frame.index + frame[0].length);
        let parsed = parseSseChunk(chunk);
        if (!parsed) continue;
        const eventAt = new Date().toISOString();
        sseLastEventAt = eventAt;
        if (parsed.event === 'heartbeat' || parsed.event === 'ping' || parsed.event === 'keepalive') {
          sseLastHeartbeatAt = eventAt;
        }
        syncHealth.stream = {
          ...syncHealth.stream,
          state: 'live',
          lastEventAt: eventAt,
          lastHeartbeatAt: sseLastHeartbeatAt,
          failureCode: null,
          status: null
        };
        if (parsed.event === 'heartbeat' || parsed.event === 'ping' || parsed.event === 'keepalive') {
          publishSyncHealth();
          continue;
        }
        if (parsed.event === 'stats' && parsed.data?.stats) {
          latestHubStats = parsed.data.stats;
          latestHubStatsLive = true;
          cacheHubSnapshot();
          const displayStats = composeLocalSyncStats(latestHubStats, lastCollectedDevice);
          parsed = { ...parsed, data: { ...parsed.data, stats: displayStats } };
        }
        sendPush(parsed);
      }
    }
    if (!isCurrent()) return { ok: false, superseded: true };
    sendStatus(false, classifyStreamFailure({ eof: true }));
    scheduleStreamRetry({ generation: currentGeneration });
    scheduleRestFallbackPoll(currentGeneration);
    return { ok: false, code: 'disconnected' };
  } catch (error) {
    if (!isCurrent()) return { ok: false, superseded: true };
    if (controller.signal.aborted && !idleTimedOut) return { ok: false, superseded: true };
    const failure = idleTimedOut
      ? { reason: 'idle_timeout', detail: null }
      : classifyStreamFailure({ errorCode: error?.cause?.code || error?.code, message: error?.message });
    sendStatus(false, { ...failure, state: idleTimedOut ? 'idle-timeout' : 'offline' });
    scheduleStreamRetry({ generation: currentGeneration });
    scheduleRestFallbackPoll(currentGeneration);
    return { ok: false, code: failure.reason };
  } finally {
    clearSseIdleWatchdog(controller);
    if (sseAbortController === controller) sseAbortController = null;
  }
}





function focusExistingWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
}


function effectiveWindowSurface(source = settings) {
  if (source?.systemGlass === false) return 'regular';
  if (process.platform === 'win32') {
    const profile = windowsSurfaceFor({ systemGlass: true, source });
    if (profile.kind === 'transparent') {
      return 'transparent';
    }
    if (profile.nativeBackdrop) {
      return profile.kind === 'mica' ? 'mica' : 'acrylic';
    }
  }
  return 'transparent';
}

function settingsForRenderer() {
  const safeSettings = withoutInternalOnlyKeys(stripLegacyLocalLimitSettings(settings));
  const redactedCredentials = credentialSettingsForRenderer(settings, {
    // The renderer only needs the configured boolean. A Hub secret is accepted
    // through the one-shot validation/save IPC path and is never part of the
    // settings snapshot or cache sent to the renderer.
    expose: []
  });
  return {
    ...safeSettings,
    windowsSurface: windowsSurfaceFor().kind,
    effectiveWindowSurface: effectiveWindowSurface(settings),
    ...redactedCredentials,
    hubSecretConfigured: Boolean(settings?.secret),
    limitsAuthority: 'hub',
    centralQuotaSync: true,
    currencyRatesEffective: effectiveRates || resolveEffectiveRates(rateCache?.rates || {}, settings?.currencyRates || {}),
    currencyRateInfo: rateCache ? { source: rateCache.source, date: rateCache.date, fetchedAt: rateCache.fetchedAt } : null,
    macosGlassEffectiveStyle: macosGlassStyleFor(settings),
    macosGlassLiquidAvailable: macosLiquidGlassIsAvailable(),
  };
}

function pushSettingsToRenderer() {
  const payload = settingsForRenderer();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('settings:push', payload); } catch (_) {}
  }
}





function sendMainWindowEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.send(channel, payload); } catch (_) {}
  };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}






// Navigation entry point for the application menu. The shared UI owns its own
// route list, so this only validates against that set and hands the id over.
function openSharedUiView(viewId) {
  const normalized = String(viewId || '').trim().toLowerCase();
  if (!SHARED_UI_VIEW_IDS.has(normalized)) return;
  focusExistingWindow();
  sendMainWindowEvent('view:open', normalized);
}







function startMode() {
  // Tear down collectors synchronously so they can't double-run while the
  // async reconciliation below is queued.
  stopLocalCollector();
  stopStatsStream();
  stopRestBootstrap();
  stopSyncCollector();
  const requestedGeneration = ++modeGeneration;
  // Serialize the Hub-side work so rapid UI events reconcile in order rather
  // than allowing an in-flight startup to finish against stale settings.
  modeQueue = modeQueue.then(async () => {
    if (requestedGeneration !== modeGeneration) {
      return { ok: false, superseded: true, generation: requestedGeneration };
    }
    if (settings.hubMode === 'client') {
      // `/api/stats` is an authenticated connectivity check, not merely a
      // socket probe: it verifies the address, transport policy, and saved
      // secret before the first POST /api/ingest is allowed to run.
      const startupProbe = startClientRestBootstrap(requestedGeneration);
      startSyncCollector({ startupProbe });
      // Start the long-lived stream only after the probe settles. A failed probe
      // still gets a stream retry path, but no read/write channel races the
      // initial connectivity result.
      void startupProbe.then(() => {
        if (requestedGeneration !== modeGeneration || settings?.hubMode !== 'client') return;
        return startStatsStream({ resetSnapshot: true, resetBackoff: true });
      }).catch((error) => {
        console.log(`[stream] start failed (${stableSyncFailureCode(error)}): ${error.message}`);
      });
      const config = safeEffectiveHubConfig();
      return {
        ok: config.ok && Boolean(config.url),
        mode: 'client',
        code: config.ok ? (config.url ? null : 'hub_not_configured') : (config.error?.code || 'hub_transport_unavailable'),
        state: 'connecting',
        generation: requestedGeneration
      };
    } else {
      startLocalCollector();
      return { ok: true, mode: 'local', generation: requestedGeneration };
    }
  }).catch((err) => {
    console.log(`[mode] reconciliation failed (${stableSyncFailureCode(err)}): ${err?.message || err}`);
    return { ok: false, code: stableSyncFailureCode(err, 'mode_reconcile_failed'), generation: requestedGeneration };
  });
  return modeQueue;
}


function stopAll() {
  stopPersistBoundsTimer();
  // Quit does not need to await chokidar's O(N) close pass. The runtime marks
  // itself inactive synchronously, so leaving descriptors for process teardown
  // cannot deliver another collection tick while Electron exits.
  stopLocalCollector({ skipCloseWatchers: true });
  stopStatsStream();
  stopRestBootstrap();
  stopSyncCollector({ skipCloseWatchers: true });
}

let quitRequested = false;
let quitInProgress = false;
let skipForcedQuit = false;
let updateHandoffObserved = false;

const updateInstallQuit = createUpdateInstallQuitGuard({
  ...updateInstallQuitPolicy(),
  watchdogEnabled: () => updateHandoffObserved,
  claim: () => { quitRequested = true; skipForcedQuit = true; },
  release: () => { quitRequested = false; skipForcedQuit = false; },
  onStalled: () => {
    setNativeAppUpdateState({
      phase: 'error',
      progress: null,
      error: 'Update installer did not start',
      errorKind: installFailureErrorKind({ spent: updateInstallQuit.isSpent(), stalled: true })
    });
  },
  onHandoff: (afterStalledReport) => {
    if (!afterStalledReport) return;
    setNativeAppUpdateState({ phase: 'downloaded', progress: 100, error: null });
  }
});

function performQuit() {
  if (quitInProgress) return;
  quitInProgress = true;
  try { stopAll(); }
  catch (error) { console.log(`[quit] stopAll failed: ${error?.message || error}`); }
  app.exit(0);
}

function requestAppQuit() {
  if (quitRequested) return;
  quitRequested = true;
  performQuit();
}


async function fetchStats(options = {}) {
  // Apply anything still inside the push coalescing window so callers never see a
  // snapshot older than one this process already produced.
  flushPendingPush();
  const force = Boolean(options?.force);
  // forceHistory stays independent of `force` on purpose: tool settings, account
  // sign-ins and limits actions all refresh with { force: true }, so folding the
  // history rescan into it would spawn the expensive `tokscale graph` on each one.
  // Only the manual refresh button opts in.
  const canRefreshRuntime = mode === 'local' || !isExternalAgentActive();
  if (force && deviceRuntimeHandle && canRefreshRuntime) {
    await runManualDeviceRefresh(deviceRuntimeHandle, {
      forceHistory: Boolean(options?.forceHistory),
    });
  }
  if (mode === 'local') {
    return localFallbackStats();
  }
  try {
    return await fetchHubStatsSnapshot();
  } catch (error) {
    // The local collector and the last successful Hub response remain useful
    // while a client-mode Hub is blocked or offline. Keep the read-side failure
    // in syncHealth, but never replace a usable snapshot with a blank/error
    // page. The caller can still inspect sync health to explain the source.
    void error;
    return desktopStatsFallback();
  }
}

function boundedSyncTask(task, timeoutMs = SYNC_RECOVERY_TIMEOUT_MS) {
  const deadline = Math.max(1, Number(timeoutMs) || SYNC_RECOVERY_TIMEOUT_MS);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true, code: 'recovery_timeout' }), deadline);
    timer.unref?.();
  });
  const work = Promise.resolve().then(task);
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function recoverNow(options = {}) {
  if (options?.forceStream === true) syncRecoveryForceStreamRequested = true;
  if (syncRecoveryPromise) return syncRecoveryPromise;
  syncRecoveryPromise = (async () => {
    const recoveryDeadline = Date.now() + SYNC_RECOVERY_TIMEOUT_MS;
    const remaining = () => Math.max(1, recoveryDeadline - Date.now());
    const result = {
      collection: { ok: false, code: 'not_started' },
      upload: { ok: false, code: 'not_started' },
      rest: { ok: false, code: 'not_started' },
      stream: { ok: false, code: 'not_started' }
    };
    const takeStreamReconnectRequest = () => {
      const forceStream = syncRecoveryForceStreamRequested;
      syncRecoveryForceStreamRequested = false;
      return mode === 'sync'
        && settings?.hubMode === 'client'
        && (forceStream || !streamConnected);
    };
    const startRecoveryStream = () => startStatsStream({ resetBackoff: true }).catch((error) => {
      console.log(`[stream] recovery failed (${stableSyncFailureCode(error)}): ${error.message}`);
      return { ok: false, code: stableSyncFailureCode(error) };
    });
    let streamStartPromise = takeStreamReconnectRequest()
      ? startRecoveryStream()
      : null;

    const canRefreshRuntime = mode === 'local' || !isExternalAgentActive();
    if (deviceRuntimeHandle && canRefreshRuntime) {
      try {
        const collection = await boundedSyncTask(
          () => runManualDeviceRefresh(deviceRuntimeHandle, {
            forceHistory: true,
          }),
          remaining()
        );
        result.collection = collection?.timedOut
          ? collection
          : { ok: true, ...(collection && typeof collection === 'object' ? collection : {}) };
      } catch (error) {
        result.collection = { ok: false, code: stableSyncFailureCode(error, 'collection_failed') };
      }
    } else if (isExternalAgentActive()) {
      result.collection = { ok: false, code: 'external_agent_active' };
    } else {
      result.collection = { ok: false, code: 'collector_unavailable' };
    }

    if (syncUploadSchedulerHandle) {
      try {
        result.upload = await boundedSyncTask(
          () => syncUploadSchedulerHandle.retryNow({ abortActive: true, timeoutMs: Math.min(HUB_REQUEST_TIMEOUT_MS, remaining()) }),
          remaining()
        );
      } catch (error) {
        result.upload = { ok: false, code: stableSyncFailureCode(error, 'upload_failed'), status: error?.status || null };
      }
    } else if (mode === 'local') {
      result.upload = { ok: true, code: 'not_applicable' };
    } else {
      result.upload = { ok: false, code: 'upload_scheduler_unavailable' };
    }

    if (mode === 'sync' && settings?.hubMode === 'client') {
      try {
        const stats = await boundedSyncTask(() => fetchHubStatsSnapshot(), Math.min(HUB_REQUEST_TIMEOUT_MS, remaining()));
        if (stats?.timedOut) result.rest = stats;
        else {
          result.rest = { ok: true };
          sendPush({ event: 'stats', data: { type: 'stats', reason: 'recovery-rest', transport: 'rest', mode, stats, at: new Date().toISOString() } });
        }
      } catch (error) {
        result.rest = { ok: false, code: stableSyncFailureCode(error, 'hub_read_failed'), status: error?.status || null };
      }

      // startStatsStream owns the long-lived reader. Do not await its EOF here;
      // only wait for the bounded connection attempt to publish its status.
      if (!streamStartPromise && takeStreamReconnectRequest()) {
        streamStartPromise = startRecoveryStream();
      }
      void streamStartPromise;
      while (!streamConnected && Date.now() < recoveryDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      result.stream = streamConnected
        ? { ok: true, connected: true }
        : { ok: false, code: syncHealth.stream.failureCode || 'stream_offline', timedOut: true };
    } else {
      result.rest = { ok: true, code: 'not_applicable' };
      result.stream = { ok: true, code: 'not_applicable', connected: streamConnected };
    }
    result.ok = ['collection', 'upload', 'rest', 'stream'].every((channel) => result[channel]?.ok === true);
    publishSyncHealth();
    return result;
  })().finally(() => {
    syncRecoveryPromise = null;
  });
  return syncRecoveryPromise;
}

function checkSyncNetworkRecovery() {
  if (settings?.hubMode !== 'client' || mode !== 'sync' || typeof net?.isOnline !== 'function') return;
  let online;
  try { online = Boolean(net.isOnline()); } catch (_) { return; }
  if (lastNetworkOnline === false && online === true) {
    void recoverNow({ forceStream: true }).catch((error) => console.log(`[sync] network recovery failed: ${error.message}`));
  }
  lastNetworkOnline = online;
}

function startSyncNetworkMonitor() {
  if (syncNetworkPollTimer || typeof net?.isOnline !== 'function') return;
  try { lastNetworkOnline = Boolean(net.isOnline()); } catch (_) { lastNetworkOnline = null; }
  syncNetworkPollTimer = setInterval(checkSyncNetworkRecovery, 15 * 1000);
  syncNetworkPollTimer.unref?.();
}

function stopSyncNetworkMonitor() {
  if (syncNetworkPollTimer) clearInterval(syncNetworkPollTimer);
  syncNetworkPollTimer = null;
  lastNetworkOnline = null;
}





let appUpdateCheckInFlight = false;
let appUpdateCheckPromise = null;
let appUpdateLastError = null;
let appUpdateBackgroundTimer = null;
let appUpdateNativeBusy = false;
let appUpdateNativeConfigured = false;
let appUpdateNativeState = {
  phase: 'idle',
  version: null,
  progress: null,
  error: null,
  errorKind: null
};

function latestFromUpdaterInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const version = semver.valid(info.version);
  if (!version) return null;
  return {
    version,
    tag: `v${version}`,
    name: (typeof info.releaseName === 'string' && info.releaseName.trim()) ? info.releaseName : `v${version}`,
    htmlUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`,
    publishedAt: typeof info.releaseDate === 'string' ? info.releaseDate : ''
  };
}

function rememberLatestAppUpdate(latest, checkedAt = new Date().toISOString()) {
  if (!latest) return null;
  const merged = mergeLatestReleaseMetadata(settings?.appUpdate?.lastKnownLatest, latest);
  settings.appUpdate = {
    ...(settings.appUpdate || {}),
    lastCheckedAt: checkedAt,
    lastKnownLatest: merged
  };
  saveSettings();
  return merged;
}

function linuxPackageType() {
  if (process.platform !== 'linux' || !app.isPackaged) return '';
  try {
    return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim().toLowerCase();
  } catch (_) { return ''; }
}

function nativeAppUpdateInstallSupport() {
  return appUpdateInstallSupport({
    isPackaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    packageType: linuxPackageType()
  });
}

function setNativeAppUpdateState(patch = {}) {
  const next = { ...appUpdateNativeState, ...patch };
  if ('error' in patch && !('errorKind' in patch)) next.errorKind = null;
  appUpdateNativeState = next;
  sendAppUpdatePush();
}

function configureNativeAppUpdater() {
  if (appUpdateNativeConfigured) return;
  autoUpdater = require('electron-updater').autoUpdater;
  appUpdateNativeConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;
  autoUpdater.on('checking-for-update', () => {
    setNativeAppUpdateState({ phase: 'checking', progress: null, error: null });
  });
  autoUpdater.on('update-available', (info) => {
    const latest = rememberLatestAppUpdate(latestFromUpdaterInfo(info));
    setNativeAppUpdateState({ phase: 'available', version: latest?.version || info?.version || null, progress: null, error: null });
  });
  autoUpdater.on('update-not-available', (info) => {
    appUpdateNativeBusy = false;
    const latest = rememberLatestAppUpdate(latestFromUpdaterInfo(info));
    setNativeAppUpdateState({ phase: 'idle', version: latest?.version || null, progress: null, error: null });
  });
  autoUpdater.on('download-progress', (progress) => {
    setNativeAppUpdateState({
      phase: 'downloading',
      progress: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : null,
      error: null
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    appUpdateNativeBusy = false;
    const latest = latestFromUpdaterInfo(info);
    setNativeAppUpdateState({ phase: 'downloaded', version: latest?.version || info?.version || appUpdateNativeState.version || null, progress: 100, error: null });
  });
  // The install hand-off is emitted by Electron's native autoUpdater emitter,
  // not necessarily by electron-updater's wrapper. Arm the watchdog only after
  // this registration has actually succeeded.
  try {
    updateHandoffObserved = observeUpdateInstallHandoff(
      require('electron').autoUpdater,
      () => updateInstallQuit.noteHandoff()
    );
  } catch (error) {
    updateHandoffObserved = false;
    console.log(`[update] cannot observe the install hand-off: ${error?.message || error}`);
  }
  if (!updateHandoffObserved) console.log('[update] no install hand-off signal; quit recovery disabled');
  autoUpdater.on('error', (error) => {
    const wasInstalling = updateInstallQuit.abort();
    // A late updater error after the watchdog already reported a spent attempt
    // must not erase that recovery state. Conversely, a check/download error
    // without an outstanding install remains an ordinary updater error.
    if (!appUpdateNativeBusy && !wasInstalling) return;
    appUpdateNativeBusy = false;
    setNativeAppUpdateState({
      phase: 'error',
      progress: null,
      error: error?.message || String(error || 'Update failed'),
      errorKind: wasInstalling
        ? installFailureErrorKind({ spent: updateInstallQuit.isSpent() })
        : null
    });
  });
}

function deriveAppUpdateState() {
  const block = settings?.appUpdate || {};
  const currentVersion = app.getVersion();
  const latest = block.lastKnownLatest || null;
  const dismissedVersion = block.dismissedVersion || null;
  const installSupport = nativeAppUpdateInstallSupport();
  const availability = deriveAppUpdateAvailability({
    currentVersion,
    latest,
    dismissedVersion,
    phase: appUpdateNativeState.phase,
    downloadedVersion: appUpdateNativeState.version
  });
  return {
    currentVersion,
    latest,
    hasUpdate: availability.hasUpdate,
    showUpdateNotice: availability.showUpdateNotice,
    dismissedVersion,
    lastCheckedAt: block.lastCheckedAt || null,
    checking: appUpdateCheckInFlight,
    lastError: appUpdateLastError,
    installSupported: installSupport.supported,
    installSupportReason: installSupport.reason,
    installPhase: appUpdateNativeState.phase,
    installProgress: appUpdateNativeState.progress,
    installVersion: appUpdateNativeState.version,
    installError: appUpdateNativeState.error,
    installErrorKind: appUpdateNativeState.errorKind || null,
    downloaded: availability.downloaded,
    installStarting: updateInstallQuit.isInstalling(),
    installRetryBlocked: updateInstallQuit.isSpent(),
    installBusy: appUpdateNativeBusy
      || updateInstallQuit.isInstalling()
      || appUpdateNativeState.phase === 'checking'
      || appUpdateNativeState.phase === 'downloading'
  };
}

function restoreDismissedAppUpdate(version) {
  const block = settings?.appUpdate || {};
  if (!version || block.dismissedVersion !== version) return false;
  settings.appUpdate = {
    ...block,
    dismissedVersion: null
  };
  saveSettings();
  return true;
}

function sendAppUpdatePush() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('appUpdate:push', deriveAppUpdateState());
}

async function runAppUpdateCheck({ force = false, bypassCooldown = false } = {}) {
  // An install owns electron-updater until its hand-off resolves. Its error is
  // reported on the same emitter as check failures, so allowing a check here
  // could release the install's quit claim or make a second update lifecycle run.
  if (updateInstallQuit.isOutstanding()) return deriveAppUpdateState();
  if (appUpdateCheckPromise) {
    if (force) sendAppUpdatePush();
    const activeResult = await appUpdateCheckPromise;
    if (force) {
      if (activeResult?.ok) {
        if (activeResult.newer) restoreDismissedAppUpdate(activeResult.latest?.version);
        appUpdateLastError = null;
      } else {
        appUpdateLastError = activeResult?.error || 'Update check failed';
      }
      sendAppUpdatePush();
    }
    return deriveAppUpdateState();
  }
  const block = settings?.appUpdate || {};
  if (!bypassCooldown && shouldSkipAppUpdateCheck({
    force,
    lastCheckedAt: block.lastCheckedAt,
    latest: block.lastKnownLatest,
    dismissedVersion: block.dismissedVersion,
    currentVersion: app.getVersion()
  })) {
    return deriveAppUpdateState();
  }
  const checkTask = (async () => {
    appUpdateCheckInFlight = true;
    appUpdateLastError = null;
    if (force) sendAppUpdatePush();
    let result;
    try {
      result = await checkLatestRelease(app.getVersion());
      if (result.ok) {
        rememberLatestAppUpdate(result.latest, result.checkedAt);
        if (force && result.newer) restoreDismissedAppUpdate(result.latest?.version);
        appUpdateLastError = null;
      } else {
        appUpdateLastError = force ? (result.error || 'Update check failed') : null;
        if (!force) console.warn('App update check failed:', result.error);
      }
    } catch (error) {
      const message = error.message || String(error);
      appUpdateLastError = force ? message : null;
      if (!force) console.warn('App update check threw:', error);
      return { ok: false, newer: false, latest: null, error: message };
    } finally {
      appUpdateCheckInFlight = false;
      sendAppUpdatePush();
    }
    return result;
  })();
  appUpdateCheckPromise = checkTask;
  try {
    await checkTask;
  } finally {
    if (appUpdateCheckPromise === checkTask) appUpdateCheckPromise = null;
  }
  return deriveAppUpdateState();
}

function maybeRunBackgroundUpdateCheck() {
  runAppUpdateCheck({ force: false }).catch(() => {});
}

function startAppUpdateBackgroundChecks() {
  if (appUpdateBackgroundTimer) return;
  appUpdateBackgroundTimer = setInterval(maybeRunBackgroundUpdateCheck, 60 * 60 * 1000);
  appUpdateBackgroundTimer.unref?.();
}

function dismissAppUpdateVersion(version) {
  if (typeof version !== 'string' || !version) return deriveAppUpdateState();
  settings.appUpdate = {
    ...(settings.appUpdate || {}),
    dismissedVersion: version
  };
  saveSettings();
  sendAppUpdatePush();
  return deriveAppUpdateState();
}

async function downloadAndPrepareAppUpdate() {
  const support = nativeAppUpdateInstallSupport();
  if (!support.supported) {
    setNativeAppUpdateState({ phase: 'error', error: support.reason || 'unsupported-platform', progress: null });
    return deriveAppUpdateState();
  }
  if (updateInstallQuit.isOutstanding()) return deriveAppUpdateState();
  if (appUpdateCheckPromise) await appUpdateCheckPromise;
  if (appUpdateNativeBusy) return deriveAppUpdateState();
  const latest = settings?.appUpdate?.lastKnownLatest || null;
  if (downloadedAppUpdateMatchesLatest({
    phase: appUpdateNativeState.phase,
    downloadedVersion: appUpdateNativeState.version,
    latest
  })) return deriveAppUpdateState();
  restoreDismissedAppUpdate(latest?.version);
  configureNativeAppUpdater();
  appUpdateNativeBusy = true;
  setNativeAppUpdateState({ phase: 'checking', progress: null, error: null });
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo || null;
    const version = semver.valid(info?.version) || null;
    if (!version || !semver.gt(version, app.getVersion())) {
      appUpdateNativeBusy = false;
      setNativeAppUpdateState({ phase: 'idle', version, progress: null, error: null });
      return deriveAppUpdateState();
    }
    setNativeAppUpdateState({ phase: 'downloading', version, progress: 0, error: null });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    appUpdateNativeBusy = false;
    setNativeAppUpdateState({ phase: 'error', progress: null, error: error?.message || String(error) });
  }
  return deriveAppUpdateState();
}

async function installDownloadedAppUpdate() {
  if (appUpdateCheckPromise) await appUpdateCheckPromise;
  const latest = settings?.appUpdate?.lastKnownLatest || null;
  if (!downloadedAppUpdateMatchesLatest({
    phase: appUpdateNativeState.phase,
    downloadedVersion: appUpdateNativeState.version,
    latest
  })) return deriveAppUpdateState();
  if (!updateInstallQuit.request()) {
    if (updateInstallQuit.phase() === 'spent') {
      setNativeAppUpdateState({
        phase: 'error',
        progress: null,
        error: 'Update install was already attempted',
        errorKind: 'attempt-spent'
      });
    }
    return deriveAppUpdateState();
  }
  try {
    // isSilent: skip the NSIS installer UI on Windows so the update feels seamless
    // (per-user install needs no elevation); isForceRunAfter relaunches the app.
    autoUpdater.quitAndInstall(true, true);
  } catch (error) {
    updateInstallQuit.abort();
    setNativeAppUpdateState({
      phase: 'error',
      progress: null,
      error: error?.message || String(error || 'Update failed'),
      errorKind: installFailureErrorKind({ spent: updateInstallQuit.isSpent() })
    });
  }
  return deriveAppUpdateState();
}

function isAllowedExternalUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch (_) { return false; }
  if (parsed.protocol !== 'https:') return false;
  const enterpriseHost = settings?.copilotEnterpriseHost || process.env.COPILOT_ENTERPRISE_HOST || process.env.GITHUB_ENTERPRISE_HOST || '';
  if (isAllowedVerificationUrl(value, enterpriseHost)) return true;
  if (isAllowedCodexLoginUrl(value)) return true;
  if (parsed.hostname === 'github.com' && parsed.pathname.startsWith('/junhoyeo/tokscale')) return true;
  if (parsed.hostname === 'www.npmjs.com' && parsed.pathname.startsWith('/package/@tokscale/')) return true;
  if (parsed.hostname === 'github.com' && (parsed.pathname.startsWith('/IGNGserver/jiran') || parsed.pathname.startsWith('/IGNGserver/token-monitor-suite'))) return true;
  if ((parsed.hostname === 'cursor.com' || parsed.hostname === 'www.cursor.com') && parsed.pathname.startsWith('/settings')) return true;
  if (parsed.hostname === 'opencode.ai' || parsed.hostname === 'www.opencode.ai') return true;
  if (parsed.hostname === 'openrouter.ai' && parsed.pathname.startsWith('/settings/keys')) return true;
  if (parsed.hostname === 'platform.deepseek.com' && parsed.pathname.startsWith('/api_keys')) return true;
  if (parsed.hostname === 'platform.minimaxi.com') return true;
  if (parsed.hostname === 'platform.minimax.io') return true;
  if (parsed.hostname === 'z.ai' || parsed.hostname === 'www.z.ai') return true;
  if (parsed.hostname === 'bigmodel.cn' || parsed.hostname === 'www.bigmodel.cn') return true;
  if (parsed.hostname === 'www.volcengine.com' || parsed.hostname === 'console.volcengine.com') return true;
  if (parsed.hostname === 'qoder.com' || parsed.hostname === 'www.qoder.com' || parsed.hostname === 'qoder.com.cn' || parsed.hostname === 'www.qoder.com.cn') return true;
  if ((parsed.hostname === 'ollama.com' || parsed.hostname === 'www.ollama.com') && (parsed.pathname === '/settings' || parsed.pathname === '/signin')) return true;
  if ((parsed.hostname === 'kimi.com' || parsed.hostname === 'www.kimi.com') && parsed.pathname.startsWith('/code')) return true;
  return false;
}

function revealWindow(target = mainWindow, options = {}) {
  if (!target || target.isDestroyed() || target.isVisible()) return;
  const inactive = options.inactive === true;
  if (inactive && typeof target.showInactive === 'function') {
    target.showInactive();
    return;
  }
  target.show();
}

function loadWindowFile(target, options = {}) {
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    // A sign-in launch stays in the tray. The tray, the Dock and the second-instance
    // path can all still bring the window up, so nothing is lost by not showing it.
    if (options.startHidden === true && settings.startHidden !== false) {
      cleanup();
      return;
    }
    revealWindow(target, { inactive: options.inactive === true });
  };
  const waitForContent = options.waitForContent === true;
  const onContentReady = (event) => {
    if (event.sender === target.webContents) reveal();
  };
  const fallbackTimer = setTimeout(reveal, 2500);
  const cleanup = () => {
    clearTimeout(fallbackTimer);
    ipcMain.removeListener('window:contentReady', onContentReady);
  };
  target.once('show', cleanup);
  target.once('closed', cleanup);
  if (waitForContent) {
    // A recreated window paints its static "0" defaults before the renderer's
    // async stats fetch resolves; revealing on load would flash empty content.
    // Wait until the renderer reports it has rendered real data instead.
    ipcMain.on('window:contentReady', onContentReady);
    target.webContents.once('did-finish-load', () => applyZoomFactor(target));
  } else {
    target.once('ready-to-show', reveal);
    target.webContents.once('did-finish-load', () => {
      applyZoomFactor(target);
      reveal();
    });
  }
  target.webContents.once('did-fail-load', (_event, code, description) => {
    console.log(`[window] renderer load failed: ${code} ${description}`);
    reveal();
  });
  const filePath = path.join(__dirname, 'renderer', 'index.html');
  const load = options.query ? target.loadFile(filePath, { query: options.query }) : target.loadFile(filePath);
  load.catch((error) => {
    console.log(`[window] renderer load failed: ${error.message}`);
    reveal();
  });
}

function createWindow(boundsOverride, options = {}) {
  ensureSettingsLoaded();
  const glass = nativeBlurEnabled();
  const macosGlassStyle = macosGlassStyleFor(settings);
  const windowsSurface = windowsSurfaceFor({ systemGlass: glass });
  const nativeWindowsBackdrop = windowsSurface.nativeBackdrop;
  // Only the very first window of a sign-in launch starts hidden: a later rebuild
  // (material change, activation, restore) happens while the user is looking for it.
  const startHidden = !initialWindowCreated && hiddenLaunchRequested();
  initialWindowCreated = true;
  // Resolving the surface also pins nativeTheme.themeSource, so the native
  // controls and the web content start on the same theme.
  const nativeSurface = resolveNativeSurface(settings);
  const bounds = boundsOverride || restoredBounds() || DEFAULT_WINDOW;
  // A normal application window: framed, resizable, minimizable, and present in
  // the taskbar/Dock. The widget-era build's borderless always-on-top chrome is gone, so
  // `frame: false`, `transparent`, `skipTaskbar` and the fixed collapsed size
  // have no remaining caller. macOS keeps an inset title bar so the traffic
  // lights sit on the app's own toolbar, which is the platform convention for a
  // window with a full-height sidebar.
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(typeof bounds.x === 'number' ? { x: bounds.x, y: bounds.y } : {}),
    ...WINDOW_LIMITS,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: windowsTitleBarOverlayOptions(settings) }
      : {}),
    show: false,
    backgroundColor: (glass || nativeWindowsBackdrop) ? '#00000000' : nativeSurface.background,
    icon: APP_ICON_PATH,
    autoHideMenuBar: process.platform !== 'darwin',
    ...(process.platform === 'darwin' && glass && macosGlassStyle === MACOS_GLASS_VIBRANCY
      ? { vibrancy: 'under-window', visualEffectState: 'active' }
      : {}),
    ...(process.platform === 'win32' && nativeWindowsBackdrop
      ? { backgroundMaterial: windowsSurface.nativeMaterial }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  applyNativeTheme(win);
  applyMacosNativeWindowButtons(win);
  applyWindowsChrome(win, { round: true });
  if (windowsSurface.useLegacyAccent) applyWindowsAccentBlur(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
  });
  applyWindowSettings();
  applyNativeMaterial();
  keepNativeBlurActive();
  win.on('focus', () => {
    keepNativeBlurActive();
  });
  win.on('show', replayDeferredStatsPush);
  win.on('restore', replayDeferredStatsPush);
  win.on('blur', () => {
    keepNativeBlurActive();
  });
  win.on('resized', persistBoundsSoon);
  win.on('moved', persistBoundsSoon);
  // Keep the collector alive when the user closes the window. The explicit Quit
  // action (tray menu, app menu, update hand-off or signal) sets quitRequested
  // first and is therefore still allowed to destroy the window and process.
  win.on('close', (event) => {
    if (quitRequested) return;
    // Closing to the tray is the default, but it is a choice: with it off, or with
    // no tray to fall back to, the window really closes and the app follows.
    if (settings.closeToTray === false) return;
    if (!applicationTray || applicationTray.isDestroyed?.()) return;
    event.preventDefault();
    win.hide();
  });
  win.webContents.on('before-input-event', handleZoomShortcut);
  loadWindowFile(win, {
    waitForContent: options.waitForContent === true,
    inactive: options.inactive === true,
    startHidden,
    query: {
      ...initialRendererViewStateQuery(rendererViewState),
      ...(settings?.systemGlass === false ? { systemGlassDisabled: '1' } : {}),
      windowSurface: effectiveWindowSurface(settings),
      ...(process.platform === 'win32' ? { windowsSurface: windowsSurface.kind } : {})
    }
  });
}

function handleZoomShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const key = input.key;
  if (!(input.control || input.meta)) return;
  if (key === '=' || key === '+') { event.preventDefault(); adjustZoom(ZOOM_LIMITS.step); }
  else if (key === '-' || key === '_') { event.preventDefault(); adjustZoom(-ZOOM_LIMITS.step); }
  else if (key === '0') { event.preventDefault(); setZoomFactor(1); }
}





async function getDashboardHistory(options = {}) {
  const deviceId = String(options?.query?.get?.('deviceId') || '').trim();
  const localDeviceHistory = () => deviceId && String(localDevice?.deviceId || '') === deviceId
    ? aggregateHistory([localDevice])
    : null;
  if (mode === 'local') {
    // The local collector keeps localDevice.history current (watch + interval
    // ticks, with carry-forward), so read it directly — exactly as the hub
    // branch reads /api/history. Forcing a full collection tick here made the
    // fetch take seconds; on a quick close/reopen the response outlived the
    // renderer and was dropped, stranding the dashboard on its empty state.
    const history = deviceId && !localDeviceHistory()
      ? aggregateHistory([])
      : aggregateHistory(localDevice ? [localDevice] : []);
    if (localDevice) cacheLocalSnapshot({ history });
    return history;
  }
  ensureDesktopSnapshotCacheLoaded();
  const config = safeEffectiveHubConfig();
  if (!config.ok) {
    const error = new Error('Hub history transport is unavailable');
    error.code = config.error?.code || 'hub_history_transport_unavailable';
    updateSyncHealth('rest', { state: 'error', lastFailureAt: new Date().toISOString(), failureCode: error.code });
    if (deviceId) {
      const localHistory = localDeviceHistory();
      if (localHistory) return localHistory;
      throw error;
    }
    return desktopSnapshotCache?.hub?.history
      || desktopSnapshotCache?.local?.history
      || aggregateHistory(lastCollectedDevice ? [lastCollectedDevice] : []);
  }
  const { url: hubUrl, secret } = config;
  if (!hubUrl) {
    const error = new Error('Hub history is not configured');
    error.code = 'hub_not_configured';
    updateSyncHealth('rest', { state: 'blocked', lastFailureAt: new Date().toISOString(), failureCode: error.code });
    if (deviceId) {
      const localHistory = localDeviceHistory();
      if (localHistory) return localHistory;
      throw error;
    }
    return desktopSnapshotCache?.hub?.history
      || desktopSnapshotCache?.local?.history
      || aggregateHistory(lastCollectedDevice ? [lastCollectedDevice] : []);
  }
  const historyUrl = new URL(`${hubUrl.replace(/\/$/, '')}/api/history`);
  if (deviceId) historyUrl.searchParams.set('deviceId', deviceId);
  try {
    const response = await fetchBufferedWithTimeout(fetch, historyUrl, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {}
    }, HUB_REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      const error = new Error('Hub history request failed');
      error.status = response.status;
      error.code = stableSyncFailureCode(error, 'hub_history_failed');
      throw error;
    }
    const history = await response.json();
    if (!deviceId) cacheHubSnapshot({ history });
    updateSyncHealth('rest', { state: 'ok', lastSuccessAt: new Date().toISOString(), failureCode: null, status: null });
    return history;
  } catch (error) {
    updateSyncHealth('rest', {
      state: 'error',
      lastFailureAt: new Date().toISOString(),
      failureCode: stableSyncFailureCode(error, 'hub_history_failed'),
      status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null
    });
    if (deviceId) {
      const localHistory = localDeviceHistory();
      if (localHistory) return localHistory;
      throw error;
    }
    // History is an enhancement to the cached stats snapshot. Preserve the
    // last full trend data when the Hub is unavailable, then fall back to the
    // current local record if this is a first-ever connection.
    return desktopSnapshotCache?.hub?.history
      || desktopSnapshotCache?.local?.history
      || aggregateHistory(lastCollectedDevice ? [lastCollectedDevice] : []);
  }
}

function fetchSessionDetail(args) {
  const { client, sessionId, period, sessionCost } = args || {};
  return readSessionDetail({ client, sessionId, period, sessionCost, home: os.homedir() });
}

// What this device can serve. The shared UI reads these the same way it reads a
// Hub's /api/capabilities, so a view can hide a surface it cannot populate
// instead of rendering an empty state that looks like real data.
function localCapabilitiesForRenderer() {
  const hubCaps = latestHubStats?.capabilities || {};
  const clientMode = settings?.hubMode === 'client';
  return {
    authenticated: true,
    role: clientMode ? 'client' : 'local',
      capabilities: {
      stats: true,
      history: true,
      statsStream: clientMode,
      subscriptions: clientMode && hubCaps.subscriptions !== false,
      usageRange: !clientMode || hubCaps.usageRange !== false,
      pricing: clientMode && hubCaps.pricing !== false,
      deviceDelete: clientMode && hubCaps.deviceDelete !== false,
      deviceRename: clientMode && hubCaps.deviceRename !== false,
      hubAccounts: clientMode && hubCaps.hubAccounts !== false,
      centralLimits: true,
      limitsAuthority: 'hub',
      // Desktop-only surfaces, gated so the shared UI can render them
      // consistently without branching on platform.
      themeEditor: true,
      desktopSettings: true
    }
  };
}

// Proxies a Hub-owned route through this process, which owns the secret. Used
// for accounts/subscriptions/pricing and the device rename/delete actions; the
// shared UI reaches them by the same path it uses in the browser.
async function requestHubRoute(path, options = {}) {
  const config = effectiveHubConfig();
  if (!config.url) throw Object.assign(new Error('Hub is not configured'), { code: 'hub_not_configured' });
  const method = String(options.method || 'GET').toUpperCase();
  const normalizedPath = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  const needsSecret = method !== 'GET' || normalizedPath.startsWith('/api/accounts') || normalizedPath.startsWith('/api/subscriptions') || normalizedPath.startsWith('/api/pricing');
  if (needsSecret && !config.secret) {
    throw Object.assign(new Error('Hub secret is not configured'), { code: 'hub_secret_not_configured' });
  }
  const headers = {};
  if (config.secret) headers.authorization = `Bearer ${config.secret}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchBufferedWithTimeout(fetch, `${config.url.replace(/\/$/, '')}${normalizedPath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {})
  }, HUB_REQUEST_TIMEOUT_MS);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || body.message || `Hub request failed (${response.status})`);
    Object.assign(error, {
      code: body.code || 'hub_request_failed',
      status: response.status,
      payload: body
    });
    throw error;
  }
  return body;
}

// Validate a newly entered Hub secret before replacing the process-owned
// credential. Normal renderer requests deliberately cannot override that
// credential, so secret rotation needs this separate, one-shot path.
async function validateHubSecret(secret) {
  const config = effectiveHubConfig();
  if (!config.url) throw Object.assign(new Error('Hub is not configured'), { code: 'hub_not_configured' });
  const candidate = String(secret || '').trim();
  if (!candidate) throw Object.assign(new Error('Hub secret is not configured'), { code: 'hub_secret_not_configured' });
  const response = await fetchBufferedWithTimeout(fetch, `${config.url.replace(/\/$/, '')}/api/capabilities`, {
    headers: { authorization: `Bearer ${candidate}` }
  }, HUB_REQUEST_TIMEOUT_MS);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || body.message || `Hub request failed (${response.status})`);
    Object.assign(error, {
      code: body.code || (response.status === 401 ? 'unauthorized' : 'hub_request_failed'),
      status: response.status,
      payload: body
    });
    throw error;
  }
  return body;
}

// Serves the shared UI's `/api/*` calls from this device. Local data comes from
// the running collector/runtime; Hub-owned resources are proxied with the
// process-held secret so the renderer never sees a credential.
const desktopRouter = createRequestRouter({
  getSettings: () => settingsForRenderer(),
  getStats: (options) => fetchStats(options),
  getHistory: (options) => getDashboardHistory(options),
  getCustomRange: (options) => fetchCustomRangeStats(options?.body || options),
  getSessionDetail: (args) => fetchSessionDetail(args),
  getCapabilities: () => localCapabilitiesForRenderer(),
  getHealth: () => {
    const caps = localCapabilitiesForRenderer();
    return {
      ok: true,
      role: 'desktop',
      secretRequired: false,
      capabilities: caps?.capabilities || {}
    };
  },
  getRates: () => ({
    rates: effectiveRates || resolveEffectiveRates(rateCache?.rates || {}, settings?.currencyRates || {}),
    source: rateCache?.source || null,
    date: rateCache?.date || null,
    fetchedAt: rateCache?.fetchedAt || null
  }),
  hubRequest: (path, options) => requestHubRoute(path, options)
});

function rebuildWindow() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const wasFocused = mainWindow.isFocused();
  const old = mainWindow;
  old.removeAllListeners('close');
  // Build the new window first so total window count never drops to 0
  // (otherwise window-all-closed fires and quits the app on Windows).
  createWindow(bounds);
  mainWindow.once('show', () => {
    if (!old.isDestroyed()) old.destroy();
    if (wasFocused && !mainWindow.isDestroyed()) mainWindow.focus();
  });
}

async function fetchCustomRangeStats(rangeInput) {
    if (settings.hubMode === 'client' && latestHubStats?.capabilities?.usageRange === false) {
      return {
        ok: false,
        error: 'hub-capability-unsupported',
        message: 'The connected Hub does not support custom usage ranges.'
      };
    }
    const { normalizeCustomRange } = require('../shared/customRange');
    const range = normalizeCustomRange(rangeInput || {});
    if (!range.ok) {
      return { ok: false, error: range.error || 'invalid-range', message: range.error || 'invalid-range' };
    }

    const rangeMeta = {
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
    };

    const collectLocalCustomRange = async () => {
      const clients = TRACKED_CLIENTS;
      const commandTimeoutMs = Number(process.env.TOKEN_MONITOR_COMMAND_TIMEOUT_MS) || 120000;
      const result = await collectCustomRangeOnce({
        clients,
        range,
        commandTimeoutMs,
        homeDir: os.homedir()
      });
      return { ok: true, ...result };
    };

    const isEmptyCustomRangePeriod = (period) => {
      if (!period || typeof period !== 'object') return true;
      if (Math.round(Number(period.totalTokens) || 0) > 0) return false;
      if (Object.keys(period.clients || {}).some((key) => Number(period.clients[key]) > 0)) return false;
      if (Object.keys(period.models || {}).some((key) => Number(period.models[key]) > 0)) return false;
      return true;
    };

    const mergeCustomRangeDetails = (aggregatePeriod, localPeriod) => {
      const aggregate = aggregatePeriod && typeof aggregatePeriod === 'object' ? aggregatePeriod : {};
      const local = localPeriod && typeof localPeriod === 'object' ? localPeriod : {};
      return {
        ...aggregate,
        // /api/usage/range currently returns aggregate totals but deliberately
        // omits unbounded session/project detail. The desktop process already
        // has the authoritative local detail, so keep Hub totals and restore
        // the detail needed by the desktop breakdown views.
        projects: local.projects && typeof local.projects === 'object' ? local.projects : aggregate.projects || {},
        sessions: local.sessions && typeof local.sessions === 'object' ? local.sessions : aggregate.sessions || {}
      };
    };

    // Hub modes prefer /api/usage/range so multi-device totals match mobile/web.
    // When hub history/events are empty (common before graph history is warm) or
    // the hub call fails, fall back to a local tokscale scan so the desktop
    // app still shows the same data as the Day tab.
    if (mode !== 'local') {
      let hubError = null;
      try {
        const config = safeEffectiveHubConfig();
        if (!config.ok) {
          const error = new Error('Hub usage-range transport is unavailable');
          error.code = config.error?.code || 'hub_range_transport_unavailable';
          throw error;
        }
        const { url: hubUrl, secret } = config;
        if (!hubUrl) {
          const error = new Error('Hub usage-range is not configured');
          error.code = 'hub_not_configured';
          throw error;
        }
        const params = new URLSearchParams({
          startDate: range.startDate,
          endDate: range.endDate,
          startHour: String(range.startHour),
          endHour: String(range.endHour)
        });
        const url = `${hubUrl.replace(/\/$/, '')}/api/usage/range?${params}`;
        const response = await fetchBufferedWithTimeout(fetch, url, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }, HUB_REQUEST_TIMEOUT_MS);
        if (!response.ok) {
          const error = new Error('Hub usage-range request failed');
          error.status = response.status;
          error.code = stableSyncFailureCode(error, 'hub_range_failed');
          throw error;
        }
        const body = await response.json();
        updateSyncHealth('rest', { state: 'ok', lastSuccessAt: new Date().toISOString(), failureCode: null, status: null });
        const hubPeriod = {
          totalTokens: Math.round(Number(body.totalTokens) || 0),
          costUsd: Number(body.costUsd) || 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          clients: body.clients || {},
          clientCosts: body.clientCosts || {},
          clientCredits: body.clientCredits || {},
          clientCacheReads: {},
          clientCacheWrites: {},
          clientOutputs: {},
          models: body.models || {},
          modelCosts: body.modelCosts || {},
          modelCacheReads: {},
          modelCacheWrites: {},
          modelOutputs: {},
          clientModels: body.clientModels || {},
          clientModelCosts: body.clientModelCosts || {},
          projects: Object.create(null),
          sessions: {}
        };
        let local = null;
        try {
          local = await collectLocalCustomRange();
        } catch (localError) {
          if (isEmptyCustomRangePeriod(hubPeriod)) throw localError;
        }
        if (!isEmptyCustomRangePeriod(hubPeriod)) {
          const localPeriod = local?.period || {};
          return {
            ok: true,
            range: rangeMeta,
            period: mergeCustomRangeDetails(hubPeriod, localPeriod),
            devices: localPeriod && !isEmptyCustomRangePeriod(localPeriod)
              ? [{
                deviceId: settings.deviceId || defaultDeviceId(),
                periods: { custom: localPeriod },
                updatedAt: new Date().toISOString()
              }]
              : [],
            source: local && !isEmptyCustomRangePeriod(localPeriod)
              ? `${body.source || 'history_daily'}+local-details`
              : (body.source || 'history_daily'),
            updatedAt: new Date().toISOString()
          };
        }
      } catch (error) {
        hubError = error;
        updateSyncHealth('rest', {
          state: 'error',
          lastFailureAt: new Date().toISOString(),
          failureCode: stableSyncFailureCode(error, 'hub_range_failed'),
          status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null
        });
      }

      try {
        const local = await collectLocalCustomRange();
        if (!isEmptyCustomRangePeriod(local.period) || !hubError) {
          return {
            ...local,
            source: local.source || (hubError ? 'local_fallback_after_hub_error' : 'local_fallback_empty_hub')
          };
        }
      } catch (localError) {
        if (hubError) {
          return {
            ok: false,
            error: hubError?.code || 'hub-range-failed',
            message: hubError?.message || String(hubError)
          };
        }
        return {
          ok: false,
          error: localError?.code || 'collect-failed',
          message: localError?.message || String(localError)
        };
      }

      if (hubError) {
        return {
          ok: false,
          error: hubError?.code || 'hub-range-failed',
          message: hubError?.message || String(hubError)
        };
      }
    }

    try {
      return await collectLocalCustomRange();
    } catch (error) {
      return {
        ok: false,
        error: error?.code || 'collect-failed',
        message: error?.message || String(error)
      };
    }
}

// Sleep leaves the collection timer late and the Hub stream half-open. The stream
// has an idle watchdog, but resume is the moment to stop waiting for it; a short
// delay gives the network stack back before the mode is re-established.
const RESUME_RECONNECT_DELAY_MS = 2000;
let resumeReconnectTimer = null;
function handleSystemResume() {
  clearTimeout(resumeReconnectTimer);
  resumeReconnectTimer = setTimeout(() => { startMode(); }, RESUME_RECONNECT_DELAY_MS);
}

// Shared by the renderer's app-info request and the diagnostics bundle, so the two
// can never disagree about what this machine is.
function appDiagnosticsInfo() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
    sharedDataDir: sharedDataDir(),
    loginItemSupported: loginItemEnabledHere(),
    loginItemOpenAtLogin: currentLoginItemState(),
    effectiveWindowSurface: effectiveWindowSurface(settings)
  };
}

// The tooltip is the only always-visible tray surface, so it carries the two facts
// that matter without a window: that collection is paused, and what today cost.
// The prefix is the localized display name (zh users see 计然, not the romanization).
function trayTooltipText() {
  const brand = nativeShellText('brand.name');
  if (settings?.collectionPaused === true) return `${brand} · ${nativeShellText('trayMenu.paused')}`;
  const tokens = Number((localDevice || lastCollectedDevice)?.today?.totalTokens || 0);
  return tokens > 0
    ? `${brand} · ${nativeShellText('trayMenu.tooltipToday', { tokens: formatCompactTokens(tokens) })}`
    : brand;
}

// One function so the tray, the settings switch and any later menu entry all take
// the same path: persist, rebuild the runtime, tell the renderer, refresh the tray.
function setCollectionPaused(paused) {
  const next = paused === true;
  if (!settings || settings.collectionPaused === next) return;
  settings.collectionPaused = next;
  saveSettings();
  void startMode();
  pushSettingsToRenderer();
  refreshApplicationTrayMenu();
}

// The native shell (menu bar, tray, dialogs) resolves `auto` from the OS locale,
// which a renderer reads off `navigator` but this process has to ask Electron for.
function nativeShellText(key, params) {
  return translate(resolveLocale(settings?.language || 'auto', [app.getLocale()]), key, params);
}

// A normal application has a menu bar. It also gives the shared UI a
// keyboard-reachable entry point to Settings and each view. Rebuilt when the
// language changes: the menu is native, so a renderer re-render cannot relabel it.
function buildApplicationMenu() {
  // The About panel is native on Windows/Linux and reads app.name by default;
  // show the localized display name there, same as the menu/tray. macOS builds
  // its panel from the bundle (CFBundleName = the ASCII install identity) and
  // offers no runtime override — that is the intended split: ASCII path/bundle,
  // localized display.
  if (process.platform !== 'darwin') {
    try {
      app.setAboutPanelOptions({ applicationName: nativeShellText('brand.name'), applicationVersion: appVersion() });
    } catch (_) { /* older Electron without the API keeps app.name */ }
  }
  createAppMenu({
    getWindow: () => mainWindow,
    openView: openSharedUiView,
    checkForUpdates: () => runAppUpdateCheck({ force: true }),
    openUserData: () => { void shell.openPath(app.getPath('userData')); },
    translate: nativeShellText,
    appVersion: appVersion()
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(APP_ICON_PATH);
  ensureSettingsLoaded();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_HEADER]
      }
    });
  });
  createWindow();
  try {
    const trayHandle = createApplicationTray({
      iconPath: APP_ICON_PATH,
      templateIconPath: TRAY_ICON_PATH,
      getWindow: () => mainWindow,
      onOpenSettings: () => openSharedUiView('settings'),
      onOpenView: openSharedUiView,
      onQuit: () => app.quit(),
      isCollectionPaused: () => settings?.collectionPaused === true,
      onToggleCollectionPaused: () => setCollectionPaused(!(settings?.collectionPaused === true)),
      tooltip: trayTooltipText,
      translate: nativeShellText
    });
    applicationTray = trayHandle.tray;
    refreshApplicationTrayMenu = trayHandle.refreshMenu;
  } catch (error) {
    // A missing desktop shell (for example, a Linux session without a tray
    // host) must not prevent the collector window from starting. In that rare
    // case close behaves like a normal quit because there is no safe recovery
    // surface to leave the user with.
    console.log(`[tray] unavailable: ${error?.message || error}`);
  }
  syncLoginItemSettingFromOs();
  cleanupStaleStaging().catch((error) => console.log(`[tokscale] staging cleanup failed: ${error.message}`));
  buildApplicationMenu();
  powerMonitor.on('resume', handleSystemResume);
  rateCache = readRateCache();
  applyEffectiveRates();                 // use cache/defaults immediately, avoid first-paint gap
  refreshExchangeRates();                // non-blocking: only fetches when stale
  rateRefreshTimer = setInterval(() => { refreshExchangeRates(); }, 6 * 60 * 60 * 1000);
  ipcMain.handle('settings:get', () => settingsForRenderer());
  ipcMain.handle('pricing:lookup', async (_event, modelId) => {
    try {
      return { ok: true, result: await lookupModelPricing(modelId) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('settings:update', (_event, patch) => {
    const previousSettingsState = settings;
    const previousRuntimeSettings = JSON.parse(JSON.stringify(settings));
    const previousNativeMaterial = nativeBlurEnabled();
    const previousWindowsSurface = windowsSurfaceFor({ systemGlass: previousNativeMaterial }).kind;
    const previousStartAtLogin = settings.startAtLogin;
    const normalizedCurrency = patch.currency !== undefined ? normalizeCurrency(patch.currency, settings.currency) : normalizeCurrency(settings.currency);
    // A renderer (or an old preload) must not resurrect a key the app has
    // retired: the same list readSettings drops on load is dropped on write.
    const normalizedPatch = {
      ...withoutRetiredKeys(withoutInternalOnlyKeys(stripLegacyLocalLimitSettings(patch))),
      currency: normalizedCurrency
    };
    if (patch.hubUrl !== undefined) normalizedPatch.hubUrl = normalizeHubUrl(patch.hubUrl);
    delete normalizedPatch.hubAdminSecret;
    if (patch.allowInsecureHubHttp !== undefined) {
      normalizedPatch.allowInsecureHubHttp = parseBoolean(patch.allowInsecureHubHttp, false);
    }
    const requestedHubMode = patch.hubMode !== undefined ? normalizeHubMode(patch.hubMode, settings.hubMode) : settings.hubMode;
    const requestedHubUrl = normalizedPatch.hubUrl !== undefined ? normalizedPatch.hubUrl : settings.hubUrl;
    const allowInsecureHubHttp = normalizedPatch.allowInsecureHubHttp !== undefined
      ? normalizedPatch.allowInsecureHubHttp
      : settings.allowInsecureHubHttp;
    if (requestedHubMode === 'client' && requestedHubUrl) {
      requireSafeHubTransport(requestedHubUrl, { allowInsecureHttp: allowInsecureHubHttp === true });
    }
    delete normalizedPatch.hubHostPort;
    delete normalizedPatch.hubHostSecret;
    delete normalizedPatch.hubHostAdminSecret;
    delete normalizedPatch.hubAccountCredentialKey;
    if (patch.heatmapMetric !== undefined) normalizedPatch.heatmapMetric = normalizeHeatmapMetric(patch.heatmapMetric, settings.heatmapMetric);
    if (patch.homeActiveDaysWindow !== undefined) normalizedPatch.homeActiveDaysWindow = normalizeHomeActiveDaysWindow(patch.homeActiveDaysWindow, settings.homeActiveDaysWindow);
    settings = {
      ...settings,
      ...normalizedPatch,
      hubMode: patch.hubMode !== undefined ? normalizeHubMode(patch.hubMode, settings.hubMode) : settings.hubMode,
      deviceId: normalizeDeviceIdValue(patch.deviceId !== undefined ? patch.deviceId : settings.deviceId, ''),
      theme: normalizeThemeChoice(patch.theme !== undefined ? patch.theme : settings.theme),
      systemGlass: parseBoolean(patch.systemGlass ?? settings.systemGlass, true),
      collectionPaused: parseBoolean(patch.collectionPaused ?? settings.collectionPaused, false),
      closeToTray: parseBoolean(patch.closeToTray ?? settings.closeToTray, true),
      startHidden: parseBoolean(patch.startHidden ?? settings.startHidden, true),
      macosGlassStyle: normalizeMacosGlassStyle(patch.macosGlassStyle ?? settings.macosGlassStyle),
      windowsBackdrop: normalizeWindowsBackdropMode(patch.windowsBackdrop ?? settings.windowsBackdrop),
      reduceMotion: motionPreferenceApi.normalize(patch.reduceMotion ?? settings.reduceMotion),
      homeLimitAccountCount: normalizeHomeLimitAccountCount(patch.homeLimitAccountCount ?? settings.homeLimitAccountCount),
      zoomFactor: clampZoom(patch.zoomFactor ?? settings.zoomFactor),
      currency: normalizedCurrency,
      currencyRates: patch.currencyRates !== undefined ? normalizeCurrencyOverrides(patch.currencyRates) : normalizeCurrencyOverrides(settings.currencyRates),
      language: patch.language !== undefined ? normalizeLanguageSetting(patch.language, settings.language) : normalizeLanguageSetting(settings.language),
      startAtLogin: loginItemEnabledHere() ? parseBoolean(patch.startAtLogin ?? settings.startAtLogin, false) : false
    };
    delete settings.edgeDrawerEnabled;
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      settings = previousSettingsState;
      throw error;
    }
    if (settings.startAtLogin !== previousStartAtLogin) {
      // Trust the request over the read-back: an OS layer that cannot confirm
      // the entry (a moved AppImage mount, a registry hiccup) must not bounce
      // the switch back while it is still showing the requested state. The
      // startup-time sync re-converges the stored value with reality.
      const applied = applyLoginItem(settings.startAtLogin);
      if (applied !== settings.startAtLogin) {
        console.warn(`[settings] login-item read-back mismatch: requested ${settings.startAtLogin}, OS reports ${applied}`);
      }
      saveSettings({ throwOnError: true });
    } else if (previousRuntimeSettings.startHidden !== settings.startHidden && settings.startAtLogin) {
      // The hidden-launch flag is part of what gets registered at login, so
      // changing it has to rewrite the entry even though "start at login" itself
      // did not change.
      applyLoginItem(true);
    }
    if (patch.zoomFactor !== undefined) applyZoomFactor();
    applyWindowSettings();
    applyNativeTheme(mainWindow, settings);
    const nextNativeMaterial = nativeBlurEnabled();
    const nextWindowsSurface = windowsSurfaceFor({ systemGlass: nextNativeMaterial }).kind;
    const surfaceChanged = previousRuntimeSettings.systemGlass !== settings.systemGlass
      || previousRuntimeSettings.windowsBackdrop !== settings.windowsBackdrop;
    if (process.platform === 'win32' && (
      previousNativeMaterial !== nextNativeMaterial
      || previousWindowsSurface !== nextWindowsSurface
      || surfaceChanged
    )) {
      rebuildWindow();
    } else {
      applyNativeMaterial();
    }
    const runtimeChange = classifySettingsChange(previousRuntimeSettings, settings);
    // Pause is not a structural change (same mode, same config) but it does decide
    // whether the collectors run, so it needs its own restart.
    if (previousRuntimeSettings.collectionPaused !== settings.collectionPaused) {
      startMode();
    } else if (runtimeChange.modeStructural) {
      startMode();
    }
    if (patch.currency !== undefined || patch.currencyRates !== undefined) {
      applyEffectiveRates();               // sync: settingsForRenderer() below sees fresh effective map
      refreshExchangeRates();              // async: fetch if stale, then re-push
    }
    refreshApplicationTrayMenu();
    // The menu bar is native chrome, so only an explicit rebuild follows a
    // language change — the renderer re-localizes itself over the transport.
    if (previousSettingsState?.language !== settings?.language) buildApplicationMenu();
    pushSettingsToRenderer();
    return settingsForRenderer();
  });
  ipcMain.handle('appearance:preview', (_event, patch) => {
    applyNativeMaterial({ ...settings, ...patch });
    if (patch && patch.zoomFactor !== undefined && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(clampZoom(patch.zoomFactor));
    }
    return true;
  });
  ipcMain.on('window:viewState', (_event, patch) => {
    updateRendererViewState(patch);
  });
  ipcMain.handle('stats:getCustomRange', (_event, rangeInput) => fetchCustomRangeStats(rangeInput));

  ipcMain.handle('session:getDetail', (_event, args) => fetchSessionDetail(args));
  ipcMain.handle('sync:recover', () => recoverNow());
  ipcMain.handle('sync:health', () => syncHealthSnapshot());
  ipcMain.handle('desktop:snapshot-meta', () => desktopSnapshotMeta());
  ipcMain.handle('stream:status', () => ({ connected: streamConnected, mode, health: syncHealthSnapshot(), ...(streamFailure || {}) }));
  ipcMain.handle('app:getInfo', () => appDiagnosticsInfo());
  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  ipcMain.handle('app:openExternal', (_event, url) => {
    if (!isAllowedExternalUrl(url)) return { ok: false, error: 'url not in allowlist' };
    return shell.openExternal(url)
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: error.message }));
  });

  // --- Shared-UI transport surface -----------------------------------------
  // The shared UI never touches the Hub directly: this process owns the secret
  // and the transport policy, and the same view code runs against local data or
  // a remote Hub without knowing which. Errors are flattened to a plain object
  // because Error instances do not survive structured clone intact.
  ipcMain.handle('transport:request', async (_event, path, options = {}) => {
    try {
      const data = await desktopRouter.route(path, options);
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error?.message || String(error),
          code: error?.code || null,
          status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null,
          payload: error?.payload ?? null
        }
      };
    }
  });
  ipcMain.handle('hub:validate-secret', async (_event, secret) => {
    try {
      return { ok: true, data: await validateHubSecret(secret) };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error?.message || String(error),
          code: error?.code || null,
          status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null,
          payload: error?.payload ?? null
        }
      };
    }
  });
  ipcMain.handle('transport:flag:read', (_event, key) => {
    if (!isUiFlagKey(key)) return null;
    const value = settings?.[String(key)];
    return value === undefined ? null : value;
  });
  ipcMain.handle('transport:flag:write', (_event, key, value) => {
    // Flags are UI scratch state. Requiring the namespace keeps a future flag from
    // landing on a real setting key by accident — the generic settings write is
    // where validated preferences belong.
    if (!isUiFlagKey(key)) return false;
    settings[String(key)] = value;
    saveSettings();
    return true;
  });
  ipcMain.handle('ui:confirm', async (event, message, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: options.danger ? 'warning' : 'question',
      buttons: [options.confirmLabel || 'OK', options.cancelLabel || 'Cancel'],
      defaultId: options.danger ? 1 : 0,
      cancelId: 1,
      message: String(message || '')
    });
    return response === 0;
  });
  ipcMain.handle('ui:prompt', async (event, message, defaultValue = '') => {
    // Electron has no native text prompt; a modal message box cannot collect
    // input. The renderer keeps a small inline form for this one case, so the
    // main process reports "unsupported" and the shared UI falls back to it.
    return { unsupported: true, message: String(message || ''), value: String(defaultValue || '') };
  });
  ipcMain.handle('hubAccounts:list', () => requestHubAccount('/api/accounts'));
  ipcMain.handle('hubAccounts:add', (_event, request = {}) => requestHubAccount('/api/accounts', {
    method: 'POST',
    body: {
      provider: request.provider,
      name: request.name,
      label: request.label,
      credential: parseHubAccountCredential(request)
    }
  }));
  ipcMain.handle('hubAccounts:update', (_event, id, patch = {}) => {
    const body = {
      name: patch.name,
      label: patch.label,
      enabled: patch.enabled
    };
    if (patch.credential !== undefined || patch.credentialText !== undefined) {
      body.credential = parseHubAccountCredential(patch);
    }
    return requestHubAccount(`/api/accounts/${encodeURIComponent(String(id || '').trim())}`, {
      method: 'PATCH',
      body
    });
  });
  ipcMain.handle('hubAccounts:remove', (_event, id) => requestHubAccount(`/api/accounts/${encodeURIComponent(String(id || '').trim())}`, {
    method: 'DELETE'
  }));
  ipcMain.handle('hubAccounts:refresh', (_event, id) => requestHubAccount(`/api/accounts/${encodeURIComponent(String(id || '').trim())}/refresh`, {
    method: 'POST'
  }));
  ipcMain.handle('appUpdate:getState', () => deriveAppUpdateState());
  ipcMain.handle('appUpdate:checkNow', () => runAppUpdateCheck({ force: true }));
  ipcMain.handle('appUpdate:download', () => downloadAndPrepareAppUpdate());
  ipcMain.handle('appUpdate:install', () => installDownloadedAppUpdate());
  ipcMain.handle('appUpdate:dismiss', (_event, version) => dismissAppUpdateVersion(version));
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.on('window:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('history:get', () => getDashboardHistory());
  // Register the renderer/state surface before starting any collector. A fast
  // local tick or REST bootstrap must never race the initial IPC handlers.
  powerMonitor?.on?.('resume', () => {
    if (settings?.hubMode === 'client') {
      void recoverNow({ forceStream: true }).catch((error) => console.log(`[sync] resume recovery failed: ${error.message}`));
    }
  });
  powerMonitor?.on?.('unlock-screen', () => {
    if (settings?.hubMode === 'client') {
      void recoverNow({ forceStream: true }).catch((error) => console.log(`[sync] unlock recovery failed: ${error.message}`));
    }
  });
  startMode();
  startSyncNetworkMonitor();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusExistingWindow();
  });
  maybeRunBackgroundUpdateCheck();
  startAppUpdateBackgroundChecks();
});

app.on('second-instance', focusExistingWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  quitRequested = true;
  flushDesktopSnapshotCache();
  // Deliver a queued push before tearing down so the final numbers reach the
  // renderer instead of being dropped with the timer.
  flushPendingPush();
  if (rateRefreshTimer) clearInterval(rateRefreshTimer);
  if (appUpdateBackgroundTimer) clearInterval(appUpdateBackgroundTimer);
  stopSyncNetworkMonitor();
  // During a native update the updater owns the restart. Calling app.exit here
  // can pre-empt its hand-off; the watchdog releases this flag if the hand-off
  // never arrives so a later normal quit still works.
  if (skipForcedQuit) return;
  performQuit();
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, requestAppQuit);
}
