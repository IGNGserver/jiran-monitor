// HTTP/SSE transport for the Hub dashboard.
//
// Extracted from the dashboard's original `js/api.js`; the SSE client is moved
// verbatim because its reconnect/backoff/idle-watchdog behaviour is load-bearing
// (a half-open socket otherwise leaves the UI advertising stale numbers under a
// "live" badge). Only the request target became injectable.

const STORAGE_SECRET = 'token-monitor.hub.secret';
import { createSseFrameSplitter } from '../core/sseFrames.js';
import { copyTextWithFallback } from './clipboard.js';
const STORAGE_SECRET_SESSION = 'token-monitor.hub.secret.session';
const STORAGE_PREFS = 'token-monitor.hub.prefs';

// A half-open socket leaves reader.read() pending forever, so the UI would keep
// showing stale numbers under a "live" badge. The desktop client solved this with an idle
// watchdog plus a request deadline; mirror that here.
const SSE_IDLE_TIMEOUT_MS = 90_000;
const SSE_CONNECT_TIMEOUT_MS = 15_000;
const HTTP_REQUEST_TIMEOUT_MS = 15_000;

function authHeaders(secret, extra = {}) {
  const headers = { ...extra };
  const value = String(secret || '').trim();
  if (value) headers.authorization = `Bearer ${value}`;
  return headers;
}

function createRequestSignal(parentSignal, timeoutMs = HTTP_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  const abortFromParent = () => {
    try {
      controller.abort(parentSignal?.reason);
    } catch {
      controller.abort();
    }
  };

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      const reason = new Error('request timed out');
      reason.code = 'request_timeout';
      try {
        controller.abort(reason);
      } catch {
        controller.abort();
      }
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };
}

function timeoutError() {
  const error = new Error('request timed out');
  error.code = 'request_timeout';
  return error;
}

function createPrefsStore(storage) {
  return {
    load() {
      try {
        return JSON.parse(storage.local.getItem(STORAGE_PREFS) || '{}') || {};
      } catch {
        return {};
      }
    },
    save(patch) {
      const next = { ...this.load(), ...patch };
      storage.local.setItem(STORAGE_PREFS, JSON.stringify(next));
      return next;
    }
  };
}

function createSecretStore(storage) {
  return {
    load() {
      return storage.session.getItem(STORAGE_SECRET_SESSION)
        || storage.local.getItem(STORAGE_SECRET)
        || '';
    },
    save(secret, remember) {
      const value = String(secret || '').trim();
      storage.session.removeItem(STORAGE_SECRET_SESSION);
      storage.local.removeItem(STORAGE_SECRET);
      if (!value) return;
      if (remember) storage.local.setItem(STORAGE_SECRET, value);
      else storage.session.setItem(STORAGE_SECRET_SESSION, value);
    },
    clear() {
      storage.session.removeItem(STORAGE_SECRET_SESSION);
      storage.local.removeItem(STORAGE_SECRET);
    },
    isRemembered() {
      return Boolean(storage.local.getItem(STORAGE_SECRET));
    }
  };
}

function webDeviceName() {
  if (typeof navigator === 'undefined') return 'Web';
  const platform = String(navigator.userAgentData?.platform || navigator.platform || '').trim();
  return platform ? `${platform} browser` : 'Web browser';
}

function authResponseError(payload, status) {
  const error = new Error(payload?.message || payload?.error || `http_${status}`);
  error.status = status;
  error.payload = payload || null;
  if (payload?.error) error.code = payload.error;
  return error;
}

