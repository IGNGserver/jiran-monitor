'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/shared-ui/app.js'), 'utf8');

test('fallback REST reads deduplicate and cannot overwrite a newer stream frame', async () => {
  let finish;
  let calls = 0;
  let applied = 0;
  const context = {
    state: { secret: 'test', authorization: { capabilities: { statsSummary: true } } },
    fetchJson: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
    isCapable: () => false,
    applyStatsSnapshot: () => { applied++; }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function refreshStats()'), source.indexOf('function connectStream()')), context);
  const first = context.refreshStats();
  const second = context.refreshStats();
  assert.equal(calls, 1);
  context.state.statsFrameVersion = 1;
  finish({ devices: [] });
  await Promise.all([first, second]);
  assert.equal(applied, 0);
  assert.equal(context.state.statsRequest, null);
  const next = context.refreshStats();
  finish({ devices: [] });
  await next;
  assert.equal(applied, 1);
});
