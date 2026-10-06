'use strict';

// Cross-timezone range regressions.
//
// The Hub's clock is the *Hub host's*. A browser (or any caller) asks for its
// own local calendar window, so the day keys it computes must be the ones the
// Hub aggregates on — re-deriving them from `from`/`to` at the server shifted
// the window by a day whenever the two sat in different zones. The absolute
// instants still have to reach the event ledger, which is what the `from`/`to`
// pair is for. These tests pin both halves.
//
// The hub host is forced to UTC for the file, so the "label branch" cannot pass
// by coincidentally agreeing with the caller's zone.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHub } = require('../../src/hub/server');
const { MemoryRepository } = require('./memory-repository');

const HUB_TZ = 'UTC';
const CALLER_TZ = 'Asia/Shanghai'; // UTC+8

async function withHub(repository, run) {
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'range-secret',
    repository,
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  try {
    await run(hub);
  } finally {
    await hub.stop();
  }
}

function restoreTz(previous) {
  if (previous === undefined) delete process.env.TZ;
  else process.env.TZ = previous;
}

test('a range with explicit labels aggregates on the caller day, not the hub day', async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = HUB_TZ;
  const repository = new MemoryRepository();
  await repository.saveDevice({
    deviceId: 'dev-a',
    history: {
      daily: [
        { date: '2026-10-03', tokens: 100, cost: 1, perClient: { codex: { tokens: 100, cost: 1 } }, perModel: {} },
        { date: '2026-10-04', tokens: 50, cost: 0.5, perClient: { codex: { tokens: 50, cost: 0.5 } }, perModel: {} },
        { date: '2026-10-05', tokens: 999, cost: 9, perClient: { codex: { tokens: 999, cost: 9 } }, perModel: {} }
      ],
      monthly: [],
      summary: {}
    }
  });

  try {
    await withHub(repository, async (hub) => {
      // Caller in UTC+8 asks for its local 2026-10-04 *and* sends the absolute
      // instants that window names. The Hub is UTC.
      const range = await hub.getUsageRange({
        startDate: '2026-10-04',
        endDate: '2026-10-04',
        startHour: 0,
        endHour: 23,
        from: '2026-10-03T16:00:00.000Z',
        to: '2026-10-04T15:59:59.999Z'
      });
      assert.equal(range.source, 'history_daily');
      assert.equal(range.startDate, '2026-10-04');
      assert.equal(range.endDate, '2026-10-04');
      assert.equal(range.totalTokens, 50, 'only the caller-labelled day is summed');
    });
  } finally {
    restoreTz(previousTz);
  }
});

test('a from/to-only range can be keyed in the caller zone via tz=', async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = HUB_TZ;
  const repository = new MemoryRepository();
  await repository.saveDevice({
    deviceId: 'dev-a',
    history: {
      daily: [
        { date: '2026-10-03', tokens: 100, cost: 1, perClient: {}, perModel: {} },
        { date: '2026-10-04', tokens: 50, cost: 0.5, perClient: {}, perModel: {} }
      ],
      monthly: [],
      summary: {}
    }
  });

  try {
    await withHub(repository, async (hub) => {
      // 2026-10-04 00:00 -> 2026-10-05 00:00 at UTC+8, expressed as UTC instants.
      const range = await hub.getUsageRange({
        from: '2026-10-03T16:00:00.000Z',
        to: '2026-10-04T16:00:00.000Z',
        tz: CALLER_TZ
      });
      assert.equal(range.startDate, '2026-10-04');
      assert.equal(range.endDate, '2026-10-04');
      assert.equal(range.totalTokens, 50);

      // A legacy caller with no tz still falls back to the host clock (the old
      // contract), which is the documented behaviour for same-zone callers.
      const legacy = await hub.getUsageRange({
        from: '2026-10-03T16:00:00.000Z',
        to: '2026-10-04T16:00:00.000Z'
      });
      assert.equal(legacy.startDate, '2026-10-03');
      assert.equal(legacy.endDate, '2026-10-04');
    });
  } finally {
    restoreTz(previousTz);
  }
});

test('the event-ledger fallback filters on the caller instants, not the hub clock', async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = HUB_TZ;
  const repository = new MemoryRepository();
  // No history day matches 2026-10-04, so the ledger answers. The in-window
  // event is 18:00 at UTC+8; the other is 04:00 the *next* local morning.
  await repository.insertUsageEvents('dev-a', [
    {
      client: 'codex',
      sessionId: 's1',
      model: 'gpt-5',
      recordedAt: '2026-10-04T10:00:00.000Z',
      inputTokens: 40,
      outputTokens: 10,
      costUsd: 0.2
    },
    {
      client: 'codex',
      sessionId: 's2',
      model: 'gpt-5',
      recordedAt: '2026-10-04T20:00:00.000Z',
      inputTokens: 900,
      outputTokens: 0,
      costUsd: 9
    }
  ]);

  try {
    await withHub(repository, async (hub) => {
      const range = await hub.getUsageRange({
        startDate: '2026-10-04',
        endDate: '2026-10-04',
        startHour: 0,
        endHour: 23,
        from: '2026-10-03T16:00:00.000Z',
        to: '2026-10-04T15:59:59.999Z'
      });
      assert.equal(range.source, 'usage_events');
      assert.equal(range.totalTokens, 50, 'the next-local-morning event stays out of the window');
    });
  } finally {
    restoreTz(previousTz);
  }
});

test('the live fallback keys on the producers own periodWindows', async () => {
  const previousTz = process.env.TZ;
  // Force the hub host to a day *behind* the producer so a hub-clock check could
  // never match the requested key. UTC+14 against UTC-12 is 26 hours apart, so the
  // two are always on different calendar days.
  process.env.TZ = 'Etc/GMT+12';
  const repository = new MemoryRepository();
  // Derive the producer's window from the wall clock: a hard-coded `endsAt`
  // expired with the calendar, which cleared the device's `today` and turned this
  // into a date-bombed test that failed on any later day.
  const producerOffsetMs = 14 * 60 * 60 * 1000;
  const producerNow = new Date(Date.now() + producerOffsetMs);
  const day = producerNow.toISOString().slice(0, 10);
  const endOfProducerDay = new Date(
    Date.UTC(producerNow.getUTCFullYear(), producerNow.getUTCMonth(), producerNow.getUTCDate() + 1) - producerOffsetMs
  );
  const endOfProducerMonth = new Date(
    Date.UTC(producerNow.getUTCFullYear(), producerNow.getUTCMonth() + 1, 1) - producerOffsetMs
  );
  await repository.saveDevice({
    deviceId: 'dev-a',
    hostname: 'host-a',
    platform: 'win32',
    updatedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    periodWindows: {
      today: { key: day, endsAt: endOfProducerDay.toISOString() },
      month: { key: day.slice(0, 7), endsAt: endOfProducerMonth.toISOString() }
    },
    today: {
      totalTokens: 12345,
      costUsd: 1.25,
      clients: { codex: 12345 },
      clientCosts: { codex: 1.25 },
      models: { 'gpt-5': 12345 },
      modelCosts: { 'gpt-5': 1.25 }
    },
    history: { daily: [], monthly: [], summary: {} }
  });

  try {
    await withHub(repository, async (hub) => {
      const range = await hub.getUsageRange({
        startDate: day,
        endDate: day,
        startHour: 0,
        endHour: 23
      });
      assert.equal(range.source, 'live_today');
      assert.equal(range.totalTokens, 12345);
      assert.equal(range.startDate, day);
    });
  } finally {
    restoreTz(previousTz);
  }
});
