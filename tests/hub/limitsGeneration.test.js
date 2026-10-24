'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createHub } = require('../../src/hub/server');
const { MemoryRepository } = require('./memory-repository');

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

test('limits reads finish at their entry generation despite later invalidations, without serving older work to newer readers', { timeout: 5000 }, async () => {
  const hub = createHub({ repository: new MemoryRepository(), accountCredentialKey: 'test-key',
    accountProbe: async (provider) => ({ provider, status: 'ok', accountKey: 'test-account', windows: [] }),
    logger: { warn() {}, error() {}, info() {} } });
  const reads = [];
  let draining = false;
  const requests = [];
  try {
    const account = await hub.accountService.addAccount({ provider: 'deepseek', credential: { apiKey: 'synthetic' } });
    hub.accountService.getLimitsSummary = () => {
      const value = { updatedAt: new Date(Date.UTC(2026, 9, 24, 0, 0, reads.length)).toISOString(), providers: [], refreshMs: 300000 };
      if (draining) return Promise.resolve(value);
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      reads.push({ value, resolve: () => resolve(value) });
      return promise;
    };
    const first = hub.getStatsSummary();
    requests.push(first);
    await nextTurn();
    assert.equal(reads.length, 1);
    await hub.accountService.updateAccount(account.id, { label: 'newer-generation' });
    let newerFinished = false;
    const newer = hub.getStats().then((stats) => { newerFinished = true; return stats; });
    requests.push(newer);
    await nextTurn();
    assert.equal(reads.length, 1, 'new readers must share the physical in-flight limits read');
    reads[0].resolve();
    const firstStats = await within(first, 'an existing stats reader waited for absolute latest limits instead of its entry generation');
    assert.strictEqual(firstStats.limits, reads[0].value);
    await nextTurn();
    assert.equal(newerFinished, false, 'the newer reader must not consume a limits generation from before it entered');
    assert.equal(reads.length, 2, 'one follow-up read supplies the newer generation');
    await hub.accountService.updateAccount(account.id, { label: 'even-newer-generation' });
    reads[1].resolve();
    const newerStats = await within(newer, 'a later account edit starved a reader whose required generation had completed');
    assert.strictEqual(newerStats.limits, reads[1].value);
    assert.equal(reads.length, 2, 'completed required generations must not chase subsequent edits');
  } finally {
    draining = true;
    for (const read of reads) read.resolve();
    await Promise.allSettled(requests);
    await hub.stop();
  }
});
