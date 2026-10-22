'use strict';

// The IPC transport is the desktop half of the shared UI's host seam. Its job is
// to look exactly like the Hub's HTTP transport from the view layer's point of
// view, so these tests focus on the places where that could silently diverge:
// error shape, credential redaction, and the prefs key mapping that keeps an
// existing settings.json working.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createIpcTransport } = require('../../src/shared-ui/transport/ipcTransport.js');

function bridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    request: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, data: { path } };
    },
    getSettings: async () => ({}),
    updateSettings: async (patch) => {
      calls.push({ update: patch });
      return patch;
    },
    hasSecret: () => false,
    validateSecret: async () => ({ ok: true, data: { scopes: ['read'] } }),
    readFlag: () => null,
    writeFlag: () => true,
    openExternal: async () => ({ ok: true }),
    copyText: async () => true,
    confirm: async () => true,
    prompt: async () => ({ unsupported: true }),
    onStatsPush: () => () => {},
    ...overrides
  };
}

test('a successful request resolves to the data, not the envelope', async () => {
  const transport = createIpcTransport(bridge());
  assert.deepEqual(await transport.request('/api/stats'), { path: '/api/stats' });
});

test('a failed request rejects with status and payload preserved', async () => {
  const transport = createIpcTransport(bridge({
    request: async () => ({
      ok: false,
      error: { message: 'stale_write', code: 'stale_write', status: 409, payload: { current: {} } }
    })
  }));
  await assert.rejects(
    () => transport.request('/api/subscriptions', { method: 'PUT' }),
    (error) => {
      // The shared UI branches on these exact fields for 401 re-auth and the 409
      // subscription conflict banner.
      assert.equal(error.status, 409);
      assert.equal(error.code, 'stale_write');
      assert.deepEqual(error.payload, { current: {} });
      return true;
    }
  );
});

test('the secret is never exposed to the renderer', async () => {
  const configured = createIpcTransport(bridge({ hasSecret: async () => true }));
  const sentinel = await configured.secret.load();
  assert.equal(sentinel, '__configured__');
  assert.equal(await configured.secret.isRemembered(), true);

  const empty = createIpcTransport(bridge({ hasSecret: async () => false }));
  assert.equal(await empty.secret.load(), '');
  assert.equal(await empty.secret.isRemembered(), false);
});

test('saving a secret on an old preload writes through settings rather than a browser store', async () => {
  const b = bridge();
  const transport = createIpcTransport(b);
  await transport.secret.save('s3cret', true);
  const write = b.calls.find((c) => c.update);
  assert.deepEqual(write.update, { secret: 's3cret' });
});

test('saving a secret exchanges it for a device session through the dedicated bridge', async () => {
  let connected = '';
  const b = bridge({
    connectHub: async (secret) => {
      connected = secret;
      return { ok: true, data: { legacy: false, session: { id: 'session-1' } } };
    }
  });
  const transport = createIpcTransport(b);
  const result = await transport.secret.save('s3cret', true);
  assert.equal(connected, 's3cret');
  assert.equal(result.legacy, false);
  assert.equal(b.calls.some((call) => call.update), false, 'the owner secret must not be written as a setting');
});

test('clearing the desktop credential revokes through the session bridge', async () => {
  let loggedOut = 0;
  const b = bridge({
    logoutHub: async () => {
      loggedOut += 1;
      return { ok: true, data: { ok: true } };
    }
  });
  const transport = createIpcTransport(b);
  await transport.secret.clear();
  assert.equal(loggedOut, 1);
  assert.equal(b.calls.some((call) => call.update), false);
});

