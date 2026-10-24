'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHub, resolveBindHost } = require('../../src/hub/server');
const { createCatalogPricingLookup } = require('../../src/hub/pricing-upstream');
const { createHubAuthPolicy } = require('../../src/shared/hubAuth');
const { MemoryRepository } = require('./memory-repository');

function createMemoryHub(options = {}) {
  const repository = options.repository || new MemoryRepository();
  return { repository, hub: createHub({ port: 0, host: '127.0.0.1', secret: '', repository, logger: { error() {}, warn() {} }, ...options }) };
}

async function readUntil(reader, predicate, timeoutMs = 1000) {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sse_timeout')), remaining);
      reader.read().then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
    if (result.done) throw new Error('sse_closed');
    text += decoder.decode(result.value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error('sse_timeout');
}

function payload(totalTokens, { deviceId = 'dev-a', model = 'gpt-5', inputTokens = totalTokens, updatedAt = '2026-07-18T00:00:00.000Z' } = {}) {
  return {
    deviceId,
    updatedAt,
    allTime: {
      totalTokens,
      costUsd: totalTokens / 1_000_000,
      clients: { codex: totalTokens },
      clientCosts: { codex: totalTokens / 1_000_000 },
      models: { [model]: totalTokens },
      modelCosts: { [model]: totalTokens / 1_000_000 },
      clientModels: { codex: { [model]: totalTokens } },
      clientModelCosts: { codex: { [model]: totalTokens / 1_000_000 } },
      sessions: {
        'codex:session-1': {
          client: 'codex', sessionId: 'session-1', totalTokens, inputTokens,
          models: { [model]: totalTokens }, modelCosts: { [model]: totalTokens / 1_000_000 },
          lastUsedAt: updatedAt, startedAt: updatedAt
        }
      }
    },
    today: { totalTokens },
    month: { totalTokens }
  };
}

test('resolveBindHost keeps the requested host when a secret is set', () => {
  assert.equal(resolveBindHost('0.0.0.0', 's3cret'), '0.0.0.0');
  assert.equal(resolveBindHost('192.168.1.10', 's3cret'), '192.168.1.10');
});

test('resolveBindHost forces localhost when no secret and a non-loopback host is requested', () => {
  assert.equal(resolveBindHost('0.0.0.0', ''), '127.0.0.1');
  assert.equal(resolveBindHost('192.168.1.10', ''), '127.0.0.1');
  assert.equal(resolveBindHost('', ''), '127.0.0.1');
});

test('a hub without a secret binds to localhost only even when asked to bind every interface', async () => {
  const { hub } = createMemoryHub({ host: '0.0.0.0' });
  await hub.start();
  try {
    assert.equal(hub.bindHost, '127.0.0.1');
    assert.equal(hub.server.address().address, '127.0.0.1');
  } finally {
    await hub.stop();
  }
});

test('a non-loopback HTTP hub requires an explicit insecure transport opt-in', () => {
  assert.throws(() => createHub({
    host: '0.0.0.0',
    adminSecret: 'admin',
    repository: new MemoryRepository()
  }), { code: 'insecure_hub_transport' });
  const allowed = createHub({
    host: '0.0.0.0',
    adminSecret: 'admin',
    allowInsecureHttp: true,
    repository: new MemoryRepository()
  });
  assert.equal(allowed.bindHost, '0.0.0.0');
});

test('health keeps the documented API version', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.version, 1);
    assert.equal(health.apiVersion, 3);
    assert.equal(health.capabilities.usageRange, true);
  } finally {
    await hub.stop();
  }
});

