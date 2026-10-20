'use strict';

const { fetchRates, isCacheStale } = require('../shared/exchangeRates');

// Optional display data must never hold an HTTP response open for an upstream.
function createDisplayRatesCache({ fetchImpl, now = Date.now, logger = console, retryMs = 60_000 } = {}) {
  let cached = null;
  let inFlight = null;
  let retryAt = 0;

  function refresh() {
    if (inFlight || now() < retryAt || (cached && !isCacheStale(cached, now()))) return inFlight;
    inFlight = fetchRates({ fetchImpl }).then((value) => {
      cached = { ...value, fetchedAt: now() };
      retryAt = 0;
    }).catch(() => {
      retryAt = now() + retryMs;
      logger.warn?.('[hub-rates] live rates unavailable; retaining cached/built-in rates');
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function get() {
    void refresh();
    return cached
      ? { rates: cached.rates, date: cached.date, source: cached.source }
      : { rates: null, date: null, source: 'built-in' };
  }

  return { get, refresh };
}

module.exports = { createDisplayRatesCache };
