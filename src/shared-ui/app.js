import { finishFluentRender, setupFluentInteractions, syncFluentMotion, animateNavigation, animateDataUpdate, setFluentDropdownValue } from './core/fluent.js';
import {
  capabilities,
  clearSecret,
  confirmAction,
  copyText,
  fetchHealth,
  fetchJson,
  getTransport,
  isCapable,
  loadPrefs,
  loadSecret,
  openExternal,
  openStatsStream,
  promptAction,
  readFlag,
  readRoute,
  savePrefs,
  saveSecret,
  secretIsRemembered,
  testSecret,
  writeFlag,
  writeRoute
} from './transport/index.js';
import { applyI18n, resolveLocale, t } from './core/i18n.js';
import {
  isPresetRangePeriod,
  localDayKey,
  presetRangeWindow,
  presetRangeWindowMatches,
  resolveScopePeriod
} from './core/dateRanges.js';
import { configureViewContext, VIEW_HELPER_NAMES } from './core/viewContext.js';
import {
  primarySyncHealthFailure,
  syncHealthFailureLabel,
  syncHealthStateLabel
} from './core/syncHealth.js';
import { renderLimits } from './views/limits.js';
import { renderHome } from './views/home.js';
import { renderUsage, renderTokenMix } from './views/usage.js';
import { renderDevices } from './views/devices.js';
import { readDesktopSettingsPatch } from './views/settingsDesktop.js';
import { managementSections, normalizeManagementSection, renderSettingsPage } from './views/settings.js';
import { submitTransfer } from './views/transfer.js';
import { usageMetricCard } from './views/rows.js';
import {
  renderTrends,
  renderCompletenessNotice,
  renderHistoryScopeNotice
} from './views/trends.js';
import {
  configureRates,
  estimatedValue,
  formatCompact,
  formatCost,
  formatCredits,
  formatNumber,
  toDatetimeLocalValue
} from './core/format.js';
import {
  clientIconPath,
  clampHomeLimitAccountCount,
  ALL_DEVICES_OPTION_VALUE,
  ALL_PROVIDERS_OPTION_VALUE,
  deviceIdFromOptionValue,
  deviceOptionValue,
  isBrowserLoginProvider,
  toolRows
} from './core/data.js';

const UI_ICON_PATHS = Object.freeze({
  home: '<path d="M3.5 10.5 12 3l8.5 7.5v8a1 1 0 0 1-1 1h-5v-5h-5v5h-5a1 1 0 0 1-1-1z"/><path d="M8 20.5h8"/>',
  tool: '<path d="m14.7 6.3 3-3a4 4 0 0 0 1.1 4.9l-6.4 6.4-2-2 6.4-6.4a4 4 0 0 0-4.9-1.1z"/><path d="m11.4 13.6-6.7 6.7a1.4 1.4 0 0 1-2-2l6.7-6.7"/>',
  usage: '<path d="M4 19V5M4 19h16"/><path d="m7 15 3-4 3 2 5-7"/>',
  device: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h3M16 15h.01"/>',
  model: '<path d="m12 3 2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z"/>',
  project: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5z"/>',
  session: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 12h5M8 15h7"/>',
  limits: '<path d="M5 19V9M12 19V5M19 19v-8"/><path d="M3 19h18"/>',
  accounts: '<circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  status: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
  trends: '<path d="M4 17 9 12l3 3 7-8"/><path d="M15 7h4v4"/>',
  subscriptions: '<path d="M5 7h14M5 12h14M5 17h8"/><path d="M17 16v4M15 18h4"/>',
  pricing: '<path d="M6 4h12M6 20h12M8 4c0 4 8 4 8 8s-8 4-8 8"/><path d="M16 4c0 4-8 4-8 8s8 4 8 8"/>',
  management: '<path d="M4 7h16M4 12h16M4 17h10"/><path d="M17 15v6M14 18h6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  back: '<path d="m15 5-7 7 7 7"/><path d="M8 12h12"/>',
  range: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 9h16M8 13h3M13 13h3M8 16h3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.7-4L3 10"/><path d="M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14"/><path d="M21 19v-5h-5"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m19.4 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.2a2 2 0 0 1-4 0v-.2a2 2 0 0 0-3.4-1.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 1.6 12a2 2 0 0 1 2-2h.2a2 2 0 0 0 1.4-3.4l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A2 2 0 0 0 11.4 2h.2a2 2 0 0 1 2 2v.2A2 2 0 0 0 17 5.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A2 2 0 0 0 21.2 12a2 2 0 0 1-2 2H19a2 2 0 0 0-1.4 3.4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  warning: '<path d="m12 3 9 16H3z"/><path d="M12 9v4M12 16h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  arrowUpRight: '<path d="M7 17 17 7M8 7h9v9"/>',
  moreHorizontal: '<circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/>'
});

function uiIcon(name) {
  const path = UI_ICON_PATHS[name] || UI_ICON_PATHS.status;
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
}

function renderStaticUiIcons() {
  document.querySelectorAll('[data-ui-icon]').forEach((element) => {
    element.innerHTML = uiIcon(element.dataset.uiIcon);
  });
}

// The Administration group has one destination: `settings`, labelled 管理. The
// provider accounts and the subscriptions/pricing pages are sections inside it
// rather than separate views, so they are no longer in this list. Which sections
// the page shows is the page's own decision per host (`managementSections()` in
// views/settings.js); the desktop host renders none of the Hub sections.
const VIEWS = [
  { id: 'overview', icon: 'home' },
  { id: 'usage', icon: 'usage' },
  { id: 'devices', icon: 'device' },
  { id: 'limits', icon: 'limits' },
  { id: 'trends', icon: 'trends' },
  { id: 'settings', icon: 'settings' }
];

// Views that were folded into another page. A persisted preference, bookmark or
// native-menu id must still land on the page that now owns their content, not
// fall through to the overview.
const VIEW_REDIRECTS = Object.freeze({ accounts: 'settings', management: 'settings' });

// Which section of the consolidated 管理 page a redirect targets.
const VIEW_SECTION_REDIRECTS = Object.freeze({ accounts: 'accounts', management: 'consumption' });

// Keep the old identifiers in the source and in the URL resolver so existing
// bookmarks, pinned shortcuts, and persisted preferences land on the new page
// without keeping the old 12-item navigation visible.
const LEGACY_VIEWS = [
  { id: 'home', icon: 'home' },
  { id: 'tool', icon: 'tool' },
  { id: 'device', icon: 'device' },
  { id: 'model', icon: 'model' },
  { id: 'project', icon: 'project' },
  { id: 'session', icon: 'session' },
  { id: 'status', icon: 'status' },
  { id: 'subscriptions', icon: 'subscriptions' },
  { id: 'pricing', icon: 'pricing' }
];

// The scope bar's tab order: today / month / allTime are the periods the collector
// puts on the wire, and yesterday / week are calendar presets that resolve through
// /api/usage/range like a picked custom range does. A host without the range API
// hides the preset tabs.
const PERIOD_TABS = ['today', 'yesterday', 'week', 'month', 'allTime'];

const VIEW_PATHS = Object.freeze({
  overview: '/',
  usage: '/usage',
  devices: '/devices',
  limits: '/limits',
  accounts: '/accounts',
  trends: '/trends',
  management: '/management',
  settings: '/settings'
});

const LEGACY_ROUTE_ALIASES = Object.freeze({
  '/home': { view: 'overview' },
  '/tool': { view: 'usage', usageTab: 'tools' },
  '/tools': { view: 'usage', usageTab: 'tools' },
  '/model': { view: 'usage', usageTab: 'models' },
  '/models': { view: 'usage', usageTab: 'models' },
  '/project': { view: 'usage', usageTab: 'projects' },
  '/projects': { view: 'usage', usageTab: 'projects' },
  '/session': { view: 'usage', usageTab: 'sessions' },
  '/sessions': { view: 'usage', usageTab: 'sessions' },
  '/device': { view: 'devices' },
  '/status': { view: 'limits', limitTab: 'health' },
  '/subscriptions': { view: 'settings', managementSection: 'consumption', managementTab: 'subscriptions' },
  '/pricing': { view: 'settings', managementSection: 'consumption', managementTab: 'pricing' },
  '/accounts': { view: 'settings', managementSection: 'accounts' }
});

function normalizeViewId(value) {
  const id = String(value || '').trim();
  if (VIEW_REDIRECTS[id]) return VIEW_REDIRECTS[id];
  if (VIEWS.some((view) => view.id === id)) return id;
  if (!LEGACY_VIEWS.some((view) => view.id === id)) return 'overview';
  return LEGACY_ROUTE_ALIASES[`/${id}`]?.view || 'overview';
}

function routeFromLocation() {
  // The host decides where a route lives: a path on the Hub, a fragment on the
  // desktop client where file:// has no server-side SPA fallback.
  const { path, params } = readRoute();
  const target = LEGACY_ROUTE_ALIASES[path]
    || (Object.entries(VIEW_PATHS).find(([, targetPath]) => targetPath === path)
      ? { view: Object.entries(VIEW_PATHS).find(([, targetPath]) => targetPath === path)[0] }
      : null);
  if (!target) return { view: 'overview' };
  return {
    view: target.view,
    usageTab: ['tools', 'models', 'projects', 'sessions'].includes(params.get('tab'))
      ? params.get('tab')
      : target.usageTab,
    managementTab: ['subscriptions', 'pricing'].includes(params.get('tab'))
      ? params.get('tab')
      : target.managementTab,
    managementSection: managementSections().includes(params.get('section'))
      ? params.get('section')
      : target.managementSection,
    limitTab: params.get('tab') === 'health' || target.limitTab ? 'health' : 'limits'
  };
}

function viewFromLocation() {
  return routeFromLocation().view;
}

function syncUrlForView(viewId, { replace = false, tab = '' } = {}) {
  const targetPath = VIEW_PATHS[viewId] || '/';
  try {
    const params = new URLSearchParams();
    const nextTab = tab || (viewId === 'usage'
      ? state?.prefs?.usageTab
      : viewId === 'settings'
        ? state?.prefs?.managementTab
        : viewId === 'limits'
          ? (state?.prefs?.limitTab === 'health' ? 'health' : '')
          : '');
    if (nextTab && ((viewId === 'usage' && ['tools', 'models', 'projects', 'sessions'].includes(nextTab))
      || (viewId === 'settings' && ['subscriptions', 'pricing'].includes(nextTab))
      || (viewId === 'limits' && nextTab === 'health'))) {
      params.set('tab', nextTab);
    }
    // The consolidated page keeps its section in the URL so a bookmark or a
    // hand-off lands on 账号 / 消费 / 偏好 / 高级 rather than the first section. The
    // desktop host has no routed sections, so it writes no `section` param.
    if (viewId === 'settings' && managementSections().includes(state?.prefs?.managementSection)) {
      params.set('section', state.prefs.managementSection);
    }
    const query = params.toString();
    // Desktop loads from file://, where there is no server-side SPA fallback and
    // a path change would 404. Its transport reports routing:'hash' and builds a
    // `#/view` URL instead.
    if (isCapable('routing') && capabilities().routing === 'hash') {
      writeRoute(viewId, { targetPath, query, replace, hash: true });
      return;
    }
    writeRoute(viewId, { targetPath, query, replace, hash: false });
  } catch {
    /* ignore history errors if sandboxed */
  }
}

const els = {
  app: document.getElementById('app'),
  primaryNav: document.getElementById('primaryNav'),
  streamStatus: document.getElementById('streamStatus'),
  streamStatusText: document.getElementById('streamStatusText'),
  streamStatusDetail: document.getElementById('streamStatusDetail'),
  desktopSyncStatus: document.getElementById('desktopSyncStatus'),
  desktopSnapshotSource: document.getElementById('desktopSnapshotSource'),
  brandSubtitle: document.getElementById('brandSubtitle'),
  settingsOpen: document.getElementById('settingsOpen'),
  settingsOpenTop: document.getElementById('settingsOpenTop'),
  menuToggle: document.getElementById('menuToggle'),
  pwaBanner: document.getElementById('pwaBanner'),
  pwaBannerText: document.getElementById('pwaBannerText'),
  pwaInstallBtn: document.getElementById('pwaInstallBtn'),
  pwaDismissBtn: document.getElementById('pwaDismissBtn'),
  pageTitle: document.getElementById('pageTitle'),
  pageMeta: document.getElementById('pageMeta'),
  periodTabs: document.getElementById('periodTabs'),
  customRangeBtn: document.getElementById('customRangeBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  totalTokens: document.getElementById('totalTokens'),
  totalCost: document.getElementById('totalCost'),
  deviceCount: document.getElementById('deviceCount'),
  liveLabel: document.getElementById('liveLabel'),
  deviceFilter: document.getElementById('deviceFilter'),
  content: document.getElementById('content'),
  authGate: document.getElementById('authGate'),
  authForm: document.getElementById('authForm'),
  secretInput: document.getElementById('secretInput'),
  rememberSecret: document.getElementById('rememberSecret'),
  authError: document.getElementById('authError'),
  settingsDrawer: document.getElementById('settingsDrawer'),
  languageSelect: document.getElementById('languageSelect'),
  themeSelect: document.getElementById('themeSelect'),
  currencySelect: document.getElementById('currencySelect'),
  homeLimitAccountCount: document.getElementById('homeLimitAccountCount'),
  settingsSecret: document.getElementById('settingsSecret'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  signOutBtn: document.getElementById('signOutBtn'),
  aboutLine: document.getElementById('aboutLine'),
  rangePopover: document.getElementById('rangePopover'),
  rangeFrom: document.getElementById('rangeFrom'),
  rangeTo: document.getElementById('rangeTo'),
  rangeError: document.getElementById('rangeError'),
  rangeApply: document.getElementById('rangeApply'),
  rangeClear: document.getElementById('rangeClear'),
  rangeClose: document.getElementById('rangeClose'),
  toast: document.getElementById('toast'),
  navScrim: document.getElementById('navScrim'),
  heroStrip: document.getElementById('heroStrip')
};

// Preferences and credentials are asynchronous in the desktop transport.
// Start from safe defaults and merge them during init(); spreading a Promise
// here silently discarded the persisted desktop view state.
const storedPrefs = {};
const initialRoute = routeFromLocation();

const state = {
  prefs: {
    language: 'auto',
    theme: 'system',
    currency: 'USD',
    period: 'today',
    trendsRange: '30',
    trendsStack: 'client',
    trendsMetric: 'tokens',
    heatmapMetric: 'cost',
    activeDaysWindow: 'all',
    homeLimitAccountCount: 3,
    deviceFilter: '',
    selectedDeviceId: '',
    selectedToolId: '',
    ...storedPrefs,
    view: initialRoute.view || viewFromLocation() || 'overview',
    usageTab: initialRoute.usageTab || 'tools',
    managementTab: initialRoute.managementTab || 'subscriptions',
    managementSection: normalizeManagementSection(initialRoute.managementSection),
    limitTab: initialRoute.limitTab || 'limits'
  },
  secret: '',
  locale: 'en',
  health: null,
  authorization: null,
  // Transfer form pickers are rebuilt by every stats render; without this the
  // user's source/target selection snaps back to the defaults mid-form.
  transferSelection: null,
  stats: null,
  history: null,
  historyDeviceId: '',
  historyRequest: null,
  historyRequestDeviceId: '',
  historyRequestSequence: 0,
  historyLoading: false,
  historyLoadingDeviceId: '',
  historyError: null,
  historyErrorDeviceId: '',
  subscriptions: null,
  subscriptionsLoading: false,
  subscriptionsError: null,
  subscriptionsSaving: false,
  subscriptionsConflict: false,
  subscriptionsPending: null,
  subscriptionEditId: '',
  subscriptionDrawerOpen: false,
  pricing: null,
  pricingLoading: false,
  pricingError: null,
  pricingSaving: false,
  pricingEditModel: '',
  pricingDrawerOpen: false,
  accounts: null,
  accountsLoading: false,
  accountsError: null,
  accountsSaving: false,
  accountFormError: '',
  accountEditId: '',
  accountDrawerOpen: false,
  accountFormMode: 'simple',
  accountSelectedProvider: 'deepseek',
  oauthSession: null,
  oauthLoading: false,
  limitProvider: '',
  loading: true,
  error: null,
  customRange: null,
  customPeriod: null,
  // Calendar presets (yesterday / this week) are fetched ranges, not snapshot
  // periods, so they carry their own request bookkeeping.
  presetRangeRequest: null,
  presetRangeRequestKey: '',
  presetRangeSequence: 0,
  presetRangeFailedKey: '',
  presetRangeRetryAfter: 0,
  stream: 'offline',
  // Wall-clock time of the last data frame, so the UI can state how old the
  // displayed numbers are instead of implying they are current.
  dataAsOf: null,
  stopStream: null,
  toastTimer: null,
  navOpen: false,
  overlayFocus: {
    settings: null,
    range: null
  },
  managementReturnFocus: null,
  deferredInstall: null,
  formDrafts: new Map(),
  managementRequestSeq: {
    subscriptions: 0,
    pricing: 0,
    accounts: 0
  },
  managementControllers: {
    subscriptions: null,
    pricing: null,
    accounts: null
  },
  managementPromises: {
    subscriptions: null,
    pricing: null,
    accounts: null
  },
  pwaDismissed: readFlag('token-monitor.hub.pwaDismissed') === '1',
  // Desktop-only settings, loaded from the main process when the host has them.
  desktopSettings: null,
  desktopInfo: null,
  desktopAppUpdate: null,
  desktopSyncHealth: null,
  desktopConnectionError: null,
  desktopSnapshotMeta: null
};

const EMPTY_STATS_MODEL = Object.freeze({
  devices: [],
  periods: {},
  limits: { providers: [] },
  historyPreview: { daily: [], summary: null }
});

function tr(key, params) {
  return t(state.locale, key, params);
}

function viewStats() {
  const stats = state.stats || EMPTY_STATS_MODEL;
  const deviceId = String(state.prefs.deviceFilter || '').trim();
  if (!deviceId) return stats;
  const device = (stats.devices || []).find((entry) => String(entry?.deviceId || '') === deviceId);
  if (!device) return stats;
  return {
    ...stats,
    devices: [device],
    periods: device.periods || {},
    // Limits are Hub-owned account data, not per-device usage. Keep the
    // top-level collection when a device filter is active.
    limits: stats.limits || { providers: [] },
    projectsIncomplete: Boolean(device.allTimeProjectsOmitted || device.allTimeProjectsIncomplete)
  };
}

function activePeriod() {
  // A range answer belongs to the tab that asked for it — see `resolveScopePeriod()`.
  // Reading `state.customPeriod` unconditionally would let one fetched range answer every
  // tab, which is exactly how the desktop/Hub client showed the same figure under two
  // different scope labels.
  const resolved = resolveScopePeriod({
    period: state.prefs.period,
    customRange: state.customRange,
    customPeriod: state.customPeriod,
    periods: viewStats()?.periods
  });
  if (resolved) return resolved;
  return {
    totalTokens: 0,
    costUsd: 0,
    clients: {},
    clientCosts: {},
    models: {},
    modelCosts: {},
    projects: {},
    sessions: {}
  };
}

// The range API is what makes the calendar presets answerable; a Hub that does not
// expose it must not offer tabs that would only ever render zeros.
function presetRangesEnabled() {
  const capabilities = state.authorization?.capabilities || state.health?.capabilities || {};
  return capabilities.usageRange !== false;
}

/**
 * The calendar the Hub reports its day/month totals in, or '' for this viewer's
 * own. When a fleet timezone is configured, 昨日/本周 must be computed in it too:
 * the labels are what the Hub aggregates on, so a viewer in another zone asking
 * with local labels would get a different window than the numbers shown.
 */
function fleetTimeZone() {
  return String(state.stats?.fleetTimeZone || state.health?.fleetTimeZone || '').trim();
}

function periodTabs() {
  return PERIOD_TABS.filter((period) => !isPresetRangePeriod(period) || presetRangesEnabled());
}

/** Drop a persisted or stale selection that this host cannot answer. */
function normalizePeriodSelection() {
  const period = String(state.prefs.period || '');
  if (periodTabs().includes(period)) return;
  state.prefs.period = 'today';
  savePrefs({ period: 'today' });
  // Demoting the selection has to demote its answer too. A fetched range is this
  // selection's number, so leaving `customPeriod` populated would render yesterday's
  // window under the Day tab — the same leak the scope-tab gating exists to prevent,
  // reached here by switching to a Hub that cannot answer presets at all.
  state.customRange = null;
  state.customPeriod = null;
  state.presetRangeRequest = null;
  state.presetRangeRequestKey = '';
  state.presetRangeFailedKey = '';
  state.presetRangeRetryAfter = 0;
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.round(Number(milliseconds || 0) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder ? `${days}d ${remainder}h` : `${days}d`;
}

function renderDesktopSyncStatus() {
  if (!isCapable('desktopSettings')) return;
  renderDesktopConnectionError();
  if (!els.desktopSyncStatus) return;
  els.desktopSyncStatus.classList.remove('hidden');
  const health = state.desktopSyncHealth || {};
  const channels = [
    ['local', health.local],
    ['upload', health.upload],
    ['rest', health.rest],
    ['stream', health.stream]
  ];
  for (const [channel, value] of channels) {
    const row = els.desktopSyncStatus.querySelector(`[data-sync-channel="${channel}"]`);
    if (!row) continue;
    const stateValue = value?.state || 'unknown';
    row.dataset.state = stateValue;
    const stateNode = row.querySelector('[data-sync-state]');
    if (stateNode) stateNode.textContent = syncHealthStateLabel(stateValue, tr);
    const failure = value?.failureCode
      ? ` · ${syncHealthFailureLabel(value.failureCode, tr)}`
      : '';
    row.title = `${syncHealthStateLabel(stateValue, tr)}${failure}`;
  }
  const source = String(state.desktopSnapshotMeta?.source || 'empty');
  const sourceChannel = source.startsWith('local') ? 'settings.sync.healthLocal' : 'settings.sync.healthRest';
  const sourceState = source.includes('cache') ? 'offline' : source === 'empty' ? 'unknown' : 'ok';
  if (els.desktopSnapshotSource) {
    els.desktopSnapshotSource.textContent = `${tr(sourceChannel)} · ${syncHealthStateLabel(sourceState, tr)}`;
  }
  if (els.streamStatusDetail) {
    els.streamStatusDetail.textContent = source.includes('cache')
      ? tr('settings.sync.healthState.offline')
      : source === 'empty'
        ? tr('settings.sync.healthState.unknown')
        : tr('settings.sync.healthState.ok');
  }
  renderDesktopConnectionError();
}

function desktopConnectionFailure() {
  return state.desktopConnectionError || primarySyncHealthFailure(state.desktopSyncHealth);
}

function renderDesktopConnectionError() {
  const node = document.querySelector('[data-desktop-connection-error]');
  if (!node || !isCapable('desktopSettings')) return;
  const failure = desktopConnectionFailure();
  const clientMode = state.desktopSettings?.hubMode === 'client';
  const visible = clientMode && Boolean(failure);
  node.classList.toggle('hidden', !visible);
  if (!visible) return;

  const channelKeys = {
    local: 'settings.sync.healthLocal',
    upload: 'settings.sync.healthUpload',
    rest: 'settings.sync.healthRest',
    stream: 'settings.sync.healthStream'
  };
  const channel = tr(channelKeys[failure.channel] || 'settings.sync.healthRest');
  const reason = syncHealthFailureLabel(failure.code, tr);
  const status = Number.isInteger(Number(failure.status)) && Number(failure.status) > 0
    ? ` · ${tr('settings.sync.httpStatus', { status: Number(failure.status) })}`
    : '';
  const message = node.querySelector('[data-desktop-connection-message]');
  if (message) message.textContent = `${channel}：${reason}${status}`;
  node.dataset.failureCode = failure.code;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2200);
}

/**
 * Build a client -> model -> value map from session rows.
 *
 * Used where the wire payload only carries flat per-client and per-model maps but
 * the UI renders a nested split (Usage -> Tools under a custom range).
 */
function deriveClientModels(sessions, field) {
  const result = {};
  for (const session of Object.values(sessions || {})) {
    const client = String(session?.client || '').trim();
    if (!client) continue;
    const values = session?.[field];
    if (!values || typeof values !== 'object') continue;
    const bucket = result[client] || (result[client] = {});
    for (const [model, value] of Object.entries(values)) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      bucket[model] = (bucket[model] || 0) + numeric;
    }
  }
  return result;
}

function setStreamStatus(status, meta = {}) {
  state.stream = status;
  const map = {
    connecting: 'status.connecting',
    retrying: 'status.retrying',
    live: 'status.live',
    disconnected: 'status.offline',
    offline: 'status.offline',
    unauthorized: 'status.unauthorized',
    'idle-timeout': 'status.idleTimeout',
    error: 'status.error'
  };
  const live = status === 'live';
  // A paused collector is neither live nor broken: saying "offline" would send the
  // user looking for a network fault.
  const collectionPaused = isCapable('desktopSettings') && state.desktopSettings?.collectionPaused === true;
  els.streamStatus.dataset.state = collectionPaused ? 'offline' : (live ? 'live' : (status === 'unauthorized' || status === 'error' ? 'error' : 'offline'));
  els.streamStatusText.textContent = collectionPaused ? tr('status.paused') : tr(map[status] || 'status.offline');
  els.liveLabel.textContent = collectionPaused ? tr('status.paused') : (live ? tr('stats.live.on') : tr('stats.live.off'));
  // Always publish the age of the displayed data: the badge alone used to read
  // "live" while the numbers could be arbitrarily old.
  const at = Number(meta.lastEventAt) || null;
  if (at) state.dataAsOf = at;
  els.streamStatus.title = state.dataAsOf
    ? `${tr('status.dataAsOf')} ${new Date(state.dataAsOf).toLocaleTimeString()}`
    : '';
  if (status === 'unauthorized') showAuth(true);
  renderDesktopSyncStatus();
}

function applyTheme() {
  const pref = state.prefs.theme || 'system';
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = theme;
  const motionPreference = isCapable('desktopSettings')
    ? state.desktopSettings?.reduceMotion
    : state.prefs.reduceMotion;
  syncFluentMotion(motionPreference || 'system');
  const meta = document.querySelector('meta[name="theme-color"]:not([media])')
    || document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#292929' : '#f5f5f5');
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((state.prefs.theme || 'system') === 'system') applyTheme();
});

