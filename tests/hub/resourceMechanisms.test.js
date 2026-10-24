'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFleetReadModel } = require('../../src/hub/fleetReadModel');
const { createLatestPublisher } = require('../../src/hub/latestPublisher');
const { createHub } = require('../../src/hub/server');
const { normalizeDeviceRecord, aggregateHistory } = require('../../src/shared/usage');
const { historyRevision, deviceHistoryRevision } = require('../../src/shared/history');
const { computePeriodWindows } = require('../../src/shared/fleetTimeZone');
const { MemoryRepository } = require('./memory-repository');

const AT = Date.parse('2026-07-18T12:00:00Z');
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message, ms = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function record(deviceId = 'dev-a', tokens = 100, at = AT) {
  const period = {
    totalTokens: tokens, clients: { codex: tokens }, models: { 'gpt-5': tokens },
    sessions: { 'codex:s1': { client: 'codex', sessionId: 's1', totalTokens: tokens, inputTokens: tokens } }
  };
  return {
    deviceId, updatedAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString(),
    today: period, month: period, allTime: period
  };
}

function readModel(rows, options = {}) {
  let calls = 0;
  const model = createFleetReadModel({
    store: { async listDeviceRecords() { calls++; return structuredClone(rows); } },
    staleAfterMs: 1000, timeZone: 'UTC', now: () => AT, ...options
  });
  return { model, calls: () => calls };
}

test('fleet reads normalize once, share concurrent cold reads and retain unchanged aggregates', async () => {
  const { model, calls } = readModel([record(), record('dev-b', 40)]);
  const [full, summary, history] = await Promise.all([model.usage(), model.usage({ summary: true }), model.history()]);
  assert.equal(calls(), 1);
  assert.equal(model.metrics().normalizedDevices, 2);
  assert.equal(full.periods.allTime.totalTokens, 140);
  assert.equal(summary.periods.allTime.totalTokens, 140);
  const before = model.metrics();
  model.put(normalizeDeviceRecord(record()), { normalized: true });
  const again = await model.usage();
  await model.usage({ summary: true });
  assert.strictEqual(again.periods, full.periods, 'no-change writes must reuse the heavy fold, not merely return equal totals');
  assert.strictEqual(await model.history(), history);
  assert.deepEqual(model.metrics(), before);
});

test('a committed normalized contribution is not normalized again on warm reads', async () => {
  const { model } = readModel([record()]);
  await model.usage();
  const normalized = normalizeDeviceRecord(record('dev-a', 120));
  model.put(normalized, { normalized: true });
  const [full, summary] = await Promise.all([model.usage(), model.usage({ summary: true })]);
  assert.equal(full.periods.allTime.totalTokens, 120);
  assert.equal(summary.periods.allTime.totalTokens, 120);
  assert.equal(model.metrics().normalizedDevices, 1, 'only the initial database row needs normalization');
  assert.strictEqual((await model.getRecords())[0], normalized);
});

test('a stats snapshot derives usage and history from one record set and one clock instant', async () => {
  let clockReads = 0;
  const { model, calls } = readModel([record()], { now: () => AT + clockReads++ * 1000 });
  const snapshot = await model.snapshot({ summary: true });
  assert.equal(calls(), 1);
  assert.equal(clockReads, 1);
  assert.equal(snapshot.stats.updatedAt, new Date(AT).toISOString());
  assert.equal(snapshot.stats.periods.allTime.totalTokens, 100);
  assert.equal(snapshot.history.revision, historyRevision(snapshot.history.document));
  assert.equal(model.metrics().fullBuilds, 0);
});

