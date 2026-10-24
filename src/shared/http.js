'use strict';

const zlib = require('node:zlib');
const { MAX_JSON_BODY_BYTES } = require('./wireValidation');
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 15 * 1000;

// Below this the framing overhead and the thread-pool handoff cost more than the
// savings, and Node's own `res.write` already keeps small bodies in one packet.
const COMPRESSION_MIN_BYTES = 1024;
// Quality 4 for brotli: on JSON it is within a few percent of quality 11 at a
// fraction of the CPU, and the Hub must not block its single event loop on
// compressing a multi-megabyte fleet snapshot.
const BROTLI_QUALITY = 4;
const REQUEST_STARTED_AT = Symbol('jiran.requestStartedAt');
const MAX_COMPRESSION_BYTES = 16 * 1024 * 1024;
const MAX_COMPRESSION_JOBS = 4;
let compressionBytes = 0;
let compressionJobs = 0;

function compressBounded(buffer, encoding) {
  if (compressionJobs >= MAX_COMPRESSION_JOBS || compressionBytes + buffer.length > MAX_COMPRESSION_BYTES) return null;
  compressionJobs++;
  compressionBytes += buffer.length;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      compressionJobs--;
      compressionBytes -= buffer.length;
      if (error) reject(error);
      else resolve(value);
    };
    try {
      if (encoding === 'br') zlib.brotliCompress(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }, done);
      else zlib.gzip(buffer, done);
    } catch (error) { done(error); }
  });
}

function sendEncodedBuffer(res, statusCode, buffer, contentType, encoding, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, corsHeaders({
    'content-type': contentType, 'cache-control': 'no-store', vary: 'accept-encoding',
    ...responseTimingHeaders(res), ...extraHeaders,
    ...(encoding ? { 'content-encoding': encoding } : {}),
    'content-length': String(buffer.length)
  }));
  res.end(buffer);
}

function startResponseTiming(req) {
  req[REQUEST_STARTED_AT] = performance.now();
}

function responseTimingHeaders(res) {
  const started = res?.req?.[REQUEST_STARTED_AT];
  return Number.isFinite(started)
    ? { 'server-timing': `app;dur=${Math.max(0, performance.now() - started).toFixed(1)}` }
    : {};
}

/**
 * The single encoding to use for a response body, or null to send it as-is.
 *
 * Reads `res.req` (Node sets it on every response) rather than taking the request
 * as a parameter: `sendJson` has dozens of call sites and none of them should
 * have to thread the request through just to enable compression.
 */
function negotiateEncoding(res) {
  const header = res?.req?.headers?.['accept-encoding'] || res?.req?.headers?.['Accept-Encoding'];
  const value = String(header || '');
  if (!value) return null;
  let brotliQ = 0;
  let gzipQ = 0;
  let wildcardQ = 0;
  for (const part of value.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed)) quality = parsed;
      }
    }
    if (name === 'br' || name === 'brotli') brotliQ = Math.max(brotliQ, quality);
    else if (name === 'gzip' || name === 'x-gzip') gzipQ = Math.max(gzipQ, quality);
    else if (name === '*') wildcardQ = Math.max(wildcardQ, quality);
  }
  // `br` is only offered when the client actually asked for it; an `*` wildcard is
  // satisfied with gzip, which every HTTP client that speaks encodings understands.
  if (brotliQ > 0 && brotliQ >= gzipQ) return 'br';
  if (gzipQ > 0) return 'gzip';
  if (wildcardQ > 0) return 'gzip';
  return null;
}

/**
 * Write a body, compressing it when the client asked for an encoding it supports.
 *
 * Compression runs on the libuv thread pool (`zlib.gzip` / `zlib.brotliCompress`),
 * not synchronously: a fleet snapshot is multi-megabyte JSON and a sync pass would
 * stall the event loop that also has to serve SSE heartbeats and every other
 * request. `res.end()` is asynchronous anyway, so callers keep their current
 * fire-and-forget contract. A compression failure falls back to the raw body.
 */
