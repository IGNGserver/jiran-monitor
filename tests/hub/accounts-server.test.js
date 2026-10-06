'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHub } = require('../../src/hub/server');
const { MemoryRepository } = require('./memory-repository');

function accountProbe(provider) {
  return {
    provider,
    status: 'ok',
    accountKey: `${provider}-server-account`,
    accountEmail: `${provider}@example.test`,
    accountLabel: 'Server account',
    windows: [{ label: 'daily', used: 12, limit: 100, remaining: 88, unit: 'tokens' }]
  };
}

async function requestJson(port, path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function usagePayload() {
  return {
    deviceId: 'device-a',
    updatedAt: '2026-09-11T00:00:00.000Z',
    today: { totalTokens: 10 },
    month: { totalTokens: 10 },
    allTime: {
      totalTokens: 10,
      clients: { codex: 10 },
      clientCosts: { codex: 0 },
      models: { 'gpt-5': 10 },
      modelCosts: { 'gpt-5': 0 },
      clientModels: { codex: { 'gpt-5': 10 } },
      clientModelCosts: { codex: { 'gpt-5': 0 } },
      sessions: {}
    },
    limits: {
      providers: [{ provider: 'deepseek', status: 'ok', accountKey: 'device-side-secret' }]
    },
    limitsOnly: true
  };
}

test('Hub account API stores credentials centrally and never returns them', async () => {
  const repository = new MemoryRepository();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    adminSecret: 'admin-token',
    viewerSecret: 'viewer-token',
    ingestCredentials: { 'device-a': 'device-token' },
    accountCredentialKey: 'account-encryption-key',
    accountProbe: async (provider) => accountProbe(provider),
    accountRefreshMs: 60_000,
    repository,
    logger: { error() {}, warn() {}, info() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const unauthenticated = await requestJson(port, '/api/accounts');
    assert.equal(unauthenticated.response.status, 401);

    const added = await requestJson(port, '/api/accounts', {
      method: 'POST',
      token: 'admin-token',
      body: {
        provider: 'deepseek',
        name: 'work',
        credential: { apiKey: 'server-secret-api-key', region: 'cn', site: 'global' }
      }
    });
    assert.equal(added.response.status, 201);
    assert.equal(added.body.account.provider, 'deepseek');
    assert.equal(JSON.stringify(added.body).includes('server-secret-api-key'), false);

    const accountId = added.body.account.id;
    const envelope = repository.hubCredentials.get(accountId);
    assert.ok(envelope);
    assert.equal(JSON.stringify(envelope).includes('server-secret-api-key'), false);

    const listed = await requestJson(port, '/api/accounts', { token: 'admin-token' });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.authority, 'hub');
    assert.equal(listed.body.accounts.length, 1);
    assert.equal(JSON.stringify(listed.body).includes('server-secret-api-key'), false);
    assert.deepEqual(listed.body.accounts[0].credentialMetadata, { site: 'global', region: 'cn' });

    const owner = await requestJson(port, '/api/accounts', { token: 'admin-token' });
    assert.equal(owner.response.status, 200);
    assert.equal(owner.body.accounts.length, 1);
    assert.equal(owner.body.accounts[0].provider, 'deepseek');
    assert.equal(owner.body.accounts[0].name, 'work');
    assert.deepEqual(owner.body.accounts[0].credentialMetadata, { site: 'global', region: 'cn' });
    assert.equal(JSON.stringify(owner.body).includes('server-secret-api-key'), false);
    const viewer = await requestJson(port, '/api/accounts', { token: 'viewer-token' });
    assert.equal(viewer.response.status, 401);

    const edited = await requestJson(port, `/api/accounts/${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      token: 'admin-token',
      body: { credential: { region: 'us-east-1' }, credentialMode: 'merge' }
    });
    assert.equal(edited.response.status, 200);
    const relisted = await requestJson(port, '/api/accounts', { token: 'admin-token' });
    assert.deepEqual(relisted.body.accounts[0].credentialMetadata, { site: 'global', region: 'us-east-1' });
  } finally {
    await hub.stop();
  }
});

test('one Hub secret enables account administration and encryption', async () => {
  const repository = new MemoryRepository();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'single-hub-secret',
    accountProbe: async (provider) => accountProbe(provider),
    accountRefreshMs: 60_000,
    repository,
    logger: { error() {}, warn() {}, info() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const added = await requestJson(port, '/api/accounts', {
      method: 'POST',
      token: 'single-hub-secret',
      body: {
        provider: 'deepseek',
        name: 'single-key',
        credential: { apiKey: 'single-key-api-secret' }
      }
    });
    assert.equal(added.response.status, 201);
    assert.ok(repository.hubCredentials.get(added.body.account.id));
  } finally {
    await hub.stop();
  }
});

test('Hub drops device limits and serves centrally refreshed limits from stats', async () => {
  const repository = new MemoryRepository();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    adminSecret: 'admin-token',
    ingestCredentials: { 'device-a': 'device-token' },
    accountCredentialKey: 'account-encryption-key',
    accountProbe: async (provider) => accountProbe(provider),
    accountRefreshMs: 60_000,
    repository,
    logger: { error() {}, warn() {}, info() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const added = await requestJson(port, '/api/accounts', {
      method: 'POST',
      token: 'admin-token',
      body: { provider: 'deepseek', credential: { apiKey: 'central-key' } }
    });
    assert.equal(added.response.status, 201);

    const ingested = await requestJson(port, '/api/ingest', {
      method: 'POST',
      token: 'admin-token',
      body: usagePayload()
    });
    assert.equal(ingested.response.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(repository.devices.get('device-a'), 'limits'), false);

    const stats = await requestJson(port, '/api/stats', { token: 'admin-token' });
    assert.equal(stats.response.status, 200);
    assert.equal(stats.body.limitsAuthority, 'hub');
    assert.equal(stats.body.devices.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(stats.body.devices[0], 'limits'), false);
    assert.equal(stats.body.limits.providers.length, 1);
    assert.equal(stats.body.limits.providers[0].authority, 'hub');
    assert.equal(stats.body.limits.providers[0].accountId, added.body.account.id);
  } finally {
    await hub.stop();
  }
});

test('the accounts list advertises provider ids and one provider snapshot per account', async () => {
  const repository = new MemoryRepository();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    adminSecret: 'admin-token',
    accountCredentialKey: 'account-encryption-key',
    accountProbe: async (provider) => accountProbe(provider),
    accountRefreshMs: 60_000,
    repository,
    logger: { error() {}, warn() {}, info() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    await requestJson(port, '/api/accounts', {
      method: 'POST',
      token: 'admin-token',
      body: { provider: 'deepseek', name: 'work', credential: { apiKey: 'x' } }
    });

    const listed = await requestJson(port, '/api/accounts', { token: 'admin-token' });
    assert.equal(listed.response.status, 200);
    // `providers` is a list of provider-id *strings*, never provider objects: the
    // Android `AccountsResponseDto.providers` is `List<String>`, and a value typed
    // as an object failed to decode every /api/accounts response on the phone.
    assert.ok(Array.isArray(listed.body.providers));
    assert.ok(listed.body.providers.length > 0);
    assert.ok(listed.body.providers.every((id) => typeof id === 'string'));
    assert.ok(listed.body.providers.includes('deepseek'));
    // Each account carries a single provider snapshot, not a `{ providers: [...] }`
    // wrapper, which is why Android models `account.limits` as a `LimitProviderDto`.
    assert.equal(listed.body.accounts[0].limits.provider, 'deepseek');
    assert.equal(Array.isArray(listed.body.accounts[0].limits.providers), false);
  } finally {
    await hub.stop();
  }
});

test('Hub account API supports adding codex and antigravity accounts with explicit credentials', async () => {
  const repository = new MemoryRepository();
  let counter = 0;
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    adminSecret: 'admin-token',
    accountCredentialKey: 'account-encryption-key',
    accountProbe: async (provider) => {
      counter += 1;
      const row = accountProbe(provider);
      return {
        ...row,
        accountKey: `${provider}-${counter}`,
        accountEmail: `${provider}-${counter}@example.test`
      };
    },
    accountRefreshMs: 60_000,
    repository,
    logger: { error() {}, warn() {}, info() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const codex = await requestJson(port, '/api/accounts', {
      method: 'POST',
      token: 'admin-token',
      body: {
        provider: 'codex',
        name: 'codex-hub',
        credential: { accessToken: 'mock-chatgpt-token' }
      }
    });
    assert.equal(codex.response.status, 201);
    assert.equal(codex.body.account.provider, 'codex');

    const agy = await requestJson(port, '/api/accounts', {
      method: 'POST',
      token: 'admin-token',
      body: {
        provider: 'antigravity',
        name: 'agy-hub',
        credential: { endpoint: 'http://127.0.0.1:12345', csrfToken: 'mock-csrf' }
      }
    });
    assert.equal(agy.response.status, 201);
    assert.equal(agy.body.account.provider, 'antigravity');

    // Test OAuth start flow
    const oauthStart = await requestJson(port, '/api/accounts/oauth/start', {
      method: 'POST',
      token: 'admin-token',
      body: { provider: 'antigravity' }
    });
    assert.equal(oauthStart.response.status, 200);
    assert.equal(oauthStart.body.ok, true);
    assert.ok(oauthStart.body.sessionId);
    const oauthUrl = new URL(oauthStart.body.authUrl);
    assert.equal(oauthUrl.origin, 'https://accounts.google.com');
    assert.equal(oauthUrl.searchParams.get('redirect_uri'), 'https://antigravity.google/oauth-callback');
    assert.ok(oauthUrl.searchParams.get('state'));

    // Test OAuth exchange with direct token paste
    const oauthExchange = await requestJson(port, '/api/accounts/oauth/exchange', {
      method: 'POST',
      token: 'admin-token',
      body: {
        sessionId: oauthStart.body.sessionId,
        redirectUrl: `https://antigravity.google/oauth-callback?state=${encodeURIComponent(oauthUrl.searchParams.get('state'))}&api_key=exchanged-agy-token`,
        name: 'agy-oauth-exchanged'
      }
    });
    assert.equal(oauthExchange.response.status, 201);
    assert.equal(oauthExchange.body.ok, true);
    assert.equal(oauthExchange.body.account.name, 'agy-oauth-exchanged');
    assert.equal(oauthExchange.body.account.provider, 'antigravity');
  } finally {
    await hub.stop();
  }
});

