#!/usr/bin/env node
'use strict';

// Deliberately dependency-free driver. The target Hub gets its dependencies via
// its own node_modules or NODE_PATH; no install or data directory is touched.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const EPOCH = '2026-10-24T12:00:00.000Z';

function parseOptions(args) {
  const options = { duration: 10, devices: [1, 5, 20, 50], sessions: 40, seed: 613,
    interval: 250, source: ROOT, epoch: EPOCH };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=');
    if (flag === '--help') return { help: true };
    if (!['--duration', '--devices', '--sessions', '--seed', '--interval', '--source', '--output', '--epoch'].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${flag}`);
    const key = flag.slice(2);
    options[key] = ['duration', 'sessions', 'seed', 'interval'].includes(key) ? Number(value)
      : key === 'devices' ? value.split(',').map(Number) : value;
  }
  for (const [key, min, max] of [['duration', 0.1, 3600], ['sessions', 0, 200], ['seed', 1, 0xffffffff], ['interval', 0, 60000]]) {
    if (!Number.isFinite(options[key]) || options[key] < min || options[key] > max
      || (key !== 'duration' && !Number.isInteger(options[key]))) throw new Error(`Invalid --${key}`);
  }
  if (!options.devices.length || options.devices.length > 16
    || options.devices.some((n) => !Number.isInteger(n) || n < 1 || n > 50)) throw new Error('Invalid --devices (1..50)');
  if (!Number.isFinite(Date.parse(options.epoch))) throw new Error('Invalid --epoch');
  options.source = fs.realpathSync(path.resolve(options.source));
  return options;
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeOutputPath(output, scratch = process.env.BUILD_SCRATCH_ROOT || path.join(os.homedir(), '.build')) {
  const resolvedRoot = path.resolve(scratch);
  const project = path.join(os.homedir(), '项目');
  if (within(project, resolvedRoot)) throw new Error('Scratch must not be on the project volume');
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const root = fs.realpathSync(resolvedRoot);
  if (fs.existsSync(project) && within(fs.realpathSync(project), root)) throw new Error('Scratch resolves to the project volume');
  const rootFs = fs.statfsSync(root);
  // Darwin NFS is type 2; Linux NFS/SMB use magic constants. This is an
  // additional guard, not a promise to identify every possible network mount.
  if ((process.platform === 'darwin' && rootFs.type === 2)
    || [0x6969, 0xff534d42, 0xfe534d42].includes(rootFs.type)) throw new Error('Scratch must be on a local filesystem');
  const target = path.resolve(output || path.join(root, 'jiran', 'hub-resource-benchmarks', `${Date.now()}-${process.pid}.json`));
  if (!within(root, target) || target === root) throw new Error('Output must be inside BUILD_SCRATCH_ROOT');
  if (within(project, target)) throw new Error('Output must not be on the project volume');
  // Validate existing ancestors before mkdir, including symlinks out of scratch.
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!within(root, fs.realpathSync(ancestor))) throw new Error('Output ancestor escapes scratch');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!within(root, fs.realpathSync(path.dirname(target)))) throw new Error('Output parent escapes scratch');
  const parentFs = fs.statfsSync(path.dirname(target));
  if ((process.platform === 'darwin' && parentFs.type === 2)
    || [0x6969, 0xff534d42, 0xfe534d42].includes(parentFs.type)) throw new Error('Output must be on a local filesystem');
  if (fs.existsSync(target)) throw new Error('Refusing to overwrite an existing output');
  const free = fs.statfsSync(root);
  if (free.bavail * free.bsize < 20 * 1024 ** 3) throw new Error('Scratch has less than 20 GiB free');
  return target;
}

function makeFixture({ devices = 1, sessions = 40, seed = 613, epoch = EPOCH } = {}) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  return Array.from({ length: devices }, (_, index) => {
    const deviceId = `bench-${String(index).padStart(3, '0')}`;
    const archive = {};
    let tokens = 0;
    for (let j = 0; j < sessions; j++) {
      const totalTokens = 1000 + random() % 9000;
      tokens += totalTokens;
      const lastUsedAt = new Date(Date.parse(epoch) - j * 60000).toISOString();
      archive[`codex:${deviceId}-${j}`] = { client: 'codex', sessionId: `${deviceId}-${j}`,
        projectId: `project-${j % 5}`, projectLabel: `Synthetic project ${j % 5}`,
        totalTokens, inputTokens: totalTokens - 100, outputTokens: 100, messageCount: 12,
        costUsd: totalTokens / 1e6, models: { 'bench-model': totalTokens }, startedAt: lastUsedAt, lastUsedAt };
    }
    tokens ||= 1000 + random() % 9000;
    const period = { totalTokens: tokens, costUsd: tokens / 1e6, clients: { codex: tokens },
      clientCosts: { codex: tokens / 1e6 }, models: { 'bench-model': tokens }, modelCosts: { 'bench-model': tokens / 1e6 },
      clientModels: { codex: { 'bench-model': tokens } }, clientModelCosts: { codex: { 'bench-model': tokens / 1e6 } },
      sessions: archive, projects: { synthetic: { label: 'Synthetic', tokens, costUsd: tokens / 1e6, clients: { codex: tokens } } } };
    const daily = Array.from({ length: 30 }, (_, day) => ({
      date: new Date(Date.parse(epoch) - day * 86400000).toISOString().slice(0, 10),
      tokens, cost: tokens / 1e6, messages: 12, activeTimeMs: 60000,
      perClient: { codex: { tokens, cost: tokens / 1e6 } }, perModel: { 'bench-model': { tokens, cost: tokens / 1e6 } }
    }));
    const monthly = [...new Set(daily.map((d) => d.date.slice(0, 7)))].map((month) => {
      const count = daily.filter((d) => d.date.startsWith(month)).length;
      return { month, tokens: tokens * count, cost: tokens * count / 1e6,
        perClient: { codex: { tokens: tokens * count, cost: tokens * count / 1e6 } },
        perModel: { 'bench-model': { tokens: tokens * count, cost: tokens * count / 1e6 } } };
    });
    return { deviceId, hostname: deviceId, platform: 'linux', agentVersion: '0.0.0-benchmark', updatedAt: epoch,
      trackedClients: ['codex'], today: structuredClone(period), month: structuredClone(period), allTime: structuredClone(period),
      history: { daily, monthly, summary: {} } };
  });
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
    max: sorted.at(-1) ?? null, tailWarning: sorted.length < 100 ? 'Fewer than 100 samples; tail percentiles are descriptive only.' : null };
}

function nextPayload(record, increment, updatedAt) {
  const payload = structuredClone(record);
  payload.updatedAt = updatedAt;
  for (const name of ['today', 'month', 'allTime']) {
    const period = payload[name];
    period.totalTokens += increment; period.clients.codex += increment;
    period.models['bench-model'] += increment; period.clientModels.codex['bench-model'] += increment;
    period.costUsd += increment / 1e6; period.clientCosts.codex += increment / 1e6;
    period.modelCosts['bench-model'] += increment / 1e6; period.clientModelCosts.codex['bench-model'] += increment / 1e6;
    period.projects.synthetic.tokens += increment; period.projects.synthetic.costUsd += increment / 1e6;
    // Advance an actual archived session, not just headline counters: the Hub's
    // ledger derives session deltas when a session archive is present.
    const session = Object.values(period.sessions)[0];
    if (session) {
      session.totalTokens += increment; session.inputTokens += increment;
      session.models['bench-model'] += increment; session.costUsd += increment / 1e6;
      session.lastUsedAt = updatedAt;
    }
  }
  return payload;
}

function instrumentRepository(repository) {
  const calls = {};
  // Count nested calls and transaction work too, using the same harness fake for
  // both target versions. These are method invocations, NOT SQL statement counts.
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(repository))) {
    if (key === 'constructor' || typeof repository[key] !== 'function') continue;
    const original = repository[key];
    repository[key] = function (...args) {
      calls[key] = (calls[key] || 0) + 1;
      return original.apply(this, args);
    };
  }
  return { calls, reset() { for (const key of Object.keys(calls)) delete calls[key]; } };
}

async function worker(options) {
  // An accepted server socket does not call connect(). Block all *outgoing*
  // connections, including accidental localhost MySQL/provider/proxy access.
  require('node:net').Socket.prototype.connect = function () { throw new Error('Benchmark forbids outbound connections'); };
  globalThis.fetch = async () => { throw new Error('Benchmark forbids outbound fetch'); };
  const RealDate = Date;
  const started = performance.now();
  const epochMs = RealDate.parse(options.epoch);
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [epochMs + performance.now() - started])); }
    static now() { return epochMs + Math.floor(performance.now() - started); }
  };
  const { createHub } = require(path.join(options.source, 'src/hub/server.js'));
  const { MemoryRepository } = require(path.join(ROOT, 'tests/hub/memory-repository.js'));
  const repository = new MemoryRepository();
  const counted = instrumentRepository(repository);
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', repository, accountsEnabled: false,
    fleetTimeZone: 'UTC', tls: null, ingestRateLimit: 1000000, sseHeartbeatMs: 1000,
    lookupPricing: async () => null, fallbackPricing: async () => null,
    oauthFetch: globalThis.fetch, logger: { error() {}, warn() {}, info() {} } });
  await hub.start();
  for (const record of makeFixture(options)) await hub.ingest(record, { includeStats: false });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let cpu, resources, beforeMemory, memoryTimer;
  let peak = {};
  let memorySamples = 0;
  const sampleMemory = () => {
    const current = process.memoryUsage();
    memorySamples++;
    for (const [key, value] of Object.entries(current)) peak[key] = Math.max(peak[key] || 0, value);
  };
  process.on('message', async (message) => {
    try {
      if (message === 'begin') {
        counted.reset();
        cpu = process.cpuUsage(); resources = process.resourceUsage(); beforeMemory = process.memoryUsage();
        peak = {}; memorySamples = 0; sampleMemory();
        memoryTimer = setInterval(sampleMemory, 50);
        loop.enable(); loop.reset();
        process.send({ type: 'begin' });
      } else if (message === 'end') {
        clearInterval(memoryTimer); sampleMemory(); loop.disable();
        const afterResources = process.resourceUsage();
        process.send({ type: 'metrics', cpuMicroseconds: process.cpuUsage(cpu),
          memoryBytes: { before: beforeMemory, after: process.memoryUsage(), sampledPeak: peak, samples: memorySamples, intervalMs: 50 },
          resourceUsage: { cumulative: afterResources,
            delta: Object.fromEntries(Object.keys(resources).filter((key) => key !== 'maxRSS').map((key) => [key, afterResources[key] - resources[key]])),
            maxRSSUnit: 'KiB; process lifetime peak includes setup' },
          eventLoopMs: { samples: loop.count, p50: loop.count ? loop.percentile(50) / 1e6 : null,
            p95: loop.count ? loop.percentile(95) / 1e6 : null, p99: loop.count ? loop.percentile(99) / 1e6 : null,
            max: loop.count ? loop.max / 1e6 : null, resolutionMs: 10 }, repositoryCalls: { ...counted.calls } });
      } else if (message === 'stop') {
        clearInterval(memoryTimer); loop.disable(); await hub.stop(); process.disconnect();
      }
    } catch (error) { process.send({ type: 'error', error: error.stack }); }
  });
  process.send({ type: 'ready', port: hub.server.address().port });
}

function waitMessage(child, type, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Worker timeout: ${type}`)), timeout);
    const done = (error, value) => {
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit);
      error ? reject(error) : resolve(value);
    };
    const onMessage = (message) => {
      if (message.type === 'error') done(new Error(message.error));
      else if (message.type === type) done(null, message);
    };
    const onExit = (code) => done(new Error(`Worker exited (${code}) before ${type}`));
    child.on('message', onMessage); child.once('exit', onExit);
  });
}