test('a live Hub can rotate device-bound credentials without an unauthenticated transition', async () => {
  const { hub } = createMemoryHub({
    adminSecret: 'admin-token',
    ingestCredentials: { 'dev-a': 'device-a-token' }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const ingest = (deviceId, token) => fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        prefer: 'return=minimal'
      },
      body: JSON.stringify(payload(1, { deviceId }))
    });
    assert.equal((await ingest('dev-a', 'admin-token')).status, 200);

    hub.replaceAuthPolicy(createHubAuthPolicy({
      adminSecret: 'admin-token',
      ingestCredentials: { 'dev-b': 'device-b-token' }
    }));

    assert.equal((await ingest('dev-a', 'admin-token')).status, 200);
    assert.equal((await ingest('dev-b', 'device-b-token')).status, 401);
    assert.throws(() => hub.replaceAuthPolicy(createHubAuthPolicy()), /preserve configured state/);
  } finally {
    await hub.stop();
  }
});

test('SSE emits an initial snapshot, an ingest update, and the fixed heartbeat', async () => {
  const { hub } = createMemoryHub({ sseHeartbeatMs: 20 });
  await hub.start();
  const controller = new AbortController();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/stats/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    assert.match(await readUntil(reader, (text) => text.includes('event: snapshot')), /reason":"snapshot"/);
    await hub.ingest(payload(5));
    assert.match(await readUntil(reader, (text) => text.includes('event: stats')), /reason":"ingest"/);
    assert.match(await readUntil(reader, (text) => text.includes(': hb')), /: hb/);
    await reader.cancel();
  } finally {
    controller.abort();
    await hub.stop();
  }
});

test('HTTP ingest reuses the one stats aggregation for its response and SSE update', async () => {
  const { hub, repository } = createMemoryHub();
  let listCalls = 0;
  const originalListDeviceRecords = repository.listDeviceRecords.bind(repository);
  repository.listDeviceRecords = async (...args) => {
    listCalls += 1;
    return originalListDeviceRecords(...args);
  };
  await hub.start();
  const controller = new AbortController();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/stats/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    await readUntil(reader, (text) => text.includes('event: snapshot'));
    listCalls = 0;

    const ingest = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(5))
    });
    assert.equal(ingest.status, 200);
    assert.equal((await ingest.json()).stats.periods.allTime.totalTokens, 5);
    assert.match(await readUntil(reader, (text) => text.includes('event: stats')), /reason":"ingest"/);
    // The warm read model replaces the committed contribution; response/SSE
    // reuse must not reload the fleet merely to aggregate the same mutation.
    assert.equal(listCalls, 0);
    await reader.cancel();
  } finally {
    controller.abort();
    await hub.stop();
  }
});

test('HTTP ingest honors Prefer return=minimal without aggregating an unused response', async () => {
  const { hub, repository } = createMemoryHub();
  let listCalls = 0;
  const originalListDeviceRecords = repository.listDeviceRecords.bind(repository);
  repository.listDeviceRecords = async (...args) => {
    listCalls += 1;
    return originalListDeviceRecords(...args);
  };
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify(payload(5))
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deviceId: 'dev-a' });
    assert.equal(listCalls, 0);
  } finally {
    await hub.stop();
  }
});