test('single-device cold reads use the indexed lookup without loading or aggregating the fleet', async () => {
  let indexed = 0;
  const { model, calls } = readModel([], { store: {
    async listDeviceRecords() { throw new Error('single-device read loaded the fleet'); },
    async getActiveDeviceRecord(id) { indexed++; return id === 'dev-a' ? record() : null; }
  } });
  const first = await model.device('dev-a');
  assert.equal(first.periods.allTime.totalTokens, 100);
  assert.equal((await model.device('dev-a')).detailRevision, first.detailRevision);
  assert.equal(await model.device('missing'), null);
  assert.equal(indexed, 2, 'the cached device is reused, but a missing id is checked');
  assert.equal(calls(), 0);
  assert.deepEqual(model.metrics(), { fleetReads: 0, normalizedDevices: 1, fullBuilds: 0, summaryBuilds: 0, historyBuilds: 0 });
});

test('summary has no full build or session fold and retains aggregate provenance', async () => {
  const raw = record();
  raw.allTime = { ...raw.allTime, clientEstimated: { codex: true }, clientCredits: { codex: 2 } };
  const normalized = normalizeDeviceRecord(raw);
  // This catches a disguised full build even if its fullBuilds counter is wrong.
  normalized.periods.allTime.sessions = new Proxy(normalized.periods.allTime.sessions, {
    ownKeys() { throw new Error('summary walked the session archive'); }
  });
  const { model } = readModel([]);
  model.put(normalized, { normalized: true });
  const summary = await model.usage({ summary: true });
  assert.equal(summary.detail, 'summary');
  assert.equal(summary.periods.allTime.totalTokens, 100);
  assert.equal(summary.periods.allTime.clientEstimated.codex, true);
  assert.equal(summary.periods.allTime.clientCredits.codex, 2);
  assert.equal(summary.periods.allTime.clientMeasurements.codex.tokens, 'estimated');
  assert.equal(summary.periods.allTime.sessions, undefined);
  assert.equal(summary.devices[0].periods.allTime.clients, undefined);
  assert.equal(model.metrics().fullBuilds, 0);
  assert.equal(model.metrics().summaryBuilds, 1);
});

test('presence advances without a heavy fold and receivedAt heartbeats restore freshness', async () => {
  let at = AT;
  const { model } = readModel([record()], { now: () => at });
  const first = await model.usage();
  assert.equal(await model.nextBoundary(), AT + 1001);
  at += 1001;
  const stale = await model.usage();
  assert.equal(stale.devices[0].stale, true);
  assert.equal(stale.devices[0].ageMs, 1001);
  assert.strictEqual(stale.periods, first.periods);
  assert.equal(model.metrics().fullBuilds, 1);
  const heartbeat = { ...record(), receivedAt: new Date(at).toISOString() };
  model.put(heartbeat);
  const fresh = await model.usage();
  assert.equal(fresh.devices[0].stale, false);
  assert.equal(fresh.devices[0].receivedAt, heartbeat.receivedAt);
  assert.equal(fresh.devices[0].detailRevision, first.devices[0].detailRevision);
  assert.strictEqual(fresh.periods, first.periods);
  assert.equal(model.metrics().fullBuilds, 1);
});

test('calendar expiry invalidates today/month exactly at producer boundaries, not stale deadlines', async () => {
  let at = Date.parse('2026-07-31T23:59:59Z');
  const raw = { ...record('dev-a', 100, at), periodWindows: computePeriodWindows(new Date(at), 'UTC') };
  const { model } = readModel([raw], { now: () => at, staleAfterMs: 60000 });
  const before = await model.usage();
  assert.equal(before.periods.today.totalTokens, 100);
  assert.equal(await model.nextBoundary(), Date.parse('2026-08-01T00:00:00Z'));
  at += 1000;
  const after = await model.usage();
  assert.equal(after.periods.today.totalTokens, 0);
  assert.equal(after.periods.month.totalTokens, 0);
  assert.equal(after.periods.allTime.totalTokens, 100);
  assert.notEqual(after.devices[0].detailRevision, before.devices[0].detailRevision);
  assert.notDeepEqual(after.sessionRevision, before.sessionRevision);
  assert.equal((await model.device('dev-a')).periods.today.totalTokens, 0);
  assert.equal(model.metrics().normalizedDevices, 1);
  assert.equal(model.metrics().fullBuilds, 2);
  assert.equal((await model.getRecords())[0].periods.today.totalTokens, 100, 'expiry is a projection, never a mutation of the source');
});

