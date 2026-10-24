'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createHubAccountService } = require('../../src/hub/accountService');
const { decryptCredential } = require('../../src/hub/accountCrypto');
const { MemoryRepository } = require('./memory-repository');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function row(provider, key = 'account') {
  return { provider, status: 'ok', accountKey: key, windows: [{ kind: 'daily', usedPercent: 10 }] };
}

function fixture(options = {}) {
  const store = new MemoryRepository();
  const service = createHubAccountService({ store, credentialKey: 'test-key', logger: { warn() {} }, ...options });
  const add = (key) => service.addAccount({ provider: 'deepseek', name: key, credential: { apiKey: key } });
  return { store, service, add };
}

test('overlapping stale cycles, manual refresh, add, edit and authorization share physical permits', async () => {
  let clock = Date.parse('2026-10-24T00:00:00Z');
  let blocking = false;
  let active = 0;
  let peak = 0;
  let calls = 0;
  const entered = deferred();
  const release = deferred();
  const { service, add } = fixture({
    concurrency: 1,
    now: () => clock,
    refreshCeilingOverride: 10,
    probe: async (provider, options) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (blocking) {
        entered.resolve();
        await release.promise;
      }
      active -= 1;
      return row(provider, options.deepseekApiKey);
    }
  });
  const first = await add('first');
  const second = await add('second');
  blocking = true;
  const oldCycle = service.refreshAll('test');
  await entered.promise;
  clock += 100;
  const newCycle = service.refreshAll('test');
  const manual = service.refreshAccount(first.id);
  const other = service.refreshAccount(second.id);
  const adding = add('third');
  const editing = service.updateAccount(second.id, { credential: { apiKey: 'edited' } });
  const authorizing = service.authorizeAccount(first.id, { credential: { apiKey: 'authorized' } });
  await nextTurn();
  assert.equal(calls, 3, 'the old cycle is still physically running; no new request may bypass its permit');
  release.resolve();
  await Promise.all([oldCycle, newCycle, manual, other, adding, editing, authorizing]);
  assert.equal(peak, 1);
  await service.stop();
});

test('same account version refreshes singleflight and publish only once', async () => {
  const entered = deferred();
  const release = deferred();
  let block = false;
  let calls = 0;
  let updates = 0;
  const { service, add } = fixture({
    onUpdate: ({ type }) => { if (type === 'account-refresh') updates += 1; },
    probe: async (provider) => {
      calls += 1;
      if (block) { entered.resolve(); await release.promise; }
      return row(provider);
    }
  });
  const account = await add('key');
  block = true;
  const first = service.refreshAccount(account.id);
  await entered.promise;
  const second = service.refreshAccount(account.id);
  const cycle = service.refreshAll('test');
  await nextTurn();
  assert.equal(calls, 2);
  release.resolve();
  assert.equal((await first).status, 'ok');
  assert.equal((await second).status, 'ok');
  await cycle;
  assert.equal(updates, 1);
  await service.stop();
});

test('timed-out physical probes keep their permit and singleflight until they really finish', async () => {
  let block = false;
  let calls = 0;
  const entered = deferred();
  const release = deferred();
  const { service, add } = fixture({
    concurrency: 1,
    probeDeadlineMs: 40,
    probe: async (provider) => {
      calls += 1;
      if (block) { entered.resolve(); await release.promise; }
      return row(provider);
    }
  });
  const account = await add('key');
  block = true;
  const first = service.refreshAccount(account.id);
  await entered.promise;
  assert.equal((await first).status, 'error');
  assert.equal((await service.refreshAccount(account.id)).status, 'error');
  await assert.rejects(add('queued'), { code: 'PROBE_TIMEOUT' });
  assert.equal(calls, 2, 'neither the same version nor another account may replace an uncooperative probe');
  block = false;
  release.resolve();
  await nextTurn();
  assert.equal((await service.refreshAccount(account.id)).status, 'ok');
  await service.stop();
});

test('late provider response bodies cannot free a permit or overwrite the timeout snapshot', async () => {
  let blocking = false;
  let body;
  let calls = 0;
  const entered = deferred();
  const { service, store, add } = fixture({
    concurrency: 1,
    probeDeadlineMs: 40,
    oauthFetch: async () => {
      calls += 1;
      return new Response(new ReadableStream({ start(controller) { body = controller; } }));
    },
    probe: async (provider, options, context, runtime) => {
      if (blocking) {
        const response = await runtime.fetch('https://provider.example.test');
        const text = response.text();
        entered.resolve();
        await text;
      }
      return row(provider, blocking ? 'late' : 'initial');
    }
  });
  const account = await add('key');
  blocking = true;
  const refresh = service.refreshAccount(account.id);
  await entered.promise;
  assert.equal((await refresh).status, 'error');
  await assert.rejects(add('queued'), { code: 'PROBE_TIMEOUT' });
  assert.equal(calls, 1);
  body.enqueue(new TextEncoder().encode('{}'));
  body.close();
  await nextTurn();
  assert.equal(store.hubSnapshots.get(account.id).provider.status, 'error');
  assert.equal(store.hubSnapshots.get(account.id).lastGood.accountKey, 'initial');
  await service.stop();
});

