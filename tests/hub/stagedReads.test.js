'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const zlib = require('node:zlib');

const { createHub } = require('../../src/hub/server');
const { MemoryRepository } = require('./memory-repository');

function createMemoryHub(options = {}) {
  const repository = options.repository || new MemoryRepository();
  return {
    repository,
    hub: createHub({
      port: 0,
      host: '127.0.0.1',
      secret: '',
      repository,
      logger: { error() {}, warn() {}, info() {} },
      ...options
    })
  };
}

function sessions(count, prefix = 'codex', deviceTag = 'd') {
  const out = {};
  for (let i = 0; i < count; i++) {
    const lastUsedAt = new Date(Date.UTC(2026, 6, 18) - i * 60000).toISOString();
    // Session identity is device-scoped in the aggregate too, so ids must differ
    // per device or two devices' rows fold into one and the total under-counts.
    out[`${prefix}:session-${deviceTag}-${i}`] = {
      client: prefix,
      sessionId: `session-${deviceTag}-${i}`,
      projectId: `project-${i % 5}`,
      projectLabel: `Project ${i % 5}`,
      totalTokens: 1000 + i,
      inputTokens: 500,
      outputTokens: 400,
      costUsd: (1000 + i) / 1_000_000,
      startedAt: lastUsedAt,
      lastUsedAt,
      models: { 'gpt-5': 1000 + i }
    };
  }
  return out;
}

function period(totalTokens, sessionCount, deviceTag) {
  return {
    totalTokens,
    costUsd: totalTokens / 1_000_000,
    clients: { codex: totalTokens },
    clientCosts: { codex: totalTokens / 1_000_000 },
    models: { 'gpt-5': totalTokens },
    modelCosts: { 'gpt-5': totalTokens / 1_000_000 },
    clientModels: { codex: { 'gpt-5': totalTokens } },
    clientModelCosts: { codex: { 'gpt-5': totalTokens / 1_000_000 } },
    clientEstimated: {},
    clientCredits: {},
    clientMeasurements: {},
    estimated: false,
    projects: { 'project-0': { label: 'Project 0', tokens: totalTokens, costUsd: 0, clients: { codex: totalTokens } } },
    sessions: sessions(sessionCount, 'codex', deviceTag)
  };
}

// A history document with both tiers, so /api/history has a non-trivial aggregate.
// `mergeHistories` takes lifetime totals from the *monthly* tier and the rolling
// window from daily, so both are required for a meaningful total.
function history(totalTokens) {
  const perClient = { codex: { tokens: totalTokens, cost: totalTokens / 1_000_000, messages: 10 } };
  const perModel = { 'gpt-5': { tokens: totalTokens, cost: totalTokens / 1_000_000 } };
  return {
    daily: [{
      date: '2026-07-18',
      tokens: totalTokens,
      cost: totalTokens / 1_000_000,
      messages: 10,
      activeTimeMs: 60_000,
      perClient,
      perModel
    }],
    monthly: [{
      month: '2026-07',
      tokens: totalTokens,
      cost: totalTokens / 1_000_000,
      activeTimeMs: 60_000,
      perClient,
      perModel
    }],
    summary: {}
  };
}

function payload(totalTokens, { deviceId = 'dev-a', sessionCount = 40 } = {}) {
  return {
    deviceId,
    updatedAt: '2026-07-18T00:00:00.000Z',
    allTime: period(totalTokens, sessionCount, deviceId),
    month: period(totalTokens, sessionCount, deviceId),
    today: period(totalTokens, sessionCount, deviceId),
    history: history(totalTokens)
  };
}

async function seed(hub, entries) {
  for (const entry of entries) await hub.ingest(entry);
}

test('capabilities advertise the staged read endpoints', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await (await fetch(`http://127.0.0.1:${port}/api/capabilities`)).json();
    assert.equal(response.capabilities.statsSummary, true);
    assert.equal(response.capabilities.deviceDetail, true);
    assert.equal(response.capabilities.sessionList, true);
    assert.equal(response.capabilities.sessionQuery, true);
    assert.equal(response.capabilities.usageAnalytics, true);
    assert.equal(response.capabilities.usageDailyFacts, true);
  } finally {
    await hub.stop();
  }
});