function request(port, route, payload) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const body = payload ? JSON.stringify(payload) : null;
    const req = http.request({ host: '127.0.0.1', port, path: route, method: body ? 'POST' : 'GET',
      headers: { 'accept-encoding': 'identity', ...(body ? { 'content-type': 'application/json',
        'content-length': Buffer.byteLength(body), prefer: 'return=minimal' } : {}) } }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('error', reject);
      res.on('end', () => res.statusCode === 200 ? resolve({ ms: performance.now() - start, bytes })
        : reject(new Error(`${route}: HTTP ${res.statusCode}`)));
    });
    req.setTimeout(30000, () => req.destroy(new Error(`Request timeout: ${route}`)));
    req.on('error', reject); req.end(body);
  });
}

async function openStream(port, detail) {
  const stats = { bytes: 0, frames: 0, events: {}, initialSnapshotMs: null, errors: [] };
  let req, response;
  await new Promise((resolve, reject) => {
    const start = performance.now();
    let pending = '';
    req = http.get({ host: '127.0.0.1', port, path: `/api/stats/stream${detail === 'slim' ? '?detail=slim' : ''}` }, (res) => {
      response = res;
      if (res.statusCode !== 200) { reject(new Error(`SSE HTTP ${res.statusCode}`)); return; }
      res.on('data', (chunk) => {
        stats.bytes += chunk.length;
        pending += chunk.toString('utf8');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          if (event) {
            stats.frames++; stats.events[event] = (stats.events[event] || 0) + 1;
            if (event === 'snapshot' && stats.initialSnapshotMs === null) {
              stats.initialSnapshotMs = performance.now() - start; req.setTimeout(0); resolve();
            }
          }
        }
      });
      res.on('error', (error) => { stats.errors.push(error.message); reject(error); });
    });
    req.setTimeout(30000, () => req.destroy(new Error('SSE snapshot timeout')));
    req.on('error', reject);
  });
  return { stats, close() { response.destroy(); req.destroy(); } };
}

