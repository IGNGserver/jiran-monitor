'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHub } = require('../../src/hub/server');
const { MemoryRepository } = require('./memory-repository');

// Device data transfer: /api/devices/{source}/transfer moves the source's
// recorded history onto an existing target device. The source keeps its
// identity and keeps recording; only the ownership of the already-recorded
// history changes, so the source's next upload must book only new usage.

function createMemoryHub(options = {}) {
  const repository = options.repository || new MemoryRepository();
  return { repository, hub: createHub({ port: 0, host: '127.0.0.1', secret: '', repository, logger: { error() {}, warn() {} }, ...options }) };
}

function payload(totalTokens, { deviceId = 'dev-a', model = 'gpt-5', inputTokens = totalTokens, updatedAt = '2026-07-18T00:00:00.000Z' } = {}) {
  return {
    deviceId,
    updatedAt,
    allTime: {
      totalTokens,
      costUsd: totalTokens / 1_000_000,
      clients: { codex: totalTokens },
      clientCosts: { codex: totalTokens / 1_000_000 },
      models: { [model]: totalTokens },
      modelCosts: { [model]: totalTokens / 1_000_000 },
      clientModels: { codex: { [model]: totalTokens } },
      clientModelCosts: { codex: { [model]: totalTokens / 1_000_000 } },
      sessions: {
        'codex:session-1': {
          client: 'codex', sessionId: 'session-1', totalTokens, inputTokens,
          models: { [model]: totalTokens }, modelCosts: { [model]: totalTokens / 1_000_000 },
          lastUsedAt: updatedAt, startedAt: updatedAt
        }
      }
    },
    today: { totalTokens },
    month: { totalTokens }
  };
}

async function startTransferHub(options = {}) {
  const { hub, repository } = createMemoryHub(options);
  await hub.start();
  const { port } = hub.server.address();
  const transfer = (source, targetDeviceId) => fetch(`http://127.0.0.1:${port}/api/devices/${encodeURIComponent(source)}/transfer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetDeviceId }),
    signal: AbortSignal.timeout(5000)
  });
  const ingest = (body) => hub.ingest(body);
  return { hub, repository, port, transfer, ingest };
}

test('transfer moves the ledger, merges periods, and removes the source device', async () => {
  const ctx = await startTransferHub();
  const { hub, transfer, ingest } = ctx;
  try {
    await ingest(payload(100, { deviceId: 'dev-a' }));
    await ingest(payload(40, { deviceId: 'dev-b', updatedAt: '2026-07-18T01:00:00.000Z' }));

    const response = await transfer('dev-a', 'dev-b');
    assert.equal(response.status, 200);

    const stats = await (await fetch(`http://127.0.0.1:${ctx.port}/api/stats`)).json();
    const target = stats.devices.find((device) => device.deviceId === 'dev-b');
    const source = stats.devices.find((device) => device.deviceId === 'dev-a');
    assert.equal(target.periods.allTime.totalTokens, 140, 'target owns both devices\' history');
    assert.equal(source, undefined, 'the source device is removed by the Hub');
    assert.equal(stats.periods.allTime.totalTokens, 140, 'the aggregate does not double-count');
  } finally {
    await hub.stop();
  }
});

test('a removed source re-registering under the same id only books new usage', async () => {
  const ctx = await startTransferHub();
  const { hub, repository, transfer, ingest } = ctx;
  try {
    await ingest(payload(100, { deviceId: 'dev-a' }));
    await ingest(payload(40, { deviceId: 'dev-b', updatedAt: '2026-07-18T01:00:00.000Z' }));
    const transferred = await transfer('dev-a', 'dev-b');
    assert.equal(transferred.status, 200);
    const eventsAfterTransfer = repository.events.length;

    // The operator re-identified this machine; until then its agent keeps
    // uploading under the old cumulative id. The pinned baseline means the
    // replayed cumulative counters book nothing; only new usage counts.
    await ingest(payload(120, { deviceId: 'dev-a', updatedAt: '2026-07-18T02:00:00.000Z' }));

    assert.equal(repository.events.length - eventsAfterTransfer, 1, 'exactly one new event');
    const newEvent = repository.events[repository.events.length - 1];
    assert.equal(newEvent.deviceId, 'dev-a', 'new usage stays attributed to the source');
    assert.equal(newEvent.totalTokens, 20, 'only the delta is booked, not the transferred history');

    const stats = await (await fetch(`http://127.0.0.1:${ctx.port}/api/stats`)).json();
    const target = stats.devices.find((device) => device.deviceId === 'dev-b');
    const source = stats.devices.find((device) => device.deviceId === 'dev-a');
    assert.equal(target.periods.allTime.totalTokens, 140, 'target keeps the transferred total');
    assert.equal(source.periods.allTime.totalTokens, 20, 'source owns only its new usage');
    assert.equal(stats.periods.allTime.totalTokens, 160);
  } finally {
    await hub.stop();
  }
});