test('/api/stats/summary drops the session archive but keeps every headline number', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await seed(hub, [payload(1000, { deviceId: 'dev-a' }), payload(2000, { deviceId: 'dev-b' })]);

    const full = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
    const summary = await (await fetch(`http://127.0.0.1:${port}/api/stats/summary`)).json();

    // Headline numbers are the same measurement, not a second one.
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(summary.periods[name].totalTokens, full.periods[name].totalTokens, name);
      assert.equal(summary.periods[name].costUsd, full.periods[name].costUsd, name);
      assert.deepEqual(summary.periods[name].clients, full.periods[name].clients, name);
      assert.deepEqual(summary.periods[name].clientCosts, full.periods[name].clientCosts, name);
      assert.deepEqual(summary.periods[name].models, full.periods[name].models, name);
      assert.deepEqual(summary.periods[name].clientModels, full.periods[name].clientModels, name);
    }
    assert.equal(summary.devices.length, full.devices.length);
    assert.deepEqual(
      summary.devices.map((device) => device.deviceId).sort(),
      full.devices.map((device) => device.deviceId).sort()
    );

    // Detail is what the summary exists to drop, and the full shape still has it.
    assert.ok(Object.keys(full.periods.allTime.sessions).length > 0);
    assert.ok(Object.keys(full.devices[0].periods.allTime.sessions).length > 0);
    assert.equal(summary.periods.allTime.sessions, undefined);
    assert.equal(summary.devices[0].periods.allTime.sessions, undefined);
    assert.equal(summary.devices[0].periods.allTime.projects, undefined);
    // Per-device breakdown maps are device-detail material, not fleet-list data:
    // the device list and the comparison chart read totals only.
    assert.equal(summary.devices[0].periods.allTime.clientModels, undefined);
    assert.equal(summary.devices[0].periods.allTime.clients, undefined);
    assert.equal(summary.devices[0].periods.allTime.models, undefined);
    // The top-level aggregate keeps every breakdown a dashboard draws, including
    // the project rollup the 项目 screen renders.
    assert.ok(Object.keys(summary.periods.allTime.clientModels).length > 0);
    assert.ok(Object.keys(summary.periods.allTime.clients).length > 0);
    assert.deepEqual(summary.periods.today.projects, full.periods.today.projects);

    // Per-device headline totals survive for the device list and comparison chart.
    for (const device of summary.devices) {
      assert.equal(typeof device.periods.today.totalTokens, 'number');
      assert.ok(device.periods.today.costUsd >= 0);
    }

    // The summary is also genuinely smaller on the wire.
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
    assert.ok(summaryBytes < fullBytes, `${summaryBytes} !< ${fullBytes}`);
  } finally {
    await hub.stop();
  }
});

test('/api/devices/:id serves one device with its full periods', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await seed(hub, [payload(1000, { deviceId: 'dev-a' }), payload(2000, { deviceId: 'dev-b' })]);

    const detail = await (await fetch(`http://127.0.0.1:${port}/api/devices/dev-b`)).json();
    assert.equal(detail.device.deviceId, 'dev-b');
    assert.equal(detail.device.periods.allTime.totalTokens, 2000);
    assert.ok(Object.keys(detail.device.periods.allTime.sessions).length > 0);
    assert.ok(Object.keys(detail.device.periods.allTime.clientModels).length > 0);

    const missing = await fetch(`http://127.0.0.1:${port}/api/devices/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'device_not_found');
  } finally {
    await hub.stop();
  }
});

test('/api/sessions returns the aggregate list, capped, with the true total', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await seed(hub, [payload(1000, { deviceId: 'dev-a', sessionCount: 120 }), payload(2000, { deviceId: 'dev-b', sessionCount: 120 })]);

    const response = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    assert.ok(response.total > response.shown, 'total should exceed the display cap');
    assert.equal(response.shown, response.sessions.length);
    assert.equal(response.sessions.length, 200);
    // Newest first, and each row names the period it came from.
    for (let i = 1; i < response.sessions.length; i++) {
      assert.ok(String(response.sessions[i - 1].lastUsedAt) >= String(response.sessions[i].lastUsedAt));
    }
    assert.ok(response.sessions.every((row) => ['today', 'month', 'allTime'].includes(row.period)));
    assert.ok(response.sessions[0].models);

    // Scoping to one period filters the list.
    const scoped = await (await fetch(`http://127.0.0.1:${port}/api/sessions?period=today`)).json();
    assert.ok(scoped.sessions.every((row) => row.period === 'today'));
  } finally {
    await hub.stop();
  }
});

