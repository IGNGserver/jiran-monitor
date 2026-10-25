'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeRequestPath,
  resolveWebFile,
  resolveStaticAsset,
  tryServeStatic,
  DEFAULT_WEB_ROOT,
  SHARED_UI_ROOT
} = require('../../src/hub/static');
const { createHub } = require('../../src/hub/server');
const { MemoryRepository } = require('./memory-repository');

test('normalizeRequestPath blocks traversal and keeps root', () => {
  assert.equal(normalizeRequestPath('/'), '/');
  assert.equal(normalizeRequestPath('/css/app.css'), '/css/app.css');
  assert.equal(normalizeRequestPath('/../secret'), null);
  assert.equal(normalizeRequestPath('/foo/../../etc/passwd'), null);
});

test('resolveWebFile stays inside the web root', () => {
  const file = resolveWebFile(DEFAULT_WEB_ROOT, '/index.html');
  assert.equal(file, path.join(DEFAULT_WEB_ROOT, 'index.html'));
  assert.equal(resolveWebFile(DEFAULT_WEB_ROOT, '/../server.js'), null);
});

test('resolveStaticAsset serves the SPA shell and real assets', async () => {
  const index = await resolveStaticAsset(DEFAULT_WEB_ROOT, '/');
  assert.ok(index);
  assert.equal(path.basename(index.filePath), 'index.html');

  const css = await resolveStaticAsset(SHARED_UI_ROOT, '/styles/app.css');
  assert.ok(css);
  assert.equal(path.basename(css.filePath), 'app.css');

  const spa = await resolveStaticAsset(DEFAULT_WEB_ROOT, '/devices');
  assert.ok(spa);
  assert.equal(path.basename(spa.filePath), 'index.html');

  const toolRoute = await resolveStaticAsset(DEFAULT_WEB_ROOT, '/tool');
  assert.ok(toolRoute);
  assert.equal(path.basename(toolRoute.filePath), 'index.html');

  const trendsRoute = await resolveStaticAsset(DEFAULT_WEB_ROOT, '/trends');
  assert.ok(trendsRoute);
  assert.equal(path.basename(trendsRoute.filePath), 'index.html');
  for (const route of [
    '/usage', '/management', '/settings',
    '/home', '/tool', '/tools', '/model', '/models', '/project', '/projects',
    '/session', '/sessions', '/device', '/status', '/subscriptions', '/pricing'
  ]) {
    const resolved = await resolveStaticAsset(DEFAULT_WEB_ROOT, route);
    assert.ok(resolved, `expected SPA route ${route}`);
    assert.equal(path.basename(resolved.filePath), 'index.html');
  }
});