test('GET /api/devices returns the normalized current-period view used by mobile clients', async () => {
  const { hub } = createMemoryHub();
  await hub.ingest(payload(5, { updatedAt: '2026-07-18T00:00:00.000Z' }));
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/devices`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.devices.length, 1);
    assert.equal(body.devices[0].periods.today.totalTokens, 0);
    assert.equal(body.devices[0].periods.allTime.totalTokens, 5);
    assert.equal(Object.hasOwn(body.devices[0], 'today'), false);
  } finally {
    await hub.stop();
  }
});

test('SSE keeps a healthy client connected when one snapshot exceeds the writable high-water mark', async () => {
  const { hub } = createMemoryHub();
  const models = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`model-${index}`, 1]));
  const large = payload(2000);
  large.allTime = { ...large.allTime, models };
  await hub.ingest(large);
  await hub.start();
  const controller = new AbortController();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/stats/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    const snapshot = await readUntil(reader, (text) => text.includes('event: snapshot'));
    assert.ok(Buffer.byteLength(snapshot) > 16 * 1024);

    const next = payload(2001);
    next.allTime = { ...next.allTime, models: { ...models, 'model-next': 1 } };
    await hub.ingest(next);
    assert.match(await readUntil(reader, (text) => text.includes('event: stats')), /reason":"ingest"/);
    await reader.cancel();
  } finally {
    controller.abort();
    await hub.stop();
  }
});

test('ingest records initial, incremental, and reset deltas without negative events', async () => {
  const { hub, repository } = createMemoryHub();
  await hub.ingest(payload(100, { updatedAt: '2026-07-18T00:00:00.000Z' }));
  await hub.ingest(payload(160, { updatedAt: '2026-07-18T00:01:00.000Z' }));
  await hub.ingest(payload(20, { updatedAt: '2026-07-18T00:02:00.000Z' }));

  assert.deepEqual(repository.events.map((event) => event.totalTokens), [100, 60, 20]);
  assert.ok(repository.events.every((event) => event.inputTokens >= 0 && event.costUsd >= 0));
  assert.equal((await hub.getStats()).periods.allTime.totalTokens, 20);
});

test('concurrent cumulative ingests serialize one device baseline', async () => {
  const { repository, hub } = createMemoryHub();
  await hub.ingest(payload(100, { updatedAt: '2026-07-18T00:00:00.000Z' }));
  let enteredResolve;
  let release;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const originalLock = repository.lockDevice.bind(repository);
  let first = true;
  repository.lockDevice = async (...args) => {
    const result = await originalLock(...args);
    if (first) {
      first = false;
      enteredResolve();
      await gate;
    }
    return result;
  };
  const firstUpload = hub.ingest(payload(110, { updatedAt: '2026-07-18T00:00:01.000Z' }));
  await entered;
  const secondUpload = hub.ingest(payload(120, { updatedAt: '2026-07-18T00:00:02.000Z' }));
  release();
  await Promise.all([firstUpload, secondUpload]);
  assert.equal(repository.devices.get('dev-a').periods.allTime.totalTokens, 120);
  assert.equal(repository.events.reduce((sum, event) => sum + event.inputTokens, 0), 120);
  assert.equal(repository.events.length, 3);
});

test('pricing changes do not mutate existing event snapshots or costs', async () => {
  const { hub, repository } = createMemoryHub();
  await hub.setPricing('gpt-5', {
    inputPricePerMillion: 1,
    outputPricePerMillion: 0,
    cacheReadPricePerMillion: 0,
    cacheWritePricePerMillion: 0
  });
  await hub.ingest(payload(1_000_000));
  const first = { ...repository.events[0] };
  await hub.setPricing('gpt-5', {
    inputPricePerMillion: 3,
    outputPricePerMillion: 0,
    cacheReadPricePerMillion: 0,
    cacheWritePricePerMillion: 0
  });
  await hub.ingest(payload(2_000_000, { updatedAt: '2026-07-18T00:01:00.000Z' }));

  assert.equal(first.priceInputPerMillion, 1);
  assert.equal(first.costUsd, 1);
  assert.equal(repository.events[0].priceInputPerMillion, 1);
  assert.equal(repository.events[0].costUsd, 1);
  assert.equal(repository.events[1].priceInputPerMillion, 3);
  assert.equal(repository.events[1].costUsd, 3);
});

test('device deletion hides the snapshot but preserves its baseline and ledger identity', async () => {
  const { hub, repository } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    const ingest = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(5))
    });
    assert.equal(ingest.status, 200);
    const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
    assert.equal(stats.periods.allTime.totalTokens, 5);
    assert.equal(stats.devices[0].deviceId, 'dev-a');

    const deleted = await fetch(`http://127.0.0.1:${port}/api/devices/dev-a`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal((await hub.getStats()).devices.length, 0);
    assert.equal(repository.events.length, 1);
    assert.equal(repository.events[0].deviceId, 'dev-a');

    const reingest = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(5))
    });
    assert.equal(reingest.status, 200);
    assert.equal(repository.events.length, 1, 'the same cumulative snapshot must not be counted again');
    assert.equal((await hub.getStats()).devices.length, 1);
  } finally {
    await hub.stop();
  }
});