test('legacy timestamp day changes expire periods even when counters are unchanged', async () => {
  let at = Date.parse('2026-07-19T12:00:00Z');
  const { model } = readModel([record()], { now: () => at });
  assert.equal((await model.usage()).periods.today.totalTokens, 0);
  model.put(record('dev-a', 100, at));
  assert.equal((await model.usage()).periods.today.totalTokens, 100);
  at += 1000;
  assert.equal((await model.usage()).periods.today.totalTokens, 100);
  assert.equal(model.metrics().fullBuilds, 2);
});

for (const scenario of [
  { name: 'today', explicit: 'month', before: '2026-07-18T23:59:59Z' },
  { name: 'month', explicit: 'today', before: '2026-07-31T23:59:59Z' }
]) {
  test(`partial periodWindows refreshes the missing ${scenario.name} UTC window with unchanged counters`, async () => {
    let at = Date.parse(scenario.before);
    const raw = { ...record('dev-a', 100, at), periodWindows: {
      [scenario.explicit]: computePeriodWindows(new Date(at), 'UTC')[scenario.explicit]
    } };
    const { model } = readModel([raw], { now: () => at });
    await Promise.all([model.usage(), model.usage({ summary: true })]);
    at += 2000;
    const expired = await model.usage();
    const expiredSummary = await model.usage({ summary: true });
    assert.equal(expired.periods[scenario.name].totalTokens, 0);
    assert.equal(expiredSummary.periods[scenario.name].totalTokens, 0);
    const builds = model.metrics();
    model.put({ ...raw, updatedAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString() });
    const [full, summary, detail] = await Promise.all([
      model.usage(), model.usage({ summary: true }), model.device('dev-a')
    ]);
    for (const stats of [full, summary]) {
      assert.equal(stats.periods[scenario.name].totalTokens, 100);
      assert.equal(stats.devices[0].periods[scenario.name].totalTokens, detail.periods[scenario.name].totalTokens);
      assert.equal(stats.devices[0].detailRevision, detail.detailRevision);
      assert.equal(stats.periods.allTime.totalTokens, 100);
    }
    assert.equal(detail.periods[scenario.name].totalTokens, 100);
    assert.notEqual(full.devices[0].detailRevision, expired.devices[0].detailRevision);
    assert.equal(model.metrics().fullBuilds, builds.fullBuilds + 1);
    assert.equal(model.metrics().summaryBuilds, builds.summaryBuilds + 1);
  });
}

test('history revisions follow archive/availability changes but not receivedAt-only heartbeats', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: AT });
  const raw = { ...record(), historyAvailable: true, history: {
    daily: [{ date: '2026-07-18', tokens: 100, cost: 0.01, perClient: { codex: { tokens: 100, cost: 0.01 } } }],
    monthly: [], summary: {}
  } };
  const { model } = readModel([raw]);
  const first = await model.history();
  model.put({ ...raw, receivedAt: '2026-07-18T12:01:00Z' });
  assert.strictEqual(await model.history(), first, 'a heartbeat does not invalidate the archive');
  const changed = structuredClone(raw);
  changed.history.daily[0].tokens = 120;
  changed.history.daily[0].perClient.codex.tokens = 120;
  model.put(changed);
  const second = await model.history();
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.deviceRevision, first.deviceRevision);
  assert.equal(second.revision, historyRevision(second.document));
  assert.equal(second.deviceRevision, deviceHistoryRevision(await model.getRecords()));
  model.put({ ...changed, historyAvailable: false });
  const unavailable = await model.history();
  assert.equal(unavailable.revision, second.revision);
  assert.notEqual(unavailable.deviceRevision, second.deviceRevision);
});