test('scheduled refresh skips disabled and not-yet-due accounts without database writes', async () => {
  let clock = Date.parse('2026-10-24T00:00:00Z');
  let calls = 0;
  const { store, service, add } = fixture({ now: () => clock, probe: async (provider) => row(provider, String(++calls)) });
  const enabled = await add('enabled');
  const disabled = await add('disabled');
  await service.updateAccount(disabled.id, { enabled: false });
  let writes = 0;
  const update = store.updateHubAccount.bind(store);
  const save = store.saveHubAccountSnapshot.bind(store);
  store.updateHubAccount = (...args) => { writes += 1; return update(...args); };
  store.saveHubAccountSnapshot = (...args) => { writes += 1; return save(...args); };
  await service.refreshAll('interval');
  await service.refreshAll('startup');
  assert.equal(writes, 0);
  clock += 5 * 60 * 1000;
  await service.refreshAll('interval');
  assert.equal(calls, 3);
  assert.equal(store.hubAccounts.get(enabled.id).status, 'ok');
  assert.equal((await service.refreshAccount(disabled.id)).status, 'disabled');
  const previousWrites = writes;
  clock += 5 * 60 * 1000;
  await service.refreshAll('interval');
  assert.equal(writes - previousWrites, 3, 'only the enabled account gets refreshing/account/snapshot writes');
  await service.stop();
});

test('classified failures back off, retain lastGood, and manual success restores five-minute freshness', async () => {
  let clock = Date.parse('2026-10-24T00:00:00Z');
  let status = 'ok';
  let calls = 0;
  const { store, service, add } = fixture({ now: () => clock, probe: async (provider) => { calls += 1; return { ...row(provider), status }; } });
  const account = await add('key');
  const good = structuredClone(store.hubSnapshots.get(account.id).lastGood);
  status = 'unauthorized';
  const failed = await service.refreshAccount(account.id);
  assert.equal(failed.status, 'unauthorized');
  assert.deepEqual(failed.windows, good.windows);
  assert.deepEqual(store.hubSnapshots.get(account.id).lastGood, good);
  assert.equal(Date.parse(store.hubAccounts.get(account.id).nextRefreshAt) - clock, 30 * 60 * 1000);
  clock += 5 * 60 * 1000;
  await service.refreshAll('interval');
  assert.equal(calls, 2);
  await service.refreshAccount(account.id);
  assert.equal(Date.parse(store.hubAccounts.get(account.id).nextRefreshAt) - clock, 60 * 60 * 1000);
  status = 'ok';
  await service.refreshAccount(account.id);
  assert.equal(Date.parse(store.hubAccounts.get(account.id).nextRefreshAt) - clock, 5 * 60 * 1000);
  status = 'rateLimited';
  await service.refreshAccount(account.id);
  assert.equal(Date.parse(store.hubAccounts.get(account.id).nextRefreshAt) - clock, 10 * 60 * 1000);
  await service.stop();
});

test('same-clock credential edits fence late probes and invalidate provider runtime caches', async () => {
  const entered = deferred();
  const release = deferred();
  const states = [];
  let block = false;
  const { store, service, add } = fixture({
    now: () => Date.parse('2026-10-24T00:00:00Z'),
    probe: async (provider, options, context, runtime) => {
      states.push(runtime.providerRuntimeState);
      if (block && options.deepseekApiKey === 'old') { entered.resolve(); await release.promise; }
      return row(provider, options.deepseekApiKey);
    }
  });
  const account = await add('old');
  await service.refreshAccount(account.id);
  assert.equal(states[0], states[1], 'ordinary probes reuse the existing provider caches');
  block = true;
  const old = service.refreshAccount(account.id);
  await entered.promise;
  await service.updateAccount(account.id, { credential: { apiKey: 'new' } });
  release.resolve();
  assert.equal(await old, null);
  assert.equal(decryptCredential(store.hubCredentials.get(account.id), 'test-key').apiKey, 'new');
  await service.refreshAccount(account.id);
  assert.notEqual(states[0], states.at(-1));
  await service.clearAccountCredential(account.id);
  await service.authorizeAccount(account.id, { credential: { apiKey: 'new' } });
  const authorizedState = states.at(-1);
  await service.refreshAccount(account.id);
  assert.notEqual(states.at(-1), authorizedState, 'reauthorization invalidates even a matching credential cache');
  await service.deleteAccount(account.id);
  await service.stop();
});