test('device rename moves the baseline and ledger atomically before the next ingest', async () => {
  const { hub, repository } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await hub.ingest(payload(100));
    const renamed = await fetch(`http://127.0.0.1:${port}/api/devices/dev-a/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-b' })
    });
    assert.equal(renamed.status, 200);
    assert.equal(repository.events[0].deviceId, 'dev-b');
    assert.equal(repository.devices.has('dev-a'), false);
    assert.equal(repository.devices.get('dev-b').deviceId, 'dev-b');

    await hub.ingest(payload(100, { deviceId: 'dev-b' }));
    assert.equal(repository.events.length, 1, 'rename must preserve the cumulative baseline');
    const conflict = await fetch(`http://127.0.0.1:${port}/api/devices/dev-b/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-b' })
    });
    assert.equal(conflict.status, 200);
  } finally {
    await hub.stop();
  }
});

test('pricing endpoints accept manual and tokscale-upstream data', async () => {
  const { repository, hub } = createMemoryHub({
    lookupPricing: async () => ({ pricing: {
      inputCostPerToken: 0.000002, outputCostPerToken: 0.000004,
      cacheReadInputTokenCost: 0.0000002, cacheCreationInputTokenCost: 0.0000004
    } })
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const manual = await fetch(`http://127.0.0.1:${port}/api/pricing/gpt-5`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputPricePerMillion: 1, outputPricePerMillion: 2, cacheReadPricePerMillion: 0.1, cacheWritePricePerMillion: 0.2 })
    });
    assert.equal(manual.status, 200);
    const upstream = await fetch(`http://127.0.0.1:${port}/api/pricing/gpt-5/fetch-upstream`, { method: 'POST' });
    assert.equal(upstream.status, 200);
    assert.equal(repository.pricing.get('gpt-5').source, 'tokscale_upstream');
    assert.equal(repository.pricing.get('gpt-5').inputPricePerMillion, 2);
  } finally {
    await hub.stop();
  }
});

test('pricing fetch falls back to the tokscale catalog when the CLI cannot reach its upstreams', async () => {
  const { repository, hub } = createMemoryHub({
    lookupPricing: async () => { throw new Error('raw.githubusercontent.com timed out'); },
    fallbackPricing: async () => ({ pricing: {
      inputCostPerToken: 0.00000125,
      outputCostPerToken: 0.00001,
      cacheReadInputTokenCost: 0.000000125,
      cacheCreationInputTokenCost: 0
    } })
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/pricing/gpt-5/fetch-upstream`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(repository.pricing.get('gpt-5').source, 'tokscale_upstream');
    assert.equal(repository.pricing.get('gpt-5').inputPricePerMillion, 1.25);
  } finally {
    await hub.stop();
  }
});

test('catalog fallback uses models.dev costs and caches its upstream response', async () => {
  let calls = 0;
  const lookup = createCatalogPricingLookup({
    fetchFn: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ openai: { models: { 'gpt-5': { id: 'gpt-5', cost: { input: 1.25, output: 10, cache_read: 0.125 } } } } }) };
    }
  });
  const first = await lookup('openai/gpt-5');
  const second = await lookup('gpt-5');
  assert.deepEqual(first.pricing, {
    inputCostPerToken: 0.00000125,
    outputCostPerToken: 0.00001,
    cacheReadInputTokenCost: 0.000000125,
    cacheCreationInputTokenCost: 0
  });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test('oversized ingest returns 413 without storing the device', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'oversized', padding: 'x'.repeat(1024 * 1024) })
    });
    assert.equal(response.status, 413);
    assert.equal((await hub.getStats()).devices.length, 0);
  } finally {
    await hub.stop();
  }
});

test('rate limiting isolates peer IPs when trustProxy is enabled', async () => {
  const { hub } = createMemoryHub({
    secret: 'test-secret',
    trustProxy: true,
    authFailureLimit: 2
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    // 2 failed attempts for client-1
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/stats`, {
        headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1', authorization: 'Bearer wrong' }
      });
      assert.equal(res.status, 401);
    }
    // 3rd attempt for client-1 should be rate limited
    const resLimited = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1', authorization: 'Bearer wrong' }
    });
    assert.equal(resLimited.status, 429);

    // client-2 through the same proxy should not be rate limited
    const resOther = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      headers: { 'x-forwarded-for': '198.51.100.2, 10.0.0.1', authorization: 'Bearer wrong' }
    });
    assert.equal(resOther.status, 401);
  } finally {
    await hub.stop();
  }
});

