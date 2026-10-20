'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const template = fs.readFileSync(path.resolve(__dirname, '../../src/hub/web/sw.js'), 'utf8');

function worker() {
  const handlers = {};
  const deleted = [];
  let networkCalls = 0;
  const context = {
    self: { location: { origin: 'https://hub.example' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { open: async () => ({ match: async () => new Response('cached shell'), addAll: async () => {} }),
      keys: async () => ['other-app', 'jiran-web-old', 'jiran-web-test'], delete: async (key) => deleted.push(key) },
    URL, Response, Request, AbortSignal, Promise,
    fetch: async () => { networkCalls++; throw new Error('network must not delay cached navigation'); }
  };
  vm.runInNewContext(template.replace("'jiran-web-development'", "'jiran-web-test'")
    .replace('/* generated-precache */ []', '["/index.html", "/assets/app-ABCDEFGH.js"]'), context);
  return { handlers, deleted, networkCalls: () => networkCalls };
}

test('installed navigation is immediately cache-first even for a deep link', async () => {
  const w = worker();
  let response;
  w.handlers.fetch({ request: { method: 'GET', url: 'https://hub.example/usage?tab=sessions', mode: 'navigate' }, respondWith: (value) => { response = value; } });
  assert.equal(await (await response).text(), 'cached shell');
  assert.equal(w.networkCalls(), 0);
});

test('worker never intercepts API/authenticated documents or another origin', () => {
  const w = worker();
  for (const url of ['https://hub.example/api/stats', 'https://hub.example/api/accounts', 'https://another.example/index.html']) {
    w.handlers.fetch({ request: { method: 'GET', url, mode: 'cors' }, respondWith() { assert.fail('unsafe cache interception'); } });
  }
});

test('activation only retires this application caches; updates do not force takeover', async () => {
  const w = worker();
  let done;
  w.handlers.activate({ waitUntil: (value) => { done = value; } });
  await done;
  assert.deepEqual(w.deleted, ['jiran-web-old']);
  assert.ok(!/self\.(skipWaiting|clients\.claim)\(/.test(template));
});