function applyLocale() {
  state.locale = resolveLocale(state.prefs.language);
  document.documentElement.lang = state.locale;
  applyI18n(document, state.locale);
  // The window/plateau title is the app name: zh shows 计然, other locales the
  // romanized brand — same brand.name surface as the sidebar and PWA banner.
  document.title = tr('brand.name');
  renderChrome();
  render();
}

/**
 * On the desktop host the settings document *is* the prefs store (the preload
 * bridges PREFS_KEYS onto it), so a settings write has to land back in
 * `state.prefs` — otherwise the theme, locale and currency keep rendering the
 * pre-change values until the next restart. `savePrefs` does this on the Hub;
 * here the main process is the one that just answered.
 */
function adoptDesktopPrefs(settings) {
  if (!settings) return;
  const before = {
    language: state.prefs.language || 'auto',
    currency: state.prefs.currency || 'USD'
  };
  let changed = false;
  for (const key of ['language', 'theme', 'currency']) {
    if (settings[key] === undefined || state.prefs[key] === settings[key]) continue;
    state.prefs[key] = settings[key];
    changed = true;
  }
  if (!changed) return;
  applyTheme();
  // Labels and formatted costs are baked into the rendered content, so a locale
  // or currency change repaints it; a theme change is pure CSS.
  if (before.language !== (state.prefs.language || 'auto')
    || before.currency !== (state.prefs.currency || 'USD')) applyLocale();
}

function showAuth(show) {
  els.authGate.classList.toggle('hidden', !show);
  els.app.toggleAttribute('inert', show);
  if (show) {
    els.secretInput.value = state.secret || '';
    els.authError.classList.add('hidden');
    els.secretInput.focus();
  }
}

const OVERLAY_FOCUSABLE = 'a[href], button:not([disabled]), fluent-button:not([disabled]), fluent-tab, fluent-radio-group:not([disabled]), fluent-dropdown:not([disabled]), fluent-switch:not([disabled]), fluent-text-input:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function overlayFocusable(root) {
  if (!root) return [];
  return [...root.querySelectorAll(OVERLAY_FOCUSABLE)]
    .filter((element) => !element.hidden && !element.closest('[hidden], .hidden'));
}

function restoreOverlayFocus(key) {
  const opener = state.overlayFocus[key];
  state.overlayFocus[key] = null;
  if (!opener || !opener.isConnected || opener.disabled) return;
  opener.focus({ preventScroll: true });
}

function trapOverlayFocus(event) {
  const root = !els.authGate.classList.contains('hidden')
    ? els.authGate.querySelector('.auth-card')
    : !els.rangePopover.classList.contains('hidden')
    ? els.rangePopover.querySelector('.popover-card')
    : els.content.querySelector('.management-drawer:not(.hidden) [role="dialog"]')
      || (!els.settingsDrawer.classList.contains('hidden')
        ? els.settingsDrawer.querySelector('.drawer-panel')
        : null);
  if (!root || event.key !== 'Tab') return false;
  const focusable = overlayFocusable(root);
  if (!focusable.length) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
  return true;
}

function openSettings(open) {
  const nextOpen = Boolean(open);
  const wasOpen = !els.settingsDrawer.classList.contains('hidden');
  if (nextOpen && !wasOpen) state.overlayFocus.settings = document.activeElement;
  els.settingsDrawer.classList.toggle('hidden', !nextOpen);
  els.settingsDrawer.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
  els.settingsOpen?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  els.settingsOpenTop?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  if (nextOpen) {
    setFluentDropdownValue(els.languageSelect, state.prefs.language || 'auto');
    setFluentDropdownValue(els.themeSelect, state.prefs.theme || 'system');
    setFluentDropdownValue(els.currencySelect, state.prefs.currency || 'USD');
    if (els.homeLimitAccountCount) {
      els.homeLimitAccountCount.value = String(clampHomeLimitAccountCount(state.prefs.homeLimitAccountCount, 3));
    }
    if (els.settingsSecret) els.settingsSecret.value = state.secret || '';
    (els.languageSelect.control || els.languageSelect).focus({ preventScroll: true });
  } else if (wasOpen) {
    restoreOverlayFocus('settings');
  }
}


function isMobileNav() {
  return window.matchMedia('(max-width: 860px)').matches;
}

function openNav(open) {
  const wasOpen = state.navOpen;
  state.navOpen = Boolean(open) && isMobileNav();
  const pane = document.getElementById('navigationPane');
  pane?.toggleAttribute('inert', isMobileNav() && !state.navOpen);
  document.querySelector('.main')?.toggleAttribute('inert', state.navOpen);
  pane?.setAttribute('role', state.navOpen ? 'dialog' : 'complementary');
  if (state.navOpen) pane?.setAttribute('aria-modal', 'true');
  else pane?.removeAttribute('aria-modal');
  if (state.navOpen && !wasOpen) requestAnimationFrame(() => pane?.querySelector('a')?.focus());
  if (wasOpen && !state.navOpen) els.menuToggle?.focus();
  els.app.classList.toggle('nav-open', state.navOpen);
  document.body.classList.toggle('nav-open', state.navOpen);
  if (els.navScrim) els.navScrim.classList.toggle('hidden', !state.navOpen);
  if (els.menuToggle) els.menuToggle.setAttribute('aria-expanded', state.navOpen ? 'true' : 'false');
}

function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function pwaStatusText() {
  if (isStandaloneDisplay()) return tr('pwa.status.installed');
  if (!window.isSecureContext) return tr('pwa.status.insecure');
  if (!('serviceWorker' in navigator)) return tr('pwa.status.unsupported');
  if (state.deferredInstall) return tr('pwa.status.ready');
  return tr('pwa.status.hint');
}

function refreshPwaUi() {
  if (els.aboutLine) {
    const base = `${tr('brand.name')} hub web · ${state.health?.now ? new Date(state.health.now).toLocaleString(state.locale) : 'ready'}`;
    els.aboutLine.textContent = `${base} · ${pwaStatusText()}`;
  }
  if (!els.pwaBanner) return;
  const canPrompt = Boolean(state.deferredInstall) && !state.pwaDismissed && !isStandaloneDisplay();
  const showInsecureHint = !window.isSecureContext && !state.pwaDismissed && !isStandaloneDisplay() && isMobileNav();
  if (canPrompt) {
    if (els.pwaBannerText) els.pwaBannerText.textContent = tr('pwa.hint');
    if (els.pwaInstallBtn) els.pwaInstallBtn.classList.remove('hidden');
    els.pwaBanner.classList.remove('hidden');
  } else if (showInsecureHint) {
    if (els.pwaBannerText) els.pwaBannerText.textContent = tr('pwa.insecure');
    if (els.pwaInstallBtn) els.pwaInstallBtn.classList.add('hidden');
    els.pwaBanner.classList.remove('hidden');
  } else {
    els.pwaBanner.classList.add('hidden');
  }
}

function openRange(open) {
  const nextOpen = Boolean(open);
  const wasOpen = !els.rangePopover.classList.contains('hidden');
  if (nextOpen && !wasOpen) state.overlayFocus.range = document.activeElement;
  els.rangePopover.classList.toggle('hidden', !nextOpen);
  els.rangePopover.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
  els.customRangeBtn?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  if (nextOpen) {
    const now = new Date();
    const start = state.customRange?.from
      ? new Date(state.customRange.from)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end = state.customRange?.to ? new Date(state.customRange.to) : now;
    els.rangeFrom.value = toDatetimeLocalValue(start);
    els.rangeTo.value = toDatetimeLocalValue(end);
    els.rangeError.classList.add('hidden');
    els.rangeFrom.focus({ preventScroll: true });
  } else if (wasOpen) {
    restoreOverlayFocus('range');
  }
}

function viewUsesUsageScope(view = state.prefs.view) {
  return ['overview', 'usage', 'devices'].includes(view);
}

function viewKicker(view = state.prefs.view) {
  if (view === 'settings') return tr(isCapable('desktopSettings') ? 'settings.desktopTitle' : 'settings.webOnly');
  if (view === 'limits') return tr('limits.health');
  return tr('page.overview.kicker');
}

function viewDescription(view = state.prefs.view) {
  if (view === 'settings' && isCapable('desktopSettings')) return tr('settings.desktopDescription');
  return tr(`page.${view}.description`);
}

function renderChrome() {
  normalizePeriodSelection();
  // Administration is a single destination whose account/consumption sections
  // gate themselves, so the nav list is the full VIEWS set.
  const visibleViews = VIEWS;
  if (!visibleViews.some((view) => view.id === state.prefs.view)) state.prefs.view = 'overview';
  if (els.brandSubtitle) {
    els.brandSubtitle.textContent = isCapable('desktopSettings')
      ? tr('brand.desktopSubtitle')
      : tr('brand.subtitle');
  }
  els.primaryNav.setAttribute('aria-label', tr('nav.primary'));
  document.querySelector('.scope-commandbar')?.setAttribute('aria-label', tr('filters.scope'));
  // Administration is one entry now; the accounts and consumption surfaces are
  // sections inside it, so they are not navigation destinations.
  const navGroups = [
    ['nav.groupInsights', ['overview', 'usage', 'trends']],
    ['nav.groupResources', ['devices', 'limits']],
    ['nav.groupAdministration', ['settings']]
  ];
  const navHtml = navGroups.map(([label, ids]) => {
    const items = visibleViews.filter((view) => ids.includes(view.id));
    if (!items.length) return '';
    return `<div class="nav-group"><span class="nav-group-label">${tr(label)}</span>${items.map((view) => `
      <a id="nav-${view.id}" href="${isCapable('desktopSettings') ? '#' : ''}${VIEW_PATHS[view.id]}" class="nav-btn ${state.prefs.view === view.id ? 'active' : ''}" data-view="${view.id}" ${state.prefs.view === view.id ? 'aria-current="page"' : ''}>
        <span class="nav-ico">${uiIcon(view.icon)}</span><span class="nav-label">${tr(`nav.${view.id}`)}</span>
      </a>`).join('')}</div>`;
  }).join('');
  // Compare before assigning: a stats tick used to rebuild this list every few
  // seconds, dropping focus and hover on a nav link the user was on.
  if (els.primaryNav.innerHTML !== navHtml) els.primaryNav.innerHTML = navHtml;
  const scoped = viewUsesUsageScope();
  document.querySelector('.scope-commandbar')?.classList.toggle('hidden', !scoped);
  els.deviceFilter?.closest('.device-filter')?.classList.toggle('hidden', !scoped);
  els.periodTabs?.classList.toggle('hidden', !scoped);
  els.customRangeBtn?.classList.toggle('hidden', !scoped || !presetRangesEnabled());

  // Only a hand-picked range falls back to the transient "custom" chip; a preset is
  // selected because the user selected it, so `prefs.period` is the truth either way.
  // Reading the chip off `customRange.kind` instead would highlight whichever range was
  // fetched last, which is the same leak `resolveScopePeriod()` closes for the figures.
  const rangeKind = state.customRange?.kind || '';
  const selectedPeriod = rangeKind === 'custom' ? 'custom' : state.prefs.period;
  const periodOptions = periodTabs().map((period) => [period, tr(`period.${period}`)]);
  if (rangeKind === 'custom') periodOptions.push(['custom', tr('period.custom')]);
  els.periodTabs.dataset.selection = 'period';
  els.periodTabs.setAttribute('name', 'period');
  els.periodTabs.setAttribute('aria-label', tr('period.label'));
  const periodTabsHtml = segButtons(periodOptions, selectedPeriod, 'period');
  // Rebuild only on a real change: this list is inside the scope bar the user
  // interacts with, and replacing it every frame moved focus off the selected tab.
  if (els.periodTabs.innerHTML !== periodTabsHtml) els.periodTabs.innerHTML = periodTabsHtml;
  els.periodTabs.value = selectedPeriod;

  els.pageTitle.textContent = tr(`nav.${state.prefs.view}`);
  const allDevices = state.stats?.devices || [];
  const totalDevices = allDevices.length;
  const periodLabel = tr(`period.${selectedPeriod}`);
  const selectedDevice = allDevices.find((device) => device.deviceId === state.prefs.deviceFilter);
  const scopedDeviceCount = selectedDevice ? 1 : totalDevices;
  const dataAsOf = state.dataAsOf && Number.isFinite(new Date(state.dataAsOf).getTime())
    ? `${tr('status.dataAsOf')} ${new Date(state.dataAsOf).toLocaleTimeString(state.locale, { hour: 'numeric', minute: '2-digit' })}`
    : '';
  const deviceCountLabel = scopedDeviceCount === 1 ? tr('stats.device') : tr('stats.devices');
  const scopeMeta = [scoped ? `${periodLabel} · ${scopedDeviceCount} ${deviceCountLabel.toLowerCase()}` : '', dataAsOf].filter(Boolean).join(' · ');
  const desc = viewDescription();
  const kicker = viewKicker();
  els.pageMeta.textContent = [scoped ? '' : kicker, desc, scopeMeta].filter(Boolean).join(' · ');
  if (els.deviceFilter) {
    const current = state.prefs.deviceFilter || '';
    const selectedDeviceId = allDevices.some((device) => device.deviceId === current) ? current : '';
    const selectedDeviceOption = selectedDeviceId ? deviceOptionValue(selectedDeviceId) : ALL_DEVICES_OPTION_VALUE;
    const deviceOptionsHtml = [
      `<fluent-option value="${ALL_DEVICES_OPTION_VALUE}"${selectedDeviceId ? '' : ' selected'}>${escapeHtml(tr('filters.allDevices'))}</fluent-option>`,
      ...allDevices.map((device) => `<fluent-option value="${escapeHtml(deviceOptionValue(device.deviceId || ''))}"${device.deviceId === selectedDeviceId ? ' selected' : ''}>${escapeHtml(device.hostname || device.deviceId || tr('devices.title'))}</fluent-option>`)
    ].join('');
    let deviceListbox = els.deviceFilter.querySelector('fluent-listbox');
    if (!deviceListbox) {
      els.deviceFilter.innerHTML = `<fluent-listbox>${deviceOptionsHtml}</fluent-listbox>`;
    } else if (deviceListbox.innerHTML !== deviceOptionsHtml) {
      // Keep Dropdown's generated slotted control connected while refreshing
      // the options; replacing the Dropdown's own innerHTML leaves a blank trigger.
      deviceListbox.innerHTML = deviceOptionsHtml;
    }
    setFluentDropdownValue(els.deviceFilter, selectedDeviceOption);
    els.deviceFilter.title = selectedDevice?.hostname || selectedDevice?.deviceId || tr('filters.allDevices');
  }
  renderMobileNav();
  refreshPwaUi();
}

function renderMobileNav() {
  if (typeof document === 'undefined') return;
  let nav = document.getElementById('mobileBottomNav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'mobileBottomNav';
    nav.className = 'mobile-bottom-nav';
    nav.setAttribute('aria-label', tr('nav.primary'));
    nav.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-view]');
      if (!btn) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const targetView = btn.dataset.view;
      if (targetView === 'more') {
        openNav(!state.navOpen);
      } else {
        switchView(targetView);
      }
    });
    document.body.appendChild(nav);
  }
  nav.setAttribute('aria-label', tr('nav.primary'));
  const currentView = state.prefs.view;
  const primaryKeys = ['overview', 'usage', 'devices'];
  const isMoreActive = !primaryKeys.includes(currentView);

  const items = [
    { id: 'overview', icon: 'home', label: tr('nav.overview'), active: currentView === 'overview' },
    { id: 'usage', icon: 'usage', label: tr('nav.usage'), active: currentView === 'usage' },
    { id: 'devices', icon: 'device', label: tr('nav.devices'), active: currentView === 'devices' },
    { id: 'more', icon: 'moreHorizontal', label: tr('nav.more'), active: isMoreActive }
  ];

  const navHtml = items.map((item) => `
    <a href="${isCapable('desktopSettings') ? '#' : ''}${VIEW_PATHS[item.id] || '#'}" class="mobile-nav-item ${item.active ? 'active' : ''}" data-view="${item.id}" ${item.active ? 'aria-current="page"' : ''}>
      <span class="mobile-nav-icon">${uiIcon(item.icon)}</span>
      <span class="mobile-nav-label">${escapeHtml(item.label)}</span>
    </a>
  `).join('');
  // Only the active marker changes between frames; rewriting the whole bar on a
  // stats tick dropped the tap feedback on whichever item the user was touching.
  if (nav.innerHTML !== navHtml) nav.innerHTML = navHtml;
}