test('history advances across midnight without uploads and scoped revisions match returned documents', async (t) => {
  let at = Date.parse('2026-07-18T23:59:59Z');
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const raw = { ...record('dev-a', 100, at), history: {
    daily: [{ date: '2026-07-18', tokens: 100, cost: 0.01 }], monthly: [], summary: {}
  } };
  const { model } = readModel([raw], { now: () => at });
  const before = await model.history();
  at += 1000;
  t.mock.timers.tick(1000);
  const after = await model.history();
  assert.equal(model.metrics().historyBuilds, 2);
  assert.notEqual(after.revision, before.revision, 'calendar-dependent history/streak summary must change at midnight');
  const expected = aggregateHistory(await model.getRecords(), { normalized: true, fallbackTodayKey: '2026-07-19' });
  assert.deepEqual(after.document, expected);
  const scoped = await model.history('dev-a');
  assert.deepEqual(scoped.document, expected);
  assert.equal(scoped.revision, historyRevision(scoped.document));
});

test('cold SELECT cannot overwrite a newer put or resurrect a removed device', async () => {
  const gate = deferred();
  const { model } = readModel([], { store: { listDeviceRecords: () => gate.promise } });
  const waiting = model.getRecords();
  model.put(record('dev-a', 120));
  model.remove('dev-b');
  gate.resolve([record(), record('dev-b', 40)]);
  const rows = await waiting;
  assert.deepEqual(rows.map((entry) => [entry.deviceId, entry.periods.allTime.totalTokens]), [['dev-a', 120]]);
});

test('reset during a cold SELECT keeps one physical read in flight and discards its stale result', async () => {
  const gate = deferred();
  let reads = 0;
  let active = 0;
  let peak = 0;
  const { model } = readModel([], { store: { async listDeviceRecords() {
    reads++;
    active++;
    peak = Math.max(peak, active);
    try { return reads === 1 ? await gate.promise : [record('dev-a', 120)]; }
    finally { active--; }
  } } });
  const first = model.usage();
  model.reset();
  const second = model.usage({ summary: true });
  assert.equal(reads, 1);
  gate.resolve([record('dev-a', 10)]);
  const results = await Promise.all([first, second]);
  assert.equal(peak, 1);
  assert.equal(reads, 2);
  assert.ok(results.every((result) => result.periods.allTime.totalTokens === 120));
  assert.equal(model.metrics().normalizedDevices, 1, 'invalidated rows must not even be normalized');
});

test('latest publisher coalesces a burst and builds only one follow-up while a slow publish runs', async () => {
  const entered = deferred();
  const release = deferred();
  const reasons = [];
  let active = 0;
  let peak = 0;
  const publisher = createLatestPublisher({ delayMs: 0, async publish(reason) {
    active++;
    peak = Math.max(peak, active);
    reasons.push(reason);
    if (reasons.length === 1) { entered.resolve(); await release.promise; }
    active--;
  } });
  try {
    const initial = publisher.request('first');
    publisher.request('latest-before-build');
    await entered.promise;
    const requests = Array.from({ length: 100 }, (_, index) => publisher.request(`during-${index}`));
    assert.deepEqual(publisher.metrics(), { builds: 1, active: true, dirty: true });
    release.resolve();
    await Promise.all([initial, ...requests]);
    assert.deepEqual(reasons, ['latest-before-build', 'during-99']);
    assert.equal(peak, 1);
    assert.deepEqual(publisher.metrics(), { builds: 2, active: false, dirty: false });
  } finally { release.resolve(); await publisher.close(); }
});

test('latest publisher recovers from a failed build and close drains active work without a trailing build', { timeout: 3000 }, async () => {
  const errors = [];
  let builds = 0;
  const entered = deferred();
  const release = deferred();
  const publisher = createLatestPublisher({ delayMs: 0, onError: (error) => errors.push(error.message), async publish() {
    builds++;
    if (builds === 1) throw new Error('read_failed');
    entered.resolve();
    await release.promise;
  } });
  try {
    await publisher.request();
    assert.deepEqual(errors, ['read_failed']);
    const running = publisher.request('recovered');
    await within(entered.promise, 'request immediately after failed completion was stranded');
    publisher.request('discard-on-close');
    const closing = publisher.close();
    release.resolve();
    await Promise.all([running, closing]);
    await publisher.request('after-close');
    assert.equal(builds, 2);
    assert.deepEqual(publisher.metrics(), { builds: 2, active: false, dirty: false });
  } finally { release.resolve(); await publisher.close(); }
});

