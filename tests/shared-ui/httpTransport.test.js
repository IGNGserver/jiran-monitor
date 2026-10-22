'use strict';

// Stream cancellation must outlive the short handshake timeout.

const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const transportPath = pathToFileURL(require('node:path').resolve(__dirname, '../../src/shared-ui/transport/httpTransport.js')).href;

test('stopping a live slim stream aborts the underlying fetch after headers', async () => {
  const { createHttpTransport } = await import(transportPath);
  const original = global.fetch;
  let signal;
  let url;
  let cancelled = false;
  let live;
  const ready = new Promise((resolve) => { live = resolve; });
  global.fetch = async (target, options) => {
    url = target;
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: stats\r\ndata: {"stats":{"devices":[]}}\r\n\r\n'));
        signal.addEventListener('abort', () => { try { controller.close(); } catch {} });
      },
      cancel() { cancelled = true; }
    }));
  };
  let stop;
  try {
    stop = createHttpTransport({ storage: storage() }).openStream({ detail: 'slim', onStatus: (status) => { if (status === 'live') live(); } });
    await ready;
    assert.equal(url, '/api/stats/stream?detail=slim');
    assert.equal(signal.aborted, false);
    stop();
    assert.equal(signal.aborted, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(cancelled || signal.aborted);
  } finally {
    stop?.();
    global.fetch = original;
  }
});

function storage() {
  const values = new Map();
  return {
    local: {
      getItem: (key) => values.get(`local:${key}`) ?? null,
      setItem: (key, value) => values.set(`local:${key}`, String(value)),
      removeItem: (key) => values.delete(`local:${key}`)
    },
    session: {
      getItem: (key) => values.get(`session:${key}`) ?? null,
      setItem: (key, value) => values.set(`session:${key}`, String(value)),
      removeItem: (key) => values.delete(`session:${key}`)
    }
  };
}

test('Hub HTTP requests abort with a stable timeout error', async () => {
  const { createHttpTransport } = await import(transportPath);
  const originalFetch = global.fetch;
  global.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

  try {
    const transport = createHttpTransport({ storage: storage() });
    await assert.rejects(
      transport.request('/api/stats', { timeoutMs: 10 }),
      (error) => error?.code === 'request_timeout'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hub login exchanges the secret for a cookie without storing it in script storage', async () => {
  const { createHttpTransport } = await import(transportPath);
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      ok: true,
      session: { id: 'session-1', deviceName: 'Browser', platform: 'web' }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const transport = createHttpTransport({ storage: storage() });
    const session = await transport.login('owner-secret', true);
    assert.equal(session.session.id, 'session-1');
    assert.equal(calls[0].url, '/api/auth/login');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.credentials, 'same-origin');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.secret, 'owner-secret');
    assert.equal(body.mode, 'cookie');
    assert.equal(transport.secret.load(), '');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hub login reports an old Hub so the caller can fall back to the secret', async () => {
  const { createHttpTransport } = await import(transportPath);
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' }
  });
  try {
    const transport = createHttpTransport({ storage: storage() });
    await assert.rejects(
      transport.login('owner-secret', true),
      (error) => error?.code === 'session_auth_unsupported' && error?.status === 404
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hub HTTP transport still honors an explicit caller abort', async () => {
  const { createHttpTransport } = await import(transportPath);
  const originalFetch = global.fetch;
  global.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('caller aborted'), { name: 'AbortError' }));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

  try {
    const controller = new AbortController();
    const transport = createHttpTransport({ storage: storage() });
    const request = transport.request('/api/stats', { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await assert.rejects(request, /caller aborted/);
  } finally {
    global.fetch = originalFetch;
  }
});