function rowHtml(row, { showIcon = false, sub } = {}) {
  // A row with no known client falls back to the colour swatch rather than
  // collapsing the row's leading column, so the metric columns stay aligned.
  const iconId = row.client || row.key;
  const icon = showIcon && iconId
    ? `<img class="client-icon" src="${clientIconPath(iconId)}" alt="" onerror="this.style.display='none'" />`
    : `<span class="swatch" style="background:${row.color}"></span>`;
  return `
    <div class="row">
      <div class="row-main">
        ${icon}
        <div class="row-copy">
          <div class="row-name">${escapeHtml(row.name)}</div>
          ${sub || row.sub ? `<div class="row-sub">${escapeHtml(sub || row.sub)}</div>` : ''}
        </div>
      </div>
      <div class="row-metrics">
        <div class="row-value">${formatNumber(row.value)}</div>
        <div class="row-cost">${formatCost(row.cost, state.prefs.currency)}</div>
      </div>
    </div>
  `;
}

function emptyHtml(key) {
  return `<div class="empty-card">${tr(key)}</div>`;
}

function panel(title, body, meta = '', action = '') {
  return `
    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">${escapeHtml(title)}</h2>
        ${action || (meta ? `<div class="panel-meta tiny">${escapeHtml(meta)}</div>` : '')}
      </div>
      ${body}
    </section>
  `;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function draftKeyForForm(container) {
  return String(container?.dataset?.draftKey || '').trim();
}

/**
 * Any element that owns a draft: the management `<form>`s and the two non-form
 * groups (the desktop settings stack, the transfer form) all carry
 * `data-draft-key`. The selector is a static literal so it stays trivially
 * greppable.
 */
function draftScopes(root = els.content) {
  return [...root.querySelectorAll('[data-draft-key]')];
}

/** The draft scope a control belongs to, if any. */
function draftScopeFor(target) {
  return target?.closest?.('[data-draft-key]') || null;
}

function formFieldSnapshot(form) {
  const fields = {};
  form?.querySelectorAll?.('[name]').forEach((control) => {
    const name = String(control.name || '').trim();
    if (!name || name === 'provider' || name === 'oauthSessionId') return;
    // Fluent's web components do not surface `.type`/`.value`/`.checked` the way
    // a native control does, so a switch or radio group is snapshotted by its
    // own property. Without this branch, a desktop settings draft could not
    // remember the checkbox rows it owns.
    if (control.matches('fluent-switch, fluent-checkbox')) {
      fields[name] = { checked: Boolean(control.checked) };
    } else if (control.matches('fluent-radio-group')) {
      fields[name] = { value: String(control.value ?? '') };
    } else if (control.type === 'checkbox' || control.type === 'radio') {
      fields[name] = { checked: Boolean(control.checked) };
    } else if (control.multiple) {
      fields[name] = { value: [...control.selectedOptions].map((option) => option.value) };
    } else {
      fields[name] = { value: control.value };
    }
  });
  return fields;
}

function rememberFormDraft(target) {
  const form = draftScopeFor(target);
  const key = draftKeyForForm(form);
  if (!form || !key) return;
  const hasTopUpLedger = Boolean(form.querySelector('[data-topup-ledger]'));
  const previous = state.formDrafts.get(key);
  const topUpRows = [...form.querySelectorAll('[data-topup-row]')].map((row) => ({
    id: row.getAttribute('data-topup-id') || '',
    date: row.querySelector('[data-topup-date]')?.value || '',
    amount: row.querySelector('[data-topup-amount]')?.value || ''
  }));
  state.formDrafts.set(key, {
    dirty: true,
    fields: { ...previous?.fields, ...formFieldSnapshot(form) },
    topUpRows: hasTopUpLedger ? topUpRows : (previous?.topUpRows || []),
    topUpRowsPresent: hasTopUpLedger || Boolean(previous?.topUpRowsPresent)
  });
}

function clearFormDraft(key) {
  if (key) state.formDrafts.delete(String(key));
}

function hasDirtyFormDraft(prefix) {
  return [...state.formDrafts.entries()].some(([key, draft]) => key.startsWith(prefix) && draft?.dirty);
}

function restoreFormDrafts() {
  draftScopes().forEach((scope) => {
    const draft = state.formDrafts.get(draftKeyForForm(scope));
    if (!draft?.dirty || !draft.fields) return;
    for (const control of scope.querySelectorAll('[name]')) {
      const name = String(control.name || '').trim();
      const value = draft.fields[name];
      if (!name || !value || name === 'provider' || name === 'oauthSessionId') continue;
      if (control.matches('fluent-switch, fluent-checkbox')) {
        control.checked = Boolean(value.checked);
      } else if (control.matches('fluent-radio-group')) {
        if (value.value !== undefined) control.value = value.value;
      } else if (control.type === 'checkbox' || control.type === 'radio') {
        control.checked = Boolean(value.checked);
      } else if (control.multiple && Array.isArray(value.value)) {
        const selected = new Set(value.value);
        for (const option of control.options) option.selected = selected.has(option.value);
      } else if (value.value !== undefined) {
        if (control.matches('fluent-dropdown')) {
          // Only restore a value an option actually offers. A draft can outlive
          // the option it named (a device was removed, a provider was retired),
          // and `setFluentDropdownValue` deselects every option when it finds no
          // match — which would blank the control instead of leaving its default.
          const hasOption = [...control.querySelectorAll('fluent-option')]
            .some((option) => option.value === String(value.value));
          if (hasOption) setFluentDropdownValue(control, value.value);
        } else {
          control.value = value.value;
        }
      }
    }
  });
}

function rememberManagementOpener(element) {
  if (!element) return;
  for (const attribute of ['data-account-add', 'data-account-edit', 'data-subscription-add', 'data-subscription-edit', 'data-pricing-add', 'data-pricing-edit']) {
    if (element.hasAttribute(attribute)) {
      state.managementReturnFocus = { attribute, value: element.getAttribute(attribute) || '' };
      return;
    }
  }
  const menuTrigger = element.closest('.row-action-menu')?.querySelector(':scope > summary[data-management-focus]');
  if (menuTrigger) state.managementReturnFocus = { attribute: 'data-management-focus', value: menuTrigger.dataset.managementFocus || '' };
}

function closeManagementDrawer(kind) {
  const stateKey = ({ account: 'accountDrawerOpen', subscription: 'subscriptionDrawerOpen', pricing: 'pricingDrawerOpen' })[kind];
  if (!stateKey) return;
  state[stateKey] = false;
  render();
}

// Attributes that identify a control across a re-render. The first one present
// (with a value) is the fingerprint, so a menu, a dropdown or a select row is
// found again by what it *is*, not by where it sat in the list.
const IDENTITY_ATTRIBUTES = [
  'data-management-focus',
  'data-view',
  'data-select-tool',
  'data-select-device',
  'data-row-key',
  'data-limit-provider',
  'data-trends-device',
  'data-trends-setting',
  'data-desktop-action'
];

/** The nearest ancestor (or self) that a re-render can find again by identity. */
function identityKeyFor(element) {
  if (!element || element.nodeType !== 1) return null;
  for (const attribute of IDENTITY_ATTRIBUTES) {
    const match = element.closest(`[${attribute}]`);
    if (match) return { attribute, value: match.getAttribute(attribute) || '' };
  }
  return null;
}

/**
 * A stable descriptor for a form control, scoped to its draft form when one
 * exists. Value is the discriminative field: two same-name controls in a
 * repeated row (top-up date/amount) are told apart by the row's `data-topup-id`.
 */
function describeFormControl(element) {
  const form = draftScopeFor(element);
  const key = draftKeyForForm(form);
  if (!key) return { key: '', name: '', index: 0 };
  const controls = [...form.querySelectorAll('[name]')].filter((control) => control.name === element.name);
  const rowId = element.closest('[data-topup-id]')?.getAttribute('data-topup-id') || '';
  const indexInRow = rowId
    ? [...element.closest('[data-topup-id]').querySelectorAll('[name]')]
      .filter((control) => control.name === element.name)
      .indexOf(element)
    : 0;
  return { key, name: element.name, index: Math.max(0, controls.indexOf(element)), rowId, indexInRow };
}

function describeActiveElement(element) {
  const selection = element?.control || element;
  if (!element || element === document.body || element === document.documentElement) return null;
  // Draft forms come first: a control registered by `rememberFormDraft` may also
  // carry an identity attribute, and the form-scoped descriptor is the more
  // precise one.
  const formControl = describeFormControl(element);
  if (formControl.key) {
    if (element.matches('[data-account-provider-select]')) return { kind: 'account-provider-select', key: formControl.key };
    return {
      kind: 'form-control',
      ...formControl,
      selectionStart: typeof selection.selectionStart === 'number' ? selection.selectionStart : null,
      selectionEnd: typeof selection.selectionEnd === 'number' ? selection.selectionEnd : null,
      selectionDirection: selection.selectionDirection || 'none'
    };
  }
  // Standalone settings controls (the desktop groups are not draft forms) keep
  // their identity by `id` or `name`, so a frame does not drop focus mid-edit.
  if (element.id) return { kind: 'id', id: element.id };
  if (element.name) return { kind: 'named', name: element.name };
  const identity = identityKeyFor(element);
  if (identity) return { kind: 'data', attribute: identity.attribute, value: identity.value };
  // A menu summary is identified by the menu it opens.
  const summary = element.closest('summary');
  if (summary) {
    const nested = identityKeyFor(summary.parentElement || summary);
    if (nested) return { kind: 'data', attribute: nested.attribute, value: nested.value };
  }
  return null;
}

function findActiveElement(snapshot) {
  if (!snapshot) return null;
  if (snapshot.kind === 'id') return document.getElementById(snapshot.id);
  if (snapshot.kind === 'named') {
    return els.content.querySelector(`[name="${CSS.escape(snapshot.name)}"]`)
      || document.querySelector(`#settingsDrawer [name="${CSS.escape(snapshot.name)}"]`);
  }
  if (snapshot.kind === 'account-provider-select') {
    return [...draftScopes()]
      .find((form) => draftKeyForForm(form) === snapshot.key)
      ?.querySelector('[data-account-provider-select]') || null;
  }
  if (snapshot.kind === 'form-control') {
    const form = [...draftScopes()]
      .find((entry) => draftKeyForForm(entry) === snapshot.key);
    if (!form) return null;
    if (snapshot.rowId) {
      const row = form.querySelector(`[data-topup-id="${CSS.escape(snapshot.rowId)}"]`);
      const control = row && [...row.querySelectorAll('[name]')]
        .filter((entry) => entry.name === snapshot.name)[snapshot.indexInRow];
      if (control) return control;
    }
    return [...form.querySelectorAll('[name]')]
      .filter((control) => control.name === snapshot.name)[snapshot.index] || null;
  }
  if (snapshot.kind === 'data') {
    return [...els.content.querySelectorAll(`[${snapshot.attribute}]`)]
      .find((element) => (element.getAttribute(snapshot.attribute) || '') === snapshot.value) || null;
  }
  return null;
}

// Nested scroll regions that a frame must not reset. `#content` is rebuilt
// wholesale, so a scroll the user made inside a table wrapper or a status list
// is lost unless it is keyed and restored with the rest of the render state.
const SCROLL_REGIONS = ['.trends-table-wrap', '.device-status-details .status-tags', '.pricing-table', '.account-list', '.table-scroll'];

function captureScrollRegions() {
  const regions = [];
  for (const selector of SCROLL_REGIONS) {
    els.content.querySelectorAll(selector).forEach((element, index) => {
      if (!element.scrollTop && !element.scrollLeft) return;
      // These wrappers carry no identity attribute of their own, and there is
      // normally exactly one per view, so position among same-selector matches is
      // the stable-enough key. An identity ancestor, when there is one, is
      // preferred so a list that also reorders still restores the right wrapper.
      regions.push({
        selector,
        index,
        identity: identityKeyFor(element),
        scrollTop: element.scrollTop,
        scrollLeft: element.scrollLeft
      });
    });
  }
  return regions;
}

function restoreScrollRegions(regions) {
  for (const region of regions || []) {
    const candidates = region.identity
      ? [...els.content.querySelectorAll(region.selector)].filter((element) => (
        element.closest(`[${region.identity.attribute}]`)?.getAttribute(region.identity.attribute)
        === region.identity.value))
      : [...els.content.querySelectorAll(region.selector)];
    const target = candidates[region.identity ? 0 : region.index];
    if (!target) continue;
    target.scrollTop = region.scrollTop;
    target.scrollLeft = region.scrollLeft;
  }
}

function captureRenderState() {
  draftScopes().forEach((form) => {
    const key = draftKeyForForm(form);
    const draft = state.formDrafts.get(key);
    if (draft?.dirty) draft.fields = { ...draft.fields, ...formFieldSnapshot(form) };
  });
  const openDetails = [];
  els.content.querySelectorAll('details[open]').forEach((detail) => {
    const rowKey = detail.dataset.rowKey;
    const focusKey = detail.querySelector(':scope > summary[data-management-focus]')?.dataset?.managementFocus;
    const className = detail.className;
    if (rowKey) {
      openDetails.push({ type: 'rowKey', value: rowKey });
    } else if (focusKey) {
      openDetails.push({ type: 'focus', value: focusKey });
    } else if (className) {
      // A class-only menu is not unique (the device list has one per row), so
      // record its position among same-class menus and restore that index. The
      // old `querySelector` always reopened the *first* match, which is how an
      // expanded device menu moved to the top row after a refresh.
      const sameClass = [...els.content.querySelectorAll(`details.${className.trim().split(/\s+/).join('.')}`)];
      openDetails.push({ type: 'class', value: className, index: sameClass.indexOf(detail) });
    }
  });
  const openDropdowns = [...els.content.querySelectorAll('fluent-dropdown')]
    .map((dropdown) => ({
      dropdown,
      listbox: dropdown.listbox,
      identity: dropdown.id ? { attribute: 'id', value: dropdown.id } : identityKeyFor(dropdown)
    }))
    .filter((entry) => entry.listbox?.matches?.(':popover-open') && entry.identity);
  const active = document.activeElement;
  const mainEl = document.querySelector('.main');
  return {
    active: describeActiveElement(active),
    openDetails,
    openDropdowns: openDropdowns.map((entry) => entry.identity),
    scrollRegions: captureScrollRegions(),
    scrollY: active && (active === els.content || els.content.contains(active)) ? window.scrollY : null,
    mainScrollTop: mainEl ? mainEl.scrollTop : null
  };
}

function findByIdentity(identity) {
  if (!identity) return null;
  if (identity.attribute === 'id') return document.getElementById(identity.value);
  return [...els.content.querySelectorAll(`[${identity.attribute}]`)]
    .find((element) => (element.getAttribute(identity.attribute) || '') === identity.value) || null;
}

function restoreRenderState(snapshot) {
  finishFluentRender(els.content, state.prefs.view);
  restoreFormDrafts();
  els.content.querySelectorAll('[data-web-settings-form]').forEach(syncWebSettingsFormState);
  // Reopen the dropdowns that were open *before* the rebuild. `showPopover()`
  // re-attaches the same listbox implementation, so the selection popover does
  // not use the generic `setFluentDropdownValue` path.
  // Reopening is best-effort: a dropdown whose options vanished with the frame is
  // simply not restored.
  for (const identity of snapshot?.openDropdowns || []) {
    const dropdown = findByIdentity(identity);
    const listbox = dropdown?.listbox;
    try {
      if (listbox && !listbox.matches(':popover-open')) listbox.showPopover();
    } catch (_) {
      // A popover without a valid DOM anchor throws; the dropdown stays closed.
    }
  }
  if (Array.isArray(snapshot?.openDetails)) {
    snapshot.openDetails.forEach((entry) => {
      let match = null;
      if (entry.type === 'rowKey') {
        match = els.content.querySelector(`details[data-row-key="${CSS.escape(entry.value)}"]`);
      } else if (entry.type === 'focus') {
        match = els.content.querySelector(`details:has(> summary[data-management-focus="${CSS.escape(entry.value)}"])`);
      } else if (entry.type === 'class') {
        const sameClass = [...els.content.querySelectorAll(`details.${entry.value.trim().split(/\s+/).join('.')}`)];
        match = sameClass[Number.isInteger(entry.index) ? entry.index : 0] || sameClass[0] || null;
      }
      // Assign only when it actually changed: setting `.open = true` on an
      // already-open element fires a `toggle` event, and the tree's `toggle`
      // listener replays the row's entrance animation — a re-render would
      // re-animate every expanded row. The `data-restored-open` marker tells
      // that listener this open is a snapshot restore, not a user opening.
      if (match && !match.open) {
        match.dataset.restoredOpen = '1';
        match.open = true;
      }
    });
  }
  const active = findActiveElement(snapshot?.active);
  if (active && !active.disabled) {
    active.focus({ preventScroll: true });
    const selection = active.control || active;
    if (snapshot.active.kind === 'form-control'
      && typeof snapshot.active.selectionStart === 'number'
      && typeof selection.setSelectionRange === 'function') {
      try {
        selection.setSelectionRange(snapshot.active.selectionStart, snapshot.active.selectionEnd, snapshot.active.selectionDirection);
      } catch (_) {
        // Some input types reject selection ranges; focus preservation still applies.
      }
    }
  }
  if (typeof snapshot?.scrollY === 'number' && typeof window.scrollTo === 'function') {
    window.scrollTo({ top: snapshot.scrollY, behavior: 'auto' });
  }
  if (typeof snapshot?.mainScrollTop === 'number') {
    const mainEl = document.querySelector('.main');
    if (mainEl) mainEl.scrollTop = snapshot.mainScrollTop;
  }
  restoreScrollRegions(snapshot?.scrollRegions);
  const managementDialog = els.content.querySelector('.management-drawer:not(.hidden) [role="dialog"]');
  if (managementDialog && !managementDialog.contains(document.activeElement)) {
    (managementDialog.querySelector('input:not([type="hidden"]), textarea, fluent-text-input, fluent-dropdown, button, fluent-button') || managementDialog).focus({ preventScroll: true });
  } else if (!managementDialog && state.managementReturnFocus) {
    const { attribute, value } = state.managementReturnFocus;
    const target = [...els.content.querySelectorAll(`[${attribute}]`)].find((item) => item.getAttribute(attribute) === value);
    state.managementReturnFocus = null;
    target?.focus({ preventScroll: true });
  }
}

function syncWebSettingsFormState(form) {
  if (!form) return;
  const values = {
    language: state.prefs.language || 'auto',
    theme: state.prefs.theme || 'system',
    reduceMotion: state.prefs.reduceMotion || 'system',
    currency: state.prefs.currency || 'USD',
    homeLimitAccountCount: String(clampHomeLimitAccountCount(state.prefs.homeLimitAccountCount, 3)),
    secret: state.secret || ''
  };
  const dirty = Object.entries(values).some(([name, expected]) => {
    const control = form.querySelector(`[name="${name}"]`);
    if (!control) return false;
    const actual = name === 'homeLimitAccountCount'
      ? String(clampHomeLimitAccountCount(control.value, 3))
      : String(control.value ?? '');
    return actual !== String(expected);
  });
  const submit = form.querySelector('[data-settings-submit]');
  if (submit) submit.disabled = !dirty;
  form.toggleAttribute('data-dirty', dirty);
  if (!dirty) clearFormDraft('preferences');
}

function segButtons(options, current, groupName) {
  return options.map(([value, label]) => {
    const selected = String(current) === String(value);
    const id = `choice-${groupName}-${String(value).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    return `<label class="choice-option${selected ? ' selected' : ''}" for="${id}">
      <fluent-radio id="${id}" value="${escapeHtml(value)}" aria-labelledby="${id}-label"${selected ? ' checked' : ''}></fluent-radio>
      <span id="${id}-label">${escapeHtml(label)}</span>
    </label>`;
  }).join('');
}

function shareBarHtml(rows, { clientIcons = true } = {}) {
  if (!rows.length) return emptyHtml('empty.usage');
  // `estimated` and `credits` are only ever attached to client rows, so model and
  // project rows passed through here render unchanged — a model row can mix an
  // exact client's tokens with an estimated one and earns no label either way.
  return `<div class="stack">${rows.map((row) => {
    const credits = formatCredits(row.credits);
    return `
    <div class="share-row">
      <div class="row">
        <div class="row-main">
          ${clientIcons && (row.client || row.key)
            ? `<img class="client-icon" src="${clientIconPath(row.client || row.key)}" alt="" onerror="this.style.display='none'" />`
            : `<span class="swatch" style="background:${row.color}"></span>`}
          <div class="row-copy">
            <div class="row-name">${escapeHtml(row.name)}</div>
            <div class="row-sub">${Math.round(row.percent || 0)}%${credits ? escapeHtml(` · ${credits} ${tr('stats.credits')}`) : ''}</div>
          </div>
        </div>
        <div class="row-metrics">
          <div class="row-value">${escapeHtml(estimatedValue(formatNumber(row.value), row.estimated))}</div>
          <div class="row-cost">${escapeHtml(estimatedValue(formatCost(row.cost, state.prefs.currency), row.estimated))}</div>
        </div>
      </div>
      <div class="share-meter"><span style="width:${Math.max(0, Math.min(100, row.percent || 0))}%; background:${row.color}"></span></div>
    </div>
  `;}).join('')}</div>`;
}

function loadingHtml() {
  return `<fluent-spinner size="small">${tr('loading')}</fluent-spinner><div class="loading-stack" aria-live="polite"><div class="skeleton skeleton-title"></div><div class="skeleton-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div><div class="skeleton skeleton-panel"></div><span class="muted tiny">${tr('loading')}</span></div>`;
}

function managementError(title, error, retryAction) {
  const isHubUnconfigured = error?.code === 'hub_not_configured'
    || error?.code === 'hub_secret_not_configured'
    || String(error?.message || '').toLowerCase().includes('hub is not configured');

  if (isHubUnconfigured) {
    return `
      <section class="panel empty-card" style="text-align:center;padding:48px 24px;display:flex;flex-direction:column;align-items:center;gap:12px;">
        <div class="empty-kicker muted tiny" style="text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${escapeHtml(title)}</div>
        <h2 style="margin:0;font-size:18px;">${escapeHtml(tr('desktop.settings.hubClient'))}</h2>
        <p class="muted" style="max-width:440px;margin:0;font-size:13px;line-height:1.5;">${escapeHtml(tr('desktop.settings.hubSecretHint'))}</p>
        <div style="margin-top:8px;">
          <fluent-button appearance="primary" type="button" class="primary-btn" data-jump-view="settings">${escapeHtml(tr('nav.settings'))}</fluent-button>
        </div>
      </section>
    `;
  }

  return `<section class="error-card"><div class="error-kicker">${escapeHtml(title)}</div><h2>${escapeHtml(tr('error.title'))}</h2><p>${escapeHtml(error?.message || tr('error.generic'))}</p><fluent-button appearance="primary" type="button" class="primary-btn" data-management-retry="${retryAction}">${tr('actions.retry')}</fluent-button></section>`;
}

function renderHero() {
  const onHome = state.prefs.view === 'overview';
  if (els.heroStrip) {
    els.heroStrip.classList.toggle('hidden', !onHome);
  }
  if (!onHome) return;
  const period = activePeriod();
  const stats = viewStats();
  const tokens = period.totalTokens || 0;
  // The exact figure is always available on hover; the narrow hero card only
  // fits the compact form.
  els.totalTokens.textContent = formatCompact(tokens);
  els.totalTokens.title = formatNumber(tokens);
  els.totalCost.textContent = formatCost(period.costUsd || 0, state.prefs.currency);
  els.deviceCount.textContent = formatNumber(stats?.devices?.length || 0);
}




function formatSubscriptionMoney(amountMinor, currency) {
  const code = ['USD', 'CNY', 'TWD', 'HKD'].includes(String(currency || '').toUpperCase())
    ? String(currency).toUpperCase()
    : 'USD';
  try {
    return new Intl.NumberFormat(state.locale, { style: 'currency', currency: code }).format(Number(amountMinor || 0) / 100);
  } catch {
    return `${(Number(amountMinor || 0) / 100).toFixed(2)} ${code}`;
  }
}

function subscriptionToday() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nextSubscriptionRenewal(record) {
  if (!record || record.kind === 'topup' || record.autoRenew === false) return '';
  const today = subscriptionToday();
  const override = String(record.nextRenewalOverride || '');
  if (override >= today) return override;
  const start = String(record.startDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return '';
  const [year, month, day] = start.split('-').map(Number);
  const step = Math.max(1, Number(record.intervalCount || 1)) * (record.interval === 'year' ? 12 : 1);
  const todayDate = new Date(`${today}T00:00:00Z`);
  let index = Math.max(0, ((todayDate.getUTCFullYear() - year) * 12 + todayDate.getUTCMonth() + 1 - month) / step | 0);
  const candidate = () => {
    const total = (year * 12) + (month - 1) + index * step;
    const nextYear = Math.floor(total / 12);
    const nextMonth = total % 12;
    const maxDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
    return `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(Math.min(day, maxDay)).padStart(2, '0')}`;
  };
  let result = candidate();
  while (result < today) {
    index += 1;
    result = candidate();
  }
  return result;
}

function subscriptionRecords() {
  return Array.isArray(state.subscriptions?.subscriptions) ? state.subscriptions.subscriptions : [];
}

function subscriptionMonthlyTotals(records) {
  const totals = {};
  const month = subscriptionToday().slice(0, 7);
  for (const record of records) {
    if (record?.endDate && String(record.endDate) <= subscriptionToday()) continue;
    let minor = Number(record.amountMinor || 0);
    if (record.kind === 'topup') {
      minor = (record.topUps || [])
        .filter((entry) => String(entry?.date || '').startsWith(month))
        .reduce((sum, entry) => sum + Number(entry?.amountMinor || 0), 0);
    } else if (record.interval === 'year') {
      minor /= Math.max(1, Number(record.intervalCount || 1) * 12);
    } else {
      minor /= Math.max(1, Number(record.intervalCount || 1));
    }
    const currency = String(record.currency || 'USD').toUpperCase();
    totals[currency] = (totals[currency] || 0) + minor;
  }
  return totals;
}

function subscriptionField(record, key, fallback = '') {
  const value = record?.[key];
  return escapeHtml(value === undefined || value === null ? fallback : value);
}

function subscriptionTopUpRows(record, draft, enabled) {
  if (!enabled) return [];
  if (draft?.dirty && draft.topUpRowsPresent) {
    return Array.isArray(draft.topUpRows) ? draft.topUpRows : [];
  }
  const rows = Array.isArray(record?.topUps)
    ? record.topUps.map((entry, index) => ({
      id: String(entry?.id || `top_existing_${index}`),
      date: String(entry?.date || ''),
      amount: Number.isFinite(Number(entry?.amountMinor)) ? (Number(entry.amountMinor) / 100).toFixed(2) : ''
    }))
    : [];
  return rows.length ? rows : [{ id: 'top_new_0', date: '', amount: '' }];
}

function subscriptionTopUpRowHtml(row) {
  const id = String(row?.id || `top_${Date.now()}`);
  const date = escapeHtml(row?.date || '');
  const amount = escapeHtml(row?.amount ?? '');
  return `<div class="topup-row" data-topup-row data-topup-id="${escapeHtml(id)}">
    <label class="field"><span>${tr('subscriptions.topupDate')}</span><input name="topupDate_${escapeHtml(id)}" data-topup-date type="date" value="${date}" /></label>
    <label class="field"><span>${tr('subscriptions.topupAmount')}</span><input name="topupAmount_${escapeHtml(id)}" data-topup-amount type="number" min="0" step="0.01" value="${amount}" /></label>
    <fluent-button appearance="transparent" type="button" class="ghost-btn topup-remove" data-topup-remove>${tr('subscriptions.topupRemove')}</fluent-button>
  </div>`;
}

function renderSubscriptions() {
  if (state.subscriptionsLoading && !state.subscriptions) return loadingHtml();
  if (state.subscriptionsError && !state.subscriptions) {
    return managementError(tr('subscriptions.title'), state.subscriptionsError, 'subscriptions-retry');
  }
  const records = subscriptionRecords();
  const totals = subscriptionMonthlyTotals(records);
  const editing = records.find((record) => record.id === state.subscriptionEditId) || null;
  const canManage = state.authorization?.authenticated === true;
  const subscriptionDraftKey = `subscription:${state.subscriptionEditId || 'new'}`;
  const subscriptionDraft = state.formDrafts.get(subscriptionDraftKey);
  const draftKind = subscriptionDraft?.dirty ? String(subscriptionDraft.fields?.kind?.value || '') : '';
  const formKind = draftKind === 'topup' || (!draftKind && editing?.kind === 'topup') ? 'topup' : 'subscription';
  const formIsTopUp = formKind === 'topup';
  const topUpRows = subscriptionTopUpRows(editing, subscriptionDraft, formIsTopUp);
  const firstTopUp = topUpRows[0] || null;
  const amount = formIsTopUp
    ? Number(firstTopUp?.amount || 0)
    : Number(editing?.amountMinor || 0) / 100;
  const summary = Object.entries(totals).length
    ? Object.entries(totals).map(([currency, minor]) => `<div class="summary-chip"><span class="summary-label">${escapeHtml(tr('subscriptions.monthly'))} · ${currency}</span><strong>${escapeHtml(formatSubscriptionMoney(minor, currency))}</strong></div>`).join('')
    : `<div class="summary-chip"><span class="summary-label">${tr('subscriptions.monthly')}</span><strong>—</strong></div>`;
  const conflictNotice = state.subscriptionsConflict
    ? `<div class="notice warn management-conflict" role="alert"><span>${escapeHtml(tr('subscriptions.conflict'))}</span><fluent-button appearance="transparent" type="button" class="ghost-btn" data-subscription-reload-latest>${tr('subscriptions.reloadLatest')}</fluent-button></div>`
    : '';
  const list = records.length
    ? `<div class="management-list">${records.map((record) => {
      const topUp = record.kind === 'topup';
      const renewal = nextSubscriptionRenewal(record);
      const detail = [
        record.planName || '',
        record.binding?.accountEmail || '',
        topUp ? tr('subscriptions.topup') : (record.interval === 'year' ? tr('subscriptions.yearly') : tr('subscriptions.monthly')),
        renewal ? `${tr('subscriptions.next')} ${renewal}` : ''
      ].filter(Boolean).join(' · ');
      const recordAmount = topUp
        ? (record.topUps || []).reduce((sum, entry) => sum + Number(entry?.amountMinor || 0), 0)
        : Number(record.amountMinor || 0);
      return `<article class="management-row ${record.id === state.subscriptionEditId && state.subscriptionDrawerOpen ? 'is-editing' : ''}">
        <div class="row-main">
          <span class="management-icon">${uiIcon(topUp ? 'arrowUpRight' : 'refresh')}</span>
          <div class="row-copy"><div class="row-name">${escapeHtml(record.provider || tr('subscriptions.untitled'))}</div><div class="row-sub">${escapeHtml(detail || tr('subscriptions.noDetails'))}</div></div>
        </div>
        <div class="row-metrics"><div class="row-value">${escapeHtml(formatSubscriptionMoney(recordAmount, record.currency))}</div><div class="row-cost">${escapeHtml(record.currency || 'USD')}</div></div>
        ${canManage ? `<details class="row-action-menu"><summary aria-label="${escapeHtml(tr('actions.more'))}" data-management-focus="subscription-${escapeHtml(record.id)}">•••</summary><div class="row-action-popover"><fluent-button appearance="transparent" type="button" data-subscription-edit="${escapeHtml(record.id)}">${tr('actions.edit')}</fluent-button><fluent-button appearance="transparent" type="button" class="danger-btn" data-subscription-delete="${escapeHtml(record.id)}">${tr('actions.delete')}</fluent-button></div></details>` : ''}
      </article>`;
    }).join('')}</div>`
    : emptyHtml('subscriptions.empty');
  const form = `<form class="management-form" data-subscription-form data-draft-key="${escapeHtml(subscriptionDraftKey)}">
    <div class="form-section-head"><div><p class="muted tiny">${tr('subscriptions.formHint')}</p></div></div>
    <div class="form-grid">
      <fluent-text-input class="field" name="provider" required value="${subscriptionField(editing, 'provider')}" placeholder="codex">${tr('subscriptions.provider')}</fluent-text-input>
      <label class="field"><span>${tr('subscriptions.kind')}</span><fluent-dropdown name="kind" data-subscription-kind><fluent-listbox><fluent-option value="subscription"${!formIsTopUp ? ' selected' : ''}>${tr('subscriptions.plan')}</fluent-option><fluent-option value="topup"${formIsTopUp ? ' selected' : ''}>${tr('subscriptions.topup')}</fluent-option></fluent-listbox></fluent-dropdown></label>
      <fluent-text-input class="field" name="planName" value="${subscriptionField(editing, 'planName')}" placeholder="Pro">${tr('subscriptions.planName')}</fluent-text-input>
      ${!formIsTopUp ? `<label class="field"><span>${tr('subscriptions.amount')}</span><input name="amount" type="number" min="0" step="0.01" value="${escapeHtml(amount || '')}" required /></label>` : ''}
      <label class="field"><span>${tr('subscriptions.currency')}</span><fluent-dropdown name="currency"><fluent-listbox>${['USD', 'CNY', 'TWD', 'HKD'].map((code) => `<fluent-option value="${code}"${(editing?.currency || 'USD') === code ? ' selected' : ''}>${code}</fluent-option>`).join('')}</fluent-listbox></fluent-dropdown></label>
      <label class="field"><span>${tr('subscriptions.interval')}</span><fluent-dropdown name="interval"><fluent-listbox><fluent-option value="month"${editing?.interval !== 'year' ? ' selected' : ''}>${tr('subscriptions.monthly')}</fluent-option><fluent-option value="year"${editing?.interval === 'year' ? ' selected' : ''}>${tr('subscriptions.yearly')}</fluent-option></fluent-listbox></fluent-dropdown></label>
      <label class="field"><span>${tr('subscriptions.intervalCount')}</span><input name="intervalCount" type="number" min="1" max="24" step="1" value="${subscriptionField(editing, 'intervalCount', '1')}" /></label>
      ${formIsTopUp ? `<div class="field field-wide topup-ledger" data-topup-ledger><div class="topup-ledger-head"><span>${tr('subscriptions.topupLedger')}</span><fluent-button appearance="transparent" type="button" class="ghost-btn" data-topup-add>${tr('subscriptions.topupAdd')}</fluent-button></div>${topUpRows.map(subscriptionTopUpRowHtml).join('')}</div>` : `<label class="field"><span>${tr('subscriptions.startDate')}</span><input name="startDate" type="date" value="${subscriptionField(editing, 'startDate')}" /></label>`}
      <label class="field"><span>${tr('subscriptions.nextRenewal')}</span><input name="nextRenewalOverride" type="date" value="${subscriptionField(editing, 'nextRenewalOverride')}" /></label>
      <label class="field"><span>${tr('subscriptions.endDate')}</span><input name="endDate" type="date" value="${subscriptionField(editing, 'endDate')}" /></label>
      <fluent-text-input class="field" name="accountEmail" type="email" value="${subscriptionField(editing?.binding, 'accountEmail')}">${tr('subscriptions.accountEmail')}</fluent-text-input>
      <fluent-text-input class="field" name="profileName" value="${subscriptionField(editing?.binding, 'profileName')}">${tr('subscriptions.profileName')}</fluent-text-input>
      <fluent-text-input class="field field-wide" name="note" value="${subscriptionField(editing, 'note')}">${tr('subscriptions.note')}</fluent-text-input>
    </div>
    <label class="check-row"><input name="autoRenew" type="checkbox"${editing?.autoRenew !== false ? ' checked' : ''} /><span>${tr('subscriptions.autoRenew')}</span></label>
    <div class="drawer-actions management-form-actions"><fluent-button appearance="transparent" type="button" class="ghost-btn" data-subscription-reset>${tr('actions.cancel')}</fluent-button><fluent-button appearance="primary" type="submit" class="primary-btn"${state.subscriptionsSaving ? ' disabled' : ''}>${state.subscriptionsSaving ? tr('actions.saving') : tr('actions.save')}</fluent-button></div>
  </form>`;
  const addAction = canManage
    ? `<fluent-button appearance="primary" type="button" class="primary-btn" data-subscription-add>${tr('subscriptions.add')}</fluent-button>`
    : '';
  const management = canManage
    ? `<div class="drawer management-drawer${state.subscriptionDrawerOpen ? '' : ' hidden'}" data-management-drawer="subscription" aria-hidden="${state.subscriptionDrawerOpen ? 'false' : 'true'}">
        <div class="drawer-backdrop" data-close-management-drawer></div>
        <aside class="drawer-panel management-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="subscription-form-title" tabindex="-1">
          <header class="drawer-head"><div><h2 id="subscription-form-title">${editing ? tr('subscriptions.edit') : tr('subscriptions.add')}</h2><p class="muted tiny">${tr('subscriptions.formHint')}</p></div><fluent-button appearance="transparent" icon-only type="button" class="icon-btn" data-close-management-drawer aria-label="${tr('actions.close')}"><span class="ui-icon-slot" data-ui-icon="close"></span></fluent-button></header>
          <div class="drawer-body">${form}</div>
        </aside>
      </div>`
    : '';
  return `${renderCompletenessNotice(viewStats(), state.prefs.period)}${conflictNotice}<div class="settings-section-toolbar">${addAction}</div><div class="summary-grid subscription-summary">${summary}</div>${list}${management}`;
}

function renderPricing() {
  if (state.pricingLoading && !state.pricing) return loadingHtml();
  if (state.pricingError && !state.pricing) return managementError(tr('pricing.title'), state.pricingError, 'pricing-retry');
  const entries = Array.isArray(state.pricing) ? state.pricing : [];
  const formatPrice = (value) => new Intl.NumberFormat(state.locale, { maximumFractionDigits: 6 }).format(Number(value || 0));
  const rows = entries.length
    ? `<div class="pricing-table" role="table" aria-label="${escapeHtml(tr('pricing.title'))}">
        <div class="pricing-table-head" role="row"><span role="columnheader">${tr('pricing.model')}</span><span role="columnheader">${tr('pricing.input')}</span><span role="columnheader">${tr('pricing.output')}</span><span role="columnheader">${tr('pricing.cacheRead')}</span><span role="columnheader">${tr('pricing.cacheWrite')}</span><span role="columnheader"></span></div>
        ${entries.map((entry) => `<div class="pricing-row" role="row">
          <div class="pricing-model" role="cell"><strong>${escapeHtml(entry.model)}</strong><span class="row-sub">${escapeHtml(entry.source || '')}${entry.updatedAt ? ` · ${escapeHtml(entry.updatedAt)}` : ''}</span></div>
          <span class="pricing-value" role="cell" data-label="${escapeHtml(tr('pricing.input'))}">${formatPrice(entry.inputPricePerMillion)}</span>
          <span class="pricing-value" role="cell" data-label="${escapeHtml(tr('pricing.output'))}">${formatPrice(entry.outputPricePerMillion)}</span>
          <span class="pricing-value" role="cell" data-label="${escapeHtml(tr('pricing.cacheRead'))}">${formatPrice(entry.cacheReadPricePerMillion)}</span>
          <span class="pricing-value" role="cell" data-label="${escapeHtml(tr('pricing.cacheWrite'))}">${formatPrice(entry.cacheWritePricePerMillion)}</span>
          <details class="row-action-menu" role="cell"><summary aria-label="${escapeHtml(tr('actions.more'))}" data-management-focus="pricing-${escapeHtml(entry.model)}">•••</summary><div class="row-action-popover"><fluent-button appearance="transparent" type="button" data-pricing-edit="${escapeHtml(entry.model)}">${tr('actions.edit')}</fluent-button><fluent-button appearance="transparent" type="button" data-pricing-upstream="${escapeHtml(entry.model)}">${tr('pricing.fetch')}</fluent-button></div></details>
        </div>`).join('')}
      </div>`
    : emptyHtml('pricing.empty');
  const editing = entries.find((entry) => entry.model === state.pricingEditModel) || null;
  const addAction = `<fluent-button appearance="primary" type="button" class="primary-btn" data-pricing-add>${tr('pricing.add')}</fluent-button>`;
  const actions = `<div class="pricing-toolbar"><span class="muted tiny">${tr('pricing.hint')}</span><div class="pricing-toolbar-actions"><fluent-button appearance="transparent" type="button" class="ghost-btn" data-pricing-refresh-all>${tr('pricing.refreshAll')}</fluent-button>${addAction}</div></div>`;
  const drawer = state.pricingDrawerOpen
    ? `<div class="drawer management-drawer" data-management-drawer="pricing" aria-hidden="false">
        <div class="drawer-backdrop" data-close-management-drawer></div>
        <aside class="drawer-panel management-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="pricing-form-title" tabindex="-1">
          <header class="drawer-head"><div><h2 id="pricing-form-title">${editing ? tr('actions.edit') : tr('pricing.add')}</h2><p class="muted tiny">${tr('pricing.hint')}</p></div><fluent-button appearance="transparent" icon-only type="button" class="icon-btn" data-close-management-drawer aria-label="${tr('actions.close')}"><span class="ui-icon-slot" data-ui-icon="close"></span></fluent-button></header>
          <div class="drawer-body">${pricingForm(editing)}</div>
        </aside>
      </div>`
    : '';
  return `${actions}${rows}${drawer}`;
}

function pricingForm(entry) {
  const model = entry?.model || '';
  const value = (field) => escapeHtml(entry?.[field] ?? '');
  const draftKey = `pricing:${model || 'new'}`;
  return `<form class="pricing-form" data-pricing-form data-pricing-model="${escapeHtml(model)}" data-draft-key="${escapeHtml(draftKey)}">
    <div class="pricing-form-head"><div><h3>${escapeHtml(model || tr('pricing.newModel'))}</h3><p class="muted tiny">${entry?.source ? `${escapeHtml(entry.source)} · ${escapeHtml(entry.updatedAt || '')}` : tr('pricing.formHint')}</p></div>${entry ? `<fluent-button appearance="transparent" type="button" class="ghost-btn" data-pricing-upstream="${escapeHtml(model)}">${tr('pricing.fetch')}</fluent-button>` : ''}</div>
    <div class="form-grid pricing-grid">
      <label class="field${entry ? '' : ' field-wide'}"><span>${tr('pricing.model')}</span><input name="model" required value="${escapeHtml(model)}" placeholder="gpt-5"${entry ? ' readonly' : ''} /></label>
      <label class="field"><span>${tr('pricing.input')}</span><input name="inputPricePerMillion" type="number" min="0" step="any" required value="${value('inputPricePerMillion')}" /></label>
      <label class="field"><span>${tr('pricing.output')}</span><input name="outputPricePerMillion" type="number" min="0" step="any" required value="${value('outputPricePerMillion')}" /></label>
      <label class="field"><span>${tr('pricing.cacheRead')}</span><input name="cacheReadPricePerMillion" type="number" min="0" step="any" required value="${value('cacheReadPricePerMillion')}" /></label>
      <label class="field"><span>${tr('pricing.cacheWrite')}</span><input name="cacheWritePricePerMillion" type="number" min="0" step="any" required value="${value('cacheWritePricePerMillion')}" /></label>
    </div>
    <div class="drawer-actions"><fluent-button appearance="primary" type="submit" class="primary-btn"${state.pricingSaving ? ' disabled' : ''}>${state.pricingSaving ? tr('actions.saving') : tr('actions.save')}</fluent-button></div>
  </form>`;
}

// The 消费 section body: the subscriptions/pricing tablist and its panel. It
// lives in app.js because those renderers read the app's ledger state; the
// Management page receives the rendered body.
function renderConsumptionSection() {
  const owner = state.authorization?.authenticated === true;
  const pricingVisible = state.authorization?.capabilities?.pricing !== false && owner;
  const current = state.prefs.managementTab === 'pricing' && pricingVisible ? 'pricing' : 'subscriptions';
  if (state.prefs.managementTab !== current) state.prefs.managementTab = current;
  const body = current === 'pricing' ? renderPricing() : renderSubscriptions();
  return `<tm-tablist class="page-tabs" aria-label="${escapeHtml(tr('management.section.consumption'))}" role="tablist">
    <fluent-tab id="management-tab-subscriptions" role="tab" aria-controls="management-tabpanel" aria-selected="${current === 'subscriptions' ? 'true' : 'false'}" class="page-tab${current === 'subscriptions' ? ' active' : ''}" data-management-tab="subscriptions">${escapeHtml(tr('management.tabs.subscriptions'))}</fluent-tab>
    ${pricingVisible ? `<fluent-tab id="management-tab-pricing" role="tab" aria-controls="management-tabpanel" aria-selected="${current === 'pricing' ? 'true' : 'false'}" class="page-tab${current === 'pricing' ? ' active' : ''}" data-management-tab="pricing">${escapeHtml(tr('management.tabs.pricing'))}</fluent-tab>` : ''}
  </tm-tablist>
  <section class="management-tabpanel" id="management-tabpanel" role="tabpanel" aria-labelledby="management-tab-${current}" tabindex="0">${body}</section>`;
}

function settingsOptionList(options, selected) {
  return `<fluent-listbox>${options.map(([value, label]) => `<fluent-option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</fluent-option>`).join('')}</fluent-listbox>`;
}


async function saveWebSettingsForm(form) {
  const values = new FormData(form);
  state.prefs.language = String(values.get('language') || 'auto');
  state.prefs.theme = String(values.get('theme') || 'system');
  state.prefs.currency = String(values.get('currency') || 'USD');
  if (!isCapable('desktopSettings')) state.prefs.reduceMotion = String(values.get('reduceMotion') || 'system');
  // On desktop the quota-count control lives in the desktop group; reading the
  // absent field here would reset it to the default on every language or theme save.
  if (!isCapable('desktopSettings')) {
    state.prefs.homeLimitAccountCount = clampHomeLimitAccountCount(values.get('homeLimitAccountCount'), 3);
  }
  savePrefs({
    language: state.prefs.language,
    theme: state.prefs.theme,
    reduceMotion: state.prefs.reduceMotion,
    currency: state.prefs.currency,
    homeLimitAccountCount: state.prefs.homeLimitAccountCount
  });
  clearFormDraft('preferences');
  const nextSecret = String(values.get('secret') || '').trim();
  const secretChanged = nextSecret !== state.secret;
  applyTheme();
  applyLocale();
  if (secretChanged) {
    const ok = await tryConnect(nextSecret, true, { persist: true });
    if (!ok) return false;
  }
  showToast(tr('toast.saved'));
  return true;
}

function signOutFromHub() {
  clearSecret();
  state.secret = '';
  if (state.stopStream) state.stopStream();
  state.stopStream = null;
  setStreamStatus('offline');
  showAuth(true);
}




function trendValue(value, metric) {
  if (metric === 'cost') return Number(value?.cost ?? value ?? 0);
  if (metric === 'activeTime') return Number(value?.activeTimeMs || 0);
  return Number(value?.tokens ?? value ?? 0);
}

function formatTrendValue(value, metric) {
  return metric === 'cost'
    ? formatCost(value, state.prefs.currency)
    : metric === 'activeTime'
      ? formatDuration(value)
      : formatNumber(value);
}


// A "quiet" render is one the user did not ask for: an SSE/stats frame, a
// settings push, a history or management request settling. Those may need to
// rebuild the DOM, but they must never do it while the user has a transient
// control open (a Fluent dropdown popover, a dirty form) — replacing the DOM
// closes the dropdown and snaps a half-typed value back. Each quiet render is
// deferred to `renderPending` and retried once the interaction ends.
const DEFERRED_RENDER_EVENTS = ['pointerdown', 'focusout', 'keyup'];

// `renderPending` is the anchor the performance test slices this file on, so it
// is declared first and every other deferral variable follows it: the test
// evaluates the slice from here to `ensureHistory`, and a declaration above this
// line would be missing from that context.
let renderPending = false;
let quietFailed = false; // a quiet view render threw; stay eager until one succeeds

function queueDeferredRender() {
  renderPending = true;
}

/**
 * True while the user has a transient surface open that a content rebuild would
 * destroy: a Fluent dropdown popover, a modal management drawer, or a form the
 * *focused* control belongs to with unsaved input.
 *
 * The draft check is deliberately focus-scoped rather than "any dirty draft":
 * a draft the user abandoned by clicking a nav link must not suppress updates
 * for the rest of the session. A `details` menu is not counted — the render
 * snapshot restores it, and a menu that closed on every frame is worse than one
 * that stays open.
 */
function hasOpenTransientInteraction() {
  const content = els?.content;
  if (!content?.querySelector) return false;
  if (content.querySelector('fluent-dropdown fluent-listbox:popover-open')) return true;
  if (content.querySelector('.management-drawer:not(.hidden)')) return true;
  // Only the scope the focused control belongs to counts: a draft abandoned by
  // clicking elsewhere must not suppress updates for the rest of the session.
  const active = document?.activeElement;
  if (active?.closest) {
    const scope = active.closest('[data-draft-key]');
    const key = String(scope?.dataset?.draftKey || '').trim();
    if (key && state.formDrafts?.get(key)?.dirty) return true;
  }
  return false;
}

function renderDeferred() {
  // Replay as a *quiet* render so an interaction that is still open keeps
  // deferring rather than being torn down by the retry itself. Once the
  // interaction ends this applies the pending frame; until then it stays
  // pending, which is the whole point of deferring.
  if (renderPending) render({ quiet: true });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && renderPending) render({ quiet: true });
});
// The replay listeners are installed in `bindEvents()` rather than at module
// scope: booting the app is a host concern, and a module-scope `for` loop here
// would also run in the unit tests that evaluate a slice of this file.

// The desktop window delays its own reveal until this fires, so a reopened window
// never paints the shell's static "0" placeholders first. The main process keeps a
// timeout fallback, so an unreachable collector still shows the window.
let contentReadySignalled = false;
function signalContentReady() {
  if (contentReadySignalled || !state.stats) return;
  contentReadySignalled = true;
  getTransport().desktop?.signalContentReady?.();
}

function render({ quiet = false } = {}) {
  // Continue accepting snapshots while hidden, but rebuild the DOM only once
  // with the latest state when the user returns to the window/tab.
  if (document.hidden) {
    queueDeferredRender();
    return;
  }
  // A quiet render that would destroy a control the user is in the middle of
  // using is deferred, not dropped: `renderDeferred` replays it once the
  // interaction ends. A user-driven render (a click, a preference change) is
  // never deferred — the caller states the interaction is already committed.
  if (quiet && !quietFailed && hasOpenTransientInteraction()) {
    queueDeferredRender();
    return;
  }
  renderPending = false;
  const renderState = captureRenderState();
  renderChrome();
  if (typeof renderDesktopSyncStatus === 'function') renderDesktopSyncStatus();
  // A browser has to wait for its authorized Hub snapshot. The desktop host
  // has an independent local collector/cache and must keep navigation and
  // settings usable while a remote request is timing out.
  const desktopHost = isCapable('desktopSettings');
  if (state.loading && !state.stats && !desktopHost) {
    writeContentHtml(loadingHtml(), renderState);
    return;
  }
  if (state.error && !state.stats && !desktopHost) {
    writeContentHtml(`<section class="error-card"><div class="error-kicker">${escapeHtml(tr('brand.name'))}</div><h2>${escapeHtml(tr('error.title'))}</h2><p>${escapeHtml(state.error.message || tr('error.generic'))}</p><fluent-button appearance="primary" type="button" class="primary-btn" data-retry-dashboard>${tr('actions.retry')}</fluent-button></section>`, renderState);
    return;
  }
  let html;
  try {
    // Keep the hero update before the view render: it is useful to show the
    // latest aggregate even when a secondary view has a local rendering bug.
    renderHero();
    switch (state.prefs.view) {
      case 'usage':
        html = renderUsage();
        break;
      case 'devices':
        html = renderDevices();
        break;
      case 'limits':
        html = renderLimits();
        break;
      case 'trends':
        html = renderTrends();
        break;
      case 'settings':
        // The 消费 body only ever mounts into the web section; building it for the
        // desktop host would walk ledger state no section renders.
        html = renderSettingsPage({
          consumption: desktopHost ? '' : renderConsumptionSection()
        });
        break;
      default:
        html = renderHome();
    }
  } catch (error) {
    // A view exception used to leave the previous loading skeleton in place,
    // which made a valid stats response look like a dead Hub. Keep the
    // diagnostic in the console without exposing internal details or secrets
    // in the page, and give the user a retry path.
    console.error('[token-monitor] view render failed', error);
    // A throwing quiet render must not take the quiet path on later frames:
    // the error card is the only signal the user gets, so it has to paint.
    quietFailed = true;
    writeContentHtml(`<section class="error-card" role="alert"><div class="error-kicker">${escapeHtml(tr('brand.name'))}</div><h2>${escapeHtml(tr('error.title'))}</h2><p>${escapeHtml(tr('error.generic'))}</p><fluent-button appearance="primary" type="button" class="primary-btn" data-retry-dashboard>${tr('actions.retry')}</fluent-button></section>`, renderState);
    return;
  }
  // The skip-write check below makes per-frame work bounded: a tick that changes
  // nothing the user can see costs one `innerHTML` read and no DOM mutation.
  // A successful view render re-enables the quiet path after an earlier throw.
  quietFailed = false;
  writeContentHtml(html, renderState);
}

// The last HTML written to `#content`, and the view it belonged to. A quiet
// render that reproduces the previous bytes leaves the DOM untouched, which is
// what keeps an open dropdown, a focused input, a scroll position and a
// restored `<details>` alive across a stats tick that changed nothing visible.
let lastRenderedHtml = null;
let lastRenderedView = '';

/** Write `#content` only when the bytes actually changed; restore state either way. */
function writeContentHtml(html, renderState) {
  const view = state.prefs.view;
  if (html === lastRenderedHtml && view === lastRenderedView) {
    if (typeof renderDesktopConnectionError === 'function') renderDesktopConnectionError();
    return;
  }
  els.content.innerHTML = html;
  lastRenderedHtml = html;
  lastRenderedView = view;
  restoreRenderState(renderState);
  if (typeof renderDesktopConnectionError === 'function') renderDesktopConnectionError();
}

async function ensureHistory({ force = false, deviceId = state.prefs.deviceFilter || '' } = {}) {
  // Full /api/history includes perClient/perModel stacks needed by Trends.
  // historyPreview from /api/stats is totals-only and must NOT block this fetch.
  if (!state.secret && state.health?.secretRequired) return;
  const scopedDeviceId = String(deviceId || '').trim();
  if (!force && state.history && state.historyDeviceId === scopedDeviceId) return;
  if (state.historyRequest && state.historyRequestDeviceId === scopedDeviceId) return state.historyRequest;
  const requestSequence = ++state.historyRequestSequence;
  state.historyLoading = true;
  state.historyLoadingDeviceId = scopedDeviceId;
  state.historyError = null;
  state.historyErrorDeviceId = '';
  state.historyRequestDeviceId = scopedDeviceId;
  const path = scopedDeviceId
    ? `/api/history?deviceId=${encodeURIComponent(scopedDeviceId)}`
    : '/api/history';
  const request = (async () => {
    try {
      const full = await fetchJson(path, { secret: state.secret });
      if (!full || !Array.isArray(full.daily)) throw new Error('bad_history_payload');
      if (requestSequence === state.historyRequestSequence) {
        state.history = full;
        state.historyDeviceId = scopedDeviceId;
      }
    } catch (error) {
      if (requestSequence === state.historyRequestSequence) {
        if (error.status === 401) showAuth(true);
        state.historyError = error;
        state.historyErrorDeviceId = scopedDeviceId;
      }
    } finally {
      if (requestSequence === state.historyRequestSequence) {
        state.historyLoading = false;
        state.historyLoadingDeviceId = '';
        state.historyRequest = null;
        state.historyRequestDeviceId = '';
      }
    }
  })();
  state.historyRequest = request;
  return request;
}

function applyStatsSnapshot(stats, meta = null) {
  if (!stats || typeof stats !== 'object') return;
  const previous = state.stats;
  const historyChanged = Boolean(previous)
    && (previous.historyRevision !== stats.historyRevision
      || previous.deviceHistoryRevision !== stats.deviceHistoryRevision);
  const subscriptionsChanged = Boolean(previous)
    && previous.subscriptionsUpdatedAt !== stats.subscriptionsUpdatedAt;
  state.stats = stats;
  if (meta?.snapshot) state.desktopSnapshotMeta = meta.snapshot;
  else if (meta && isCapable('desktopSettings')) state.desktopSnapshotMeta = meta;
  state.loading = false;
  state.error = null;
  if (historyChanged) {
    state.history = null;
    if (state.prefs.view === 'overview' || state.prefs.view === 'trends') {
      void ensureHistory({ force: true }).then(() => render({ quiet: true }));
    }
  }
  if (subscriptionsChanged && state.subscriptions) {
    void loadSubscriptions({ force: true, preserveDraft: hasDirtyFormDraft('subscription:') });
  }
  // Also the boot and post-auth retry path for a persisted preset: the selection is
  // restored before any range has been fetched, and the first snapshot is the signal
  // that the host can answer it.
  const presetRange = pendingPresetRangeWindow();
  // A snapshot frame is data-driven: it must not tear down an open dropdown or a
  // form the user is typing into. Deferring still accepts the frame; it just paints
  // after the interaction ends.
  render({ quiet: true });
  if (presetRange) void loadPresetRange(presetRange).then(() => render({ quiet: true }));
  // Painted with real data: release a desktop window that is waiting to reveal.
  signalContentReady();
}

async function refreshStats() {
  state.error = null;
  const stats = await fetchJson('/api/stats', { secret: state.secret });
  let meta = null;
  if (isCapable('desktopSettings')) {
    try { meta = await getTransport().desktop?.getSnapshotMeta?.(); } catch (_) {}
  }
  applyStatsSnapshot(stats, meta);
  return stats;
}

function connectStream() {
  if (state.stopStream) {
    state.stopStream();
    state.stopStream = null;
  }
  state.stopStream = openStatsStream({
    secret: state.secret,
    onStatus: setStreamStatus,
    onStats: (stats, _event, meta) => {
      if (meta?.lastEventAt) state.dataAsOf = meta.lastEventAt;
      applyStatsSnapshot(stats, meta);
    },
    onHealth: (health) => {
      if (!isCapable('desktopSettings')) return;
      if (health?.snapshot) state.desktopSnapshotMeta = health.snapshot;
      state.desktopSyncHealth = health;
      if (health?.local || health?.upload || health?.rest || health?.stream) {
        state.desktopConnectionError = null;
      }
      renderDesktopSyncStatus();
    },
    onRetry: (delay) => {
      if (state.stream !== 'live') setStreamStatus('retrying');
      if (delay) els.streamStatus.title = `${tr('status.retrying')} · ${Math.ceil(delay / 1000)}s`;
    }
  });
}

function startManagementRequest(kind) {
  state.managementControllers[kind]?.abort();
  const controller = new AbortController();
  const seq = (state.managementRequestSeq[kind] || 0) + 1;
  state.managementRequestSeq[kind] = seq;
  state.managementControllers[kind] = controller;
  return { controller, seq };
}

function isCurrentManagementRequest(kind, seq) {
  return state.managementRequestSeq[kind] === seq;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

async function loadSubscriptions({ force = false, preserveDraft = false } = {}) {
  if (!force && state.subscriptions) return state.subscriptions;
  if (!force && state.subscriptionsLoading) return state.managementPromises.subscriptions || state.subscriptions;
  const { controller, seq } = startManagementRequest('subscriptions');
  state.subscriptionsLoading = true;
  state.subscriptionsError = null;
  const keepDraft = Boolean(preserveDraft || hasDirtyFormDraft('subscription:'));
  const request = (async () => {
    try {
      const next = await fetchJson('/api/subscriptions', { secret: state.secret, signal: controller.signal });
      if (!isCurrentManagementRequest('subscriptions', seq)) return state.subscriptions;
      if (keepDraft && state.subscriptions) {
        state.subscriptionsPending = next;
        state.subscriptionsConflict = true;
      } else {
        state.subscriptions = next;
        state.subscriptionsPending = null;
        state.subscriptionsConflict = false;
      }
      return state.subscriptions;
    } catch (error) {
      if (!isCurrentManagementRequest('subscriptions', seq) || isAbortError(error)) return state.subscriptions;
      state.subscriptionsError = error;
      if (error.status === 401) showAuth(true);
      return null;
    } finally {
      if (isCurrentManagementRequest('subscriptions', seq)) {
        state.subscriptionsLoading = false;
        state.managementControllers.subscriptions = null;
        state.managementPromises.subscriptions = null;
        if (state.prefs.view === 'settings' && state.prefs.managementSection === 'consumption' && state.prefs.managementTab === 'subscriptions') render({ quiet: true });
      }
    }
  })();
  state.managementPromises.subscriptions = request;
  return request;
}

async function loadPricing({ force = false } = {}) {
  if (!force && state.pricing) return state.pricing;
  if (!force && state.pricingLoading) return state.managementPromises.pricing || state.pricing;
  const { controller, seq } = startManagementRequest('pricing');
  state.pricingLoading = true;
  state.pricingError = null;
  const request = (async () => {
    try {
      const payload = await fetchJson('/api/pricing', { secret: state.secret, signal: controller.signal });
      if (!isCurrentManagementRequest('pricing', seq)) return state.pricing;
      state.pricing = Array.isArray(payload?.pricing) ? payload.pricing : [];
      return state.pricing;
    } catch (error) {
      if (!isCurrentManagementRequest('pricing', seq) || isAbortError(error)) return state.pricing;
      state.pricingError = error;
      if (error.status === 401) showAuth(true);
      return null;
    } finally {
      if (isCurrentManagementRequest('pricing', seq)) {
        state.pricingLoading = false;
        state.managementControllers.pricing = null;
        state.managementPromises.pricing = null;
        if (state.prefs.view === 'settings' && state.prefs.managementSection === 'consumption' && state.prefs.managementTab === 'pricing') render({ quiet: true });
      }
    }
  })();
  state.managementPromises.pricing = request;
  return request;
}

async function loadAccounts({ force = false } = {}) {
  if (!force && state.accounts) return state.accounts;
  if (!force && state.accountsLoading) return state.managementPromises.accounts || state.accounts;
  const { controller, seq } = startManagementRequest('accounts');
  state.accountsLoading = true;
  state.accountsError = null;
  const request = (async () => {
    try {
      const payload = await fetchJson('/api/accounts', { secret: state.secret, signal: controller.signal });
      if (!isCurrentManagementRequest('accounts', seq)) return state.accounts;
      state.accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
      return state.accounts;
    } catch (error) {
      if (!isCurrentManagementRequest('accounts', seq) || isAbortError(error)) return state.accounts;
      state.accountsError = error;
      if (error.status === 401) showAuth(true);
      return null;
    } finally {
      if (isCurrentManagementRequest('accounts', seq)) {
        state.accountsLoading = false;
        state.managementControllers.accounts = null;
        state.managementPromises.accounts = null;
        if (state.prefs.view === 'settings' && state.prefs.managementSection === 'accounts') render({ quiet: true });
      }
    }
  })();
  state.managementPromises.accounts = request;
  return request;
}



async function saveAccountFromForm(form) {
  const values = new FormData(form);
  const editing = state.accounts?.find((a) => a.id === state.accountEditId) || null;
  const mode = String(form.dataset.accountMode || state.accountFormMode || 'simple');
  const draftKey = draftKeyForForm(form);
  const provider = editing ? editing.provider : String(values.get('provider') || '').trim().toLowerCase();
  const name = String(values.get('name') || '').trim();
  const label = String(values.get('label') || '').trim();
  const enabled = values.get('enabled') !== null ? values.get('enabled') === 'on' : true;

  if (!name) throw new Error(tr('accounts.nameRequired'));
  if (!provider) throw new Error(tr('accounts.providerRequired'));

  const oauthMode = mode === 'oauth' && isBrowserLoginProvider(provider);
  const oauthAccountId = editing ? editing.id : '';
  if (oauthMode) {
    const agree = values.get('disclaimerAgree');
    // The disclaimer is a one-time acknowledgement on creation; re-authorizing an
    // account the owner already accepted must not require it again.
    if (!editing && agree !== 'on') throw new Error(tr('accounts.disclaimerRequired'));
    const sessionId = String(values.get('oauthSessionId') || '').trim();
    const redirectUrl = String(values.get('redirectUrl') || '').trim();
    if (!sessionId || !redirectUrl) throw new Error(tr('accounts.oauthInputRequired'));

    state.accountsSaving = true;
    state.accountFormError = '';
    render();
    try {
      // With an accountId the Hub replaces this account's credential in place,
      // so re-authorizing never creates a duplicate login.
      await fetchJson('/api/accounts/oauth/exchange', {
        secret: state.secret,
        method: 'POST',
        body: { sessionId, redirectUrl, name, label, ...(oauthAccountId ? { accountId: oauthAccountId } : {}) }
      });
      state.oauthSession = null;
      state.accountFormMode = 'simple';
      state.accountSelectedProvider = 'deepseek';
      state.accountFormError = '';
      state.accountDrawerOpen = false;
      state.accountEditId = '';
      clearFormDraft(draftKey);
      showToast(tr('accounts.updated'));
      await loadAccounts({ force: true });
      await refreshStats();
    } catch (error) {
      state.accountFormError = error.message || tr('error.generic');
      showToast(state.accountFormError);
    } finally {
      state.accountsSaving = false;
      render();
    }
    return;
  }

  let credential = null;
  if (mode === 'json') {
    const rawJson = String(values.get('credentialJson') || '').trim();
    if (rawJson) {
      try {
        credential = JSON.parse(rawJson);
      } catch (err) {
        throw new Error(tr('accounts.invalidJson'), { cause: err });
      }
      if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
        throw new Error(tr('accounts.invalidJson'));
      }
    }
  } else {
    // Simple mode
    const apiKey = String(values.get('apiKey') || '').trim();
    const cookie = String(values.get('cookie') || '').trim();
    const accessToken = String(values.get('accessToken') || '').trim();
    const accessKeyId = String(values.get('accessKeyId') || '').trim();
    const secretAccessKey = String(values.get('secretAccessKey') || '').trim();
    const region = String(values.get('region') || '').trim();
    const site = String(values.get('site') || '').trim();
    const organizationId = String(values.get('organizationId') || '').trim();
    const projectId = String(values.get('projectId') || '').trim();
    const adapter = String(values.get('adapter') || '').trim();
    const baseUrl = String(values.get('baseUrl') || '').trim();
    const enterpriseHost = String(values.get('enterpriseHost') || '').trim();
    const authJson = String(values.get('authJson') || '').trim();
    const endpoint = String(values.get('endpoint') || '').trim();
    const csrfToken = String(values.get('csrfToken') || '').trim();
    const accountId = String(values.get('accountId') || '').trim();
    const serviceToken = String(values.get('serviceToken') || '').trim();
    const userId = String(values.get('userId') || '').trim();
    const refreshToken = String(values.get('refreshToken') || '').trim();

    const credObj = {};
    if (apiKey) credObj.apiKey = apiKey;
    if (cookie) credObj.cookie = cookie;
    if (serviceToken || userId) {
      if (!credObj.cookie) {
        const parts = [];
        if (serviceToken) parts.push(`api-platform_serviceToken=${serviceToken}`);
        if (userId) parts.push(`userId=${userId}`);
        credObj.cookie = parts.join('; ');
      }
    }
    if (accessToken) credObj.accessToken = accessToken;
    if (refreshToken) credObj.refreshToken = refreshToken;
    if (accessKeyId) credObj.accessKeyId = accessKeyId;
    if (secretAccessKey) credObj.secretAccessKey = secretAccessKey;
    if (region) credObj.region = region;
    if (site) credObj.site = site;
    if (organizationId) credObj.organizationId = organizationId;
    if (projectId) credObj.projectId = projectId;
    if (enterpriseHost) credObj.enterpriseHost = enterpriseHost;
    if (endpoint) credObj.endpoint = endpoint;
    if (csrfToken) credObj.csrfToken = csrfToken;
    if (accountId) credObj.accountId = accountId;
    if (authJson) {
      try { credObj.authJson = JSON.parse(authJson); }
      catch (_) { credObj.authJson = authJson; }
    }
    if (adapter || baseUrl) {
      credObj.adapter = adapter || 'newapi';
      credObj.baseUrl = baseUrl;
    }
    if (Object.keys(credObj).length > 0) {
      credential = credObj;
    }
  }

  if (!editing && !credential) {
    throw new Error(tr('accounts.credentialRequired'));
  }

  if (!editing && isBrowserLoginProvider(provider)) {
    const agree = values.get('disclaimerAgree');
    if (agree !== 'on') {
      throw new Error(tr('accounts.disclaimerRequired'));
    }
  }

  state.accountsSaving = true;
  state.accountFormError = '';
  render();
  try {
    if (editing) {
      const patch = { name, label, enabled };
      if (credential) {
        patch.credential = credential;
        patch.credentialMode = mode === 'json' ? 'replace' : 'merge';
      }
      await fetchJson(`/api/accounts/${encodeURIComponent(editing.id)}`, {
        secret: state.secret,
        method: 'PATCH',
        body: patch
      });
      state.accountEditId = '';
    } else {
      await fetchJson('/api/accounts', {
        secret: state.secret,
        method: 'POST',
        body: { provider, name, label, credential }
      });
    }
    state.accountDrawerOpen = false;
    clearFormDraft(draftKey);
    state.accountFormError = '';
    state.accountFormMode = 'simple';
    state.accountSelectedProvider = 'deepseek';
    showToast(tr('accounts.updated'));
    await loadAccounts({ force: true });
    await refreshStats();
  } catch (error) {
    state.accountFormError = error.message || tr('error.generic');
    showToast(state.accountFormError);
  } finally {
    state.accountsSaving = false;
    render();
  }
}

async function refreshAccount(accountId) {
  if (!accountId) return;
  state.accountsSaving = true;
  render();
  try {
    await fetchJson(`/api/accounts/${encodeURIComponent(accountId)}/refresh`, {
      secret: state.secret,
      method: 'POST'
    });
    showToast(tr('toast.refreshed'));
    await loadAccounts({ force: true });
    await refreshStats();
  } catch (error) {
    showToast(error.message || tr('error.generic'));
  } finally {
    state.accountsSaving = false;
    render();
  }
}

async function clearAccountCredential(accountId) {
  const account = state.accounts?.find((a) => a.id === accountId);
  if (!account) return;
  if (!(await confirmAction(tr('accounts.confirmClearCredential', { name: account.name || account.provider })))) return;
  state.accountsSaving = true;
  render();
  try {
    await fetchJson(`/api/accounts/${encodeURIComponent(accountId)}/credential`, {
      secret: state.secret,
      method: 'DELETE'
    });
    state.oauthSession = null;
    showToast(tr('accounts.credentialCleared'));
    await loadAccounts({ force: true });
    await refreshStats();
  } catch (error) {
    showToast(error.message || tr('error.generic'));
  } finally {
    state.accountsSaving = false;
    render();
  }
}

async function toggleAccount(accountId) {
  const account = state.accounts?.find((a) => a.id === accountId);
  if (!account) return;
  state.accountsSaving = true;
  render();
  try {
    await fetchJson(`/api/accounts/${encodeURIComponent(accountId)}`, {
      secret: state.secret,
      method: 'PATCH',
      body: { enabled: !account.enabled }
    });
    showToast(tr('accounts.updated'));
    await loadAccounts({ force: true });
    await refreshStats();
  } catch (error) {
    showToast(error.message || tr('error.generic'));
  } finally {
    state.accountsSaving = false;
    render();
  }
}

async function deleteAccount(accountId) {
  const account = state.accounts?.find((a) => a.id === accountId);
  if (!account) return;
  if (!(await confirmAction(tr('accounts.confirmDelete', { name: account.name || account.provider })))) return;
  state.accountsSaving = true;
  render();
  try {
    await fetchJson(`/api/accounts/${encodeURIComponent(accountId)}`, {
      secret: state.secret,
      method: 'DELETE'
    });
    if (state.accountEditId === accountId) state.accountEditId = '';
    clearFormDraft(`account:${accountId}`);
    showToast(tr('accounts.deleted'));
    await loadAccounts({ force: true });
    await refreshStats();
  } catch (error) {
    showToast(error.message || tr('error.generic'));
  } finally {
    state.accountsSaving = false;
    render();
  }
}

async function bootstrapAuthorized() {
  showAuth(false);
  state.loading = true;
  state.error = null;
  render();
  await refreshStats();
  const capabilities = state.authorization?.capabilities || state.health?.capabilities || {};
  // The stats snapshot is the required boot dependency. Establish the stream
  // and paint the core dashboard immediately; history and management data are
  // useful enhancements and must not keep a healthy snapshot behind a spinner.
  connectStream();
  render();
  // The desktop client renders neither 账号 nor 消费: those are Hub surfaces, so
  // proxying ledger and credential reads it never displays is pure traffic.
  const hubManagement = managementSections().length > 0;
  void Promise.allSettled([
    ensureHistory(),
    hubManagement && capabilities.subscriptions !== false ? loadSubscriptions() : null,
    hubManagement && capabilities.pricing !== false ? loadPricing() : null,
    hubManagement && capabilities.hubAccounts !== false ? loadAccounts() : null
  ]).then(() => {
    if (state.stats) render({ quiet: true });
  });
}

async function tryConnect(secret, remember = true, { persist = false } = {}) {
  const candidateSecret = String(secret || '').trim();
  const desktopOwnsSecret = isCapable('desktopSettings');
  // Electron's main process owns the credential. Keep it out of renderer state;
  // a newly entered value is validated through the dedicated bridge before it is
  // persisted, because ordinary IPC requests intentionally ignore `secret`.
  state.secret = desktopOwnsSecret ? '' : candidateSecret;
  try {
    if (desktopOwnsSecret && candidateSecret) {
      state.authorization = await testSecret(candidateSecret);
      // Desktop credentials are always persisted by the main-process store;
      // `remember` remains an interface-compatible argument for the Hub form.
      await saveSecret(candidateSecret, remember);
      await fetchJson('/api/stats');
    } else {
      await fetchJson('/api/stats', { secret: candidateSecret });
      state.authorization = await fetchJson('/api/capabilities', { secret: candidateSecret });
      if (persist) await saveSecret(candidateSecret, remember);
    }
    if (desktopOwnsSecret) {
      els.secretInput.value = '';
      if (els.settingsSecret) els.settingsSecret.value = '';
    }
    els.authError.classList.add('hidden');
    await bootstrapAuthorized();
    return true;
  } catch (error) {
    if (error.status === 401) {
      els.authError.textContent = tr('auth.error');
      els.authError.classList.remove('hidden');
      showAuth(true);
      return false;
    }
    state.error = error;
    state.loading = false;
    showAuth(false);
    render();
    return false;
  }
}

async function deleteDevice(deviceId) {
  if (!deviceId) return;
  if (!(await confirmAction(tr('devices.confirmDelete')))) return;
  await fetchJson(`/api/devices/${encodeURIComponent(deviceId)}`, {
    secret: state.secret,
    method: 'DELETE'
  });
  showToast(tr('toast.deleted'));
  await refreshStats();
}

async function renameDevice(deviceId) {
  if (!deviceId) return;
  const nextDeviceId = String(await promptForValue(tr('devices.renamePrompt'), deviceId) || '').trim();
  if (!nextDeviceId || nextDeviceId === deviceId) return;
  if (!(await confirmAction(tr('devices.renameCredentialWarning')))) return;
  await fetchJson(`/api/devices/${encodeURIComponent(deviceId)}/rename`, {
    secret: state.secret,
    method: 'POST',
    body: { deviceId: nextDeviceId }
  });
  showToast(tr('devices.renamed'));
  await refreshStats();
}

/**
 * Electron intentionally has no native text-prompt API. Keep the shared
 * action usable there by falling back to a small DOM dialog when the host
 * reports that its native prompt is unavailable.
 */
async function promptForValue(message, defaultValue = '') {
  try {
    return await promptAction(message, defaultValue);
  } catch (error) {
    if (error?.code !== 'prompt_unsupported') throw error;
  }

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'inline-prompt-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('form');
    dialog.className = 'card inline-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(input.value);
    });

    const title = document.createElement('h2');
    title.textContent = message;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.className = 'inline-prompt-input';
    input.setAttribute('aria-label', message);

    const actions = document.createElement('div');
    actions.className = 'drawer-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost-btn';
    cancel.textContent = tr('actions.cancel');
    cancel.addEventListener('click', () => finish(null));
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary-btn';
    submit.textContent = tr('actions.save');
    actions.append(cancel, submit);
    dialog.append(title, input, actions);
    backdrop.append(dialog);

    const finish = (value) => {
      backdrop.remove();
      resolve(value);
    };
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(null);
    });
    document.body.append(backdrop);
    input.focus();
    input.select();
  });
}

