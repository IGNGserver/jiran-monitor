'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The shared UI reads its split preferences out of the settings document, and
// the web dashboard uses these exact keys. Keeping the mapping here means the
// shared view code persists the same shape in both hosts and an existing
// desktop settings.json keeps working unchanged.
const PREFS_KEYS = Object.freeze([
  'language',
  'theme',
  'currency',
  'period',
  'trendsRange',
  'trendsStack',
  'trendsMetric',
  'heatmapMetric',
  'activeDaysWindow',
  'homeLimitAccountCount',
  'deviceFilter',
  'selectedDeviceId',
  'selectedToolId',
  'view',
  'usageTab',
  'managementTab',
  'limitTab'
]);

// These live in settings.json under a different name than the UI pref they back.
const PREFS_SETTINGS_ALIASES = Object.freeze({
  activeDaysWindow: 'homeActiveDaysWindow'
});

function prefsFromSettings(settings = {}) {
  const out = {};
  for (const key of PREFS_KEYS) {
    const source = PREFS_SETTINGS_ALIASES[key] || key;
    if (settings[source] !== undefined) out[key] = settings[source];
  }
  return out;
}

function prefsToSettingsPatch(patch = {}) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PREFS_KEYS.includes(key)) continue;
    out[PREFS_SETTINGS_ALIASES[key] || key] = value;
  }
  return out;
}

contextBridge.exposeInMainWorld('tokenMonitor', {
  // --- Shared-UI transport surface -----------------------------------------
  request: (path, options) => ipcRenderer.invoke('transport:request', path, options),
  validateSecret: (secret) => ipcRenderer.invoke('hub:validate-secret', secret),
  connectHub: (secret) => ipcRenderer.invoke('hub:connect', secret),
  logoutHub: () => ipcRenderer.invoke('hub:logout'),
  readFlag: (key) => ipcRenderer.invoke('transport:flag:read', key),
  writeFlag: (key, value) => ipcRenderer.invoke('transport:flag:write', key, value),
  confirm: (message, options) => ipcRenderer.invoke('ui:confirm', message, options),
  prompt: (message, defaultValue) => ipcRenderer.invoke('ui:prompt', message, defaultValue),
  hasSecret: async () => {
    const settings = await ipcRenderer.invoke('settings:get');
    return Boolean(settings && settings.hubSecretConfigured);
  },
  prefsFromSettings,
  prefsToSettingsPatch,

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  lookupModelPricing: (modelId) => ipcRenderer.invoke('pricing:lookup', modelId),
  previewAppearance: (patch) => ipcRenderer.invoke('appearance:preview', patch),
  getCustomRangeStats: (range) => ipcRenderer.invoke('stats:getCustomRange', range),
  getSessionDetail: (args) => ipcRenderer.invoke('session:getDetail', args),
  getStreamStatus: () => ipcRenderer.invoke('stream:status'),
  recoverNow: () => ipcRenderer.invoke('sync:recover'),
  getSyncHealth: () => ipcRenderer.invoke('sync:health'),
  getSnapshotMeta: () => ipcRenderer.invoke('desktop:snapshot-meta'),
  // The standalone trends window is gone; the trends view renders in the main
  // window. History is fetched through the transport's /api/history route.
  getHistory: () => ipcRenderer.invoke('history:get'),
  onStatsPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('stats:push', listener);
    return () => ipcRenderer.removeListener('stats:push', listener);
  },
  // The main process already classifies connection state (SSE health, backoff
  // countdown, failure codes); the shared UI only needs to render it.
  onStreamStatus: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('stream:status', listener);
    return () => ipcRenderer.removeListener('stream:status', listener);
  },
  onSettingsPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('settings:push', listener);
    return () => ipcRenderer.removeListener('settings:push', listener);
  },
  onOpenSettings: (callback) => {
    const listener = () => { try { callback(); } catch (_) {} };
    ipcRenderer.on('settings:open', listener);
    return () => ipcRenderer.removeListener('settings:open', listener);
  },
  onOpenView: (callback) => {
    const listener = (_event, viewId) => { try { callback(viewId); } catch (_) {} };
    ipcRenderer.on('view:open', listener);
    return () => ipcRenderer.removeListener('view:open', listener);
  },
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  hubAccounts: {
    list: () => ipcRenderer.invoke('hubAccounts:list'),
    add: (request = {}) => ipcRenderer.invoke('hubAccounts:add', request),
    update: (id, patch = {}) => ipcRenderer.invoke('hubAccounts:update', id, patch),
    remove: (id) => ipcRenderer.invoke('hubAccounts:remove', id),
    refresh: (id) => ipcRenderer.invoke('hubAccounts:refresh', id)
  },
  getAppUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  checkAppUpdateNow: () => ipcRenderer.invoke('appUpdate:checkNow'),
  downloadAppUpdate: () => ipcRenderer.invoke('appUpdate:download'),
  installAppUpdate: () => ipcRenderer.invoke('appUpdate:install'),
  dismissAppUpdate: (version) => ipcRenderer.invoke('appUpdate:dismiss', version),
  signalContentReady: () => ipcRenderer.send('window:contentReady'),
  setViewState: (patch) => ipcRenderer.send('window:viewState', patch),
  onAppUpdatePush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('appUpdate:push', listener);
    return () => ipcRenderer.removeListener('appUpdate:push', listener);
  },
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close')
});