test('the deadline includes OAuth renewal and does not release a stuck physical token request', async () => {
  let fetching = false;
  let calls = 0;
  let signal;
  const release = deferred();
  const { service } = fixture({
    concurrency: 1,
    probeDeadlineMs: 40,
    now: () => Date.parse('2026-10-24T00:00:00Z'),
    oauthFetch: async (url, init) => {
      calls += 1;
      signal = init.signal;
      fetching = true;
      await release.promise;
      return new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }));
    },
    probe: async (provider) => row(provider)
  });
  const credential = { accessToken: 'expired', refreshToken: 'refresh', expiresAt: 1 };
  await assert.rejects(service.addAccount({ provider: 'codex', credential }), { code: 'PROBE_TIMEOUT' });
  assert.equal(fetching, true);
  assert.equal(signal.aborted, true);
  await assert.rejects(service.addAccount({ provider: 'codex', credential }), { code: 'PROBE_TIMEOUT' });
  assert.equal(calls, 1);
  release.resolve();
  await nextTurn();
  await service.stop();
});

test('concurrent identical OAuth renewals share one token exchange', async () => {
  const entered = deferred();
  const release = deferred();
  let tokenCalls = 0;
  const { service, store } = fixture({
    concurrency: 2,
    oauthFetch: async () => {
      tokenCalls += 1;
      entered.resolve();
      await release.promise;
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }));
    },
    probe: async (provider, options) => row(provider, options.codexAccountLabel)
  });
  const credential = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 };
  const first = service.addAccount({ provider: 'codex', label: 'first', credential: { ...credential, marker: 'first' } });
  await entered.promise;
  const second = service.addAccount({ provider: 'codex', label: 'second', credential: { ...credential, marker: 'second' } });
  await nextTurn();
  assert.equal(tokenCalls, 1);
  release.resolve();
  const accounts = await Promise.all([first, second]);
  assert.deepEqual(accounts.map((account) => decryptCredential(store.hubCredentials.get(account.id), 'test-key').marker), ['first', 'second']);
  await service.stop();
});

test('a late credential validation cannot replace a newer committed credential or snapshot', async () => {
  const entered = deferred();
  const release = deferred();
  const { service, store, add } = fixture({
    now: () => Date.parse('2026-10-24T00:00:00Z'),
    probe: async (provider, options) => {
      if (options.deepseekApiKey === 'late') { entered.resolve(); await release.promise; }
      return row(provider, options.deepseekApiKey);
    }
  });
  const account = await add('initial');
  const late = service.updateAccount(account.id, { credential: { apiKey: 'late' } });
  await entered.promise;
  await service.updateAccount(account.id, { credential: { apiKey: 'newer' } });
  const rejects = assert.rejects(late, { code: 'stale_write' });
  release.resolve();
  await rejects;
  assert.equal(decryptCredential(store.hubCredentials.get(account.id), 'test-key').apiKey, 'newer');
  assert.equal(store.hubSnapshots.get(account.id).provider.accountKey, 'newer');
  await service.stop();
});

test('provider runtime cache uses bounded account LRU retention', async () => {
  const states = [];
  const { service, add } = fixture({
    probe: async (provider, options, context, runtime) => {
      if (options.deepseekApiKey === 'first') states.push(runtime.providerRuntimeState);
      return row(provider, options.deepseekApiKey);
    }
  });
  const first = await add('first');
  await service.refreshAccount(first.id);
  assert.equal(states[0], states[1]);
  for (let index = 0; index < 128; index += 1) await add(`key-${index}`);
  await service.refreshAccount(first.id);
  assert.notEqual(states[0], states[2], 'the oldest account cache must be evicted, not retained forever');
  await service.stop();
});

test('stop drops queued work and waits for active logical refreshes without starting more probes', async () => {
  let block = false;
  let calls = 0;
  const entered = deferred();
  const release = deferred();
  const { service, add } = fixture({
    concurrency: 1,
    probe: async (provider) => {
      calls += 1;
      if (block) { entered.resolve(); await release.promise; }
      return row(provider, String(calls));
    }
  });
  await add('first');
  const second = await add('second');
  block = true;
  const cycle = service.refreshAll('test');
  await entered.promise;
  const queued = service.refreshAccount(second.id);
  await nextTurn();
  const stopping = service.stop();
  release.resolve();
  await stopping;
  await cycle;
  assert.equal((await queued).status, 'error');
  assert.equal(calls, 3);
  assert.deepEqual(await service.refreshAll('test'), []);
});

