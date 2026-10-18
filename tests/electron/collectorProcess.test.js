'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createCollectorProcess, serializableOptions } = require('../../src/electron/collectorProcess');
const { runCollectorHost } = require('../../src/electron/collectorHost');

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 6) { for (let i = 0; i < rounds; i += 1) await tick(); }

/**
 * A fake utilityProcess.fork: the host runs in this process, connected through
 * two emitters that deliver asynchronously and structured-clone every message,
 * the way the real message port does.
 */
function fakeFork(fakeStartCollector) {
  const forks = [];
  const fork = (entryPath, args, options) => {
    const child = new EventEmitter();
    const hostPort = new EventEmitter();
    child.entryPath = entryPath;
    child.options = options;
    child.alive = true;
    child.postMessage = (message) => {
      const copy = structuredClone(message);
      setImmediate(() => { if (child.alive) hostPort.emit('message', { data: copy }); });
    };
    hostPort.postMessage = (message) => {
      const copy = structuredClone(message);
      setImmediate(() => { if (child.alive) child.emit('message', copy); });
    };
    child.kill = () => { child.alive = false; };
    child.crash = (code = 1) => { child.alive = false; child.emit('exit', code); };
    child.host = runCollectorHost(hostPort, {
      startCollector: fakeStartCollector,
      pidPaths: [],
      setInterval: () => null,
      clearInterval: () => {},
      oneshots: {
        async collectCustomRangeOnce(args) {
          if (args.range === 'bad') throw Object.assign(new Error('range_failed'), { code: 'range_failed' });
          if (args.range === 'hang') return new Promise(() => {});
          return { period: { totalTokens: 42 }, echoed: args };
        }
      }
    });
    forks.push(child);
    return child;
  };
  return { fork, forks };
}

function fakeCollectorFactory() {
  const collectors = [];
  const startCollector = (options) => {
    const collector = {
      options,
      stopped: false,
      ticks: [],
      async tick(reason, tickOptions) {
        collector.ticks.push({ reason, tickOptions });
        const visible = await options.onUpdate({ updatedAt: 'u1', today: { totalTokens: 5 }, raw: true }, reason);
        collector.lastVisible = visible;
        return true;
      },
      async refreshClient(clientId) {
        if (clientId === 'bogus') throw new TypeError('Unsupported targeted usage client: bogus');
        return true;
      },
      stop(stopOptions) { collector.stopped = stopOptions || true; },
      getDiagnostics: () => ({ state: 'idle', ticks: collector.ticks.length })
    };
    collectors.push(collector);
    return collector;
  };
  return { startCollector, collectors };
}

test('only data crosses the process boundary; the archive gate becomes a token', () => {
  const wire = serializableOptions({
    clients: 'claude,codex',
    intervalMs: 1000,
    onUpdate() {},
    onError() {},
    logger() {},
    dailyHistoryArchiveWriteEnabled: () => true
  });
  assert.deepEqual(wire, { clients: 'claude,codex', intervalMs: 1000, dailyHistoryArchiveWriteEnabled: 'unless-external-agent' });
  assert.doesNotThrow(() => structuredClone(wire));
});

test('an update is transformed in the main process and the visible fields return to the collector', async () => {
  const { startCollector, collectors } = fakeCollectorFactory();
  const { fork, forks } = fakeFork(startCollector);
  const processHandle = createCollectorProcess({ fork, log: () => {} });
  const updates = [];
  const runtime = processHandle.createUsageRuntime({
    clients: 'claude',
    onUpdate: (summary, reason) => {
      updates.push({ summary, reason });
      return { ...summary, updatedAt: 'transformed', today: { totalTokens: 7 } };
    }
  });
  await settle();
  assert.equal(forks.length, 1);
  assert.equal(forks[0].options.serviceName, 'Jiran Collector');
  assert.equal(collectors.length, 1);
  assert.equal(collectors[0].options.clients, 'claude');

  const result = await runtime.tick('manual', { todayOnly: true });
  assert.equal(result, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].reason, 'manual');
  assert.equal(updates[0].summary.raw, true);
  assert.deepEqual(collectors[0].lastVisible, { updatedAt: 'transformed', today: { totalTokens: 7 } });
  assert.deepEqual(collectors[0].ticks[0].tickOptions, { todayOnly: true });
  await settle();
  assert.equal(runtime.getDiagnostics().ticks, 1, 'diagnostics are cached for synchronous readers');
  processHandle.dispose();
});

