'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayRatesCache } = require('../../src/hub/displayRates');

test('cold rates return immediately and concurrent reads share a background refresh', async () => {
  let finish;
  let calls = 0;
  const cache = createDisplayRatesCache({ now: () => Date.UTC(2026, 9, 20), fetchImpl: () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  } });
  assert.equal(cache.get().source, 'built-in');
  cache.get();
  assert.equal(calls, 1);
  finish(new Response(JSON.stringify({ date: '2026-10-20', usd: { cny: 7, twd: 30, hkd: 8 } })));
  await cache.refresh();
  assert.equal(cache.get().rates.CNY, 7);
  cache.get();
  assert.equal(calls, 1, 'pass the whole cache document to the freshness check');
});

test('failed background refresh backs off without deleting last good rates', async () => {
  let now = Date.UTC(2026, 9, 20);
  let fail = false;
  let calls = 0;
  const cache = createDisplayRatesCache({ now: () => now, retryMs: 1000, logger: { warn() {} }, fetchImpl: async () => {
    calls++;
    if (fail) throw new Error('offline');
    return new Response(JSON.stringify({ date: '2026-10-20', usd: { cny: 7, twd: 30, hkd: 8 } }));
  } });
  await cache.refresh();
  now += 25 * 60 * 60 * 1000;
  fail = true;
  await cache.refresh();
  const afterFailure = calls;
  assert.equal(cache.get().rates.CNY, 7);
  assert.equal(calls, afterFailure);
  now += 1001;
  await cache.refresh();
  assert.ok(calls > afterFailure);
});
