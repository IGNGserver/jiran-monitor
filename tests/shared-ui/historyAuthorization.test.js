'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.resolve(__dirname, '../../src/shared-ui/app.js'), 'utf8');
const source = app.slice(app.indexOf('async function ensureHistory('), app.indexOf('function applyStatsSnapshot('));

function contextFor(auth = {}, failure = null) {
  const requests = [];
  const authPrompts = [];
  const state = { prefs: {}, health: { secretRequired: true }, secret: '', session: null, authorization: null,
    historyRequestSequence: 0, ...auth };
  const context = vm.createContext({
    state, showAuth: (visible) => authPrompts.push(visible),
    fetchJson: async (path, options) => {
      requests.push({ path, secret: options.secret });
      if (failure) throw failure;
      return { daily: [] };
    }
  });
  vm.runInContext(source, context);
  return { context, state, requests, authPrompts };
}

test('history reads accept authorized cookie sessions without a renderer owner secret', async () => {
  for (const auth of [{ session: { id: 'cookie-session' } }, { authorization: { authenticated: true } }]) {
    const { context, state, requests } = contextFor(auth);
    await context.ensureHistory({ deviceId: 'a/b' });
    assert.deepEqual(requests, [{ path: '/api/history?deviceId=a%2Fb', secret: '' }]);
    assert.equal(state.history.daily.length, 0);
    await context.ensureHistory({ deviceId: 'a/b' });
    assert.equal(requests.length, 1);
  }
});

test('history reads still gate anonymous clients and accept legacy/public Hubs', async () => {
  for (const auth of [{}, { session: {}, authorization: { authenticated: false } }]) {
    const anonymous = contextFor(auth);
    await anonymous.context.ensureHistory();
    assert.equal(anonymous.requests.length, 0);
  }
  for (const auth of [{ secret: 'legacy-owner' }, { health: { secretRequired: false } }]) {
    const { context, requests } = contextFor(auth);
    await context.ensureHistory();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/history');
  }
});

test('revoked cookie session shows auth rather than treating an empty secret as logged out', async () => {
  const failure = Object.assign(new Error('unauthorized'), { status: 401 });
  const { context, state, requests, authPrompts } = contextFor({ session: { id: 'revoked' } }, failure);
  await context.ensureHistory();
  assert.equal(requests.length, 1);
  assert.deepEqual(authPrompts, [true]);
  assert.equal(state.historyError, failure);
  assert.equal(state.historyLoading, false);
});