test('a request immediately after a completed publication cannot be left dirty without an active builder', { timeout: 3000 }, async () => {
  const reasons = [];
  const publisher = createLatestPublisher({ delayMs: 0, publish: async (reason) => { reasons.push(reason); } });
  try {
    await publisher.request('first');
    await within(publisher.request('second'), 'second publication was lost between completion and active cleanup');
    assert.deepEqual(reasons, ['first', 'second']);
  } finally { await publisher.close(); }
});

test('a completed publication releases its callers even while newer work is blocked', { timeout: 3000 }, async () => {
  const entered = deferred();
  const releaseFirst = deferred();
  const enteredSecond = deferred();
  const releaseSecond = deferred();
  let builds = 0;
  const publisher = createLatestPublisher({ delayMs: 0, async publish() {
    builds++;
    if (builds === 1) { entered.resolve(); await releaseFirst.promise; }
    else { enteredSecond.resolve(); await releaseSecond.promise; }
  } });
  try {
    const first = publisher.request('first');
    await entered.promise;
    const second = publisher.request('newer');
    releaseFirst.resolve();
    await within(first, 'completed version waited for the continuously dirty publisher to drain');
    await within(enteredSecond.promise, 'newer publication never started');
    assert.equal(builds, 2);
    releaseSecond.resolve();
    await second;
  } finally { releaseFirst.resolve(); releaseSecond.resolve(); await publisher.close(); }
});

function memoryHub(repository = new MemoryRepository()) {
  return { repository, hub: createHub({ repository, host: '127.0.0.1', port: 0, accountsEnabled: false,
    logger: { warn() {}, error() {} } }) };
}

test('summary-only Hub reads and subsequent unchanged ingests never build the full fleet', async () => {
  const { hub } = memoryHub();
  try {
    await hub.ingest(record('dev-a', 100, Date.now()));
    const summary = await hub.getStatsSummary();
    const before = hub.getResourceMetrics();
    await hub.ingest(record('dev-a', 100, Date.now()));
    const next = await hub.getStatsSummary();
    assert.equal(next.periods.allTime.totalTokens, summary.periods.allTime.totalTokens);
    assert.equal(hub.getResourceMetrics().fullBuilds, 0);
    assert.equal(hub.getResourceMetrics().summaryBuilds, before.summaryBuilds);
    assert.equal(hub.getResourceMetrics().normalizedDevices, before.normalizedDevices);
    assert.equal(hub.getResourceMetrics().fleetReads, before.fleetReads);
  } finally { await hub.stop(); }
});

test('a committed ingest returns record/stats:null when the optional post-commit fleet read fails', async () => {
  const { hub, repository } = memoryHub();
  repository.listDeviceRecords = async () => { throw new Error('fleet_read_failed_after_commit'); };
  try {
    const result = await hub.ingest(record(), { includeStats: true });
    assert.equal(result.record.deviceId, 'dev-a');
    assert.equal(result.record.periods.allTime.totalTokens, 100);
    assert.equal(result.stats, null);
    assert.equal((await repository.getDeviceRecord('dev-a')).periods.allTime.totalTokens, 100);
    assert.equal(repository.events.reduce((sum, event) => sum + event.totalTokens, 0), 100);
  } finally { await hub.stop(); }
});

test('HTTP ingest does not report 400 after commit when response stats fail', async () => {
  const { hub, repository } = memoryHub();
  repository.listDeviceRecords = async () => { throw new Error('fleet_read_failed_after_commit'); };
  await hub.start();
  try {
    const response = await fetch(`http://127.0.0.1:${hub.server.address().port}/api/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record())
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.stats, null);
    assert.equal(body.ok, true);
    assert.equal((await repository.getDeviceRecord('dev-a')).periods.allTime.totalTokens, 100);
  } finally { await hub.stop(); }
});
