'use strict';

const FEED_URL = 'https://raw.githubusercontent.com/IGNGserver/jiran-monitor/updates/updates.json';
const FEED_REPOSITORY = 'IGNGserver/jiran-monitor';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 60 * 1000;
const MAX_FEED_BYTES = 4 * 1024 * 1024;

function retryAfterMs(headers, now) {
  const raw = headers?.get?.('retry-after');
  const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) * 1000 : 0;
  const date = raw && !seconds ? Date.parse(raw) - now : 0;
  const reset = Number(headers?.get?.('x-ratelimit-reset')) * 1000 - now;
  return Math.max(0, seconds || 0, Number.isFinite(date) ? date : 0, Number.isFinite(reset) ? reset : 0);
}

function validateFeed(payload) {
  if (!payload || payload.schemaVersion !== 1 || payload.repository !== FEED_REPOSITORY
      || !Array.isArray(payload.releases) || !Number.isFinite(Date.parse(payload.generatedAt))) {
    throw new Error('Invalid update feed metadata');
  }
  return payload;
}

/** The caller persists state in its device-local private settings. Manual checks
 * may bypass the success TTL, never the request cooldown or server backoff. */
function createRepositoryFeedClient({
  fetchImpl = (...args) => fetch(...args), readState, writeState,
  now = Date.now, random = Math.random
} = {}) {
  let volatileState = {};
  readState ||= () => volatileState;
  writeState ||= (next) => { volatileState = next; };
  let inFlight = null;
  async function load({ manual = false } = {}) {
    if (inFlight) return inFlight;
    const state = readState() || {};
    let cached = null;
    try { cached = validateFeed(state.payload); } catch (_) { /* unusable cache */ }
    const time = now();
    const blockedUntil = Math.max(Number(state.retryAt) || 0, (Number(state.lastAttemptAt) || 0) + MANUAL_COOLDOWN_MS);
    if (time < blockedUntil) {
      if (cached && !(state.retryAt > time)) return { payload: cached, cached: true, checkedAt: state.checkedAt };
      const error = new Error(`Update check cooling down until ${new Date(blockedUntil).toISOString()}`);
      error.status = state.status || 0;
      error.retryAt = blockedUntil;
      throw error;
    }
    if (!manual && cached && time < state.nextCheckAt) return { payload: cached, cached: true, checkedAt: state.checkedAt };
    const task = (async () => {
      const attempted = { ...state, lastAttemptAt: time };
      writeState(attempted);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetchImpl(FEED_URL, {
          signal: controller.signal,
          headers: { accept: 'application/json', ...(cached && state.etag ? { 'if-none-match': state.etag } : {}) }
        });
        if (response.status !== 304 && !response.ok) {
          const error = new Error(`Update feed responded ${response.status}`);
          error.status = response.status;
          throw error;
        }
        let payload = cached;
        if (response.status !== 304) {
          if (Number(response.headers?.get?.('content-length')) > MAX_FEED_BYTES) throw new Error('Update feed metadata too large');
          // Bound the stream as well: Content-Length is optional and untrusted.
          let text = '';
          if (response.body?.getReader) {
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_FEED_BYTES) { await reader.cancel(); throw new Error('Update feed metadata too large'); }
                chunks.push(Buffer.from(value));
              }
              text = Buffer.concat(chunks, size).toString('utf8');
            } finally { reader.releaseLock(); }
          } else {
            text = await response.text();
            if (Buffer.byteLength(text) > MAX_FEED_BYTES) throw new Error('Update feed metadata too large');
          }
          payload = validateFeed(JSON.parse(text));
        }
        if (!payload) throw new Error('Update feed returned 304 without cached metadata');
        writeState({
          payload, etag: response.headers?.get?.('etag') || (response.status === 304 ? state.etag || null : null),
          lastAttemptAt: time, checkedAt: now(), nextCheckAt: now() + CHECK_INTERVAL_MS + Math.floor(random() * 30 * 60 * 1000),
          failures: 0, retryAt: 0, status: null
        });
        return { payload, cached: response.status === 304, checkedAt: now() };
      } catch (error) {
        const failures = Math.min(10, (Number(state.failures) || 0) + 1);
        const backoff = Math.min(CHECK_INTERVAL_MS, MANUAL_COOLDOWN_MS * 2 ** (failures - 1));
        const retryAt = now() + Math.max(backoff, retryAfterMs(response?.headers, now()));
        writeState({ ...attempted, failures, retryAt, status: error.status || null });
        error.retryAt = retryAt;
        throw error;
      } finally { controller.abort(); clearTimeout(timer); }
    })();
    inFlight = task;
    try { return await task; } finally { if (inFlight === task) inFlight = null; }
  }
  return { load };
}

module.exports = { createRepositoryFeedClient, validateFeed, retryAfterMs, FEED_URL, CHECK_INTERVAL_MS, MANUAL_COOLDOWN_MS };