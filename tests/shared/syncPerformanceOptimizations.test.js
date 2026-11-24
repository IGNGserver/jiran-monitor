'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { buildClaudeDesktopPeriods } = require('../../src/shared/claudeDesktopUsage');
const { retainLiveDailyHistory } = require('../../src/shared/dailyHistoryArchive');
const { createDeviceState } = require('../../src/shared/deviceState');
const { buildPromaPeriods } = require('../../src/shared/promaUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const {
  createSyncHistoryTracker,
  postSyncPayload,
  resetNegotiatedGzipTargets,
  serializeSyncPayload
} = require('../../src/shared/syncPayload');
const { createSyncSummaryTransformer } = require('../../src/shared/syncSummary');
const { createSyncUploadSink } = require('../../src/shared/syncUploadSink');
const { createHub } = require('../../src/hub/server');
const { MemoryRepository } = require('../hub/memory-repository');

test('createSyncSummaryTransformer persists in-place dirty session mutations, throttles writes, and honors projectsScope: allTime', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-sync-perf-'));
  const archiveFile = path.join(tempDir, 'session-usage-archive.json');
  try {
    let currentNowMs = 1_000_000;
    const transformer = createSyncSummaryTransformer({
      archivePath: archiveFile,
      projectsScope: 'allTime',
      writeThrottleMs: 30_000,
      nowMs: () => currentNowMs
    });

    const summary1 = {
      updatedAt: '2026-11-16T00:00:00.000Z',
      projectsEnabled: true,
      periodWindows: {
        timeZone: 'UTC',
        today: { key: '2026-11-16', startMs: Date.parse('2026-11-16T00:00:00.000Z') },
        month: { key: '2026-11', startMs: Date.parse('2026-11-01T00:00:00.000Z') }
      },
      today: {
        totalTokens: 50,
        costUsd: 0.05,
        sessions: {
          'codex:s1': {
            client: 'codex',
            sessionId: 's1',
            totalTokens: 50,
            costUsd: 0.05,
            projectLabel: 'Proj 1',
            lastUsedAt: '2026-11-16T00:00:00.000Z'
          }
        }
      },
      month: {
        totalTokens: 50,
        costUsd: 0.05,
        sessions: {
          'codex:s1': {
            client: 'codex',
            sessionId: 's1',
            totalTokens: 50,
            costUsd: 0.05,
            projectLabel: 'Proj 1',
            lastUsedAt: '2026-11-16T00:00:00.000Z'
          }
        }
      },
      allTime: {
        totalTokens: 50,
        costUsd: 0.05,
        sessions: {
          'codex:s1': {
            client: 'codex',
            sessionId: 's1',
            totalTokens: 50,
            costUsd: 0.05,
            projectLabel: 'Proj 1',
            lastUsedAt: '2026-11-16T00:00:00.000Z'
          }
        }
      }
    };

    const out1 = transformer.transform(summary1, 'startup');
    assert.equal(out1.today.projects, undefined, 'projectsScope: allTime skips today.projects');
    assert.equal(out1.month.projects, undefined, 'projectsScope: allTime skips month.projects');
    assert.equal(out1.allTime.projects['proj 1'].tokens, 50, 'allTime.projects is still computed');
    assert.equal(fs.existsSync(archiveFile), true, 'first dirty mutation writes immediately');

    const statAfterFirst = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
    assert.equal(statAfterFirst.sessions['codex:s1'].periods.today.totalTokens, 50);

    // Rapid watch update within writeThrottleMs updates in-memory archive without hitting disk yet.
    currentNowMs += 1500;
    const summary2 = structuredClone(summary1);
    summary2.today.totalTokens = 90;
    summary2.today.sessions['codex:s1'].totalTokens = 90;
    summary2.month.totalTokens = 90;
    summary2.month.sessions['codex:s1'].totalTokens = 90;
    summary2.allTime.totalTokens = 90;
    summary2.allTime.sessions['codex:s1'].totalTokens = 90;

    transformer.transform(summary2, 'watch');
    const statThrottled = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
    assert.equal(statThrottled.sessions['codex:s1'].periods.today.totalTokens, 50, 'throttled watch tick defers disk write');

    transformer.flush();
    const statFlushed = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
    assert.equal(statFlushed.sessions['codex:s1'].periods.today.totalTokens, 90, 'flush() persists throttled dirty state');

    // When sessions are trimmed on serializeSyncPayload, period projects are derived lazily from sessions.
    const withoutAllTimeProjects = serializeSyncPayload(out1, { omitAllTimeProjects: true, maxBytes: Number.MAX_SAFE_INTEGER });
    const trimmedSerialized = serializeSyncPayload(out1, { maxBytes: withoutAllTimeProjects.bytes - 5 });
    assert.ok(trimmedSerialized.payload.sessionDetailsOmitted?.month > 0);
    assert.equal(trimmedSerialized.payload.month.projects['proj 1'].tokens, 50);
    transformer.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('retainLiveDailyHistory skips reading daily-history-archive.json when writeEnabled is false on watch ticks', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-daily-hist-'));
  const archiveFile = path.join(tempDir, 'daily-history-archive.json');
  try {
    fs.writeFileSync(archiveFile, '{"version":2,"days":{}}', 'utf8');
    let diskReads = 0;
    const origReadFileSync = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (...args) => {
      if (String(args[0] || '') === archiveFile) diskReads += 1;
      return origReadFileSync(...args);
    });

    const todayPeriod = {
      totalTokens: 250,
      costUsd: 0.05,
      clients: { codex: 250 },
      clientCosts: { codex: 0.05 },
      models: { 'gpt-5': 250 },
      modelCosts: { 'gpt-5': 0.05 },
      clientModels: { codex: { 'gpt-5': 250 } },
      clientModelCosts: { codex: { 'gpt-5': 0.05 } }
    };
    const nextLive = retainLiveDailyHistory(todayPeriod, {
      path: archiveFile,
      todayKey: '2026-11-16',
      writeEnabled: false
    });
    assert.equal(diskReads, 0, 'watch tick must not read daily-history-archive.json from disk');
    assert.ok(nextLive.liveDays['2026-11-16'], 'in-memory liveDays captures today observation');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('createDeviceState retainSnapshot: false avoids cloning on headless ticks while guarding __proto__', () => {
  let receivedRecord = null;
  const state = createDeviceState({
    envelope: { deviceId: 'headless-1', agentRuntime: 'headless-agent' },
    retainSnapshot: false,
    emitReturn: false,
    onRecord: (record) => { receivedRecord = record; }
  });
  const sessionsRef = { 'codex:1': { totalTokens: 42 } };
  const maliciousPayload = JSON.parse('{"__proto__":{"polluted":true},"customTag":"ok"}');

  const emitted = state.updateUsage({
    ...maliciousPayload,
    updatedAt: '2026-11-16T00:00:00.000Z',
    today: { totalTokens: 42, sessions: sessionsRef },
    month: { totalTokens: 42 },
    allTime: { totalTokens: 42 }
  }, 'watch');

  assert.equal(emitted, null, 'emitReturn: false skips building a return clone');
  assert.equal(({}).polluted, undefined, '__proto__ must never pollute Object.prototype');
  assert.equal(receivedRecord.today.sessions, sessionsRef, 'retainSnapshot: false forwards reference without deep-cloning');
  assert.equal(state.getSnapshot(), null, 'retainSnapshot: false releases snapshot after publish');
});

test('createSyncHistoryTracker omits acknowledged history, retries unacked history on failure, and resets on 401/404', () => {
  const nowMs = 10_000;
  const tracker = createSyncHistoryTracker({ now: () => nowMs, maxAckAgeMs: 60_000 });
  const historyDoc = { daily: [{ date: '2026-11-15', tokens: 1000, cost: 0.1 }], monthly: [], summary: {} };

  const firstAttempt = tracker.prepare({
    deviceId: 'dev-1',
    periodWindows: { timeZone: 'UTC' },
    today: { totalTokens: 10 },
    history: historyDoc
  }, { targetKey: 'http://hub/api/ingest' });
  assert.equal(firstAttempt.historyOmitted, false);
  assert.ok(firstAttempt.summary.history);
  firstAttempt.handleFailure({ status: 502 });

  const retryAttempt = tracker.prepare({
    deviceId: 'dev-1',
    periodWindows: { timeZone: 'UTC' },
    today: { totalTokens: 20 }
  }, { targetKey: 'http://hub/api/ingest' });
  assert.equal(retryAttempt.historyOmitted, false);
  assert.deepEqual(retryAttempt.summary.history, historyDoc);
  retryAttempt.commitAck();

  const steadyTick = tracker.prepare({
    deviceId: 'dev-1',
    periodWindows: { timeZone: 'UTC' },
    today: { totalTokens: 30 },
    history: historyDoc
  }, { targetKey: 'http://hub/api/ingest' });
  assert.equal(steadyTick.historyOmitted, true);
  assert.equal(Object.hasOwn(steadyTick.summary, 'history'), false);

  steadyTick.handleFailure({ status: 404 });
  const afterReset = tracker.prepare({
    deviceId: 'dev-1',
    periodWindows: { timeZone: 'UTC' },
    today: { totalTokens: 40 }
  }, { targetKey: 'http://hub/api/ingest' });
  assert.equal(afterReset.historyOmitted, false);
  assert.deepEqual(afterReset.summary.history, historyDoc);
});

test('createSyncUploadSink coalesces rapid watch bursts and deduplicates unchanged watch payloads', async () => {
  const sent = [];
  const sink = createSyncUploadSink({
    intervalMs: 0,
    watchIntervalMs: 40,
    dedupeWatchUnchanged: true,
    upload: async (summary) => {
      sent.push(summary.today.totalTokens);
    }
  });

  const makeSummary = (tokens) => ({
    deviceId: 'dev-watch',
    today: { totalTokens: tokens },
    month: { totalTokens: tokens },
    allTime: { totalTokens: tokens }
  });

  // First watch update after idle goes out immediately at 0ms latency.
  await sink.enqueue(makeSummary(100), 1, { reason: 'watch' });
  assert.deepEqual(sent, [100]);

  // Duplicate watch update with identical payload is skipped completely.
  const dup = await sink.enqueue(makeSummary(100), 2, { reason: 'watch' });
  assert.equal(dup.skipped, true);
  assert.deepEqual(sent, [100]);

  // Rapid burst of changed watch updates within 40ms coalesces to the latest revision (130).
  await sink.enqueue(makeSummary(110), 3, { reason: 'watch' });
  await sink.enqueue(makeSummary(120), 4, { reason: 'watch' });
  await sink.enqueue(makeSummary(130), 5, { reason: 'watch' });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(sent, [100, 130]);

  sink.stop();
});

test('postSyncPayload negotiates gzip ingest end-to-end with Hub, preserves omitted history, and falls back on 415', async () => {
  resetNegotiatedGzipTargets();
  const repository = new MemoryRepository();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'perf-secret',
    repository,
    logger: { error() {}, warn() {} }
  });
  await hub.start();
  const { port } = hub.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ingestUrl = `${baseUrl}/api/ingest`;
  const tracker = createSyncHistoryTracker();

  const wireSeen = [];
  const observingFetch = async (url, options) => {
    wireSeen.push({
      encoding: options.headers?.['content-encoding'] || null,
      bytes: Buffer.isBuffer(options.body) ? options.body.length : Buffer.byteLength(String(options.body || ''), 'utf8')
    });
    return fetch(url, options);
  };

  try {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const todayEndsAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    ).toISOString();
    const firstUpdatedAt = new Date(now.getTime() - 5_000).toISOString();
    const secondUpdatedAt = now.toISOString();
    const daily = Array.from({ length: 60 }, (_, idx) => ({
      date: new Date(Date.UTC(2026, 8, 1 + idx)).toISOString().slice(0, 10),
      tokens: 10_000 + idx,
      cost: 0.05,
      perClient: { codex: { tokens: 10_000 + idx, cost: 0.05 } },
      perModel: { 'gpt-5': { tokens: 10_000 + idx, cost: 0.05 } }
    }));
    const sessions = {};
    for (let i = 0; i < 20; i += 1) {
      sessions[`codex:sess-${i}`] = {
        client: 'codex',
        sessionId: `sess-${i}`,
        totalTokens: 500,
        costUsd: 0.01,
        models: { 'gpt-5': 500 },
        modelCosts: { 'gpt-5': 0.01 }
      };
    }

    // Upload 1: uncompressed discovery + full history.
    const res1 = await postSyncPayload(observingFetch, ingestUrl, {
      headers: { 'content-type': 'application/json', authorization: 'Bearer perf-secret' },
      historyTracker: tracker,
      summary: {
        deviceId: 'dev-e2e',
        updatedAt: firstUpdatedAt,
        periodWindows: { timeZone: 'UTC', today: { key: todayKey, endsAt: todayEndsAt } },
        today: { totalTokens: 10_000, costUsd: 0.2, clients: { codex: 10_000 }, sessions },
        month: { totalTokens: 10_000, costUsd: 0.2, clients: { codex: 10_000 }, sessions },
        allTime: { totalTokens: 600_000, costUsd: 3.0, clients: { codex: 600_000 } },
        history: { daily, monthly: [], summary: {} }
      }
    });
    assert.equal(res1.response.status, 200);
    assert.equal(wireSeen[0].encoding, null, 'first upload probes without assuming gzip support');

    // Upload 2: history omitted (already acked) AND gzip-compressed automatically!
    const res2 = await postSyncPayload(observingFetch, ingestUrl, {
      headers: { 'content-type': 'application/json', authorization: 'Bearer perf-secret' },
      historyTracker: tracker,
      summary: {
        deviceId: 'dev-e2e',
        updatedAt: secondUpdatedAt,
        periodWindows: { timeZone: 'UTC', today: { key: todayKey, endsAt: todayEndsAt } },
        today: { totalTokens: 12_500, costUsd: 0.25, clients: { codex: 12_500 }, sessions },
        month: { totalTokens: 12_500, costUsd: 0.25, clients: { codex: 12_500 }, sessions },
        allTime: { totalTokens: 602_500, costUsd: 3.05, clients: { codex: 602_500 } },
        history: { daily, monthly: [], summary: {} }
      }
    });
    assert.equal(res2.response.status, 200);
    assert.equal(res2.payload.history, undefined, 'acked history is omitted on subsequent uploads');
    assert.equal(wireSeen[1].encoding, 'gzip', 'second upload uses negotiated gzip');
    assert.ok(wireSeen[1].bytes < wireSeen[0].bytes / 5, 'staged history + gzip cuts wire bytes dramatically');

    // Verify Hub retained all 60 history days AND updated today's tokens to 12,500!
    const statsRes = await fetch(`${baseUrl}/api/stats`, {
      headers: { authorization: 'Bearer perf-secret' }
    });
    const stats = await statsRes.json();
    assert.equal(stats.periods.today.totalTokens, 12_500);
    const historyRes = await fetch(`${baseUrl}/api/history`, {
      headers: { authorization: 'Bearer perf-secret' }
    });
    const historyBody = await historyRes.json();
    assert.equal(historyBody.daily.length, 60);
  } finally {
    await hub.stop();
  }

  // Verify 415 reverse-proxy rejection falls back to uncompressed and disables gzip for that URL.
  const proxyCalls = [];
  const proxyUrl = 'http://broken-proxy/api/ingest';
  const largeSummary = {
    deviceId: 'dev-proxy',
    today: {
      totalTokens: 5000,
      sessions: Object.fromEntries(
        Array.from({ length: 15 }, (_, idx) => [`codex:p-${idx}`, { client: 'codex', sessionId: `p-${idx}`, totalTokens: 100 }])
      )
    },
    month: { totalTokens: 5000 },
    allTime: { totalTokens: 5000 }
  };
  const proxyFetch = async (_url, options) => {
    const enc = options.headers?.['content-encoding'] || null;
    proxyCalls.push(enc);
    if (enc === 'gzip') {
      return new Response(JSON.stringify({ error: 'unsupported_encoding' }), { status: 415 });
    }
    const decoded = Buffer.isBuffer(options.body)
      ? JSON.parse(zlib.gunzipSync(options.body).toString('utf8'))
      : JSON.parse(options.body);
    assert.equal(decoded.deviceId, 'dev-proxy');
    return new Response(JSON.stringify({ ok: true, deviceId: 'dev-proxy' }), {
      status: 200,
      headers: { 'x-jiran-accept-ingest-encoding': 'gzip' }
    });
  };

  await postSyncPayload(proxyFetch, proxyUrl, { summary: { deviceId: 'dev-proxy', allTime: { totalTokens: 1 } } });
  const fallbackRes = await postSyncPayload(proxyFetch, proxyUrl, { summary: largeSummary });
  assert.equal(fallbackRes.response.status, 200);
  const nextRes = await postSyncPayload(proxyFetch, proxyUrl, { summary: largeSummary });
  assert.equal(nextRes.response.status, 200);
  assert.deepEqual(proxyCalls, [null, 'gzip', null, null]);
  resetNegotiatedGzipTargets();
});

