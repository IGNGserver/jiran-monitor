'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

test('direct requests do not load the external proxy HTTP stack', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { createOutboundFetch } = require(${JSON.stringify(require.resolve('../../src/shared/outboundFetch'))});
    createOutboundFetch({});
    assert.equal(Object.keys(require.cache).some(file => file.includes('/node_modules/undici/')), false);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

const {
  cleanProxyUrl,
  resolveProxyConfig,
  resolveProxyUrl,
  createOutboundFetch,
  resetOutboundFetchCache
} = require('../../src/shared/outboundFetch');

test.afterEach(async () => {
  await resetOutboundFetchCache({ drainTimeoutMs: 0 });
});

test('cleanProxyUrl trims and strips matching quotes', () => {
  assert.equal(cleanProxyUrl('  http://127.0.0.1:7897  '), 'http://127.0.0.1:7897');
  assert.equal(cleanProxyUrl('"http://127.0.0.1:7897"'), 'http://127.0.0.1:7897');
  assert.equal(cleanProxyUrl("'http://127.0.0.1:7897'"), 'http://127.0.0.1:7897');
  assert.equal(cleanProxyUrl(''), '');
  assert.equal(cleanProxyUrl(null), '');
});

test('resolveProxyConfig follows lowercase precedence and honors NO_PROXY', () => {
  assert.deepEqual(
    resolveProxyConfig({
      https_proxy: 'http://lower:1',
      HTTPS_PROXY: 'http://upper:1',
      http_proxy: 'http://lower:2',
      HTTP_PROXY: 'http://upper:2',
      no_proxy: 'grok.com,localhost',
      NO_PROXY: 'ignored.example'
    }),
    {
      httpsProxy: 'http://lower:1',
      httpProxy: 'http://lower:2',
      noProxy: 'grok.com,localhost'
    }
  );
});

test('resolveProxyUrl prefers HTTPS proxy then HTTP proxy then ALL_PROXY', () => {
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://h:1', HTTP_PROXY: 'http://h:2' }), 'http://h:1');
  assert.equal(resolveProxyUrl({ HTTP_PROXY: 'http://h:2', ALL_PROXY: 'http://h:3' }), 'http://h:2');
  assert.equal(resolveProxyUrl({ all_proxy: 'http://h:3' }), 'http://h:3');
  assert.equal(resolveProxyUrl({}), '');
});

test('createOutboundFetch without proxy returns a function that delegates to global fetch', async () => {
  let called = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    called += 1;
    return { ok: true, url: String(url) };
  };
  try {
    const fetchFn = createOutboundFetch({});
    const res = await fetchFn('https://example.test/');
    assert.equal(called, 1);
    assert.equal(res.url, 'https://example.test/');
  } finally {
    globalThis.fetch = original;
  }
});

test('createOutboundFetch uses an env-aware dispatcher with NO_PROXY', async () => {
  const calls = [];
  class FakeEnvHttpProxyAgent {
    constructor(options) {
      this.options = options;
    }
  }
  const undiciFetch = async (url, init) => {
    calls.push({ url: String(url), dispatcher: init && init.dispatcher });
    return { ok: true, status: 200 };
  };
  const fetchFn = createOutboundFetch(
    { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,grok.test' },
    { EnvHttpProxyAgent: FakeEnvHttpProxyAgent, undiciFetch }
  );
  const res = await fetchFn('https://grok.com/test', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://grok.com/test');
  assert.deepEqual(calls[0].dispatcher.options, {
    httpProxy: '',
    httpsProxy: 'http://127.0.0.1:7897',
    noProxy: 'localhost,grok.test'
  });
});

test('createOutboundFetch does not silently bypass an invalid configured proxy', () => {
  class ThrowingEnvHttpProxyAgent {
    constructor() {
      throw new Error('invalid proxy URL');
    }
  }
  assert.throws(
    () => createOutboundFetch(
      { HTTPS_PROXY: 'socks5://unsupported.test:1080' },
      { EnvHttpProxyAgent: ThrowingEnvHttpProxyAgent, undiciFetch: async () => ({ ok: true }) }
    ),
    /invalid proxy URL/
  );
});

test('createOutboundFetch deps.fetch override wins over proxy wiring', async () => {
  let hits = 0;
  const fetchFn = createOutboundFetch(
    { HTTPS_PROXY: 'http://127.0.0.1:7897' },
    {
      fetch: async () => {
        hits += 1;
        return { ok: true, status: 204 };
      }
    }
  );
  const res = await fetchFn('https://example.test/');
  assert.equal(hits, 1);
  assert.equal(res.status, 204);
});

test('proxy dispatcher cache stays single-current and revives an evicted fetch closure', async () => {
  const agents = [];
  const dispatchers = [];
  class FakeAgent {
    constructor(options) {
      this.options = options;
      this.closed = false;
      agents.push(this);
    }
    close() {
      this.closed = true;
      return new Promise((resolve) => { this.resolveClose = resolve; });
    }
    destroy() {
      this.destroyed = true;
      this.resolveClose?.();
      return Promise.resolve();
    }
  }
  const undiciFetch = async (url, init) => {
    dispatchers.push(init.dispatcher);
    return { ok: true };
  };
  const fetchA = createOutboundFetch(
    { HTTPS_PROXY: 'http://proxy-a.test:8080' },
    { EnvHttpProxyAgent: FakeAgent, undiciFetch }
  );
  await fetchA('https://example.test/a1');
  await fetchA('https://example.test/a2');
  assert.equal(agents.length, 1);
  const firstA = dispatchers[0];
  assert.equal(dispatchers[1], firstA);

  const fetchB = createOutboundFetch(
    { HTTPS_PROXY: 'http://proxy-b.test:8080' },
    { EnvHttpProxyAgent: FakeAgent, undiciFetch }
  );
  await fetchB('https://example.test/b');
  assert.equal(firstA.closed, true);

  // The A closure must not keep handing its closed dispatcher to undici.
  await fetchA('https://example.test/a3');
  const revivedA = dispatchers.at(-1);
  assert.notEqual(revivedA, firstA);
  assert.equal(revivedA.closed, false);
  assert.equal(revivedA.options.httpsProxy, 'http://proxy-a.test:8080');
  assert.equal(dispatchers[2].closed, true);
});

test('proxy dispatcher shutdown drains gracefully but destroys at the deadline', async () => {
  let agent;
  class StuckAgent {
    constructor() { agent = this; }
    close() {
      this.closeCalled = true;
      return new Promise(() => {});
    }
    destroy() {
      this.destroyCalled = true;
      return Promise.resolve();
    }
  }
  createOutboundFetch(
    { HTTPS_PROXY: 'http://stuck-proxy.test:8080' },
    { EnvHttpProxyAgent: StuckAgent, undiciFetch: async () => ({ ok: true }) }
  );
  const started = Date.now();
  await resetOutboundFetchCache({ drainTimeoutMs: 20 });
  assert.equal(agent.closeCalled, true);
  assert.equal(agent.destroyCalled, true);
  assert.ok(Date.now() - started < 500, 'shutdown must not await an uncooperative close forever');
});