test('Hub Antigravity OAuth add exchanges the bare code Google displays', async () => {
  const repository = new MemoryRepository();
  const tokenRequests = [];
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    adminSecret: 'admin-token',
    accountCredentialKey: 'account-encryption-key',
    accountProbe: async (provider) => accountProbe(provider),
    accountRefreshMs: 60_000,
    repository,
    oauthFetch: async (url, init) => {
      tokenRequests.push({ url, body: new URLSearchParams(String(init?.body || '')) });
      return new Response(JSON.stringify({
        access_token: 'agy-access',
        refresh_token: 'agy-refresh',
        expires_in: 3600
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    logger: { error() {}, warn() {}, info() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const start = await requestJson(port, '/api/accounts/oauth/start', {
      method: 'POST',
      token: 'admin-token',
      body: { provider: 'antigravity' }
    });
    assert.equal(start.response.status, 200);
    assert.ok(start.body.sessionId);

    // The user copies the code Google shows on the page, not a callback URL.
    const exchange = await requestJson(port, '/api/accounts/oauth/exchange', {
      method: 'POST',
      token: 'admin-token',
      body: {
        sessionId: start.body.sessionId,
        redirectUrl: '4/0AX4XfWhGoogleCode-server-example',
        name: 'agy-code-paste'
      }
    });
    assert.equal(exchange.response.status, 201);
    assert.equal(exchange.body.account.provider, 'antigravity');
    assert.equal(exchange.body.account.name, 'agy-code-paste');
    assert.equal(JSON.stringify(exchange.body).includes('agy-refresh'), false);

    assert.equal(tokenRequests.length, 1);
    assert.equal(tokenRequests[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(tokenRequests[0].body.get('grant_type'), 'authorization_code');
    assert.equal(tokenRequests[0].body.get('code'), '4/0AX4XfWhGoogleCode-server-example');
    assert.ok(tokenRequests[0].body.get('client_secret'));
  } finally {
    await hub.stop();
  }
});