function subscriptionFromForm(form) {
  const values = new FormData(form);
  const id = String(state.subscriptionEditId || '').trim();
  const existing = subscriptionRecords().find((record) => record.id === id) || null;
  const kind = values.get('kind') === 'topup' ? 'topup' : 'subscription';
  if (!String(values.get('provider') || '').trim()) throw new Error(tr('subscriptions.providerRequired'));
  let startDate = String(values.get('startDate') || '').trim();
  let amountMinor = Math.max(0, Math.round(Number(values.get('amount') || 0) * 100));
  let topUps = [];
  if (kind === 'topup') {
    const rows = [...form.querySelectorAll('[data-topup-row]')];
    topUps = rows.map((row) => ({
      id: row.getAttribute('data-topup-id') || `top_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      date: String(row.querySelector('[data-topup-date]')?.value || '').trim(),
      amountMinor: Math.max(0, Math.round(Number(row.querySelector('[data-topup-amount]')?.value || 0) * 100))
    }));
    if (!topUps.length || topUps.some((entry) => !entry.date)) throw new Error(tr('subscriptions.dateRequired'));
    amountMinor = topUps.reduce((sum, entry) => sum + entry.amountMinor, 0);
    startDate = null;
  } else if (!startDate) {
    throw new Error(tr('subscriptions.dateRequired'));
  }
  return {
    ...(existing || {}),
    id: id || undefined,
    provider: String(values.get('provider') || '').trim(),
    kind,
    binding: {
      ...(existing?.binding || {}),
      profileName: String(values.get('profileName') || '').trim(),
      accountEmail: String(values.get('accountEmail') || '').trim()
    },
    planName: String(values.get('planName') || '').trim(),
    amountMinor,
    currency: String(values.get('currency') || 'USD').toUpperCase(),
    interval: values.get('interval') === 'year' ? 'year' : 'month',
    intervalCount: Math.max(1, Math.min(24, Math.round(Number(values.get('intervalCount') || 1)))),
    startDate: kind === 'topup' ? null : startDate,
    topUps,
    autoRenew: kind === 'subscription' && values.get('autoRenew') === 'on',
    nextRenewalOverride: String(values.get('nextRenewalOverride') || '').trim() || null,
    endDate: String(values.get('endDate') || '').trim() || null,
    note: String(values.get('note') || '').trim()
  };
}

async function saveSubscriptions(next, { closeDrawer = false } = {}) {
  const draftKey = `subscription:${state.subscriptionEditId || 'new'}`;
  state.subscriptionsSaving = true;
  render();
  try {
    const response = await fetchJson('/api/subscriptions', {
      secret: state.secret,
      method: 'PUT',
      body: {
        baseUpdatedAt: state.subscriptions?.updatedAt || '',
        subscriptions: next
      }
    });
    state.subscriptions = response;
    state.subscriptionEditId = '';
    if (closeDrawer) state.subscriptionDrawerOpen = false;
    clearFormDraft(draftKey);
    state.subscriptionsConflict = false;
    state.subscriptionsPending = null;
    state.subscriptionsError = null;
    showToast(tr('toast.saved'));
  } catch (error) {
    if (error.status === 409 && error.payload?.subscriptions) {
      state.subscriptionsPending = error.payload;
      state.subscriptionsConflict = true;
      showToast(tr('subscriptions.conflict'));
    } else {
      state.subscriptionsError = error;
      showToast(error.message || tr('error.generic'));
    }
  } finally {
    state.subscriptionsSaving = false;
    render();
  }
}

async function deleteSubscription(id) {
  const record = subscriptionRecords().find((entry) => entry.id === id);
  if (!record || !(await confirmAction(tr('subscriptions.confirmDelete')))) return;
  await saveSubscriptions(subscriptionRecords().filter((entry) => entry.id !== id));
}

async function savePricingForm(form) {
  const values = new FormData(form);
  const draftKey = draftKeyForForm(form);
  const model = String(values.get('model') || '').trim();
  if (!model) return;
  const fields = ['inputPricePerMillion', 'outputPricePerMillion', 'cacheReadPricePerMillion', 'cacheWritePricePerMillion'];
  const prices = {};
  for (const field of fields) {
    const value = Number(values.get(field));
    if (!Number.isFinite(value) || value < 0) {
      showToast(tr('pricing.invalid'));
      return;
    }
    prices[field] = value;
  }
  state.pricingSaving = true;
  render();
  try {
    await fetchJson(`/api/pricing/${encodeURIComponent(model)}`, {
      secret: state.secret,
      method: 'PUT',
      body: prices
    });
    await loadPricing({ force: true });
    clearFormDraft(draftKey);
    state.pricingDrawerOpen = false;
    state.pricingEditModel = '';
    showToast(tr('toast.saved'));
  } catch (error) {
    showToast(error.message || tr('error.generic'));
  } finally {
    state.pricingSaving = false;
    render();
  }
}

async function fetchPricingUpstream(model) {
  if (!model) return;
  state.pricingSaving = true;
  render();
  try {
    await fetchJson(`/api/pricing/${encodeURIComponent(model)}/fetch-upstream`, {
      secret: state.secret,
      method: 'POST'
    });
    await loadPricing({ force: true });
    showToast(tr('pricing.updated'));
  } catch (error) {
    showToast(error.message || tr('pricing.fetchFailed'));
  } finally {
    state.pricingSaving = false;
    render();
  }
}

async function fetchAllPricing() {
  state.pricingSaving = true;
  render();
  try {
    await fetchJson('/api/pricing/fetch-upstream-all', { secret: state.secret, method: 'POST' });
    await loadPricing({ force: true });
    showToast(tr('pricing.updated'));
  } catch (error) {
    showToast(error.message || tr('pricing.fetchFailed'));
  } finally {
    state.pricingSaving = false;
    render();
  }
}

// The range API answers both a hand-picked range and the calendar presets, so the
// payload is folded into a period once, here.
function customPeriodFromRangePayload(payload) {
  return {
    totalTokens: payload.totalTokens || 0,
    costUsd: payload.costUsd || 0,
    clients: payload.clients || {},
    clientCosts: payload.clientCosts || {},
    models: payload.models || {},
    modelCosts: payload.modelCosts || {},
    // /api/usage/range does not nest client->model maps, so derive them from the
    // returned sessions. Without this the per-client model split read "No usage"
    // for every custom range while the preset periods showed it.
    clientModels: payload.clientModels || deriveClientModels(payload.sessions, 'models'),
    clientModelCosts: payload.clientModelCosts || deriveClientModels(payload.sessions, 'modelCosts'),
    clientEstimated: payload.clientEstimated || {},
    clientCredits: payload.clientCredits || {},
    clientMeasurements: payload.clientMeasurements || {},
    estimated: payload.estimated === true,
    projects: payload.projects || {},
    sessions: payload.sessions || {}
  };
}

// The range is sent as both the caller's own calendar-day labels and the
// absolute instants they name. The Hub needs the day keys because its own clock
// is the *Hub host's*: re-deriving `from`/`to` there shifted the window by a day
// whenever the browser and the server sat in different zones, so the "yesterday"
// label could answer with two days of data (and echo wrong `startDate`/`endDate`
// back). The instants stay in the request so the event-ledger fallback can filter
// by the caller's real window instead of the server's.
async function requestUsageRange({ from, to, startDate, endDate, startHour, endHour }) {
  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString()
  });
  if (startDate && endDate) {
    query.set('startDate', startDate);
    query.set('endDate', endDate);
    query.set('startHour', String(startHour));
    query.set('endHour', String(endHour));
  }
  return fetchJson(`/api/usage/range?${query.toString()}`, { secret: state.secret });
}

async function applyCustomRange() {
  const fromValue = els.rangeFrom.value;
  const toValue = els.rangeTo.value;
  if (!fromValue || !toValue) {
    els.rangeError.textContent = tr('range.invalid');
    els.rangeError.classList.remove('hidden');
    return;
  }
  const from = new Date(fromValue);
  const to = new Date(toValue);
  if (!(from.getTime() < to.getTime())) {
    els.rangeError.textContent = tr('range.invalid');
    els.rangeError.classList.remove('hidden');
    return;
  }
  try {
    const payload = await requestUsageRange({
      from,
      to,
      startDate: localDayKey(from),
      // `to` is an exclusive instant in the range dialog, so the last included
      // calendar day is the day of `to - 1ms` — the same rule the Hub applied to
      // a raw `from`/`to` pair before the labels existed.
      endDate: localDayKey(new Date(to.getTime() - 1)),
      startHour: from.getHours(),
      endHour: to.getHours()
    });
    state.customRange = { kind: 'custom', from: from.toISOString(), to: to.toISOString() };
    state.customPeriod = customPeriodFromRangePayload(payload);
    openRange(false);
    render();
  } catch {
    els.rangeError.textContent = tr('range.failed');
    els.rangeError.classList.remove('hidden');
  }
}

function clearCustomRange() {
  state.customRange = null;
  state.customPeriod = null;
  // A preset has no snapshot period to fall back to, so clearing it lands on Day.
  if (isPresetRangePeriod(state.prefs.period)) {
    state.prefs.period = 'today';
    savePrefs({ period: 'today' });
  }
  openRange(false);
  render();
}

const PRESET_RANGE_RETRY_MS = 30_000;

function presetRangeKey(rangeWindow) {
  return `${rangeWindow.period}:${rangeWindow.startDate}:${rangeWindow.endDate}`;
}

/**
 * The calendar window the current selection asks for but does not have yet, or null.
 *
 * The window identity is what makes a range that crossed midnight refetch on the
 * next snapshot, and it is also the guard against re-requesting on every frame:
 * once `customRange` describes this window, nothing is pending.
 */
function pendingPresetRangeWindow() {
  if (!presetRangesEnabled()) return null;
  const rangeWindow = presetRangeWindow(state.prefs.period, new Date(), fleetTimeZone());
  if (!rangeWindow) return null;
  if (presetRangeWindowMatches(rangeWindow, state.customRange)) return null;
  const key = presetRangeKey(rangeWindow);
  if (state.presetRangeRequest && state.presetRangeRequestKey === key) return null;
  if (key === state.presetRangeFailedKey && Date.now() < state.presetRangeRetryAfter) return null;
  return rangeWindow;
}

/**
 * Fetch one preset calendar range.
 *
 * Deliberately not a poll: in local mode a range request runs tokscale, so it stays
 * a user action plus the snapshot-driven rollover check in pendingPresetRangeWindow().
 * A failure keeps the zeros rather than showing the previous window's numbers, and
 * backs off before the next snapshot retries it — a background retry stays quiet,
 * because the toast belongs to the click that asked for the number.
 */
function loadPresetRange(rangeWindow, { notify = false } = {}) {
  const key = presetRangeKey(rangeWindow);
  const sequence = ++state.presetRangeSequence;
  state.presetRangeRequestKey = key;
  const request = (async () => {
    try {
      const payload = await requestUsageRange({
        from: rangeWindow.from,
        to: rangeWindow.to,
        startDate: rangeWindow.startDate,
        endDate: rangeWindow.endDate,
        startHour: 0,
        endHour: 23
      });
      if (sequence !== state.presetRangeSequence) return;
      state.customRange = {
        kind: rangeWindow.period,
        from: rangeWindow.from.toISOString(),
        to: rangeWindow.to.toISOString(),
        startDate: rangeWindow.startDate,
        endDate: rangeWindow.endDate
      };
      state.customPeriod = customPeriodFromRangePayload(payload);
      state.presetRangeFailedKey = '';
    } catch (error) {
      if (sequence !== state.presetRangeSequence) return;
      if (error?.status === 401) showAuth(true);
      state.customRange = null;
      state.customPeriod = null;
      state.presetRangeFailedKey = key;
      state.presetRangeRetryAfter = Date.now() + PRESET_RANGE_RETRY_MS;
      if (notify) showToast(tr('range.failed'));
    } finally {
      if (sequence === state.presetRangeSequence) {
        state.presetRangeRequest = null;
        state.presetRangeRequestKey = '';
      }
    }
  })();
  state.presetRangeRequest = request;
  return request;
}

function switchView(viewId, { updateHistory = true, replace = false, tab = '', section = '' } = {}) {
  const target = String(viewId || 'overview').trim().replace(/^\/+/, '');
  const legacy = LEGACY_ROUTE_ALIASES[`/${target}`];
  const validView = legacy?.view || normalizeViewId(target);
  const nextUsageTab = tab || legacy?.usageTab || state.prefs.usageTab;
  const nextManagementTab = tab || legacy?.managementTab || state.prefs.managementTab;
  const nextManagementSection = section || legacy?.managementSection || state.prefs.managementSection;
  const nextLimitTab = tab || legacy?.limitTab || state.prefs.limitTab;
  const usageTab = ['tools', 'models', 'projects', 'sessions'].includes(nextUsageTab) ? nextUsageTab : 'tools';
  const managementTab = ['subscriptions', 'pricing'].includes(nextManagementTab) ? nextManagementTab : 'subscriptions';
  const managementSection = normalizeManagementSection(nextManagementSection);
  const limitTab = nextLimitTab === 'health' ? 'health' : 'limits';
  state.accountDrawerOpen = false;
  state.subscriptionDrawerOpen = false;
  state.pricingDrawerOpen = false;
  const changed = state.prefs.view !== validView
    || (validView === 'usage' && state.prefs.usageTab !== usageTab)
    || (validView === 'settings' && state.prefs.managementSection !== managementSection)
    || (validView === 'limits' && state.prefs.limitTab !== limitTab);
  state.prefs.view = validView;
  if (validView === 'usage') state.prefs.usageTab = usageTab;
  if (validView === 'settings') {
    state.prefs.managementSection = managementSection;
    state.prefs.managementTab = managementTab;
  }
  if (validView === 'limits') state.prefs.limitTab = limitTab;
  savePrefs({
    view: validView,
    usageTab: state.prefs.usageTab,
    managementTab: state.prefs.managementTab,
    managementSection: state.prefs.managementSection,
    limitTab: state.prefs.limitTab
  });
  if (updateHistory) {
    syncUrlForView(validView, {
      replace: replace || !changed,
      tab: validView === 'usage' ? usageTab : validView === 'settings' ? managementTab : (validView === 'limits' && limitTab === 'health' ? 'health' : '')
    });
  }
  openNav(false);
  if (changed) animateNavigation(els.content);
  if (validView === 'settings' && managementSection === 'consumption' && managementTab === 'subscriptions') void loadSubscriptions().then(() => render({ quiet: true }));
  if (validView === 'settings' && managementSection === 'consumption' && managementTab === 'pricing') void loadPricing().then(() => render({ quiet: true }));
  if (validView === 'settings' && managementSection === 'accounts') void loadAccounts().then(() => render({ quiet: true }));
  if (validView === 'trends' || validView === 'overview') {
    void ensureHistory().then(() => render({ quiet: true }));
    return;
  }
  if (!changed && !updateHistory) return;
  render();
}

function bindEvents() {
  setupFluentInteractions();
  // Replay a render that was deferred because a transient control was open.
  // These are passive and idempotent: `render()` is a no-op unless a deferral is
  // actually pending, so a plain click or focus move costs one boolean read.
  // Capture phase, so the replay sees the state *before* a handler that opens a
  // new dropdown (which would otherwise be torn down by its own retry).
  for (const eventName of DEFERRED_RENDER_EVENTS) {
    document.addEventListener(eventName, renderDeferred, true);
  }
  document.addEventListener('toggle', () => queueMicrotask(renderDeferred), true);
  window.addEventListener('popstate', () => {
    const route = routeFromLocation();
    switchView(route.view, {
      updateHistory: false,
      tab: route.usageTab || route.managementTab || route.limitTab,
      section: route.managementSection || ''
    });
  });

  els.primaryNav.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-view]');
    if (!btn) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    switchView(btn.dataset.view);
  });

  if (els.deviceFilter) {
    els.deviceFilter.addEventListener('change', () => {
      state.prefs.deviceFilter = deviceIdFromOptionValue(els.deviceFilter.value);
      savePrefs({ deviceFilter: state.prefs.deviceFilter });
      const historyRequest = state.prefs.view === 'overview' || state.prefs.view === 'trends'
        ? ensureHistory({ force: true })
        : null;
      animateDataUpdate();
      render();
      if (historyRequest) void historyRequest.then(() => { animateDataUpdate(); render({ quiet: true }); });
    });
  }

  els.periodTabs.addEventListener('change', () => {
    const period = String(els.periodTabs.value || '');
    if (period === 'custom') {
      openRange(true);
      return;
    }
    if (!periodTabs().includes(period)) return;
    // Clear the previous window first: a preset that is still loading must not keep
    // rendering the numbers of the period or range the user just left.
    state.customPeriod = null;
    state.customRange = null;
    state.prefs.period = period;
    savePrefs({ period: state.prefs.period });
    animateDataUpdate();
    render();
    const rangeWindow = presetRangeWindow(period, new Date(), fleetTimeZone());
    if (rangeWindow) void loadPresetRange(rangeWindow, { notify: true }).then(() => render());
  });


  const chartTip = document.createElement('div');
  chartTip.id = 'chartTip';
  chartTip.className = 'chart-tip hidden';
  chartTip.setAttribute('role', 'tooltip');
  document.body.appendChild(chartTip);

  function placeChartTip(clientX, clientY) {
    const pad = 12;
    const rect = chartTip.getBoundingClientRect();
    let left = clientX + 14;
    let top = clientY + 14;
    if (left + rect.width + pad > window.innerWidth) left = clientX - rect.width - 14;
    if (top + rect.height + pad > window.innerHeight) top = clientY - rect.height - 14;
    chartTip.style.left = `${Math.max(pad, left)}px`;
    chartTip.style.top = `${Math.max(pad, top)}px`;
  }

  function showChartTip(text, clientX, clientY) {
    if (!text) {
      chartTip.classList.add('hidden');
      return;
    }
    chartTip.textContent = text;
    chartTip.classList.remove('hidden');
    placeChartTip(clientX, clientY);
  }

  els.content.addEventListener('pointerover', (event) => {
    const hit = event.target.closest('[data-tip]');
    if (!hit || !els.content.contains(hit)) return;
    showChartTip(hit.getAttribute('data-tip') || '', event.clientX, event.clientY);
  });
  els.content.addEventListener('pointermove', (event) => {
    const hit = event.target.closest('[data-tip]');
    if (!hit || !els.content.contains(hit)) {
      chartTip.classList.add('hidden');
      return;
    }
    showChartTip(hit.getAttribute('data-tip') || '', event.clientX, event.clientY);
  });
  els.content.addEventListener('pointerleave', () => {
    chartTip.classList.add('hidden');
  });

  els.content.addEventListener('click', (event) => {
    // Desktop-only settings actions (folder picker, export, update check).
    const desktopAction = event.target.closest('[data-desktop-action]');
    if (desktopAction) {
      void runDesktopAction(desktopAction.dataset.desktopAction, desktopAction);
      return;
    }
    const managementDrawerClose = event.target.closest('[data-close-management-drawer]');
    if (managementDrawerClose) {
      const kind = managementDrawerClose.closest('.management-drawer')?.dataset.managementDrawer;
      closeManagementDrawer(kind);
      return;
    }
    const accountAdd = event.target.closest('[data-account-add]');
    if (accountAdd) {
      rememberManagementOpener(accountAdd);
      state.accountEditId = '';
      state.accountDrawerOpen = true;
      state.accountFormError = '';
      state.accountFormMode = 'simple';
      state.accountSelectedProvider = 'deepseek';
      state.oauthSession = null;
      render();
      return;
    }
    const usageTab = event.target.closest('[data-usage-tab]');
    if (usageTab) {
      state.prefs.usageTab = ['tools', 'models', 'projects', 'sessions'].includes(usageTab.dataset.usageTab)
        ? usageTab.dataset.usageTab
        : 'tools';
      savePrefs({ usageTab: state.prefs.usageTab });
      switchView('usage', { tab: state.prefs.usageTab });
      return;
    }
    const managementTab = event.target.closest('[data-management-tab]');
    if (managementTab) {
      const nextTab = managementTab.dataset.managementTab === 'pricing' ? 'pricing' : 'subscriptions';
      state.prefs.managementTab = nextTab;
      state.prefs.managementSection = 'consumption';
      savePrefs({ managementTab: nextTab, managementSection: 'consumption' });
      switchView('settings', { tab: nextTab, section: 'consumption' });
      return;
    }
    const jumpView = event.target.closest('[data-jump-view]');
    if (jumpView) {
      const view = jumpView.dataset.jumpView;
      if (jumpView.dataset.jumpTool) {
        state.prefs.selectedToolId = jumpView.dataset.jumpTool;
        savePrefs({ selectedToolId: state.prefs.selectedToolId });
      }
      if (jumpView.dataset.jumpDevice) {
        state.prefs.selectedDeviceId = jumpView.dataset.jumpDevice;
        savePrefs({ selectedDeviceId: state.prefs.selectedDeviceId });
      }
      // A jump to a folded view lands on the Management page's owning section.
      if (VIEW_REDIRECTS[view]) {
        switchView(VIEW_REDIRECTS[view], {
          tab: jumpView.dataset.jumpUsageTab || '',
          section: VIEW_SECTION_REDIRECTS[view] || ''
        });
        return;
      }
      switchView(view, { tab: jumpView.dataset.jumpUsageTab || '', section: jumpView.dataset.jumpSection || '' });
      return;
    }
    const webSignOut = event.target.closest('[data-web-signout]');
    if (webSignOut) {
      signOutFromHub();
      return;
    }
    const pwaInstall = event.target.closest('[data-pwa-install]');
    if (pwaInstall) {
      if (!state.deferredInstall) return;
      const promptEvent = state.deferredInstall;
      state.deferredInstall = null;
      void promptEvent.prompt().then(() => promptEvent.userChoice).catch(() => {}).finally(() => refreshPwaUi());
      return;
    }
    const retryDashboard = event.target.closest('[data-retry-dashboard]');
    if (retryDashboard) {
      void bootstrapAuthorized().catch((error) => {
        state.error = error;
        state.loading = false;
        render();
      });
      return;
    }
    const retryHistory = event.target.closest('[data-retry-history]');
    if (retryHistory) {
      const request = ensureHistory({ force: true });
      render();
      void request.then(() => render({ quiet: true }));
      return;
    }
    const managementRetry = event.target.closest('[data-management-retry]');
    if (managementRetry) {
      if (managementRetry.dataset.managementRetry === 'subscriptions-retry') void loadSubscriptions({ force: true });
      if (managementRetry.dataset.managementRetry === 'pricing-retry') void loadPricing({ force: true });
      if (managementRetry.dataset.managementRetry === 'accounts-retry') void loadAccounts({ force: true });
      return;
    }
    const accountRefresh = event.target.closest('[data-account-refresh]');
    if (accountRefresh) {
      void refreshAccount(accountRefresh.dataset.accountRefresh);
      return;
    }
    const accountToggle = event.target.closest('[data-account-toggle]');
    if (accountToggle) {
      void toggleAccount(accountToggle.dataset.accountToggle);
      return;
    }
    const accountEdit = event.target.closest('[data-account-edit]');
    if (accountEdit) {
      rememberManagementOpener(accountEdit);
      state.accountEditId = accountEdit.dataset.accountEdit || '';
      state.accountDrawerOpen = true;
      state.accountFormError = '';
      state.accountFormMode = 'simple';
      // Editing starts a fresh sign-in; a session left over from another provider
      // would otherwise be exchanged against the wrong account.
      state.oauthSession = null;
      render();
      return;
    }
    const accountReset = event.target.closest('[data-account-reset]');
    if (accountReset) {
      clearFormDraft(`account:${state.accountEditId || 'new'}`);
      state.accountDrawerOpen = false;
      state.accountEditId = '';
      state.accountFormError = '';
      state.accountFormMode = 'simple';
      render();
      return;
    }
    const accountClearCredential = event.target.closest('[data-account-clear-credential]');
    if (accountClearCredential) {
      void clearAccountCredential(accountClearCredential.dataset.accountClearCredential);
      return;
    }
    const accountDelete = event.target.closest('[data-account-delete]');
    if (accountDelete) {
      void deleteAccount(accountDelete.dataset.accountDelete);
      return;
    }
    const accountMode = event.target.closest('fluent-button[data-account-mode]');
    if (accountMode) {
      state.accountFormMode = accountMode.dataset.accountMode;
      state.accountFormError = '';
      render();
      return;
    }
    const accountOAuthStart = event.target.closest('[data-account-oauth-start]');
    if (accountOAuthStart) {
      const form = accountOAuthStart.closest('form');
      const providerInput = form?.querySelector('[data-account-provider-input]');
      const provider = String(providerInput?.value || accountOAuthStart.dataset.accountOAuthStart || state.accountSelectedProvider || '').trim().toLowerCase();
      state.oauthLoading = true;
      render();
      void (async () => {
        try {
          const res = await fetchJson('/api/accounts/oauth/start', {
            secret: state.secret,
            method: 'POST',
            body: { provider }
          });
          state.oauthSession = res;
        } catch (err) {
          showToast(err.message || tr('error.generic'));
        } finally {
          state.oauthLoading = false;
          render();
        }
      })();
      return;
    }
    const accountOAuthOpen = event.target.closest('[data-account-oauth-open]');
    if (accountOAuthOpen) {
      const url = accountOAuthOpen.dataset.accountOauthOpen;
      void (async () => {
        try {
          await openExternal(url);
        } catch {
          showToast(tr('error.generic'));
        }
      })();
      return;
    }
    const accountOAuthCopy = event.target.closest('[data-account-oauth-copy]');
    if (accountOAuthCopy) {
      const url = accountOAuthCopy.dataset.accountOauthCopy;
      void (async () => {
        try {
          const ok = await copyText(url);
          if (ok === false) throw new Error('clipboard_unavailable');
          showToast(tr('accounts.oauthLinkCopied'));
        } catch {
          showToast(tr('error.generic'));
        }
      })();
      return;
    }
    const topUpAdd = event.target.closest('[data-topup-add]');
    if (topUpAdd) {
      const form = topUpAdd.closest('[data-subscription-form]');
      const ledger = form?.querySelector('[data-topup-ledger]');
      if (!form || !ledger) return;
      const id = `top_new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      ledger.insertAdjacentHTML('beforeend', subscriptionTopUpRowHtml({ id, date: '', amount: '' }));
      rememberFormDraft(form);
      ledger.querySelector(`[data-topup-id="${id}"] [data-topup-date]`)?.focus();
      return;
    }
    const topUpRemove = event.target.closest('[data-topup-remove]');
    if (topUpRemove) {
      const form = topUpRemove.closest('[data-subscription-form]');
      const row = topUpRemove.closest('[data-topup-row]');
      if (!form || !row) return;
      row.remove();
      rememberFormDraft(form);
      return;
    }
    const subscriptionEdit = event.target.closest('[data-subscription-edit]');
    if (subscriptionEdit) {
      rememberManagementOpener(subscriptionEdit);
      state.subscriptionEditId = subscriptionEdit.dataset.subscriptionEdit || '';
      state.subscriptionDrawerOpen = true;
      render();
      return;
    }
    const subscriptionAdd = event.target.closest('[data-subscription-add]');
    if (subscriptionAdd) {
      rememberManagementOpener(subscriptionAdd);
      state.subscriptionEditId = '';
      state.subscriptionDrawerOpen = true;
      render();
      return;
    }
    const subscriptionReloadLatest = event.target.closest('[data-subscription-reload-latest]');
    if (subscriptionReloadLatest) {
      for (const key of state.formDrafts.keys()) {
        if (key.startsWith('subscription:')) state.formDrafts.delete(key);
      }
      if (state.subscriptionsPending) {
        state.subscriptions = state.subscriptionsPending;
        state.subscriptionsPending = null;
        state.subscriptionsConflict = false;
        state.subscriptionEditId = '';
        state.subscriptionDrawerOpen = false;
        render();
      } else {
        void loadSubscriptions({ force: true });
      }
      return;
    }
    const subscriptionReset = event.target.closest('[data-subscription-reset]');
    if (subscriptionReset) {
      clearFormDraft(`subscription:${state.subscriptionEditId || 'new'}`);
      state.subscriptionEditId = '';
      state.subscriptionDrawerOpen = false;
      render();
      return;
    }
    const subscriptionDelete = event.target.closest('[data-subscription-delete]');
    if (subscriptionDelete) {
      void deleteSubscription(subscriptionDelete.dataset.subscriptionDelete);
      return;
    }
    const pricingUpstream = event.target.closest('[data-pricing-upstream]');
    if (pricingUpstream) {
      void fetchPricingUpstream(pricingUpstream.dataset.pricingUpstream);
      return;
    }
    const pricingRefresh = event.target.closest('[data-pricing-refresh-all]');
    if (pricingRefresh) {
      void fetchAllPricing();
      return;
    }
    const pricingAdd = event.target.closest('[data-pricing-add]');
    if (pricingAdd) {
      rememberManagementOpener(pricingAdd);
      state.pricingEditModel = '';
      state.pricingDrawerOpen = true;
      render();
      return;
    }
    const pricingEdit = event.target.closest('[data-pricing-edit]');
    if (pricingEdit) {
      rememberManagementOpener(pricingEdit);
      state.pricingEditModel = pricingEdit.dataset.pricingEdit || '';
      state.pricingDrawerOpen = true;
      render();
      return;
    }
    const limitProvider = event.target.closest('[data-limit-provider]');
    if (limitProvider) return;
    const del = event.target.closest('[data-delete-device]');
    if (del) {
      void deleteDevice(del.getAttribute('data-delete-device')).catch((error) => {
        if (error.status === 401) showAuth(true);
        else showToast(error.message || tr('error.generic'));
      });
      return;
    }
    const rename = event.target.closest('[data-rename-device]');
    if (rename) {
      void renameDevice(rename.getAttribute('data-rename-device')).catch((error) => {
        showToast(error.message || tr('error.generic'));
      });
      return;
    }
    const selectTool = event.target.closest('[data-select-tool]');
    if (selectTool) {
      state.prefs.selectedToolId = selectTool.dataset.selectTool || '';
      savePrefs({ selectedToolId: state.prefs.selectedToolId });
      animateDataUpdate();
      render();
      return;
    }
    const selectDevice = event.target.closest('[data-select-device]');
    if (selectDevice && !event.target.closest('[data-delete-device]')) {
      state.prefs.selectedDeviceId = selectDevice.dataset.selectDevice || '';
      savePrefs({ selectedDeviceId: state.prefs.selectedDeviceId });
      animateDataUpdate();
      render();
      return;
    }
  });

  els.content.addEventListener('input', (event) => {
    rememberFormDraft(event.target);
    syncWebSettingsFormState(event.target.closest('[data-web-settings-form]'));
  });

  // A section-rail click on the Management page persists the choice and keeps
  // the URL in step, so a refresh or a bookmark returns to the same section.
  els.content.addEventListener('settings-section-change', (event) => {
    const section = String(event.detail?.section || '');
    if (!managementSections().includes(section)) return;
    state.prefs.managementSection = section;
    savePrefs({ managementSection: section });
    syncUrlForView('settings', { replace: true, tab: state.prefs.managementTab });
  });

  els.content.addEventListener('change', (event) => {
    syncWebSettingsFormState(event.target.closest?.('[data-web-settings-form]'));
    const trendsDevice = event.target.closest?.('[data-trends-device]');
    if (trendsDevice) {
      state.prefs.deviceFilter = deviceIdFromOptionValue(trendsDevice.value);
      savePrefs({ deviceFilter: state.prefs.deviceFilter });
      const request = ensureHistory({ force: true });
      animateDataUpdate();
      render();
      void request.then(() => { animateDataUpdate(); render({ quiet: true }); });
      return;
    }
    const trendsSetting = event.target.closest?.('[data-trends-setting]');
    if (trendsSetting) {
      const setting = trendsSetting.dataset.trendsSetting;
      const allowedValues = {
        trendsStack: ['client', 'model'],
        trendsRange: ['7', '30', '90', '365', 'all'],
        trendsMetric: ['tokens', 'cost', 'activeTime']
      }[setting];
      const value = String(trendsSetting.value || '');
      if (!allowedValues?.includes(value)) return;
      state.prefs[setting] = value;
      savePrefs({ [setting]: value });
      animateDataUpdate();
      render();
      return;
    }
    const choice = event.target.closest?.('fluent-radio-group[data-selection]');
    if (choice) {
      const value = String(choice.value || '');
      const preferences = {
        heatmapMetric: ['tokens', 'cost'].includes(value) ? value : 'tokens',
        activeDaysWindow: value === 'year' ? 'year' : 'all',
        trendsStack: value === 'model' ? 'model' : 'client',
        trendsRange: ['7', '30', '90', '365', 'all'].includes(value) ? value : '30',
        trendsMetric: ['tokens', 'cost', 'activeTime'].includes(value) ? value : 'tokens'
      };
      const setting = choice.dataset.selection;
      if (Object.hasOwn(preferences, setting)) {
        state.prefs[setting] = preferences[setting];
        savePrefs({ [setting]: state.prefs[setting] });
        animateDataUpdate();
        render();
      }
      return;
    }
    const accountProvider = event.target.closest?.('[data-account-provider-select]');
    if (accountProvider) {
      const provider = String(accountProvider.value || '').trim().toLowerCase();
      const providerInput = accountProvider.closest('form')?.querySelector('[data-account-provider-input]');
      if (providerInput) providerInput.value = provider;
      if (!provider || provider === state.accountSelectedProvider) return;
      state.accountSelectedProvider = provider;
      state.oauthSession = null;
      state.accountFormError = '';
      state.accountFormMode = isBrowserLoginProvider(provider) ? 'oauth' : 'simple';
      animateDataUpdate();
      render();
      return;
    }
    rememberFormDraft(event.target);
    const subscriptionKind = event.target.closest('[data-subscription-kind]');
    if (subscriptionKind) {
      animateDataUpdate();
      render();
      return;
    }
    const provider = event.target.closest('[data-limit-provider]');
    if (provider) {
      state.limitProvider = provider.value === ALL_PROVIDERS_OPTION_VALUE ? '' : provider.value || '';
      animateDataUpdate();
      render();
      return;
    }
  });

  // Desktop settings persist on change: a form round-trip would be needed to
  // batch them, but each control owns exactly one key. The transfer form's two
  // device pickers are kept apart here: a collision moves the other dropdown to
  // an unused device, so the pair can never be submitted as same-device (the
  // Hub rejects that with `same_device`).
  els.content.addEventListener('change', (event) => {
    const transferForm = event.target.closest('[data-transfer-form]');
    if (transferForm) {
      const source = transferForm.querySelector('[name="sourceDevice"]');
      const target = transferForm.querySelector('[name="targetDevice"]');
      if (source?.value && target?.value && source.value === target.value) {
        const alternative = [...target.querySelectorAll('fluent-option')]
          .map((option) => option.value)
          .find((value) => value !== source.value);
        if (alternative) setFluentDropdownValue(target, alternative);
      }
      state.transferSelection = {
        source: String(source?.value || ''),
        target: String(target?.value || '')
      };
      return;
    }
    const control = event.target.closest('[data-desktop-settings] [name]');
    if (!control) return;
    const form = control.closest('[data-desktop-settings]');
    if (!form) return;
    void saveDesktopSettings(readDesktopSettingsPatch(form));
  });

  els.content.addEventListener('submit', (event) => {
    const webSettingsForm = event.target.closest('[data-web-settings-form]');
    if (webSettingsForm) {
      event.preventDefault();
      void saveWebSettingsForm(webSettingsForm).catch((error) => {
        showToast(error.message || tr('error.generic'));
      });
      return;
    }
    const transferForm = event.target.closest('[data-transfer-form]');
    if (transferForm) {
      event.preventDefault();
      void submitTransfer(transferForm).then((error) => {
        if (error) showToast(error);
      }).catch((error) => {
        showToast(error?.message || tr('error.generic'));
      });
      return;
    }
    const accountForm = event.target.closest('[data-account-form]');
    if (accountForm) {
      event.preventDefault();
      void saveAccountFromForm(accountForm).catch((error) => {
        state.accountFormError = error.message || tr('error.generic');
        showToast(state.accountFormError);
        render();
      });
      return;
    }
    const subscriptionForm = event.target.closest('[data-subscription-form]');
    if (subscriptionForm) {
      event.preventDefault();
      try {
        const next = subscriptionRecords().filter((record) => record.id !== state.subscriptionEditId);
        next.push(subscriptionFromForm(subscriptionForm));
        void saveSubscriptions(next, { closeDrawer: true });
      } catch (error) {
        showToast(error.message || tr('error.generic'));
      }
      return;
    }
    const pricingFormElement = event.target.closest('[data-pricing-form]');
    if (pricingFormElement) {
      event.preventDefault();
      void savePricingForm(pricingFormElement);
    }
  });

  els.refreshBtn.addEventListener('click', async () => {
    els.refreshBtn.disabled = true;
    els.refreshBtn.setAttribute('aria-busy', 'true');
    try {
      await refreshStats();
      state.history = null;
      await ensureHistory();
      await Promise.all([
        loadSubscriptions({ force: true }),
        loadPricing({ force: true }),
        loadAccounts({ force: true })
      ]);
      showToast(tr('toast.refreshed'));
    } catch (error) {
      if (error.status === 401) showAuth(true);
      else {
        state.error = error;
        render();
      }
    } finally {
      els.refreshBtn.disabled = false;
      els.refreshBtn.removeAttribute('aria-busy');
    }
  });

  els.customRangeBtn.addEventListener('click', () => openRange(true));
  els.rangeClose.addEventListener('click', () => openRange(false));
  els.rangeApply.addEventListener('click', () => void applyCustomRange());
  els.rangeClear.addEventListener('click', () => clearCustomRange());
  els.rangePopover.addEventListener('click', (event) => {
    if (event.target === els.rangePopover) openRange(false);
  });

  if (els.menuToggle) {
    els.menuToggle.addEventListener('click', () => openNav(!state.navOpen));
  }
  if (els.navScrim) {
    els.navScrim.addEventListener('click', () => openNav(false));
  }
  window.addEventListener('keydown', (event) => {
    if (trapOverlayFocus(event)) return;
    if (event.key === 'Escape') {
      if (!els.rangePopover.classList.contains('hidden')) {
        event.preventDefault();
        openRange(false);
        return;
      }
      // A Fluent dropdown popover is its own overlay: Escape must close it
      // before this handler starts closing page-level overlays under it.
      const openPopover = els.content.querySelector('fluent-dropdown fluent-listbox:popover-open');
      if (openPopover) return;
      const managementDrawer = els.content.querySelector('.management-drawer:not(.hidden)');
      if (managementDrawer) {
        event.preventDefault();
        closeManagementDrawer(managementDrawer.dataset.managementDrawer);
        return;
      }
      if (!els.settingsDrawer.classList.contains('hidden')) {
        event.preventDefault();
        openSettings(false);
        return;
      }
      openNav(false);
    }
  });
  window.addEventListener('resize', () => {
    if (!isMobileNav()) openNav(false);
    refreshPwaUi();
  });

  const navigateToSettingsAndCloseNav = () => {
    openNav(false);
    switchView('settings');
  };
  els.customRangeBtn?.setAttribute('aria-controls', 'rangePopover');
  els.customRangeBtn?.setAttribute('aria-expanded', 'false');
  els.settingsOpen?.addEventListener('click', navigateToSettingsAndCloseNav);
  if (els.settingsOpenTop) {
    els.settingsOpenTop.addEventListener('click', navigateToSettingsAndCloseNav);
  }
  els.settingsDrawer.querySelectorAll('[data-close-settings]').forEach((el) => {
    el.addEventListener('click', () => openSettings(false));
  });

  // The install prompt and offline shell only exist in a browser. The desktop
  // client sets capabilities.pwa=false and these listeners stay unbound.
  if (isCapable('pwa')) {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.deferredInstall = event;
      refreshPwaUi();
    });
    window.addEventListener('appinstalled', () => {
      state.deferredInstall = null;
      state.pwaDismissed = true;
      writeFlag('token-monitor.hub.pwaDismissed', '1');
      refreshPwaUi();
      showToast(tr('pwa.installed'));
    });
  }
  if (els.pwaInstallBtn) {
    els.pwaInstallBtn.addEventListener('click', async () => {
      if (!state.deferredInstall) return;
      const promptEvent = state.deferredInstall;
      state.deferredInstall = null;
      try {
        await promptEvent.prompt();
        await promptEvent.userChoice;
      } catch {
        /* user dismissed native sheet */
      }
      refreshPwaUi();
    });
  }
  if (els.pwaDismissBtn) {
    els.pwaDismissBtn.addEventListener('click', () => {
      state.pwaDismissed = true;
      writeFlag('token-monitor.hub.pwaDismissed', '1');
      refreshPwaUi();
    });
  }
  els.saveSettingsBtn?.addEventListener('click', async () => {
    state.prefs.language = els.languageSelect.value;
    state.prefs.theme = els.themeSelect.value;
    state.prefs.currency = els.currencySelect.value;
    if (els.homeLimitAccountCount) {
      state.prefs.homeLimitAccountCount = clampHomeLimitAccountCount(els.homeLimitAccountCount.value, 3);
      els.homeLimitAccountCount.value = String(state.prefs.homeLimitAccountCount);
    }
    savePrefs({
      language: state.prefs.language,
      theme: state.prefs.theme,
      currency: state.prefs.currency,
      homeLimitAccountCount: state.prefs.homeLimitAccountCount
    });
    const nextSecret = els.settingsSecret?.value.trim() || '';
    const secretChanged = nextSecret !== state.secret;
    applyTheme();
    applyLocale();
    if (secretChanged) {
      const ok = await tryConnect(nextSecret, true, { persist: true });
      if (!ok) return;
    }
    openSettings(false);
    showToast(tr('toast.saved'));
  });
  els.signOutBtn?.addEventListener('click', () => {
    openSettings(false);
    signOutFromHub();
  });

  els.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await tryConnect(els.secretInput.value, els.rememberSecret.checked, { persist: true });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((state.prefs.theme || 'system') === 'system') applyTheme();
  });
}

