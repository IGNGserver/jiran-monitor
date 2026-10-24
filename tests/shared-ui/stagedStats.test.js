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

test('device revision ignores account/other-device updates and refreshes only its own document', async () => {
  const { detailRequest, createDetailCache } = await load();
  const prefs = { view: 'devices', selectedDeviceId: 'a' };
  const base = { detail: 'summary', updatedAt: 'one', historyRevision: 1, deviceHistoryRevision: 1,
    devices: [{ deviceId: 'a', detailRevision: 'a-v1', stale: false }, { deviceId: 'b', detailRevision: 'b-v1' }] };
  let calls = 0;
  const cache = createDetailCache(async () => { calls++; return { device: { deviceId: 'a', periods: {} } }; });
  const spec = detailRequest(base, prefs);
  await cache.load(spec);
  const unrelated = { ...base, updatedAt: 'two', historyRevision: 2, deviceHistoryRevision: 2,
    limits: { updatedAt: 'new-account-data' }, devices: [base.devices[0], { deviceId: 'b', detailRevision: 'b-v2' }] };
  assert.equal(detailRequest(unrelated, prefs).key, spec.key);
  await cache.load(detailRequest(unrelated, prefs));
  assert.equal(calls, 1);
  const changed = { ...unrelated, devices: [{ ...base.devices[0], detailRevision: 'a-v2' }, unrelated.devices[1]] };
  assert.notEqual(detailRequest(changed, prefs).key, spec.key);
  await cache.load(detailRequest(changed, prefs));
  assert.equal(calls, 2);
  const stale = { ...changed, devices: [{ ...changed.devices[0], stale: true }, changed.devices[1]] };
  await cache.load(detailRequest(stale, prefs));
  assert.equal(calls, 3);
  assert.notEqual(detailRequest(base, { ...prefs, selectedDeviceId: 'b' }).key, spec.key);
  assert.equal(detailRequest(base, { view: 'usage', deviceFilter: 'a' }).key, spec.key);
});

test('cached device detail retains breakdowns while the latest summary owns heartbeat and presence fields', async () => {
  const { detailRequest, createDetailCache, withStatsDetail } = await load();
  const prefs = { view: 'devices', selectedDeviceId: 'a', period: 'today' };
  const detail = { deviceId: 'a', detailRevision: 'a-v1', stale: false, ageMs: 30000,
    updatedAt: '2026-10-24T10:00:00Z', receivedAt: '2026-10-24T10:00:00Z',
    periods: { today: { totalTokens: 100, clients: { codex: 100 }, sessions: { s: { totalTokens: 100 } } } } };
  const before = structuredClone(detail);
  const other = { deviceId: 'b', detailRevision: 'b-v1', periods: {} };
  const initial = { detail: 'summary', devices: [detail, other] };
  let calls = 0;
  const cache = createDetailCache(async () => { calls++; return { device: detail }; });
  await cache.load(detailRequest(initial, prefs));
  const latestDevice = { ...detail, ageMs: 0,
    updatedAt: '2026-10-24T10:05:00Z', receivedAt: '2026-10-24T10:05:00Z',
    periods: { today: { totalTokens: 100 } } };
  const latest = { ...initial, devices: [latestDevice, other] };
  const spec = detailRequest(latest, prefs);
  assert.equal(spec.key, detailRequest(initial, prefs).key, 'a heartbeat must reuse the detail cache');
  await cache.load(spec);
  assert.equal(calls, 1);
  const hydrated = withStatsDetail(latest, spec, cache.get(spec).data);
  for (const key of ['updatedAt', 'receivedAt', 'ageMs', 'stale', 'detailRevision']) {
    assert.equal(hydrated.devices[0][key], latestDevice[key], `${key} must come from the current summary`);
  }
  assert.strictEqual(hydrated.devices[0].periods, detail.periods);
  assert.strictEqual(hydrated.devices[1], other);
  assert.strictEqual(latest.devices[0], latestDevice);
  assert.deepEqual(detail, before, 'hydration must not rewrite the cached detail');
  const changedPresence = { ...latest, devices: [{ ...latestDevice, stale: true, ageMs: 600001, detailRevision: 'a-v2' }, other] };
  const projected = withStatsDetail(changedPresence, spec, { device: detail });
  assert.equal(projected.devices[0].stale, true);
  assert.equal(projected.devices[0].ageMs, 600001);
  assert.equal(projected.devices[0].detailRevision, 'a-v2');
});

test('session revision is period-specific, independent of account/fleet timestamps', async () => {
  const { detailRequest, createDetailCache } = await load();
  const prefs = { view: 'usage', usageTab: 'sessions', period: 'today' };
  const base = { detail: 'summary', updatedAt: 'one', sessionRevision: { today: 0, month: 1, allTime: 2 }, devices: [] };
  let calls = 0;
  const cache = createDetailCache(async () => { calls++; return { sessions: [] }; });
  await cache.load(detailRequest(base, prefs));
  const unrelated = { ...base, updatedAt: 'two', historyRevision: 2, limits: { updatedAt: 'account' },
    sessionRevision: { ...base.sessionRevision, month: 2 } };
  await cache.load(detailRequest(unrelated, prefs));
  assert.equal(calls, 1);
  const changed = { ...unrelated, sessionRevision: { ...unrelated.sessionRevision, today: 1 } };
  await cache.load(detailRequest(changed, prefs));
  assert.equal(calls, 2);
  await cache.load(detailRequest(changed, { ...prefs, period: 'month' }));
  assert.equal(calls, 3);
  const scalar = { ...base, sessionRevision: 'sessions-v1' };
  assert.equal(detailRequest(scalar, prefs).key, detailRequest({ ...scalar, updatedAt: 'new' }, prefs).key);
  assert.notEqual(detailRequest(scalar, prefs).key, detailRequest({ ...scalar, sessionRevision: 'sessions-v2' }, prefs).key);
});

test('old Hubs retain fleet revision invalidation for both device and session details', async () => {
  const { detailRequest } = await load();
  const base = { detail: 'summary', updatedAt: 'one', historyRevision: 1, deviceHistoryRevision: 1,
    devices: [{ deviceId: 'a', updatedAt: 'one', stale: false }] };
  for (const prefs of [{ view: 'devices' }, { view: 'usage', usageTab: 'sessions' }]) {
    const key = detailRequest(base, prefs).key;
    for (const changed of [
      { ...base, updatedAt: 'two' }, { ...base, historyRevision: 2 }, { ...base, deviceHistoryRevision: 2 },
      { ...base, devices: [{ ...base.devices[0], updatedAt: 'two' }] },
      { ...base, devices: [{ ...base.devices[0], stale: true }] }
    ]) assert.notEqual(detailRequest(changed, prefs).key, key);
  }
});