function cookieFromResponse(response) {
  const values = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const value = values.find((entry) => entry && entry.trim());
  return value ? value.split(';')[0] : '';
}

test('device sessions: cookie login, listing, and logout', async () => {
  const { hub } = createMemoryHub({ secret: 'owner-secret' });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'owner-secret', mode: 'cookie', platform: 'web', deviceName: 'Browser' })
    });
    assert.equal(login.status, 200);
    const payload = await login.json();
    assert.equal(payload.session.deviceName, 'Browser');
    const cookie = cookieFromResponse(login);
    assert.match(cookie, /^jiran_session=jrs_/);

    const capabilities = await fetch(`${base}/api/capabilities`, { headers: { cookie } });
    assert.equal(capabilities.status, 200);
    const current = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).session.deviceName, 'Browser');

    const list = await fetch(`${base}/api/auth/sessions`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const sessions = (await list.json()).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].current, true);

    const logout = await fetch(`${base}/api/auth/session`, { method: 'DELETE', headers: { cookie } });
    assert.equal(logout.status, 200);
    const after = await fetch(`${base}/api/capabilities`, { headers: { cookie } });
    assert.equal(after.status, 401);
  } finally {
    await hub.stop();
  }
});

test('device sessions: a token can be revoked by another device', async () => {
  const { hub } = createMemoryHub({ secret: 'owner-secret' });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const base = `http://127.0.0.1:${port}`;
    const login = async (name) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 'owner-secret', mode: 'token', platform: 'android', deviceName: name })
      });
      assert.equal(response.status, 200);
      return (await response.json()).token;
    };
    const phone = await login('Phone');
    const laptop = await login('Laptop');
    assert.ok(phone && laptop);

    const phoneSession = await fetch(`${base}/api/auth/session`, {
      headers: { authorization: `Bearer ${phone}` }
    }).then((response) => response.json());
    assert.equal(phoneSession.legacy, false);

    const revoke = await fetch(`${base}/api/auth/sessions/${phoneSession.session.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${laptop}` }
    });
    assert.equal(revoke.status, 200);

    const revoked = await fetch(`${base}/api/capabilities`, {
      headers: { authorization: `Bearer ${phone}` }
    });
    assert.equal(revoked.status, 401);
    const stillValid = await fetch(`${base}/api/capabilities`, {
      headers: { authorization: `Bearer ${laptop}` }
    });
    assert.equal(stillValid.status, 200);
  } finally {
    await hub.stop();
  }
});

test('device sessions: changing the owner secret revokes old sessions', async () => {
  const repository = new MemoryRepository();
  const first = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'first-secret',
    repository,
    logger: { error() {}, warn() {} }
  });
  await first.start();
  let token;
  try {
    const { port } = first.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'first-secret', mode: 'token', platform: 'desktop', deviceName: 'Laptop' })
    });
    token = (await response.json()).token;
    assert.ok(token);
  } finally {
    await first.stop();
  }

  const second = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'second-secret',
    repository,
    logger: { error() {}, warn() {} }
  });
  await second.start();
  try {
    const { port } = second.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/capabilities`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 401);
  } finally {
    await second.stop();
  }
});