test('transfer requires an existing target device', async () => {
  const ctx = await startTransferHub();
  const { hub, transfer, ingest } = ctx;
  try {
    await ingest(payload(100, { deviceId: 'dev-a' }));

    const missingTarget = await transfer('dev-a', 'dev-missing');
    assert.equal(missingTarget.status, 404);
    assert.equal((await missingTarget.json()).error, 'target_not_found');

    const missingSource = await transfer('dev-missing', 'dev-a');
    assert.equal(missingSource.status, 404);

    const sameDevice = await transfer('dev-a', 'dev-a');
    assert.equal(sameDevice.status, 400);
    assert.equal((await sameDevice.json()).error, 'same_device');
  } finally {
    await hub.stop();
  }
});

test('transfer sums sessions present on both devices instead of dropping them', async () => {
  const ctx = await startTransferHub();
  const { hub, repository, transfer, ingest } = ctx;
  try {
    // Both devices report the same client+session id, so a plain row move would
    // collide with the target's primary key.
    await ingest(payload(100, { deviceId: 'dev-a' }));
    await ingest(payload(40, { deviceId: 'dev-b', updatedAt: '2026-07-18T01:00:00.000Z' }));

    const transferred = await transfer('dev-a', 'dev-b');
    assert.equal(transferred.status, 200);

    const sourceSessions = [...repository.sessions.entries()].filter(([key]) => key.startsWith('dev-a\u0000'));
    assert.equal(sourceSessions.length, 0, 'no session rows remain on the source');
    const moved = [...repository.sessions.entries()].find(([key]) => key.startsWith('dev-b\u0000') && key.endsWith('\u0000codex\u0000session-1'));
    assert.ok(moved, 'the shared session lives under the target device');
    // dev-a contributed 100 and dev-b 40 for the same session id.
    assert.equal(moved[1].totalTokens, 140, 'both sides\' counts are summed into one row');
  } finally {
    await hub.stop();
  }
});

test('a transferred source reporting its old cumulative totals keeps the aggregate stable', async () => {
  const ctx = await startTransferHub();
  const { hub, transfer, ingest } = ctx;
  try {
    await ingest(payload(100, { deviceId: 'dev-a' }));
    await ingest(payload(40, { deviceId: 'dev-b', updatedAt: '2026-07-18T01:00:00.000Z' }));
    assert.equal((await hub.getStats()).periods.allTime.totalTokens, 140);
    const transferred = await transfer('dev-a', 'dev-b');
    assert.equal(transferred.status, 200);
    // dev-b's own 40 plus the moved 100 — the total is conserved, the source
    // just stops displaying its share.
    assert.equal((await hub.getStats()).periods.allTime.totalTokens, 140);
    // A repeated cumulative report (no new usage yet) must not re-add anything.
    await ingest(payload(100, { deviceId: 'dev-a', updatedAt: '2026-07-18T02:00:00.000Z' }));
    assert.equal((await hub.getStats()).periods.allTime.totalTokens, 140, 'replayed counters must not double-count');
  } finally {
    await hub.stop();
  }
});