test('new secrets use a dedicated validation bridge while normal requests stay secret-free', async () => {
  let validatedSecret = '';
  const b = bridge({
    validateSecret: async (secret) => {
      validatedSecret = secret;
      return { ok: true, data: { accepted: secret } };
    }
  });
  const transport = createIpcTransport(b);
  assert.deepEqual(await transport.secret.test('s3cret'), { accepted: 's3cret' });
  assert.equal(validatedSecret, 's3cret');
  await transport.request('/api/stats', { secret: 's3cret' });
  assert.equal(b.calls.at(-1).options.secret, undefined, 'normal IPC requests must not carry the secret');
});

test('dedicated secret validation preserves Hub auth errors', async () => {
  const transport = createIpcTransport(bridge({
    validateSecret: async () => ({ ok: false, error: { status: 401, code: 'unauthorized', message: 'bad secret' } })
  }));
  await assert.rejects(
    () => transport.secret.test('wrong'),
    (error) => error.status === 401 && error.code === 'unauthorized'
  );
});

test('health degrades to a harmless shape when the probe fails', async () => {
  const transport = createIpcTransport(bridge({
    request: async () => ({ ok: false, error: { message: 'no hub' } })
  }));
  // A failed health probe must never block boot.
  assert.deepEqual(await transport.health(), { ok: false, secretRequired: false, capabilities: {} });
});

test('the stream bridge forwards stats frames and reports live status', async () => {
  let push = null;
  const transport = createIpcTransport(bridge({
    onStatsPush: (callback) => { push = callback; return () => {}; }
  }));
  const seen = [];
  const statuses = [];
  const dispose = transport.openStream({
    onStats: (stats, type) => seen.push({ stats, type }),
    onStatus: (status) => statuses.push(status)
  });
  push({ event: 'stats', data: { type: 'stats', stats: { devices: [] }, at: 'now' } });
  // Non-stats events (status pushes) must not be mistaken for data frames.
  push({ event: 'status', data: { connected: true } });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].stats, { devices: [] });
  assert.equal(statuses[0], 'live');
  dispose();
});

test('a sync-health push is unwrapped to the channel record, not the envelope', () => {
  let push = null;
  const transport = createIpcTransport(bridge({
    onStatsPush: (callback) => { push = callback; return () => {}; }
  }));
  const health = [];
  transport.openStream({ onHealth: (record) => health.push(record) });
  // This is the exact envelope main.js emits; the per-channel records must
  // reach the renderer, otherwise every row in the desktop sync panel renders
  // as "unknown".
  push({
    event: 'sync-health',
    data: {
      health: {
        mode: 'client',
        local: { state: 'ok' },
        upload: { state: 'waiting' },
        rest: { state: 'ok' },
        stream: { state: 'live' }
      }
    }
  });
  assert.equal(health.length, 1);
  assert.equal(health[0].local.state, 'ok');
  assert.equal(health[0].upload.state, 'waiting');
  assert.equal(health[0].stream.state, 'live');
});

test('a stats frame forwards only its snapshot to onHealth', () => {
  let push = null;
  const transport = createIpcTransport(bridge({
    onStatsPush: (callback) => { push = callback; return () => {}; }
  }));
  const health = [];
  transport.openStream({ onHealth: (record) => health.push(record) });
  push({ event: 'stats', data: { type: 'stats', stats: { devices: [] }, snapshot: { source: 'local' } } });
  assert.deepEqual(health, [{ snapshot: { source: 'local' } }]);
});

test('routing is hash-based because file:// has no SPA fallback', () => {
  const transport = createIpcTransport(bridge());
  assert.equal(transport.capabilities.routing, 'hash');
  assert.equal(transport.capabilities.pwa, false);
  assert.equal(transport.buildRouteUrl('usage', { tab: 'models' }), '#/usage?tab=models');
  assert.equal(transport.buildRouteUrl('overview', {}), '#/');
});

test('an unsupported native prompt rejects so the UI can use its own field', async () => {
  const transport = createIpcTransport(bridge());
  await assert.rejects(
    () => transport.prompt('Rename device', 'old'),
    (error) => error.code === 'prompt_unsupported'
  );
});