// Desktop-only settings live in the main process: the collector cadence, the
// window surface and the update channel are all owned there, and the shared UI
// only renders their current values.
async function loadDesktopSettings() {
  const desktop = getTransport().desktop;
  if (!desktop) return;
  try {
    const [settings, info, syncHealth, snapshotMeta, appUpdateState] = await Promise.all([
      desktop.getSettings(),
      desktop.getAppInfo ? desktop.getAppInfo() : Promise.resolve({}),
      desktop.getSyncHealth ? desktop.getSyncHealth() : Promise.resolve(null),
      desktop.getSnapshotMeta ? desktop.getSnapshotMeta() : Promise.resolve(null),
      desktop.getAppUpdateState ? desktop.getAppUpdateState() : Promise.resolve(null)
    ]);
    state.desktopSettings = settings || {};
    state.desktopInfo = info || {};
    state.desktopAppUpdate = appUpdateState || null;
    state.desktopSyncHealth = syncHealth || null;
    state.desktopConnectionError = null;
    state.desktopSnapshotMeta = snapshotMeta || syncHealth?.snapshot || null;
    renderDesktopSyncStatus();
  } catch (error) {
    // A settings read failure must not blank the whole dashboard; the section
    // simply renders with defaults until the next successful read.
    state.desktopSettings = {};
    state.desktopInfo = {};
    state.desktopSyncHealth = null;
    state.desktopConnectionError = { channel: 'rest', code: 'sync_failed', status: null };
    state.desktopSnapshotMeta = null;
    console.warn('Could not load desktop settings:', error?.message || error);
  }
}