test('repeated source/target transfers preserve independent raw baselines and book only new usage', async () => {
  const { hub, repository, transfer, ingest } = await startTransferHub();
  const upload = (deviceId, tokens) => ingest(payload(tokens, { deviceId, updatedAt: new Date().toISOString() }));
  const totals = async (expected, devices) => {
    const stats = await hub.getStats();
    assert.equal(stats.periods.allTime.totalTokens, expected);
    assert.deepEqual(Object.fromEntries(stats.devices.map((device) => [device.deviceId, device.periods.allTime.totalTokens])), devices);
    assert.equal(repository.events.reduce((sum, event) => sum + event.totalTokens, 0), expected, 'display and ledger conserve the same usage');
  };
  try {
    await upload('dev-a', 100);
    await upload('dev-b', 40);
    await upload('dev-c', 10);
    assert.equal((await transfer('dev-a', 'dev-b')).status, 200);
    assert.equal((await transfer('dev-c', 'dev-b')).status, 200);
    await totals(150, { 'dev-b': 150 });
    assert.equal((await repository.getIngestBaseline('dev-b')).snapshot.periods.allTime.totalTokens, 40);
    await upload('dev-b', 45);
    await upload('dev-a', 120);
    await totals(175, { 'dev-a': 20, 'dev-b': 155 });
    assert.equal((await transfer('dev-b', 'dev-a')).status, 200);
    await totals(175, { 'dev-a': 175 });
    await upload('dev-a', 130);
    await totals(185, { 'dev-a': 185 });
    const eventCount = repository.events.length;
    await upload('dev-b', 45);
    await upload('dev-c', 10);
    await totals(185, { 'dev-a': 185, 'dev-b': 0, 'dev-c': 0 });
    assert.equal(repository.events.length, eventCount, 'replaying either former source books no transferred counters');
    await upload('dev-c', 15);
    await totals(190, { 'dev-a': 185, 'dev-b': 0, 'dev-c': 5 });
    for (const [id, raw] of [['dev-a', 130], ['dev-b', 45], ['dev-c', 15]]) {
      const baseline = await repository.getIngestBaseline(id);
      assert.equal(baseline.snapshot.periods.allTime.totalTokens, raw, `${id} baseline is its own cumulative report, not the display sum`);
      assert.equal(baseline.transferred, true);
    }
    const metrics = hub.getResourceMetrics();
    await hub.getStats();
    await hub.getStats();
    assert.equal(hub.getResourceMetrics().fullBuilds, metrics.fullBuilds, 'read-only refreshes must not re-fold the transferred display');
  } finally { await hub.stop(); }
});

test('limits-only updates after transfer preserve display and raw anchors before the next normal upload', async () => {
  const { hub, repository, transfer, ingest } = await startTransferHub();
  try {
    await ingest(payload(100));
    await ingest(payload(40, { deviceId: 'dev-b' }));
    assert.equal((await transfer('dev-a', 'dev-b')).status, 200);
    const count = repository.events.length;
    const baseline = await repository.getIngestBaseline('dev-b');
    const sessionRows = structuredClone([...repository.sessions.entries()]);
    await ingest({ deviceId: 'dev-b', limitsOnly: true, limits: { providers: { codex: { remaining: 1 } } } });
    assert.deepEqual(await repository.getIngestBaseline('dev-b'), baseline);
    assert.deepEqual([...repository.sessions.entries()], sessionRows);
    assert.equal(repository.events.length, count);
    assert.equal((await hub.getStats()).periods.allTime.totalTokens, 140);
    // A limits-only report from the removed source may revive its identity, but
    // must not revive the counters already transferred to the target.
    await ingest({ deviceId: 'dev-a', limitsOnly: true, limits: {} });
    assert.equal((await hub.getStats()).periods.allTime.totalTokens, 140);
    await ingest(payload(45, { deviceId: 'dev-b' }));
    await ingest(payload(110));
    const stats = await hub.getStats();
    assert.equal(stats.periods.allTime.totalTokens, 155);
    assert.equal(stats.devices.find((device) => device.deviceId === 'dev-b').periods.allTime.totalTokens, 145);
    assert.equal(stats.devices.find((device) => device.deviceId === 'dev-a').periods.allTime.totalTokens, 10);
    assert.equal(repository.events.slice(count).reduce((sum, event) => sum + event.totalTokens, 0), 15);
  } finally { await hub.stop(); }
});

function measuredPayload(deviceId, tokens) {
  const at = new Date().toISOString();
  const body = payload(tokens, { deviceId, updatedAt: at });
  const credits = tokens / 10;
  body.allTime.clientEstimated = { codex: true };
  body.allTime.clientCredits = { codex: credits };
  body.allTime.clientModelCredits = { codex: { 'gpt-5': credits } };
  body.allTime.clientMeasurements = { codex: { tokens: 'estimated', costUsd: 'estimated', meters: { credits: { value: credits, provenance: 'exact' } } } };
  Object.assign(body.allTime.sessions['codex:session-1'], { credits, modelCredits: { 'gpt-5': credits }, messageCount: tokens / 10 });
  const row = {
    date: at.slice(0, 10), tokens, cost: tokens / 1_000_000, messages: tokens / 10,
    perClient: { codex: { tokens, cost: tokens / 1_000_000, messages: tokens / 10 } },
    perModel: { 'gpt-5': { tokens, cost: tokens / 1_000_000 } }
  };
  body.history = { daily: [row], monthly: [], summary: {} };
  body.historyAvailable = true;
  return body;
}

