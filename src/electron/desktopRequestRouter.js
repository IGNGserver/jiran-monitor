'use strict';

// Desktop request router.
//
// The shared UI issues every data call as `request('/api/<path>')`. In the Hub
// that maps one-to-one onto an HTTP route. The desktop client has to serve the
// same paths from three different places:
//
//   * data this device already owns (local-mode stats, history, rates),
//   * Hub-owned resources it must proxy through the main process, which holds
//     the bearer secret and the transport policy,
//   * operations that only exist here (settings, exports, updates).
//
// Keeping that mapping in one place is what lets the shared view code stay
// identical in both hosts. The module is deliberately free of Electron imports
// so it can be unit-tested against injected dependencies.

const READ_METHODS = new Set(['GET', 'HEAD']);

function splitPath(path) {
  const raw = String(path || '');
  const [withoutQuery, queryString = ''] = raw.split('?');
  const clean = withoutQuery.replace(/^\/api\/?/, '/').replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(queryString);
  return { path: clean || '/', query };
}

/**
 * The shared UI asks for a custom range as ISO `from`/`to` instants, matching
 * the Hub's `?from=&to=` route. The main process normalizes date+hour parts
 * instead, so convert rather than duplicating the range logic here.
 */
function rangeQueryToParts(query) {
  const from = query.get('from');
  const to = query.get('to');
  if (!from && !to) return {};
  const parts = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      hour: date.getHours()
    };
  };
  const start = from ? parts(from) : null;
  const end = to ? parts(to) : null;
  if (from && !start) return null;
  if (to && !end) return null;
  return {
    ...(start ? { startDate: start.date, startHour: start.hour } : {}),
    ...(end ? { endDate: end.date, endHour: end.hour } : {})
  };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings        Current settings snapshot.
 * @param {() => object} deps.getStats           Local-or-Hub stats snapshot.
 * @param {() => object} deps.getCustomRange     Custom-range aggregation.
 * @param {(options: object) => object} deps.getHistory Scoped history document.
 * @param {() => object|null} deps.getSessionDetail
 * @param {(path: string, options: object) => Promise<object>} deps.hubRequest
 *        Authenticated proxy for Hub-owned routes. Rejects with
 *        `{ code: 'hub_not_configured' }` when there is no Hub.
 * @param {() => object} deps.getCapabilities
 * @param {() => object} deps.getRates
 */
function createRequestRouter(deps) {
  const call = (fn, ...args) => {
    if (typeof fn !== 'function') {
      const error = new Error('This device cannot serve that request');
      error.code = 'not_supported';
      throw error;
    }
    return fn(...args);
  };

  // Routes the desktop client always serves itself, regardless of Hub state.
  // These are the device-local surfaces the Hub has no concept of.
  async function localRoute(path, method, options) {
    if ((path === '/stats' || path === '/stats/summary') && READ_METHODS.has(method)) return call(deps.getStats, options);
    if (/^\/devices\/[^/]+$/.test(path) && READ_METHODS.has(method) && deps.getDevice) {
      return call(deps.getDevice, decodeURIComponent(path.slice('/devices/'.length)));
    }
    if (path === '/sessions' && READ_METHODS.has(method)) return call(deps.getSessions, options.query.get('period') || 'today');
    if (path === '/history' && READ_METHODS.has(method)) return call(deps.getHistory, options);
    if (path === '/rates' && READ_METHODS.has(method)) return call(deps.getRates, options);
    if (path === '/capabilities' && READ_METHODS.has(method)) return call(deps.getCapabilities, options);
    if (path === '/health' && READ_METHODS.has(method)) {
      if (typeof deps.getHealth === 'function') return call(deps.getHealth, options);
      const caps = typeof deps.getCapabilities === 'function' ? await call(deps.getCapabilities, options) : {};
      return {
        ok: true,
        role: 'desktop',
        secretRequired: false,
        capabilities: caps?.capabilities || {}
      };
    }
    if (path === '/session-detail' && READ_METHODS.has(method)) {
      return call(deps.getSessionDetail, options?.body || options);
    }
    // Custom ranges are computed locally in local mode and aggregated by the Hub
    // in client mode; the main process owns that decision.
    if (path === '/usage/range' && READ_METHODS.has(method)) {
      const rangeInput = rangeQueryToParts(options?.query || new URLSearchParams());
      if (rangeInput === null) {
        const error = new Error('invalid-range');
        error.code = 'invalid-range';
        throw error;
      }
      const res = await call(deps.getCustomRange, rangeInput);
      if (res && res.ok === false) {
        const error = new Error(res.message || res.error || 'Custom range request failed');
        error.code = res.error || 'range_failed';
        throw error;
      }
      return res?.period || res;
    }
    return undefined;
  }

  // Hub-owned resources. In local mode these have no meaning, and the shared UI
  // gates them behind capabilities; returning an explicit code keeps a stale
  // view from rendering an empty state that looks like real data.
  function isHubOwned(path) {
    if (path === '/accounts' || path.startsWith('/accounts/')) return true;
    if (path === '/subscriptions') return true;
    if (path === '/pricing' || path.startsWith('/pricing/')) return true;
    if (/^\/devices\/[^/]+(\/rename)?$/.test(path)) return true;
    return false;
  }

  async function route(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const { path: cleanPath, query } = splitPath(path);
    const withQuery = options;

    const local = await localRoute(cleanPath, method, { ...withQuery, query });
    if (local !== undefined) return local;

    if (isHubOwned(cleanPath)) {
      return call(deps.hubRequest, `/api${cleanPath}${query.toString() ? `?${query}` : ''}`, { ...options, method });
    }

    // Anything else is a Hub route we have no local equivalent for.
    const error = new Error(`Unsupported desktop request: ${method} ${cleanPath}`);
    error.code = 'not_supported';
    throw error;
  }

  return { route, splitPath };
}

module.exports = { createRequestRouter, splitPath };
