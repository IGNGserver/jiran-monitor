'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHubSessionService } = require('../../src/hub/sessionService');
const { MemoryRepository } = require('./memory-repository');

function serviceAt({ idleDays = 0, clock } = {}) {
  const store = new MemoryRepository();
  const service = createHubSessionService({
    store,
    ownerSecret: 'owner-secret',
    idleDays,
    now: () => clock.now,
    logger: { info() {}, warn() {} }
  });
  return { store, service };
}

test('device sessions do not expire by default', async () => {
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  const { service } = serviceAt({ clock });
  await service.load();
  const created = await service.create({ deviceName: 'Phone', platform: 'android' });
  clock.now += 10 * 365 * 24 * 60 * 60 * 1000;
  const resolved = service.resolve(created.token);
  assert.equal(resolved?.sessionId, created.session.id);
});

test('JIRAN_SESSION_IDLE_DAYS adds a sliding idle expiry', async () => {
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  const { service } = serviceAt({ idleDays: 1, clock });
  await service.load();
  const created = await service.create({ deviceName: 'Phone', platform: 'android' });
  assert.equal(service.resolve(created.token)?.sessionId, created.session.id);

  clock.now += 2 * 24 * 60 * 60 * 1000;
  assert.equal(service.resolve(created.token), null);
});

test('changing the owner secret invalidates stored sessions on load', async () => {
  const store = new MemoryRepository();
  const first = createHubSessionService({
    store,
    ownerSecret: 'first',
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    logger: { info() {}, warn() {} }
  });
  await first.load();
  const created = await first.create({ deviceName: 'Phone', platform: 'android' });

  const second = createHubSessionService({
    store,
    ownerSecret: 'second',
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    logger: { info() {}, warn() {} }
  });
  await second.load();
  assert.equal(second.resolve(created.token), null);
  assert.ok((await store.listHubSessions())[0].revokedAt);
  // Rotating back must not resurrect credentials from before the rotation.
  const restored = createHubSessionService({ store, ownerSecret: 'first', logger: { info() {}, warn() {} } });
  await restored.load();
  assert.equal(restored.resolve(created.token), null);
  assert.equal(restored.list().length, 0);
});

test('loading prefers only active sessions without reading revoked/expired history', async () => {
  const clock = { now: Date.now() };
  const { store, service } = serviceAt({ clock });
  await service.load();
  const active = await service.create({ deviceName: 'Active' });
  const revoked = await service.create({ deviceName: 'Revoked' });
  const expired = await service.create({ deviceName: 'Expired' });
  await service.revoke(revoked.session.id);
  store.hubSessions.get(expired.session.id).expiresAt = new Date(clock.now - 1).toISOString();
  let activeLoads = 0;
  const loadActive = store.loadActiveHubSessions.bind(store);
  store.loadActiveHubSessions = () => { activeLoads++; return loadActive(); };
  store.listHubSessions = () => { throw new Error('unbounded session history read'); };
  const reloaded = createHubSessionService({ store, ownerSecret: 'owner-secret', now: () => clock.now });
  await reloaded.load();
  assert.equal(activeLoads, 1);
  assert.deepEqual(reloaded.list().map((row) => row.id), [active.session.id]);
  assert.equal(reloaded.resolve(active.token)?.sessionId, active.session.id);
  assert.equal(reloaded.resolve(revoked.token), null);
  assert.equal(reloaded.resolve(expired.token), null);
});

test('legacy stores still load sessions and do not repeatedly revoke old history', async () => {
  const clock = { now: Date.now() };
  const { store, service } = serviceAt({ clock });
  await service.load();
  const created = await service.create({ deviceName: 'Active' });
  const revoked = await service.create({ deviceName: 'Revoked' });
  await service.revoke(revoked.session.id);
  store.hubSessions.get(revoked.session.id).secretFingerprint = 'old-secret';
  store.loadActiveHubSessions = undefined;
  let listReads = 0;
  let revokeWrites = 0;
  const list = store.listHubSessions.bind(store);
  store.listHubSessions = () => { listReads++; return list(); };
  const revoke = store.revokeHubSession.bind(store);
  store.revokeHubSession = (id) => { revokeWrites++; return revoke(id); };
  const reloaded = createHubSessionService({ store, ownerSecret: 'owner-secret', now: () => clock.now });
  await reloaded.load();
  assert.equal(listReads, 1);
  assert.equal(revokeWrites, 0);
  assert.equal(reloaded.resolve(created.token)?.sessionId, created.session.id);
});

test('listing drops expired sessions from both indexes while preserving live/default-unlimited sessions', async () => {
  const clock = { now: Date.now() };
  const { service, store } = serviceAt({ idleDays: 1, clock });
  await service.load();
  const expired = await service.create({ deviceName: 'Old' });
  clock.now += 12 * 60 * 60 * 1000;
  const live = await service.create({ deviceName: 'Live' });
  clock.now += 13 * 60 * 60 * 1000;
  assert.deepEqual(service.list().map((row) => row.id), [live.session.id]);
  assert.equal(await service.revoke(expired.session.id), null, 'expired id was removed, not just hidden');
  assert.equal(await service.revokeToken(expired.token), null, 'expired token hash was removed too');
  assert.equal(store.hubSessions.get(expired.session.id).revokedAt, null, 'list pruning does not add database writes');
  const unlimited = serviceAt({ clock }).service;
  await unlimited.load();
  const created = await unlimited.create();
  clock.now += 100 * 365 * 24 * 60 * 60 * 1000;
  assert.equal(unlimited.list()[0].id, created.session.id);
  assert.equal(unlimited.resolve(created.token)?.sessionId, created.session.id);
});
