// Transport facade — the single seam between the shared UI and its host.
//
// Every data access in the shared UI goes through this module, never through
// `fetch`, `localStorage`, or `window.tokenMonitor` directly. That is what lets
// the exact same view code run in two very different hosts:
//
//   * the Hub dashboard, which talks HTTP/SSE to the Hub on its own origin, and
//   * the Electron desktop client, which talks IPC to its main process.
//
// A host installs its implementation once at boot via `configureTransport()`.
// Calling a facade method before that is a programming error and throws, rather
// than silently falling through to a browser global that does not exist in
// Electron.

let activeTransport = null;

/** @typedef {ReturnType<typeof import('./contract.js').describeContract>} TransportContract */

export function configureTransport(transport) {
  if (!transport || typeof transport.request !== 'function') {
    throw new Error('configureTransport requires a transport with a request() method');
  }
  activeTransport = transport;
  return transport;
}

export function getTransport() {
  if (!activeTransport) {
    throw new Error(
      'No transport configured. The host must call configureTransport() before the shared UI boots.'
    );
  }
  return activeTransport;
}

export function hasTransport() {
  return activeTransport !== null;
}

/** Environment capabilities. Reads never throw so early render works pre-boot. */
export function capabilities() {
  return activeTransport?.capabilities || {};
}

export function isCapable(name) {
  return Boolean(activeTransport?.capabilities?.[name]);
}

// --- Data access -----------------------------------------------------------

/** The single request primitive. `path` is an `/api/...` path in both hosts. */
export function request(path, options) {
  return getTransport().request(path, options);
}

/** Alias kept so hub view code reads naturally; identical to `request`. */
export function fetchJson(path, options) {
  return request(path, options);
}

export function fetchHealth() {
  return getTransport().health();
}

/** Returns a disposer. */
export function openStatsStream(handlers) {
  return getTransport().openStream(handlers);
}

// --- Split preferences (hub: localStorage) vs settings (desktop: settings.json)

export function loadPrefs() {
  return getTransport().prefs.load();
}

export function savePrefs(patch) {
  return getTransport().prefs.save(patch);
}

// --- Credential handling ---------------------------------------------------

export function loadSecret() {
  return getTransport().secret.load();
}

export function saveSecret(secret, remember) {
  return getTransport().secret.save(secret, remember);
}

export function testSecret(secret) {
  const store = getTransport().secret;
  if (typeof store.test !== 'function') throw new Error('Secret validation is unavailable');
  return store.test(secret);
}

export function clearSecret() {
  return getTransport().secret.clear();
}

/** Whether the secret is persisted beyond this session (PWA only concern). */
export function secretIsRemembered() {
  const store = getTransport().secret;
  return typeof store.isRemembered === 'function' ? store.isRemembered() : false;
}

// --- Device sessions (Hub browser host) ------------------------------------

export function login(secret, remember) {
  const transport = getTransport();
  if (typeof transport.login !== 'function') throw new Error('Session login is unavailable');
  return transport.login(secret, remember);
}

export function currentSession() {
  const transport = getTransport();
  if (typeof transport.currentSession !== 'function') throw new Error('Session lookup is unavailable');
  return transport.currentSession();
}

export function listSessions() {
  const transport = getTransport();
  if (typeof transport.listSessions !== 'function') throw new Error('Session listing is unavailable');
  return transport.listSessions();
}

export function revokeSession(sessionId) {
  const transport = getTransport();
  if (typeof transport.revokeSession !== 'function') throw new Error('Session revocation is unavailable');
  return transport.revokeSession(sessionId);
}

export function logout() {
  const transport = getTransport();
  if (typeof transport.logout !== 'function') return Promise.resolve(null);
  return transport.logout();
}

export function logoutAll() {
  const transport = getTransport();
  if (typeof transport.logoutAll !== 'function') throw new Error('Session revocation is unavailable');
  return transport.logoutAll();
}

// --- Host-local flags (PWA install banner, dismissals) ----------------------

export function readFlag(key) {
  const store = getTransport().flags;
  return store && typeof store.read === 'function' ? store.read(key) : null;
}

export function writeFlag(key, value) {
  const store = getTransport().flags;
  if (store && typeof store.write === 'function') store.write(key, value);
}

// --- Host services ---------------------------------------------------------

/** Open a URL in the user's browser (or navigate the tab). */
export function openExternal(url) {
  const transport = getTransport();
  if (typeof transport.openExternal === 'function') return transport.openExternal(url);
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
  return undefined;
}

export function copyText(text) {
  const transport = getTransport();
  if (typeof transport.copyText === 'function') return transport.copyText(text);
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    return navigator.clipboard.writeText(String(text ?? ''));
  }
  return Promise.resolve(false);
}

/** Confirm a destructive action. Desktop routes this to a native dialog. */
export function confirmAction(message, options = {}) {
  const transport = getTransport();
  if (typeof transport.confirm === 'function') return transport.confirm(message, options);
  if (typeof window !== 'undefined') return Promise.resolve(window.confirm(message));
  return Promise.resolve(false);
}

/** Prompt for a single line of text. Desktop routes this to a native dialog. */
export function promptAction(message, defaultValue = '', options = {}) {
  const transport = getTransport();
  if (typeof transport.prompt === 'function') return transport.prompt(message, defaultValue, options);
  if (typeof window !== 'undefined') return Promise.resolve(window.prompt(message, defaultValue));
  return Promise.resolve(null);
}

/** Route navigation. Hash on desktop (no server SPA fallback), path on the Hub. */
export function routeUrl(view, params) {
  const transport = getTransport();
  if (typeof transport.buildRouteUrl === 'function') return transport.buildRouteUrl(view, params);
  const query = params && Object.keys(params).length
    ? `?${new URLSearchParams(params).toString()}`
    : '';
  return `/${view === 'overview' ? '' : view}${query}`;
}

export function pushRoute(view, params) {
  const transport = getTransport();
  if (typeof transport.pushRoute === 'function') return transport.pushRoute(view, params);
  return undefined;
}

/**
 * Apply a navigation to the URL bar. The host owns whether that is a path
 * (`pushState` on the Hub) or a fragment (desktop, where file:// has no
 * server-side SPA fallback), and whether the current entry may be replaced
 * instead of pushing a new one.
 */
export function writeRoute(view, { targetPath = '/', query = '', replace = false, hash = false } = {}) {
  const transport = getTransport();
  if (typeof transport.writeRoute === 'function') {
    return transport.writeRoute(view, { targetPath, query, replace, hash });
  }
  return undefined;
}

/** Read the current route. The host decodes path-then-hash in its own order. */
export function readRoute() {
  const transport = getTransport();
  if (typeof transport.readRoute === 'function') return transport.readRoute();
  return null;
}

/** Desktop-only operations. The Hub transport omits this and callers gate on `capabilities`. */
export function desktop() {
  return activeTransport?.desktop || null;
}