test('transferred history, credits and measurement provenance survive later cumulative uploads', async () => {
  const { hub, repository, transfer, ingest } = await startTransferHub();
  try {
    await ingest(measuredPayload('dev-a', 100));
    await ingest(measuredPayload('dev-b', 40));
    assert.equal((await transfer('dev-a', 'dev-b')).status, 200);
    const assertMeasured = async (tokens, credits) => {
      const stats = await hub.getStats();
      const period = stats.periods.allTime;
      assert.equal(period.totalTokens, tokens);
      assert.equal(period.clientCredits.codex, credits);
      assert.equal(period.clientModelCredits.codex['gpt-5'], credits);
      assert.equal(period.clientEstimated.codex, true);
      assert.equal(period.clientMeasurements.codex.tokens, 'estimated');
      assert.equal(period.clientMeasurements.codex.meters.credits.value, credits);
      assert.equal(period.clientMeasurements.codex.meters.credits.provenance, 'exact');
      const history = await hub.getHistory();
      assert.equal(history.daily.reduce((sum, row) => sum + row.tokens, 0), tokens);
      const target = await repository.getDeviceRecord('dev-b');
      assert.equal(target.history.daily.reduce((sum, row) => sum + row.tokens, 0), tokens);
    };
    await assertMeasured(140, 14);
    await ingest(measuredPayload('dev-b', 50));
    await assertMeasured(150, 15);
    await ingest(measuredPayload('dev-a', 100));
    await assertMeasured(150, 15);
    const before = (await hub.getStats()).historyRevision;
    await ingest(measuredPayload('dev-b', 60));
    await assertMeasured(160, 16);
    assert.notEqual((await hub.getStats()).historyRevision, before);
  } finally { await hub.stop(); }
});

test('transferred session rows retain both contributions when either device uploads again', async () => {
  const { hub, repository, transfer, ingest } = await startTransferHub();
  const sessionsFor = (id) => [...repository.sessions.entries()].filter(([key]) => key.startsWith(`${id}\u0000`)).map(([, row]) => row);
  try {
    await ingest(measuredPayload('dev-a', 100));
    await ingest(measuredPayload('dev-b', 40));
    assert.equal((await transfer('dev-a', 'dev-b')).status, 200);
    assert.equal(sessionsFor('dev-b')[0].totalTokens, 140);
    await ingest(measuredPayload('dev-b', 50));
    assert.equal(sessionsFor('dev-b')[0].totalTokens, 150, 'target upload retains moved sessions instead of replacing them with its own raw cumulative archive');
    await ingest(measuredPayload('dev-a', 110));
    assert.equal(sessionsFor('dev-a')[0].totalTokens, 10, 'source archive contains only the post-transfer delta');
    assert.equal(sessionsFor('dev-a')[0].credits, 1);
    assert.equal((await hub.getStats()).periods.allTime.totalTokens, 160);
  } finally { await hub.stop(); }
});

test('an exact target upload cannot hide its earlier estimated contribution after receiving exact source usage', async () => {
  const { hub, repository, transfer, ingest } = await startTransferHub();
  const measured = (deviceId, tokens, estimated) => {
    const body = measuredPayload(deviceId, tokens);
    body.allTime.estimated = estimated;
    body.allTime.clientEstimated = { codex: estimated };
    body.allTime.clientMeasurements.codex.tokens = estimated ? 'estimated' : 'exact';
    body.allTime.clientMeasurements.codex.costUsd = estimated ? 'estimated' : 'exact';
    body.allTime.clientMeasurements.codex.meters.requests = { value: tokens / 10, provenance: estimated ? 'estimated' : 'exact' };
    return body;
  };
  const assertEstimate = async (tokens) => {
    const persisted = (await repository.getDeviceRecord('dev-b')).periods.allTime;
    const stats = await hub.getStats();
    const displayed = stats.devices.find((device) => device.deviceId === 'dev-b').periods.allTime;
    for (const period of [persisted, displayed, stats.periods.allTime]) {
      assert.equal(period.totalTokens, tokens);
      assert.equal(period.estimated, true);
      assert.equal(period.clientEstimated.codex, true);
      assert.equal(period.clientMeasurements.codex.tokens, 'estimated');
      assert.equal(period.clientMeasurements.codex.costUsd, 'estimated');
      assert.equal(period.clientMeasurements.codex.meters.requests.value, tokens / 10);
      assert.equal(period.clientMeasurements.codex.meters.requests.provenance, 'estimated');
    }
  };
  try {
    await ingest(measured('dev-a', 100, false));
    await ingest(measured('dev-b', 40, true));
    assert.equal((await transfer('dev-a', 'dev-b')).status, 200);
    await assertEstimate(140);
    await ingest(measured('dev-b', 50, false));
    await assertEstimate(150);
    await ingest(measured('dev-b', 60, false));
    await assertEstimate(160);
    const raw = (await repository.getIngestBaseline('dev-b')).snapshot.periods.allTime;
    assert.equal(raw.totalTokens, 60);
    assert.notEqual(raw.estimated, true, 'the raw baseline retains the producer report, not the conservative display provenance');
    assert.equal(raw.clientMeasurements.codex.tokens, 'exact');
  } finally { await hub.stop(); }
});

