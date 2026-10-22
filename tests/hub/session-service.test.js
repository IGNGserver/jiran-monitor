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
});
