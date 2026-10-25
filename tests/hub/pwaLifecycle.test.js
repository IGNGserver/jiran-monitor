'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const template = fs.readFileSync(path.resolve(__dirname, '../../src/hub/web/sw.js'), 'utf8');

function worker({ failInstall = false, windows = [{ url: 'https://hub.example/usage' }] } = {}) {
  const handlers = {};
  const deleted = [];
  let route;
  let activateRequests = 0;
  let claimed = 0;
  class PrecacheController {
    addToCacheList() {}
    async install() { if (failInstall) throw new Error('missing graph asset'); }
    async activate() {}
    async matchPrecache(key) { return key === '/index.html' ? new Response('cached shell') : undefined; }
  }
  const context = {
    self: { location: { origin: 'https://hub.example' }, __WB_MANIFEST: [{ url: '/index.html', revision: 'test' }],
      addEventListener: (name, handler) => { handlers[name] = handler; },
      skipWaiting: async () => { activateRequests++; }, clients: { claim: async () => { claimed++; }, matchAll: async () => windows } },
    caches: { open: async () => ({ match: async () => new Response('previous graph') }),
      keys: async () => ['other-app', 'jiran-web-oldest', 'jiran-web-old', 'jiran-web-test'], delete: async (key) => deleted.push(key) },
    PrecacheController, registerRoute: (match, handle) => { route = { match, handle }; },
    URL, Response, Request, Headers, Promise,
    fetch: async () => { assert.fail('cached shell must not wait for network'); }
  };
  vm.runInNewContext(template.replace(/^import .*;$/gm, '').replace("'jiran-web-development'", "'jiran-web-test'"), context);
  const request = (url, options = {}) => ({ url, method: 'GET', headers: new Headers(), mode: 'cors', ...options });
  const args = (req) => ({ request: req, url: new URL(req.url), sameOrigin: new URL(req.url).origin === 'https://hub.example' });
  return { handlers, deleted, route, request, args, activateRequests: () => activateRequests, claimed: () => claimed };
}

test('offline deep links immediately use the complete cached shell', async () => {
  const w = worker();
  const args = w.args(w.request('https://hub.example/usage?tab=sessions', { mode: 'navigate' }));
  assert.equal(w.route.match(args), true);
  assert.equal(await (await w.route.handle(args)).text(), 'cached shell');
});

test('API/authenticated/cross-origin requests never enter the worker route', () => {
  const w = worker();
  for (const req of [
    w.request('https://hub.example/api'), w.request('https://hub.example/api/stats'),
    w.request('https://another.example/index.html'),
    w.request('https://hub.example/index.html', { headers: new Headers({ Authorization: 'Bearer private' }) }),
    w.request('https://hub.example/index.html', { method: 'POST' })
  ]) assert.equal(w.route.match(w.args(req)), false);
});

test('old hashed assets survive a user-approved update', async () => {
  const w = worker();
  const args = w.args(w.request('https://hub.example/assets/app-ABCDEFGH.js'));
  assert.equal(w.route.match(args), true);
  assert.equal(await (await w.route.handle(args)).text(), 'previous graph');
  let done;
  w.handlers.activate({ waitUntil: (value) => { done = value; } });
  await done;
  assert.deepEqual(w.deleted, [], 'every prior graph remains available while a window is open');
  assert.equal(w.claimed(), 1);
});

test('install never forces takeover; only the explicit update message activates a waiting worker', async () => {
  const w = worker();
  let done;
  w.handlers.install({ waitUntil: (value) => { done = value; } });
  await done;
  assert.equal(w.activateRequests(), 0);
  w.handlers.message({ data: { type: 'unrelated' } });
  assert.equal(w.activateRequests(), 0);
  w.handlers.message({ data: { type: 'ACTIVATE_UPDATE' } });
  assert.equal(w.activateRequests(), 1);
});

test('a failed candidate removes only its partial cache and leaves complete versions available', async () => {
  const w = worker({ failInstall: true });
  let done;
  w.handlers.install({ waitUntil: (value) => { done = value; } });
  await assert.rejects(done, /missing graph asset/);
  assert.deepEqual(w.deleted, ['jiran-web-test']);
  assert.equal(w.activateRequests(), 0);
});

test('successive updates retain every earlier graph while application windows remain open', async () => {
  for (const windows of [[{ url: 'https://hub.example/oldest' }], [{ url: 'https://hub.example/oldest' }, { url: 'https://hub.example/latest' }]]) {
    const w = worker({ windows });
    let done;
    w.handlers.activate({ waitUntil: (value) => { done = value; } });
    await done;
    assert.deepEqual(w.deleted, []);
    assert.equal(w.claimed(), 1);
  }
});

test('natural activation with no windows retires every obsolete application graph only', async () => {
  const w = worker({ windows: [] });
  let done;
  w.handlers.activate({ waitUntil: (value) => { done = value; } });
  await done;
  assert.deepEqual(w.deleted, ['jiran-web-oldest', 'jiran-web-old']);
  assert.equal(w.claimed(), 1);
});