test('a call that throws in the host rejects with the same message in the main process', async () => {
  const { startCollector } = fakeCollectorFactory();
  const { fork } = fakeFork(startCollector);
  const processHandle = createCollectorProcess({ fork, log: () => {} });
  const runtime = processHandle.createUsageRuntime({});
  await settle();
  await assert.rejects(runtime.refreshClient('bogus'), /Unsupported targeted usage client: bogus/);
  assert.equal(await runtime.refreshClient('claude'), true);
  processHandle.dispose();
});

test('stop is synchronous: later host messages for that runtime are ignored', async () => {
  const { startCollector, collectors } = fakeCollectorFactory();
  const { fork } = fakeFork(startCollector);
  const processHandle = createCollectorProcess({ fork, log: () => {} });
  let updates = 0;
  const runtime = processHandle.createUsageRuntime({ onUpdate: () => { updates += 1; } });
  await settle();
  runtime.stop({ skipCloseWatchers: true });
  assert.equal(await runtime.tick('manual'), false, 'a stopped runtime does not tick');
  await settle();
  assert.deepEqual(collectors[0].stopped, { skipCloseWatchers: true });
  assert.equal(updates, 0);
  processHandle.dispose();
});

test('mode switches reuse one host process; a crash restarts the active runtime after a backoff', async () => {
  const { startCollector, collectors } = fakeCollectorFactory();
  const { fork, forks } = fakeFork(startCollector);
  const timers = [];
  const errors = [];
  const processHandle = createCollectorProcess({
    fork,
    log: () => {},
    setTimeoutFn: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; },
    clearTimeoutFn: () => {}
  });
  const first = processHandle.createUsageRuntime({});
  await settle();
  first.stop();
  const second = processHandle.createUsageRuntime({ onError: (error, reason) => errors.push({ code: error.code, reason }) });
  await settle();
  assert.equal(forks.length, 1, 'one process serves successive runtimes');
  assert.equal(collectors.length, 2);

  const pending = second.tick('manual');
  forks[0].crash(3);
  assert.equal(await pending, false, 'an in-flight call settles as a failed tick');
  assert.deepEqual(errors, [{ code: 'collector_process_exited', reason: 'collector-process' }]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1000);
  timers[0].fn();
  await settle();
  assert.equal(forks.length, 2, 'a fresh host replaces the crashed one');
  assert.equal(collectors.length, 3, 'the active runtime is started again');
  assert.equal(await second.tick('manual'), true);
  processHandle.dispose();
  assert.equal(forks[1].alive, false, 'dispose kills the host');
});

test('a custom range scan runs in the host and settles on success, failure and exit', async () => {
  const { startCollector } = fakeCollectorFactory();
  const { fork, forks } = fakeFork(startCollector);
  const processHandle = createCollectorProcess({ fork, log: () => {}, setTimeoutFn: () => ({ unref() {} }), clearTimeoutFn: () => {} });
  const ok = await processHandle.run('collectCustomRangeOnce', [{ range: { from: '2026-10-01' }, clients: 'claude' }]);
  assert.equal(ok.period.totalTokens, 42);
  assert.deepEqual(ok.echoed, { range: { from: '2026-10-01' }, clients: 'claude' });
  await assert.rejects(processHandle.run('collectCustomRangeOnce', [{ range: 'bad' }]), (error) => error.code === 'range_failed');
  await assert.rejects(processHandle.run('notAThing', []), /unknown collector call/);
  const hanging = processHandle.run('collectCustomRangeOnce', [{ range: 'hang' }]);
  await settle();
  forks[0].crash(1);
  await assert.rejects(hanging, (error) => error.code === 'collector_process_exited');
  processHandle.dispose();
});