test('hub serves the web UI on the same port without a secret', async () => {
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    repository: new MemoryRepository(),
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const base = `http://127.0.0.1:${port}`;

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') || '', /text\/html/);
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
    assert.match(home.headers.get('permissions-policy') || '', /camera=\(\)/);
    const html = await home.text();
    assert.match(html, /Jiran/);
    assert.match(html, /manifest\.webmanifest/);
    assert.match(html, /apple-touch-icon-180\.png/);

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') || '', /manifest|json/);
    const body = await manifest.json();
    assert.equal(body.name, 'Jiran');
    assert.equal(body.display, 'standalone');

    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type') || '', /javascript/);
    const swSource = await sw.text();
    assert.match(swSource, /jiran-web-(?:development|[a-f0-9]{20})/);
    assert.match(swSource, /\/api\//); // API bypass behavior is exercised in pwaLifecycle.test.js.
    assert.match(swSource, /ACTIVATE_UPDATE/, 'activation is an explicit user action');
    // Built-graph reachability is tested against esbuild's manifest in web-build;
    // source development intentionally has no offline module precache promise.

    // Safari only uses opaque, full-bleed icons for Home Screen / Dock web
    // apps. The 1024px pair is the high-resolution source macOS reads; the
    // 180/167/152 files back the apple-touch-icon links.
    const iconFiles = [
      ['/icons/icon-1024.png', 1024],
      ['/icons/icon-1024-maskable.png', 1024],
      ['/icons/icon-512.png', 512],
      ['/icons/icon-512-maskable.png', 512],
      ['/icons/icon-192.png', 192],
      ['/icons/icon-192-maskable.png', 192],
      ['/icons/apple-touch-icon-180.png', 180],
      ['/icons/apple-touch-icon-167.png', 167],
      ['/icons/apple-touch-icon-152.png', 152]
    ];
    for (const [iconPath, size] of iconFiles) {
      const icon = await fetch(`${base}${iconPath}`);
      assert.equal(icon.status, 200, iconPath);
      assert.match(icon.headers.get('content-type') || '', /image\/png/, iconPath);
      const bytes = Buffer.from(await icon.arrayBuffer());
      assert.equal(bytes.toString('ascii', 1, 4), 'PNG', iconPath);
      assert.equal(bytes.readUInt32BE(16), size, `${iconPath} width`);
      assert.equal(bytes.readUInt32BE(20), size, `${iconPath} height`);
      assert.equal(bytes[25], 2, `${iconPath} must be opaque RGB without an alpha channel`);
    }

    // The UI is served from the shared package; the shell keeps its own boot
    // module and the client icons keep their historical public path.
    const css = await fetch(`${base}/ui/styles/app.css`);
    assert.equal(css.status, 200);
    assert.ok((await css.text()).length > 0);

    const appJs = await fetch(`${base}/ui/app.js`);
    assert.equal(appJs.status, 200);
    assert.equal(appJs.headers.get('cache-control'), 'no-cache');
    const appSource = await appJs.text();
    assert.match(appSource, /openStatsStream|serviceWorker/);
    assert.match(appSource, /function openNav\(/);
    assert.match(appSource, /menuToggle/);

    const bootJs = await fetch(`${base}/js/boot.js`);
    assert.equal(bootJs.status, 200);
    assert.equal(bootJs.headers.get('cache-control'), 'no-cache');
    assert.match(await bootJs.text(), /configureTransport/);

    const clientIcon = await fetch(`${base}/icons/clients/claude.svg`);
    assert.equal(clientIcon.status, 200);
    assert.match(clientIcon.headers.get('content-type') || '', /svg/);

    const manifestBody = body;
    assert.equal(manifestBody.display, 'standalone');
    assert.ok(Array.isArray(manifestBody.icons));
    assert.ok(manifestBody.icons.some((icon) => String(icon.purpose || '').includes('maskable')));
    assert.ok(manifestBody.icons.some((icon) => String(icon.purpose || '').includes('any')));
    // macOS Safari requires a 1024px opaque full-bleed icon for Add to Dock;
    // 512 alone makes it fall back to the generated monogram.
    assert.ok(manifestBody.icons.some((icon) => icon.sizes === '1024x1024' && icon.purpose === 'any'));
    assert.ok(manifestBody.icons.some((icon) => icon.sizes === '1024x1024' && icon.purpose === 'maskable'));
    assert.ok(manifestBody.icons.some((icon) => icon.sizes === '180x180' && icon.src.includes('apple-touch-icon-180')));

    // API routes remain JSON and still work beside the UI.
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.secretRequired, false);
  } finally {
    await hub.stop();
  }
});

test('hub web UI stays reachable when a secret protects the API', async () => {
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'web-ui-secret',
    repository: new MemoryRepository(),
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const base = `http://127.0.0.1:${port}`;

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /authGate|Connect to hub|Jiran/);

    const denied = await fetch(`${base}/api/stats`);
    assert.equal(denied.status, 401);
    await denied.text();

    const allowed = await fetch(`${base}/api/stats`, {
      headers: { authorization: 'Bearer web-ui-secret' }
    });
    assert.equal(allowed.status, 200);
    await allowed.text();
  } finally {
    await hub.stop();
  }
});

