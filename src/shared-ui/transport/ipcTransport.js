// Electron transport for the desktop client.
//
// Mirrors the Hub's HTTP transport, but every data call goes through this
// process over IPC. Two things make that possible without changing a line of
// view code:
//
//   * `request(path)` speaks the same `/api/...` vocabulary the Hub serves, and
//     src/electron/desktopRequestRouter.js maps it onto local data or a
//     Hub proxy;
//   * the live stats stream is the main process's existing `stats:push`
//     channel, which already carries reconnect/backoff/idle-watchdog handling
//     for both local collection and SSE.
//
// The persisted credential never reaches the renderer: `secret.load()` reports
// only whether a Hub is configured. A newly entered value may cross the explicit
// one-shot validation bridge below, but normal data requests cannot override the
// main process's credential.

function createIpcTransport(bridge) {
  if (!bridge || typeof bridge.request !== 'function') {
    throw new Error('createIpcTransport requires the preload bridge');
  }

  // Maps the main process's snake/camel failure object back onto the Error shape
  // the shared UI expects (status/payload are read by the 401 and 409 paths).
  function toError(info) {
    const error = new Error(info?.message || 'Desktop request failed');
    if (info?.code) error.code = info.code;
    if (info?.status != null) error.status = info.status;
    if (info?.payload !== undefined) error.payload = info.payload;
    return error;
  }

  async function request(path, options = {}) {
    const result = await bridge.request(path, {
      method: options.method || 'GET',
      body: options.body,
      signal: options.signal
    });
    if (!result?.ok) throw toError(result?.error);
    return result.data;
  }

  return {
    capabilities: {
      // The desktop client is not a browser: no PWA shell, native dialogs, and
      // hash routing because file:// has no server-side SPA fallback.
      pwa: false,
      nativeDialogs: true,
      externalOpen: 'shell',
      clipboard: 'ipc',
      routing: 'hash',
      localCollector: true,
      updater: true,
      desktopSettings: true,
      themeEditor: true,
      accounts: true,
      subscriptions: true,
      pricing: true
    },
    request,
    fetchJson: request,
    async health() {
      const result = await bridge.request('/api/health', { method: 'GET' });
      if (!result?.ok) {
        // A health probe must never block boot; report the same shape the Hub
        // returns when it cannot be reached.
        return { ok: false, secretRequired: false, capabilities: {} };
      }
      return result.data;
    },
    openStream({ onStats, onStatus, onRetry, onHealth } = {}) {
      // The main process owns the stream lifecycle (SSE in client mode, local
      // collector ticks otherwise) and already handles reconnect, backoff and
      // the idle watchdog. Re-deriving that here would double it.
      const offStats = bridge.onStatsPush((payload) => {
        if (!payload) return;
        // The main process publishes `sendPush({ event: 'sync-health', data: { health } })`,
        // so the per-channel health record lives one level down. Handing the
        // envelope to the renderer made every channel read as `unknown`, because
        // `health.local` etc. only exist on `data.health`.
        if (payload.event === 'sync-health') {
          onHealth?.(payload.data?.health || null);
          return;
        }
        if (payload.event !== 'stats') return;
        const data = payload.data || {};
        onStats?.(data.stats || data, data.type || 'stats', {
          at: data.at || null,
          lastEventAt: Date.now(),
          snapshot: data.snapshot || null
        });
        // Only the snapshot is forwarded here; a full health record arrives on
        // its own `sync-health` push. Spreading the stats frame instead would
        // blank one that has already landed.
        if (data.snapshot) onHealth?.({ snapshot: data.snapshot });
        onStatus?.('live', { lastEventAt: Date.now() });
      });
      const offStatus = bridge.onStreamStatus?.((status) => {
        if (!status) return;
        if (status.connected) onStatus?.('live', { lastEventAt: Date.now() });
        else if (status.failureCode === 'unauthorized') onStatus?.('unauthorized');
        else onStatus?.('disconnected');
      }) || (() => {});
      const offRetry = bridge.onStreamRetry?.((info) => onRetry?.(info?.delayMs)) || (() => {});
      return () => {
        offStats?.();
        offStatus?.();
        offRetry?.();
      };
    },
    prefs: {
      async load() {
        const settings = await bridge.getSettings();
        return bridge.prefsFromSettings(settings);
      },
      async save(patch) {
        const settings = await bridge.updateSettings(bridge.prefsToSettingsPatch(patch));
        return bridge.prefsFromSettings(settings);
      }
    },
    secret: {
      async test(secret) {
        if (typeof bridge.validateSecret !== 'function') {
          throw new Error('Desktop secret validation is unavailable');
        }
        const result = await bridge.validateSecret(String(secret || ''));
        if (!result?.ok) throw toError(result?.error);
        return result.data;
      },
      async load() {
        // Never expose the secret itself; the UI only needs to know whether a
        // Hub connection is configured.
        return (await bridge.hasSecret()) ? '__configured__' : '';
      },
      async save(secret, remember) {
        // "Remember" is meaningless on the desktop: the credential store always
        // persists. Keep the parameter for interface parity with the Hub.
        void remember;
        if (typeof bridge.connectHub !== 'function') {
          await bridge.updateSettings({ secret: String(secret || '') });
          return;
        }
        const result = await bridge.connectHub(String(secret || ''));
        if (!result?.ok) throw toError(result?.error);
        return result.data;
      },
      async clear() {
        if (typeof bridge.logoutHub === 'function') {
          const result = await bridge.logoutHub();
          if (!result?.ok) throw toError(result?.error);
          return result.data;
        }
        await bridge.updateSettings({ secret: '' });
      },
      async isRemembered() {
        return Boolean(await bridge.hasSecret());
      }
    },
    flags: {
      read: (key) => bridge.readFlag(key),
      write: (key, value) => bridge.writeFlag(key, value)
    },
    async openExternal(url) {
      const result = await bridge.openExternal(url);
      if (result && result.ok === false) throw new Error(result.error || 'openExternal failed');
    },
    async copyText(text) {
      await bridge.copyText(text);
      return true;
    },
    async confirm(message, options = {}) {
      return Boolean(await bridge.confirm(message, options));
    },
    async prompt(message, defaultValue = '') {
      const result = await bridge.prompt(message, defaultValue);
      // Electron has no native text prompt. The shared UI falls back to its own
      // inline field when the host reports it cannot prompt.
      if (result && result.unsupported) {
        const error = new Error('prompt_unsupported');
        error.code = 'prompt_unsupported';
        throw error;
      }
      return result?.value ?? null;
    },
    buildRouteUrl(view, params) {
      const query = params && Object.keys(params).length
        ? `?${new URLSearchParams(params).toString()}`
        : '';
      return `#/${view === 'overview' ? '' : view}${query}`;
    },
    writeRoute(view, { targetPath = '/', query = '', replace = false } = {}) {
      if (typeof window === 'undefined' || !window.history) return;
      // file:// has no server-side SPA fallback, so the view lives in the
      // fragment and the document itself never changes.
      const hashUrl = `#${targetPath}${query ? `?${query}` : ''}`;
      if (window.location.hash === hashUrl) return;
      const url = `${window.location.pathname}${hashUrl}`;
      if (replace) window.history.replaceState({ view }, '', url);
      else window.history.pushState({ view }, '', url);
    },
    readRoute() {
      if (typeof window === 'undefined' || !window.location) {
        return { path: '/', params: new URLSearchParams() };
      }
      // On desktop the fragment is authoritative; the pathname is the packaged
      // index.html and carries no route.
      const hash = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
      if (!hash) return { path: '/', params: new URLSearchParams() };
      const hashUrl = hash.startsWith('/') ? hash : `/${hash}`;
      const queryIndex = hashUrl.indexOf('?');
      const path = (queryIndex >= 0 ? hashUrl.slice(0, queryIndex) : hashUrl).replace(/\/+$/, '') || '/';
      const params = new URLSearchParams(queryIndex >= 0 ? hashUrl.slice(queryIndex + 1) : '');
      return { path, params };
    },
    pushRoute(view, params) {
      if (typeof window !== 'undefined' && window.history?.pushState) {
        window.history.pushState({ view }, '', this.buildRouteUrl(view, params));
      }
    },
    desktop: {
      getSettings: () => bridge.getSettings(),
      updateSettings: (patch) => bridge.updateSettings(patch),
      getAppInfo: () => bridge.getAppInfo(),
      getAppUpdateState: () => bridge.getAppUpdateState?.(),
      checkAppUpdateNow: () => bridge.checkAppUpdateNow?.(),
      downloadAppUpdate: () => bridge.downloadAppUpdate?.(),
      installAppUpdate: () => bridge.installAppUpdate?.(),
      dismissAppUpdate: (version) => bridge.dismissAppUpdate?.(version),
      recoverNow: () => bridge.recoverNow?.(),
      getSyncHealth: () => bridge.getSyncHealth?.(),
      getSnapshotMeta: () => bridge.getSnapshotMeta?.(),
      getStreamStatus: () => bridge.getStreamStatus?.(),
      onSettingsPush: (callback) => bridge.onSettingsPush?.(callback) || (() => {}),
      onAppUpdatePush: (callback) => bridge.onAppUpdatePush?.(callback) || (() => {}),
      onOpenSettings: (callback) => bridge.onOpenSettings?.(callback) || (() => {}),
      onOpenView: (callback) => bridge.onOpenView?.(callback) || (() => {}),
      signalContentReady: () => bridge.signalContentReady?.(),
      setViewState: (patch) => bridge.setViewState?.(patch)
    }
  };
}

export { createIpcTransport };