async function runScenario(options, devices) {
  const env = { PATH: process.env.PATH, HOME: os.homedir(), TZ: 'UTC', NODE_PATH: process.env.NODE_PATH || '' };
  const child = fork(__filename, ['--worker', JSON.stringify({ ...options, devices })], {
    env, cwd: path.dirname(options.output), stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const streams = [];
  try {
    const { port } = await waitMessage(child, 'ready');
    // Warm the read paths once, then open both stream shapes before measurement.
    await request(port, '/api/stats/summary'); await request(port, '/api/stats');
    for (const detail of ['slim', 'full']) streams.push(await openStream(port, detail));
    const initialStreams = streams.map(({ stats }) => structuredClone(stats));
    for (const { stats } of streams) { stats.bytes = 0; stats.frames = 0; stats.events = {}; }
    const beginning = waitMessage(child, 'begin'); child.send('begin'); await beginning;
    const fixture = makeFixture({ ...options, devices });
    const samples = { ingest: [], summary: [], full: [] };
    const bytes = { ingest: 0, summary: 0, full: 0 };
    let rounds = 0;
    const start = performance.now();
    do {
      const roundStart = performance.now();
      const payload = nextPayload(fixture[rounds % devices], Math.floor(rounds / devices) + 1,
        new Date(Date.parse(options.epoch) + rounds * 1000).toISOString());
      for (const [name, route, data] of [['ingest', '/api/ingest', payload], ['summary', '/api/stats/summary'], ['full', '/api/stats']]) {
        const result = await request(port, route, data);
        samples[name].push(result.ms); bytes[name] += result.bytes;
      }
      rounds++;
      const remaining = Math.min(options.interval - (performance.now() - roundStart), options.duration * 1000 - (performance.now() - start));
      if (remaining > 0) await delay(remaining);
    } while (performance.now() - start < options.duration * 1000);
    // Drain already-written stream bytes before taking the final Hub sample.
    await delay(25);
    const measuredMs = performance.now() - start;
    const ending = waitMessage(child, 'metrics'); child.send('end');
    const metrics = await ending;
    const { type: _type, ...hubMetrics } = metrics;
    return { devices, sessionsPerDevicePerPeriod: options.sessions, rounds, measuredMs,
      ...hubMetrics, cpuOneCorePercent: (metrics.cpuMicroseconds.user + metrics.cpuMicroseconds.system) / (measuredMs * 10),
      requests: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name,
        { latencyMs: distribution(values), bodyBytes: bytes[name], meanBodyBytes: bytes[name] / values.length }])),
      sse: { scope: 'Measured interval only; headers/chunk framing excluded. Snapshot setup reported separately.',
        slim: { ...streams[0].stats, setup: initialStreams[0] }, full: { ...streams[1].stats, setup: initialStreams[1] } }, stderr };
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`, { cause: error });
  } finally {
    for (const stream of streams) stream.close();
    child.kill('SIGTERM');
  }
}

async function main(args = process.argv.slice(2)) {
  if (args[0] === '--worker') return worker(JSON.parse(args[1]));
  const options = parseOptions(args);
  if (options.help) {
    console.log('node scripts/benchmark-hub-resources.js [--source DIR] [--duration SECONDS] [--devices 1,5,20,50] [--sessions 40] [--seed 613] [--interval 250] [--epoch ISO] [--output SCRATCH/file.json]');
    return;
  }
  options.output = safeOutputPath(options.output);
  const sourceFiles = ['src/hub/server.js', 'src/hub/repository.js', 'src/shared/usage.js', 'src/shared/http.js'];
  const result = { schemaVersion: 1, createdAt: new Date().toISOString(), options,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
    harnessHashes: Object.fromEntries(['scripts/benchmark-hub-resources.js', 'tests/hub/memory-repository.js']
      .map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')])),
    sourceHashes: Object.fromEntries(sourceFiles.map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(options.source, file))).digest('hex')])),
    fixtureHash: createHash('sha256').update(JSON.stringify(makeFixture({ ...options, devices: 50 }))).digest('hex'),
    scope: 'Real isolated Hub process + deterministic MemoryRepository. No MySQL, providers, TLS, auth, compression or production data. One rotating-device minimal ingest + summary + full read per closed-loop round; one slim and one full SSE subscriber. CPU excludes driver. Repository counters are method calls, not SQL queries.',
    scenarios: [] };
  for (const devices of options.devices) {
    result.scenarios.push(await runScenario(options, devices));
    console.error(`Completed ${devices} devices (${result.scenarios.at(-1).rounds} rounds)`);
  }
  fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(options.output);
  return result;
}

if (require.main === module) main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
module.exports = { parseOptions, safeOutputPath, makeFixture, nextPayload, distribution, instrumentRepository, runScenario, main };
