'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../../src/shared-ui/core/stagedStats.js')));

test('summary uses explicit device/session details; a full/old Hub never needs hydration', async () => {
  const { detailRequest, withStatsDetail } = await load();
  const stats = { detail: 'summary', updatedAt: 'one', devices: [{ deviceId: 'a/b' }], periods: { today: { totalTokens: 100 } } };
  assert.equal(detailRequest(stats, { view: 'overview' }), null);
  assert.equal(detailRequest({ ...stats, detail: undefined }, { view: 'devices' }), null);
  const device = detailRequest(stats, { view: 'devices' });
  assert.equal(device.path, '/api/devices/a%2Fb');
  const sessions = detailRequest(stats, { view: 'usage', usageTab: 'sessions', period: 'today' });
  assert.equal(sessions.path, '/api/sessions?period=today');
  const hydrated = withStatsDetail(stats, sessions, { sessions: [{ id: 's', totalTokens: 3 }] });
  assert.equal(hydrated.periods.today.totalTokens, 100);
  assert.equal(hydrated.periods.today.sessions.s.totalTokens, 3);
  assert.notEqual(sessions.key, detailRequest({ ...stats, updatedAt: 'two' }, { view: 'usage', usageTab: 'sessions' }).key);
});

test('detail reads deduplicate, isolate revisions, bound memory and cancel on logout', async () => {
  const { createDetailCache } = await load();
  let finish;
  let calls = 0;
  let signal;
  const cache = createDetailCache((_path, options) => {
    calls++;
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  const spec = { key: 'one', path: '/api/devices/a' };
  const first = cache.load(spec);
  assert.equal(cache.load(spec), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(cache.get({ key: 'two' }), undefined);
  cache.clear();
  assert.equal(signal.aborted, true);
  finish({ device: {} });
  await first;
  assert.equal(cache.get(spec), undefined);
});