function sendBuffer(res, statusCode, body, contentType, extraHeaders = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const encoding = buffer.length >= COMPRESSION_MIN_BYTES ? negotiateEncoding(res) : null;
  const work = encoding && compressBounded(buffer, encoding);
  // Overload falls back to identity, not an unbounded libuv queue retaining one
  // fleet-sized Buffer per waiting response. No data or durability is sacrificed.
  if (!work) return sendEncodedBuffer(res, statusCode, buffer, contentType, null, extraHeaders);
  work.then(
    (compressed) => sendEncodedBuffer(res, statusCode, compressed, contentType, encoding, extraHeaders),
    () => sendEncodedBuffer(res, statusCode, buffer, contentType, null, extraHeaders)
  );
}

// Opt-in identity cache for immutable, authenticated read envelopes only. A
// WeakMap avoids retaining the source object graph; the LRU retains at most the
// configured bytes of UTF-8/encoded representations. Never use for mutable state,
// cookies or request-dependent bodies, and never bypass route authorization.
function createJsonResponseCache({ maxBytes = 8 * 1024 * 1024, maxEntries = 8 } = {}) {
  const byObject = new WeakMap();
  const lru = new Set();
  let bytes = 0;
  const counters = { serializations: 0, compressions: 0, hits: 0 };
  function evict(entry) {
    if (!entry?.active) return;
    entry.active = false;
    lru.delete(entry);
    bytes -= entry.bytes;
    entry.encoded.clear();
  }
  function reserve(size, protectedEntry = null) {
    for (const entry of lru) {
      if (bytes + size <= maxBytes && lru.size < maxEntries + (protectedEntry ? 1 : 0)) break;
      if (entry !== protectedEntry) evict(entry);
    }
    return bytes + size <= maxBytes;
  }
  function representation(payload) {
    let entry = payload && typeof payload === 'object' ? byObject.get(payload)?.deref() : null;
    if (entry?.active) {
      counters.hits++;
      lru.delete(entry);
      lru.add(entry);
      return entry;
    }
    counters.serializations++;
    const buffer = Buffer.from(JSON.stringify(payload));
    entry = { buffer, bytes: buffer.length, encoded: new Map(), pending: new Map(), active: false };
    if (payload && typeof payload === 'object' && buffer.length <= maxBytes && maxEntries > 0 && reserve(buffer.length)) {
      entry.active = true;
      bytes += entry.bytes;
      lru.add(entry);
      byObject.set(payload, new WeakRef(entry));
    }
    return entry;
  }
  return {
    prepare(payload) { return representation(payload).buffer; },
    async send(res, statusCode, payload, headers = {}) {
      const entry = representation(payload);
      const encoding = entry.buffer.length >= COMPRESSION_MIN_BYTES ? negotiateEncoding(res) : null;
      let buffer = encoding ? entry.encoded.get(encoding) : entry.buffer;
      let selectedEncoding = buffer && encoding;
      if (!buffer && encoding) {
        let work = entry.pending.get(encoding);
        if (!work) {
          work = compressBounded(entry.buffer, encoding);
          if (work) {
            counters.compressions++;
            entry.pending.set(encoding, work);
            work.then((value) => {
              if (entry.active && reserve(value.length, entry)) {
                entry.encoded.set(encoding, value);
                entry.bytes += value.length;
                bytes += value.length;
              }
            }, () => {}).finally(() => entry.pending.delete(encoding));
          }
        }
        if (work) {
          try { buffer = await work; selectedEncoding = encoding; } catch (_) { /* identity fallback */ }
        }
      }
      if (!buffer) { buffer = entry.buffer; selectedEncoding = null; }
      sendEncodedBuffer(res, statusCode, buffer, 'application/json; charset=utf-8', selectedEncoding, headers);
    },
    clear() { for (const entry of [...lru]) evict(entry); },
    metrics: () => ({ ...counters, bytes, entries: lru.size, compressionJobs, compressionBytes })
  };
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('The request was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

// AbortController is the socket-level cancellation mechanism used by fetch, but
// racing the promise as well keeps custom/test fetch implementations from leaving
// callers stuck forever when they ignore the signal.
async function fetchWithTimeout(fetchFn, url, options = {}, timeoutMs = DEFAULT_HTTP_REQUEST_TIMEOUT_MS, { bufferBody = false } = {}) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  let timeout;
  let removeExternalAbort = null;
  const externalAbort = new Promise((_, reject) => {
    if (!externalSignal) return;
    const onAbort = () => {
      const reason = abortError(externalSignal.reason);
      try { controller.abort(externalSignal.reason); } catch (_) { controller.abort(); }
      reject(reason);
    };
    if (externalSignal.aborted) onAbort();
    else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort);
    }
  });
  const parsedTimeout = Number(timeoutMs);
  const deadline = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  const deadlineError = new Error(`Request timed out after ${deadline}ms`);
  deadlineError.code = 'request_timeout';
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      try { controller.abort(deadlineError); } catch (_) { controller.abort(); }
      reject(deadlineError);
    }, deadline);
  });
  const requestPromise = Promise.resolve().then(async () => {
    // The caller's cancellation must remain wired after SSE headers arrive.
    // The temporary deadline listener below is disposed at that point, but an
    // AbortSignal.any relationship lasts for the whole response body lifetime.
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const response = await fetchFn(url, { ...options, signal });
    if (!bufferBody || !response || typeof response.arrayBuffer !== 'function') return response;

    // fetch() resolves when response headers arrive. Ordinary Hub calls need the
    // same deadline to cover the body as well, otherwise a peer can send headers
    // and leave response.json()/text() waiting forever. Buffer under the live
    // AbortController, then return a fresh Response that callers can consume with
    // the normal API after the deadline has been cleared. SSE deliberately uses
    // the unbuffered form and owns its lifetime through an idle watchdog.
    const body = await response.arrayBuffer();
    const status = Number(response.status);
    const bodyForbidden = status === 101 || status === 204 || status === 205 || status === 304;
    const responseHeaders = new Headers(response.headers);
    // fetch exposes decoded bytes. Carrying the original transport framing onto
    // the reconstructed body would describe the buffered payload incorrectly.
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    responseHeaders.delete('transfer-encoding');
    return new Response(bodyForbidden ? null : body, {
      status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  });
  // A timed-out request may still reject after the timeout race has settled. Keep
  // that late rejection from becoming an unhandled promise in the caller.
  requestPromise.catch(() => {});
  try {
    return await Promise.race([requestPromise, timeoutPromise, externalAbort]);
  } finally {
    clearTimeout(timeout);
    removeExternalAbort?.();
  }
}

function fetchBufferedWithTimeout(fetchFn, url, options = {}, timeoutMs = DEFAULT_HTTP_REQUEST_TIMEOUT_MS) {
  return fetchWithTimeout(fetchFn, url, options, timeoutMs, { bufferBody: true });
}

function corsHeaders(extraHeaders = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,prefer,x-jiran-secret,x-token-monitor-secret',
    ...extraHeaders
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  // No pretty-printing. The 2-space format the Hub used to emit cost ~1.8x the
  // bytes of the compact form and every consumer parses JSON, not prose; the
  // whitespace was pure transfer cost on a multi-megabyte fleet snapshot.
  sendBuffer(res, statusCode, JSON.stringify(payload), 'application/json; charset=utf-8', extraHeaders);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  sendBuffer(res, statusCode, body, contentType);
}

/**
 * Answer `304 Not Modified` when the caller's `If-None-Match` covers [etag].
 *
 * Returns true when it did. Deliberately opt-in per route: it is only correct
 * where the ETag is derived from the *whole* response document, and a bare
 * `Date.now()` inside a payload (staleness) makes any other token unable to
 * promise the body is unchanged.
 */
function sendNotModifiedIfFresh(req, res, etag) {
  const header = req?.headers?.['if-none-match'];
  if (!etag || typeof header !== 'string' || !header.trim()) return false;
  const matches = header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag);
  if (!matches) return false;
  res.writeHead(304, corsHeaders({
    etag,
    'cache-control': 'no-store',
    vary: 'accept-encoding'
  }));
  res.end();
  return true;
}

function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) {
        tooLarge = true;
        body = '';
        const error = new Error('Request body too large');
        error.code = 'payload_too_large';
        reject(error);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (error) { reject(new Error(`Invalid JSON body: ${error.message}`)); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  createJsonResponseCache,
  startResponseTiming,
  responseTimingHeaders,
  COMPRESSION_MIN_BYTES,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  MAX_JSON_BODY_BYTES,
  corsHeaders,
  fetchBufferedWithTimeout,
  fetchWithTimeout,
  negotiateEncoding,
  readJsonBody,
  sendBuffer,
  sendJson,
  sendNotModifiedIfFresh,
  sendText
};