for (const scenario of [
  { name: 'day', before: '2026-07-18T23:59:59Z', after: '2026-07-19T00:00:01Z', month: 95, rawMonth: 25 },
  { name: 'month', before: '2026-07-31T23:59:59Z', after: '2026-08-01T00:00:01Z', month: 5, rawMonth: 5 }
]) {
  test(`legacy transfer carry expires at the ${scenario.name} boundary before a new cumulative upload`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(scenario.before) });
    const { hub, repository, transfer, ingest } = await startTransferHub();
    const legacy = (deviceId, allTime, today, month, updatedAt) => ({
      ...payload(allTime, { deviceId, updatedAt }), today: { totalTokens: today }, month: { totalTokens: month }
    });
    try {
      await ingest(legacy('dev-a', 100, 30, 70, scenario.before));
      await ingest(legacy('dev-b', 40, 10, 20, scenario.before));
      assert.equal((await transfer('dev-a', 'dev-b')).status, 200);
      const before = await hub.getStats();
      assert.equal(before.periods.today.totalTokens, 40);
      assert.equal(before.periods.month.totalTokens, 90);
      assert.equal((await repository.getIngestBaseline('dev-b')).snapshot.periodWindows, undefined);
      t.mock.timers.tick(Date.parse(scenario.after) - Date.parse(scenario.before));
      await ingest(legacy('dev-b', 45, 5, scenario.rawMonth, scenario.after));
      const stats = await hub.getStats();
      const stored = await repository.getDeviceRecord('dev-b');
      for (const periods of [stats.periods, stats.devices[0].periods, stored.periods]) {
        assert.equal(periods.month.totalTokens, scenario.month, 'only a month change retires the transferred monthly carry');
        assert.equal(periods.today.totalTokens, 5, 'a new UTC day must not revive yesterday\'s transferred carry');
        assert.equal(periods.allTime.totalTokens, 145, 'all-time carry survives either calendar boundary');
      }
      // Replaying the new counters must not add either the old carry or the new
      // window twice; raw anchors must be updated to the new producer window.
      await ingest(legacy('dev-b', 45, 5, scenario.rawMonth, scenario.after));
      assert.equal((await hub.getStats()).periods.today.totalTokens, 5);
      assert.equal((await repository.getIngestBaseline('dev-b')).snapshot.periods.today.totalTokens, 5);
      assert.equal(repository.events.reduce((sum, event) => sum + event.totalTokens, 0), 145);
    } finally { await hub.stop(); }
  });
}

test('opposite-direction concurrent transfers acquire sorted locks and finish without deadlock', async () => {
  const repository = new MemoryRepository();
  const lockSets = [];
  let active = 0;
  let peak = 0;
  repository.transaction = async (work) => {
    const connection = { locks: [] };
    lockSets.push(connection.locks);
    active++;
    peak = Math.max(peak, active);
    try { return await work(connection); } finally { active--; }
  };
  repository.lockDevice = async (id, connection) => {
    connection.locks.push(id);
    await new Promise((resolve) => setImmediate(resolve));
    return repository.devices.has(id);
  };
  const { hub, transfer, ingest } = await startTransferHub({ repository });
  try {
    await ingest(payload(100));
    await ingest(payload(40, { deviceId: 'dev-b' }));
    lockSets.length = 0;
    peak = 0;
    const responses = await Promise.all([transfer('dev-a', 'dev-b'), transfer('dev-b', 'dev-a')]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.deepEqual(lockSets, [['dev-a', 'dev-b'], ['dev-a', 'dev-b']]);
    assert.equal(peak, 1, 'the process lock must serialize both transactions before acquiring row locks');
    assert.equal((await hub.getStats()).periods.allTime.totalTokens, 140);
    assert.equal(repository.events.reduce((sum, event) => sum + event.totalTokens, 0), 140);
    assert.equal((await repository.getIngestBaseline('dev-a')).snapshot.periods.allTime.totalTokens, 100);
    assert.equal((await repository.getIngestBaseline('dev-b')).snapshot.periods.allTime.totalTokens, 40);
  } finally { await hub.stop(); }
});
