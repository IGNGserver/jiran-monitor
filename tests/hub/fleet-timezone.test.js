'use strict';

// Fleet-calendar Hub behaviour.
//
// The Hub owns one IANA zone when the operator sets it: it advertises that zone
// on every read and write a device or client performs, and uses it for its own
// clock fallbacks. Unset must stay exactly the pre-fleet behaviour - every
// device keeps its own calendar and no new field appears on the wire.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHub, aggregateHistoryRange } = require('../../src/hub/server');
const { MemoryRepository } = require('./memory-repository');

const FLEET_TZ = 'Asia/Shanghai';
const HUB_TZ = 'UTC';

function createMemoryHub(options = {}) {
  const repository = options.repository || new MemoryRepository();
  return {
    repository,
    hub: createHub({
      port: 0,
      host: '127.0.0.1',
      secret: '',
      repository,
      logger: { error() {}, warn() {} },
      ...options
    })
  };
}

function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
}

async function postMinimalIngest(port, body) {
  return fetch(`http://127.0.0.1:${port}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
}

test('the Hub advertises the fleet calendar on health, ingest and stats', async () => {
  const { hub } = createMemoryHub({ fleetTimeZone: FLEET_TZ });
  await hub.start();
  try {
    const { port } = hub.server.address();

    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.fleetTimeZone, FLEET_TZ);

    const ingestResponse = await postMinimalIngest(port, {
      deviceId: 'dev-a',
      updatedAt: new Date().toISOString(),
      today: { totalTokens: 1 },
      month: { totalTokens: 1 },
      allTime: { totalTokens: 1 }
    });
    assert.equal(ingestResponse.status, 200);
    const ingest = await ingestResponse.json();
    assert.equal(ingest.fleetTimeZone, FLEET_TZ);

    const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
    assert.equal(stats.fleetTimeZone, FLEET_TZ);
    // The first-paint projection spreads top-level fields, so a phone that
    // only reads the summary still learns which calendar the numbers use.
    const summary = await (await fetch(`http://127.0.0.1:${port}/api/stats/summary`)).json();
    assert.equal(summary.fleetTimeZone, FLEET_TZ);
  } finally {
    await hub.stop();
  }
});

test('an unset fleet calendar leaves the wire unchanged', async () => {
  await withEnv('TOKEN_MONITOR_FLEET_TIMEZONE', undefined, async () => {
    const { hub } = createMemoryHub();
    await hub.start();
    try {
      const { port } = hub.server.address();
      const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      assert.equal(Object.hasOwn(health, 'fleetTimeZone'), false);

      const ingest = await (await postMinimalIngest(port, {
        deviceId: 'dev-a',
        updatedAt: new Date().toISOString(),
        today: { totalTokens: 1 },
        month: { totalTokens: 1 },
        allTime: { totalTokens: 1 }
      })).json();
      assert.deepEqual(ingest, { ok: true, deviceId: 'dev-a' });

      const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
      assert.equal(Object.hasOwn(stats, 'fleetTimeZone'), false);
    } finally {
      await hub.stop();
    }
  });
});

test('the Hub reads the fleet calendar from the environment when no option is passed', async () => {
  await withEnv('TOKEN_MONITOR_FLEET_TIMEZONE', FLEET_TZ, async () => {
    const { hub } = createMemoryHub();
    await hub.start();
    try {
      const { port } = hub.server.address();
      const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      assert.equal(health.fleetTimeZone, FLEET_TZ);
    } finally {
      await hub.stop();
    }
  });
});

test('a legacy from/to-only range derives its labels in the fleet calendar', async () => {
  const previousTz = process.env.TZ;
  // The hub host is a day behind the fleet; only the fleet calendar can name
  // the caller's day from the instants alone.
  process.env.TZ = HUB_TZ;
  try {
    await withEnv('TOKEN_MONITOR_FLEET_TIMEZONE', undefined, async () => {
      const repository = new MemoryRepository();
      await repository.saveDevice({
        deviceId: 'dev-a',
        history: {
          daily: [
            { date: '2026-10-04', tokens: 100, cost: 1, perClient: {}, perModel: {} },
            { date: '2026-10-05', tokens: 50, cost: 0.5, perClient: {}, perModel: {} }
          ],
          monthly: [],
          summary: {}
        }
      });
      const { hub } = createMemoryHub({ repository, fleetTimeZone: FLEET_TZ });
      await hub.start();
      try {
        // Shanghai 2026-10-05 00:00 -> 2026-10-06 00:00, expressed as UTC.
        const range = await hub.getUsageRange({
          from: '2026-10-04T16:00:00.000Z',
          to: '2026-10-05T16:00:00.000Z'
        });
        assert.equal(range.startDate, '2026-10-05');
        assert.equal(range.endDate, '2026-10-05');
        assert.equal(range.totalTokens, 50);
      } finally {
        await hub.stop();
      }
    });
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('aggregateHistoryRange maps legacy instants through an explicit fleet zone', () => {
  const result = aggregateHistoryRange(
    { daily: [{ date: '2026-10-05', tokens: 7, cost: 0, perClient: {}, perModel: {} }] },
    new Date('2026-10-04T16:00:00.000Z'),
    new Date('2026-10-05T16:00:00.000Z'),
    { timeZone: FLEET_TZ }
  );
  assert.equal(result.totalTokens, 7);
  assert.equal(result.requestedStart, '2026-10-05');
  assert.equal(result.requestedEnd, '2026-10-05');
});