test('hub web management APIs expose subscription concurrency and pricing contracts', async () => {
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    adminSecret: 'management-secret',
    repository: new MemoryRepository(),
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const base = `http://127.0.0.1:${port}`;
    const headers = {
      authorization: 'Bearer management-secret',
      'content-type': 'application/json'
    };
    const initial = await (await fetch(`${base}/api/subscriptions`, { headers })).json();
    const saved = await fetch(`${base}/api/subscriptions`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        baseUpdatedAt: initial.updatedAt,
        subscriptions: [{ provider: 'codex', kind: 'subscription', amountMinor: 2000, currency: 'USD', startDate: '2026-08-01' }]
      })
    });
    assert.equal(saved.status, 200);
    const stored = await saved.json();
    assert.equal(stored.subscriptions.length, 1);

    const stale = await fetch(`${base}/api/subscriptions`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ baseUpdatedAt: initial.updatedAt, subscriptions: [] })
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'stale_write');

    const pricing = await fetch(`${base}/api/pricing/gpt-5`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ inputPricePerMillion: 1, outputPricePerMillion: 2, cacheReadPricePerMillion: 0, cacheWritePricePerMillion: 0 })
    });
    assert.equal(pricing.status, 200);
    const listed = await (await fetch(`${base}/api/pricing`, { headers })).json();
    assert.equal(listed.pricing[0].model, 'gpt-5');

    const stats = await (await fetch(`${base}/api/stats`, { headers })).json();
    assert.equal(typeof stats.historyRevision, 'string');
    assert.equal(typeof stats.deviceHistoryRevision, 'string');
    assert.equal(typeof stats.subscriptionsUpdatedAt, 'string');

    const accounts = await (await fetch(`${base}/api/accounts`, { headers })).json();
    assert.equal(accounts.ok, true);
    assert.equal(Array.isArray(accounts.accounts), true);
    assert.equal(Array.isArray(accounts.providers), true);
  } finally {
    await hub.stop();
  }
});

test('Hub routes use one owner credential for reads, writes, and ingest', async () => {
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    adminSecret: 'admin-token',
    viewerSecret: 'viewer-token',
    ingestCredentials: { 'device-a': 'device-token' },
    repository: new MemoryRepository(),
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  try {
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    const auth = (token) => ({ authorization: `Bearer ${token}` });
    const capabilities = await (await fetch(`${base}/api/capabilities`, { headers: auth('admin-token') })).json();
    assert.equal(capabilities.authenticated, true);
    assert.equal((await fetch(`${base}/api/stats`, { headers: auth('admin-token') })).status, 200);
    assert.equal((await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { ...auth('admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-a', today: { totalTokens: 1 }, month: { totalTokens: 1 }, allTime: { totalTokens: 1 } })
    })).status, 200);
    assert.equal((await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { ...auth('admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-b' })
    })).status, 200);
    assert.equal((await fetch(`${base}/api/devices/device-a`, { method: 'DELETE', headers: auth('admin-token') })).status, 200);
  } finally {
    await hub.stop();
  }
});

test('Hub rate-limits repeated auth failures and ingest bursts by principal', async () => {
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    adminSecret: 'owner-token',
    authFailureLimit: 1,
    ingestRateLimit: 1,
    repository: new MemoryRepository(),
    logger: { error() {}, warn() {}, info() {} }
  });
  await hub.start();
  try {
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    const wrong = { authorization: 'Bearer wrong' };
    assert.equal((await fetch(`${base}/api/stats`, { headers: wrong })).status, 401);
    const limited = await fetch(`${base}/api/stats`, { headers: wrong });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    const options = {
      method: 'POST',
      headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-a', today: { totalTokens: 1 }, month: { totalTokens: 1 }, allTime: { totalTokens: 1 } })
    };
    assert.equal((await fetch(`${base}/api/ingest`, options)).status, 200);
    assert.equal((await fetch(`${base}/api/ingest`, options)).status, 429);
  } finally {
    await hub.stop();
  }
});

test('tryServeStatic refuses non-GET methods and API paths', async () => {
  const fakeRes = {
    writeHead() {},
    end() {}
  };
  assert.equal(await tryServeStatic({ method: 'POST', url: '/' }, fakeRes), false);
  assert.equal(await tryServeStatic({ method: 'GET', url: '/api/stats' }, fakeRes), false);
  assert.equal(fs.existsSync(path.join(DEFAULT_WEB_ROOT, 'index.html')), true);
});