/** Persist a desktop settings patch and refresh the cached snapshot. */
async function saveDesktopSettings(patch) {
  const desktop = getTransport().desktop;
  if (!desktop) return false;
  try {
    const next = await desktop.updateSettings(patch);
    if (next) state.desktopSettings = next;
    state.desktopConnectionError = null;
    syncFluentMotion(state.desktopSettings?.reduceMotion || 'system');
    adoptDesktopPrefs(next);
    renderDesktopConnectionError();
    return true;
  } catch (error) {
    state.desktopConnectionError = {
      channel: 'rest',
      code: error?.code || 'sync_failed',
      status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null
    };
    renderDesktopConnectionError();
    showToast(error?.message || tr('error.generic'));
    return false;
  }
}

/**
 * Run a desktop-only settings action. These are the operations that need the
 * main process — a native folder picker, a filesystem export, an update check —
 * so each one is a named transport capability rather than a browser call the
 * shared UI could attempt on its own.
 */
async function runDesktopAction(action, element) {
  const desktop = getTransport().desktop;
  if (!desktop) return;
  try {
    switch (action) {
      case 'check-updates': {
        element?.setAttribute('disabled', 'disabled');
        const update = await desktop.checkAppUpdateNow();
        showToast(update?.latest ? tr('desktop.settings.updateAvailable') : tr('desktop.settings.upToDate'));
        element?.removeAttribute('disabled');
        state.desktopAppUpdate = await desktop.getAppUpdateState();
        render();
        break;
      }
      case 'download-install-update': {
        // One click, one intent: fetch the update and quit into the installer.
        // The confirm gate is the quit, not the download; without a pending
        // update the install side is a no-op.
        const confirmed = await confirmAction(tr('desktop.settings.installUpdate'), { danger: true });
        if (!confirmed) return;
        element?.setAttribute('disabled', 'disabled');
        await desktop.downloadAppUpdate();
        state.desktopAppUpdate = await desktop.getAppUpdateState();
        render();
        await desktop.installAppUpdate();
        break;
      }
      case 'save-hub-secret': {
        const input = element?.closest('[data-desktop-settings]')?.querySelector('[data-hub-secret-input]');
        await saveDesktopSettings({ secret: String(input?.value || '').trim() });
        if (input) input.value = '';
        render();
        showToast(tr('toast.saved'));
        break;
      }
      case 'clear-hub-secret':
        await saveDesktopSettings({ secret: '' });
        render();
        showToast(tr('toast.saved'));
        break;
      case 'recover-sync': {
        element?.setAttribute('disabled', 'disabled');
        state.desktopConnectionError = null;
        const result = await desktop.recoverNow?.();
        state.desktopSyncHealth = await desktop.getSyncHealth?.() || state.desktopSyncHealth;
        const failure = primarySyncHealthFailure(state.desktopSyncHealth)
          || (result?.ok === false
            ? {
              channel: 'rest',
              code: result.rest?.code || result.upload?.code || 'sync_failed',
              status: result.rest?.status || result.upload?.status || null
            }
            : null);
        state.desktopConnectionError = failure;
        render();
        if (!failure) showToast(tr('desktop.sync.recovered'));
        element?.removeAttribute('disabled');
        break;
      }
      default:
        break;
    }
  } catch (error) {
    showToast(error?.message || tr('error.generic'));
  }
}

