'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/shared-ui/app.js'), 'utf8');

function bootContext(prefs = {}, desktop = false) {
  const requests = [];
  const context = {
    state: { prefs: { view: 'overview', ...prefs }, health: {} },
    markLoadingStage() {}, showAuth() {}, render() {}, connectStream() {},
    refreshStats: async () => { requests.push('stats'); },
    fetchJson: async (path) => { requests.push(path); return { authenticated: true, capabilities: {} }; },
    managementSections: () => desktop ? [] : ['accounts', 'consumption'],
    ensureHistory: async () => requests.push('history'),
    loadAccounts: async () => requests.push('accounts'),
    loadSubscriptions: async () => requests.push('subscriptions'),
    loadPricing: async () => requests.push('pricing'),
    isCapable: () => desktop, saveSecret: async () => {}, testSecret: async () => ({}),
    els: { authError: { classList: { add() {}, remove() {} } }, secretInput: {}, settingsSecret: {} }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function bootstrapAuthorized()'), source.indexOf('async function deleteDevice(')), context);
  return { context, requests };
}

test('authorization downloads one stats document and does not prefetch management data', async () => {
  const { context, requests } = bootContext();
  assert.equal(await context.tryConnect('saved-secret'), true);
  assert.deepEqual(requests, ['/api/capabilities', 'stats', 'history']);
});

test('boot loads only the selected management document and no invisible desktop ledger', async () => {
  const web = bootContext({ view: 'settings', managementSection: 'consumption', managementTab: 'pricing' });
  await web.context.bootstrapAuthorized();
  assert.deepEqual(web.requests, ['stats', 'pricing']);
  const desktop = bootContext({ view: 'settings', managementSection: 'accounts' }, true);
  await desktop.context.bootstrapAuthorized();
  assert.deepEqual(desktop.requests, ['stats']);
});
