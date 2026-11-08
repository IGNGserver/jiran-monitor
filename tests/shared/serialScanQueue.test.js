'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createSerialScanQueue } = require('../../src/shared/serialScanQueue');

const immediate = () => new Promise(setImmediate);

test('ticks and ranges share one physical scan lane', async () => {
  const queue = createSerialScanQueue();
  const events = [];
  let finishTick;
  const tick = queue.run(async () => {
    events.push('tick:start');
    await new Promise((resolve) => { finishTick = resolve; });
    events.push('tick:end');
  });
  const range = queue.run(async () => { events.push('range:start'); return 42; });
  await immediate();
  assert.deepEqual(events, ['tick:start']);
  finishTick();
  assert.equal(await tick, undefined);
  assert.equal(await range, 42);
  assert.deepEqual(events, ['tick:start', 'tick:end', 'range:start']);
});

test('identical queued ranges coalesce without sharing caller cancellation', async () => {
  const queue = createSerialScanQueue();
  let runs = 0;
  let finish;
  const firstController = new AbortController();
  const first = queue.run(async () => {
    runs += 1;
    await new Promise((resolve) => { finish = resolve; });
    return { totalTokens: 7 };
  }, { coalesceKey: 'same-range', signal: firstController.signal });
  const second = queue.run(() => { throw new Error('must coalesce'); }, { coalesceKey: 'same-range' });
  const firstRejected = assert.rejects(first, (error) => error.name === 'AbortError');
  firstController.abort();
  const cancelled = queue.run(() => { throw new Error('must coalesce'); }, {
    coalesceKey: 'same-range', signal: firstController.signal
  });
  await assert.rejects(cancelled, (error) => error.name === 'AbortError');
  await immediate();
  assert.equal(runs, 1);
  finish();
  await firstRejected;
  assert.deepEqual(await second, { totalTokens: 7 });
});

test('cancelling the last waiter removes obsolete queued work', async () => {
  const queue = createSerialScanQueue();
  let releaseActive;
  const active = queue.run(() => new Promise((resolve) => { releaseActive = resolve; }));
  const controller = new AbortController();
  let queuedRuns = 0;
  const queued = queue.run(async () => { queuedRuns += 1; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, (error) => error.name === 'AbortError');
  releaseActive();
  await active;
  await immediate();
  assert.equal(queuedRuns, 0);
  assert.deepEqual(queue.getDiagnostics(), { active: false, activeWaiters: 0, queued: 0, keyed: 0 });
});

test('a caller timeout does not release the lane before physical work settles', async () => {
  const queue = createSerialScanQueue();
  let finish;
  let secondRuns = 0;
  const first = queue.run(() => new Promise((resolve) => { finish = resolve; }), { timeoutMs: 5 });
  await assert.rejects(first, (error) => error.code === 'collector_scan_timeout');
  const second = queue.run(async () => { secondRuns += 1; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(secondRuns, 0);
  finish('done');
  await second;
  assert.equal(secondRuns, 1);
});

test('aborting an active final waiter signals the physical task', async () => {
  const queue = createSerialScanQueue();
  const controller = new AbortController();
  let observedSignal;
  const work = queue.run(({ signal }) => {
    observedSignal = signal;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
  }, { signal: controller.signal });
  await immediate();
  controller.abort();
  await assert.rejects(work, (error) => error.name === 'AbortError');
  await immediate();
  assert.equal(observedSignal.aborted, true);
  assert.equal(queue.getDiagnostics().active, false);
});