test('the shared probe queue rejects work beyond 256 waiters instead of growing without limit', async () => {
  let blocking = true;
  let active = 0;
  let peak = 0;
  const entered = deferred();
  const release = deferred();
  const { service, add } = fixture({
    concurrency: 1,
    probeDeadlineMs: 5000,
    probe: async (provider, options) => {
      active += 1;
      peak = Math.max(peak, active);
      if (blocking) { entered.resolve(); await release.promise; }
      active -= 1;
      return row(provider, options.deepseekApiKey);
    }
  });
  const first = add('active');
  await entered.promise;
  let rejected = 0;
  const requests = Array.from({ length: 300 }, (_, index) => add(`queued-${index}`).then(
    (account) => ({ account }),
    (error) => { rejected += 1; return { error }; }
  ));
  await nextTurn();
  const beforeRelease = rejected;
  blocking = false;
  release.resolve();
  await first;
  const results = await Promise.all(requests);
  assert.equal(beforeRelease, 44, 'one active job and 256 waiters must reject the remaining 44 immediately');
  assert.equal(results.filter((result) => result.account).length, 256);
  assert.ok(results.filter((result) => result.error).every((result) => result.error.code === 'probe_queue_full'));
  assert.equal(peak, 1);
  await service.stop();
});

test('a thousand manual refreshes for the same provider account and version occupy one flight only', async () => {
  let blocking = false;
  let calls = 0;
  let updates = 0;
  const entered = deferred();
  const release = deferred();
  const { service, store, add } = fixture({
    concurrency: 1,
    probeDeadlineMs: 5000,
    onUpdate: ({ type }) => { if (type === 'account-refresh') updates += 1; },
    probe: async (provider) => {
      calls += 1;
      if (blocking) { entered.resolve(); await release.promise; }
      return row(provider);
    }
  });
  const account = await add('same-provider');
  let credentialReads = 0;
  const readCredential = store.getHubAccountCredential.bind(store);
  store.getHubAccountCredential = (...args) => { credentialReads += 1; return readCredential(...args); };
  blocking = true;
  const first = service.refreshAccount(account.id);
  await entered.promise;
  const requests = Array.from({ length: 1000 }, () => service.refreshAccount(account.id));
  await nextTurn();
  const callsWhileBlocked = calls;
  const readsWhileBlocked = credentialReads;
  release.resolve();
  const results = await Promise.all([first, ...requests]);
  assert.equal(callsWhileBlocked, 2);
  assert.equal(readsWhileBlocked, 1);
  assert.equal(calls, 2);
  assert.equal(updates, 1);
  assert.ok(results.every((result) => result.status === 'ok'));
  await service.stop();
});

test('late failures cannot resurrect cleared, deleted or reauthorized credentials and snapshots', async () => {
  for (const action of ['clear', 'delete', 'authorize']) {
    let blocking = false;
    const entered = deferred();
    const release = deferred();
    const { service, store, add } = fixture({
      now: () => Date.parse('2026-10-24T00:00:00Z'),
      probe: async (provider, options) => {
        if (blocking && options.deepseekApiKey === 'old') {
          entered.resolve();
          await release.promise;
          throw Object.assign(new Error('late credential failure'), { code: 'unauthorized' });
        }
        return row(provider, options.deepseekApiKey);
      }
    });
    const account = await add('old');
    blocking = true;
    const old = service.refreshAccount(account.id);
    await entered.promise;
    if (action === 'clear') await service.clearAccountCredential(account.id);
    if (action === 'delete') await service.deleteAccount(account.id);
    if (action === 'authorize') await service.authorizeAccount(account.id, { credential: { apiKey: 'new' } });
    const currentSnapshot = structuredClone(store.hubSnapshots.get(account.id));
    release.resolve();
    assert.equal(await old, null);
    assert.deepEqual(store.hubSnapshots.get(account.id), currentSnapshot, `${action} must fence the failure write too`);
    if (action === 'delete') assert.equal(store.hubCredentials.has(account.id), false);
    else assert.deepEqual(decryptCredential(store.hubCredentials.get(account.id), 'test-key'), action === 'clear' ? {} : { apiKey: 'new' });
    await service.stop();
  }
});

test('replacing credentials on an already disabled account must not republish active quota', async () => {
  const { service, add } = fixture({ probe: async (provider, options) => row(provider, options.deepseekApiKey) });
  const account = await add('old');
  await service.updateAccount(account.id, { enabled: false });
  const edited = await service.updateAccount(account.id, { credential: { apiKey: 'new' } });
  await service.stop();
  assert.equal(edited.enabled, false);
  assert.equal(edited.status, 'disabled');
  assert.equal(edited.limits.status, 'disabled');
  assert.deepEqual(edited.limits.windows, []);
});