test('claudeDesktopUsage and promaUsage cache parsed rows by mtimeMs + size and re-read on modification', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-adapter-cache-'));
  const claudeAppDir = path.join(tempRoot, 'Claude');
  const sessionHome = path.join(claudeAppDir, 'local-agent-mode-sessions', 'acct', '0000', 'local_demo');
  const claudeProjects = path.join(sessionHome, '.claude', 'projects', 'workspace');
  const claudeFile = path.join(claudeProjects, 'sess-alpha.jsonl');
  const promaDir = path.join(tempRoot, 'proma-sessions');
  fs.mkdirSync(claudeProjects, { recursive: true });
  fs.mkdirSync(promaDir, { recursive: true });

  fs.writeFileSync(`${sessionHome}.json`, JSON.stringify({
    sessionId: 'local_demo',
    cliSessionId: 'sess-alpha',
    title: 'Cache test',
    userSelectedFolders: [],
    model: 'claude-sonnet-5'
  }), 'utf8');
  fs.writeFileSync(
    claudeFile,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-16T01:00:00.000Z',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }
    })}\n`,
    'utf8'
  );
  const promaFile = path.join(promaDir, 'sess-p1.jsonl');
  fs.writeFileSync(
    promaFile,
    `${JSON.stringify({
      type: 'assistant',
      _createdAt: Date.parse('2026-11-16T01:00:00.000Z'),
      message: {
        id: 'pmsg-1',
        model: 'deepseek-v4-pro',
        usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }
    })}\n`,
    'utf8'
  );

  let transcriptReads = 0;
  const origReadFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args) => {
    const target = String(args[0] || '');
    if (target === claudeFile || target === promaFile) transcriptReads += 1;
    return origReadFileSync(...args);
  });

  try {
    const claudeOpts = { roots: [claudeAppDir], now: new Date('2026-11-16T12:00:00.000Z') };
    const promaOpts = { roots: [promaDir], now: new Date('2026-11-16T12:00:00.000Z') };

    const c1 = extractUsageFromTokscale(buildClaudeDesktopPeriods(claudeOpts).allTime);
    const p1 = extractUsageFromTokscale(buildPromaPeriods(promaOpts).allTime);
    assert.equal(c1.totalTokens, 150);
    assert.equal(p1.totalTokens, 280);
    assert.equal(transcriptReads, 2, 'cold scan reads each transcript once');

    const c2 = extractUsageFromTokscale(buildClaudeDesktopPeriods(claudeOpts).allTime);
    const p2 = extractUsageFromTokscale(buildPromaPeriods(promaOpts).allTime);
    assert.equal(c2.totalTokens, 150);
    assert.equal(p2.totalTokens, 280);
    assert.equal(transcriptReads, 2, 'warm scan skips fs.readFileSync when mtimeMs and size are unchanged');

    fs.appendFileSync(
      promaFile,
      `${JSON.stringify({
        type: 'assistant',
        _createdAt: Date.parse('2026-11-16T02:00:00.000Z'),
        message: {
          id: 'pmsg-2',
          model: 'deepseek-v4-pro',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }
      })}\n`,
      'utf8'
    );
    const p3 = extractUsageFromTokscale(buildPromaPeriods(promaOpts).allTime);
    assert.equal(p3.totalTokens, 400);
    assert.equal(transcriptReads, 3, 'modified file is re-read exactly once');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