function createFlagStore(storage) {
  return {
    read(key) {
      try { return storage.local.getItem(key); } catch { return null; }
    },
    write(key, value) {
      try {
        if (value === null || value === undefined) storage.local.removeItem(key);
        else storage.local.setItem(key, String(value));
      } catch { /* storage may be unavailable */ }
    }
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl]        Hub origin; '' means same-origin.
 * @param {() => string} [options.getSecret] Live secret provider.
 * @param {object} [options.storage]        localStorage/sessionStorage stand-ins.
 */
export function createHttpTransport(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const getSecret = typeof options.getSecret === 'function' ? options.getSecret : () => '';
  const storage = options.storage || {
    local: typeof localStorage !== 'undefined' ? localStorage : memoryStorage(),
    session: typeof sessionStorage !== 'undefined' ? sessionStorage : memoryStorage()
  };

  function resolveUrl(path) {
    const target = String(path || '');
    if (/^https?:\/\//i.test(target)) return target;
    return `${baseUrl}${target}`;
  }

  async function request(path, { secret, method = 'GET', body, signal, timeoutMs = HTTP_REQUEST_TIMEOUT_MS } = {}) {
    const requestSignal = createRequestSignal(signal, timeoutMs);
    try {
      const res = await fetch(resolveUrl(path), {
        method,
        signal: requestSignal.signal,
        cache: 'no-store',
        // Session authentication is an HttpOnly same-origin cookie. An explicit
        // secret still rides in the Authorization header for old Hubs and for the
        // migration window.
        credentials: 'same-origin',
        headers: authHeaders(secret !== undefined ? secret : getSecret(), body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      if (res.status === 401) {
        const error = new Error('unauthorized');
        error.status = 401;
        throw error;
      }
      if (!res.ok) {
        let payload = null;
        try { payload = await res.json(); } catch { /* ignore */ }
        const detail = payload?.message || payload?.error || '';
        const error = new Error(detail || `http_${res.status}`);
        error.status = res.status;
        error.payload = payload;
        throw error;
      }
      if (res.status === 204) return null;
      return await res.json();
    } catch (error) {
      if (requestSignal.didTimeout()) throw timeoutError();
      throw error;
    } finally {
      requestSignal.dispose();
    }
  }

  async function health() {
    const requestSignal = createRequestSignal(undefined, HTTP_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(resolveUrl('/api/health'), { cache: 'no-store', credentials: 'same-origin', signal: requestSignal.signal });
      if (!res.ok) throw new Error(`health_${res.status}`);
      return await res.json();
    } catch (error) {
      if (requestSignal.didTimeout()) throw timeoutError();
      throw error;
    } finally {
      requestSignal.dispose();
    }
  }

  function openStream({ secret, detail = 'full', onStats, onStatus, onRetry } = {}) {
    const controller = new AbortController();
    let closed = false;
    let retryTimer = null;
    let retryResolve = null;
    let retryAttempt = 0;
    // Timestamp of the last frame the server sent. Reported so the UI can show how
    // old the displayed data is instead of implying it is current.
    let lastEventAt = null;

    function retryDelay(attempt) {
      return Math.min(30_000, Math.round(1_000 * (2 ** Math.min(attempt, 5)) * (0.8 + Math.random() * 0.4)));
    }

    /** Abort the current socket after `timeoutMs` without progress. */
    function watchdog(timeoutMs, arm) {
      let timer = null;
      const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
      const reset = () => {
        clear();
        if (!closed) timer = setTimeout(() => arm(clear), timeoutMs);
      };
      reset();
      return { reset, clear };
    }

    async function run() {
      while (!closed) {
        onStatus?.(retryAttempt ? 'retrying' : 'connecting');
        let cleanupAttempt = () => {};
        try {
          // Bound the handshake too: a proxy that accepts the TCP connection but
          // never responds would otherwise hang here forever with the UI stuck on
          // "connecting".
          const attempt = new AbortController();
          const abortAttempt = () => { try { attempt.abort(); } catch { /* ignore */ } };
          const connectTimer = setTimeout(abortAttempt, SSE_CONNECT_TIMEOUT_MS);
          const onOuterAbort = () => abortAttempt();
          controller.signal.addEventListener('abort', onOuterAbort, { once: true });
          if (controller.signal.aborted) abortAttempt();
          cleanupAttempt = () => {
            clearTimeout(connectTimer);
            controller.signal.removeEventListener('abort', onOuterAbort);
            abortAttempt();
          };
          let res;
          try {
            res = await fetch(resolveUrl(`/api/stats/stream${detail === 'slim' ? '?detail=slim' : ''}`), {
              headers: authHeaders(secret !== undefined ? secret : getSecret(), { accept: 'text/event-stream' }),
              signal: attempt.signal,
              cache: 'no-store',
              credentials: 'same-origin'
            });
          } finally {
            clearTimeout(connectTimer);
          }
          if (res.status === 401) {
            onStatus?.('unauthorized');
            return;
          }
          if (!res.ok || !res.body) {
            const error = new Error(`stream_${res.status}`);
            error.status = res.status;
            throw error;
          }
          lastEventAt = Date.now();
          // Status is only 'live' once a frame has actually arrived: the old code
          // announced live on the response headers alone.
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const splitFrames = createSseFrameSplitter();
          const idle = watchdog(SSE_IDLE_TIMEOUT_MS, (clear) => {
            clear();
            onStatus?.('idle-timeout', { lastEventAt });
            void reader.cancel().catch(() => {});
            abortAttempt();
          });
          try {
            while (!closed) {
              const { done, value } = await reader.read();
              if (done) break;
              idle.reset();
              lastEventAt = Date.now();
              for (const chunk of splitFrames(decoder.decode(value, { stream: true }))) {
                const lines = chunk.split(/\r?\n/);
                let event = 'message';
                const dataLines = [];
                for (const line of lines) {
                  if (line.startsWith('event:')) event = line.slice(6).trim();
                  else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                }
                if (!dataLines.length) continue;
                // A heartbeat proves the socket is alive but carries no data, so it
                // must not be mistaken for freshness.
                if (event === 'heartbeat') continue;
                try {
                  const payload = JSON.parse(dataLines.join('\n'));
                  if (event === 'snapshot' || event === 'stats' || payload?.stats) {
                    retryAttempt = 0;
                    onStats?.(payload.stats || payload, event, { at: payload.at || null, lastEventAt });
                    onStatus?.('live', { lastEventAt });
                  }
                } catch {
                  /* ignore malformed frames */
                }
              }
            }
          } finally {
            idle.clear();
            void reader.cancel().catch(() => {});
          }
          if (closed) return;
          onStatus?.('disconnected');
        } catch (error) {
          if (closed || controller.signal.aborted) return;
          onStatus?.(error?.status === 401 ? 'unauthorized' : 'error');
          if (error?.status === 401) return;
        } finally {
          cleanupAttempt();
        }

        if (closed) return;
        const delay = retryDelay(retryAttempt);
        retryAttempt += 1;
        onRetry?.(delay);
        await new Promise((resolve) => {
          retryResolve = resolve;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            retryResolve = null;
            resolve();
          }, delay);
        });
      }
    }

    run();
    return () => {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
        retryResolve?.();
        retryResolve = null;
      }
      controller.abort();
    };
  }

  async function login(secret, remember = true) {
    const requestSignal = createRequestSignal(undefined, HTTP_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(resolveUrl('/api/auth/login'), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        signal: requestSignal.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secret: String(secret || '').trim(),
          remember: remember !== false,
          mode: 'cookie',
          platform: 'web',
          deviceName: webDeviceName()
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 404 || res.status === 405 || res.status === 501 || payload?.error === 'session_auth_unavailable') {
        const error = authResponseError(payload, res.status);
        error.code = 'session_auth_unsupported';
        throw error;
      }
      if (!res.ok) throw authResponseError(payload, res.status);
      return payload;
    } catch (error) {
      if (requestSignal.didTimeout()) throw timeoutError();
      throw error;
    } finally {
      requestSignal.dispose();
    }
  }

  async function currentSession() {
    return request('/api/auth/session');
  }

  async function listSessions() {
    return request('/api/auth/sessions');
  }

  async function revokeSession(sessionId) {
    return request(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }

  async function logout() {
    return request('/api/auth/session', { method: 'DELETE' });
  }

  async function logoutAll() {
    return request('/api/auth/logout-all', { method: 'POST' });
  }

  return {
    capabilities: {
      // The Hub dashboard is a normal web page: it can use browser dialogs,
      // window.open and the clipboard directly.
      pwa: true,
      sessionAuth: true,
      nativeDialogs: false,
      externalOpen: 'window',
      clipboard: 'navigator',
      routing: 'history',
      localCollector: false,
      updater: false,
      desktopSettings: false,
      themeEditor: false,
      accounts: true,
      subscriptions: true,
      pricing: true
    },
    request,
    fetchJson: request,
    health,
    openStream,
    login,
    logout,
    logoutAll,
    currentSession,
    listSessions,
    revokeSession,
    prefs: createPrefsStore(storage),
    secret: createSecretStore(storage),
    flags: createFlagStore(storage),
    openExternal(url) {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    },
    copyText: copyTextWithFallback,
    confirm(message) {
      return Promise.resolve(typeof window !== 'undefined' ? window.confirm(message) : false);
    },
    buildRouteUrl(view, params) {
      const query = params && Object.keys(params).length
        ? `?${new URLSearchParams(params).toString()}`
        : '';
      return `/${view === 'overview' ? '' : view}${query}`;
    },
    writeRoute(view, { targetPath = '/', query = '', replace = false } = {}) {
      if (typeof window === 'undefined' || !window.history) return;
      const url = `${targetPath}${query ? `?${query}` : ''}`;
      const currentPath = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
      const samePath = currentPath === targetPath
        && window.location.search === (query ? `?${query}` : '')
        && !window.location.hash;
      // Pushing an identical entry would break the back button, so a no-op
      // navigation is dropped rather than recorded.
      if (samePath) return;
      if (replace) window.history.replaceState({ view }, '', url);
      else window.history.pushState({ view }, '', url);
    },
    readRoute() {
      if (typeof window === 'undefined' || !window.location) {
        return { path: '/', params: new URLSearchParams() };
      }
      let path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
      let params = new URLSearchParams(window.location.search || '');
      const hash = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
      if (hash) {
        const hashUrl = hash.startsWith('/') ? hash : `/${hash}`;
        const queryIndex = hashUrl.indexOf('?');
        path = (queryIndex >= 0 ? hashUrl.slice(0, queryIndex) : hashUrl).replace(/\/+$/, '') || '/';
        params = new URLSearchParams(queryIndex >= 0 ? hashUrl.slice(queryIndex + 1) : '');
      }
      return { path, params };
    },
    pushRoute(view, params) {
      if (typeof window !== 'undefined' && window.history?.pushState) {
        window.history.pushState({ view }, '', this.buildRouteUrl(view, params));
      }
    }
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); }
  };
}