async function init() {
  // Views read translations and escaping through this context; app.js stays the
  // single owner of both while view modules remain importable and testable.
  configureViewContext({
    tr,
    escapeHtml,
    settingsOptionList,
    state,
    els,
    render,
    savePrefs,
    switchView,
    showToast,
    // Helpers the extracted views use; installing them here rather than
    // re-exporting keeps the call sites unchanged.
    emptyHtml,
    panel,
    segButtons,
    formatDuration,
    trendValue,
    formatTrendValue,
    viewStats,
    activePeriod,
    uiIcon,
    toolRows,
    shareBarHtml,
    rowHtml,
    loadingHtml,
    managementError,
    renderCompletenessNotice,
    renderHistoryScopeNotice,
    renderTokenMix,
    usageMetricCard
  }, { requiredHelpers: VIEW_HELPER_NAMES });
  const loadedPrefs = await loadPrefs();
  if (loadedPrefs && typeof loadedPrefs === 'object') {
    Object.assign(state.prefs, loadedPrefs);
    const routeView = initialRoute.view || viewFromLocation();
    const prefsPatch = { ...loadedPrefs };
    if (routeView) delete prefsPatch.view;
    else if (loadedPrefs.view) prefsPatch.view = normalizeViewId(loadedPrefs.view);
    if (initialRoute.usageTab) delete prefsPatch.usageTab;
    if (initialRoute.managementTab) delete prefsPatch.managementTab;
    if (initialRoute.managementSection) delete prefsPatch.managementSection;
    if (initialRoute.limitTab) delete prefsPatch.limitTab;
    Object.assign(state.prefs, prefsPatch);
  }
  const loadedSecret = await loadSecret();
  if (!isCapable('desktopSettings') && loadedSecret !== undefined && loadedSecret !== null) {
    state.secret = loadedSecret;
  }
  if (isCapable('desktopSettings')) await loadDesktopSettings();
  renderStaticUiIcons();
  applyTheme();
  applyLocale();
  bindEvents();
  if (isCapable('desktopSettings')) {
    const desktop = getTransport().desktop;
    desktop?.onSettingsPush?.((next) => {
      state.desktopSettings = next || {};
      syncFluentMotion(state.desktopSettings.reduceMotion || 'system');
      // The main process pushes settings on a folder-picker or a collector tick;
      // treat it as data so it cannot close a dropdown the user has open.
      render({ quiet: true });
    });
    desktop?.onOpenSettings?.(() => switchView('settings'));
    desktop?.onOpenView?.((view) => switchView(normalizeViewId(view)));
    // The update panel is driven by the main process, which owns the download and
    // install lifecycles; without this it would only ever show boot state.
    desktop?.onAppUpdatePush?.((next) => {
      state.desktopAppUpdate = next || null;
      // A pushed update state (a download that started or finished) is data, not
      // a user action: it must not tear down a control the user has open.
      render({ quiet: true });
    });
  }
  renderChrome();
  // Paint the shell before any remote request. On desktop this is what keeps
  // Settings and local navigation available during a Hub timeout.
  render();

  if (isCapable('pwa') && 'serviceWorker' in navigator && window.isSecureContext) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      if (reg?.update) void reg.update();
    } catch {
      /* optional when the browser rejects the worker */
    }
  }
  if (isCapable('pwa')) refreshPwaUi();

  // Display rates keep this dashboard's costs in the same currency units as the
  // device that collected them; the built-in table is only a fallback while the
  // request is in flight or unavailable. A failure must never block boot.
  const ratesReady = fetchJson('/api/rates').then((payload) => {
    if (payload?.rates) configureRates(payload.rates, { source: payload.source, date: payload.date });
  }).catch(() => { /* keep the built-in rates */ });
  const healthReady = fetchHealth().then((health) => {
    state.health = health;
  }).catch(() => {
    state.health = { secretRequired: true };
  });
  await Promise.all([ratesReady, healthReady]);

  if (!state.health.secretRequired) {
    await tryConnect('', true);
    return;
  }

  if (state.secret) {
    const ok = await tryConnect(state.secret, await secretIsRemembered());
    if (ok) return;
  }
  showAuth(true);
}

void init();