test('advanced session and analytics reads share bounded filter contracts', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await seed(hub, [payload(1000, { deviceId: 'dev-a', sessionCount: 5 }), payload(2000, { deviceId: 'dev-b', sessionCount: 5 })]);
    const base = `http://127.0.0.1:${port}`;
    const sessions = await (await fetch(`${base}/api/sessions?period=allTime&deviceId=dev-a&q=session-dev-a-&sort=totalTokens&order=desc&limit=2`)).json();
    assert.equal(sessions.total, 5);
    assert.equal(sessions.sessions.length, 2);
    assert.equal(sessions.sessions[0].sessionId, 'session-dev-a-4');
    assert.ok(sessions.nextCursor);
    const next = await (await fetch(`${base}/api/sessions?period=allTime&deviceId=dev-a&q=session-dev-a-&sort=totalTokens&order=desc&limit=2&cursor=${encodeURIComponent(sessions.nextCursor)}`)).json();
    assert.deepEqual(next.sessions.map((row) => row.sessionId), ['session-dev-a-2', 'session-dev-a-1']);
    const invalid = await fetch(`${base}/api/sessions?limit=1000`);
    assert.equal(invalid.status, 400);

    const query = 'startDate=2026-01-01&endDate=2026-12-31&source=events&groupBy=model&bucket=none&metrics=tokens,cost';
    const analyticsResponse = await fetch(`${base}/api/usage/analytics?${query}`);
    assert.equal(analyticsResponse.status, 200);
    const analytics = await analyticsResponse.json();
    assert.equal(analytics.source, 'usageEventsBestEffort');
    // The shared fixture's ten sessions each carry 500 input + 400 output tokens.
    assert.equal(analytics.totals.totalTokens, 9000);
    assert.equal(analytics.rows[0].model, 'gpt-5');
    const csv = await fetch(`${base}/api/usage/analytics?${query}&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(await csv.text(), /gpt-5/);
  } finally {
    await hub.stop();
  }
});

test('the shared fleet read keeps /api/history and its device scope correct', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await seed(hub, [payload(1000, { deviceId: 'dev-a' }), payload(2000, { deviceId: 'dev-b' })]);

    const fleet = await (await fetch(`http://127.0.0.1:${port}/api/history`)).json();
    const scoped = await (await fetch(`http://127.0.0.1:${port}/api/history?deviceId=dev-b`)).json();
    const unknown = await (await fetch(`http://127.0.0.1:${port}/api/history?deviceId=nope`)).json();

    assert.equal(fleet.summary.totalTokens, 3000);
    assert.equal(scoped.summary.totalTokens, 2000);
    assert.equal(unknown.summary.totalTokens, 0);
  } finally {
    await hub.stop();
  }
});

test('a mutation invalidates the shared fleet read', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await seed(hub, [payload(1000, { deviceId: 'dev-a' })]);

    const before = await (await fetch(`http://127.0.0.1:${port}/api/history`)).json();
    assert.equal(before.summary.totalTokens, 1000);
    // A second read is served from the same normalized bundle.
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/history`)).json()).summary.totalTokens, 1000);

    await hub.ingest(payload(5000, { deviceId: 'dev-b' }));

    const after = await (await fetch(`http://127.0.0.1:${port}/api/history`)).json();
    assert.equal(after.summary.totalTokens, 6000);
  } finally {
    await hub.stop();
  }
});

test('/api/history answers a repeat read with 304 and no body', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await seed(hub, [payload(1000, { deviceId: 'dev-a' })]);

    const first = await fetch(`http://127.0.0.1:${port}/api/history`);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.match(etag, /^"hist-/);
    const body = await first.json();
    assert.equal(body.summary.totalTokens, 1000);

    const second = await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { 'if-none-match': etag }
    });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
    assert.equal(second.headers.get('etag'), etag);

    // A write moves the revision, so the stale validator must not match.
    await hub.ingest(payload(500, { deviceId: 'dev-b' }));
    const afterWrite = await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { 'if-none-match': etag }
    });
    assert.equal(afterWrite.status, 200);
    assert.equal((await afterWrite.json()).summary.totalTokens, 1500);

    // Device-scoped reads carry their own validator and stay independent.
    const scoped = await fetch(`http://127.0.0.1:${port}/api/history?deviceId=dev-a`);
    const scopedTag = scoped.headers.get('etag');
    assert.match(scopedTag, /dev-a"$/);
    assert.equal((await scoped.json()).summary.totalTokens, 1000);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/history?deviceId=dev-a`, {
        headers: { 'if-none-match': scopedTag }
      })).status,
      304
    );
  } finally {
    await hub.stop();
  }
});

test('a large JSON response is gzipped when the client negotiates it', async () => {
  const { hub } = createMemoryHub();
  await hub.start();
  try {
    const { port } = hub.server.address();
    await seed(hub, [payload(1000, { deviceId: 'dev-a', sessionCount: 400 })]);

    const request = (acceptEncoding) => new Promise((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1',
        port,
        path: '/api/stats',
        headers: { 'accept-encoding': acceptEncoding }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
    });

    const raw = await request('identity');
    const compressed = await request('gzip');
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(raw.headers['content-encoding'], undefined);
    assert.equal(compressed.headers.vary, 'accept-encoding');

    // Raw bytes on the socket, before any client-side decoding.
    assert.ok(compressed.body.length < raw.body.length, `${compressed.body.length} !< ${raw.body.length}`);
    assert.deepEqual(
      JSON.parse(zlib.gunzipSync(compressed.body).toString('utf8')),
      JSON.parse(raw.body.toString('utf8'))
    );
  } finally {
    await hub.stop();
  }
});
