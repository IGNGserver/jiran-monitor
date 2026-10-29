'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { decryptCredential, encryptCredential } = require('../../src/hub/accountCrypto');
const { createHubAccountService, providerOptions } = require('../../src/hub/accountService');
const { MemoryRepository } = require('./memory-repository');

function probeRow(provider, accountKey = `${provider}-account`) {
  return {
    provider,
    status: 'ok',
    accountKey,
    accountEmail: `${accountKey}@example.test`,
    accountLabel: 'Manual Hub account',
    windows: [{ label: 'daily', used: 10, limit: 100, remaining: 90, unit: 'tokens' }]
  };
}

test('Hub credential envelopes round-trip and reject a different key', () => {
  const envelope = encryptCredential({ apiKey: 'keep-this-on-hub' }, 'hub-key');
  assert.notEqual(envelope.ciphertext, 'keep-this-on-hub');
  assert.deepEqual(decryptCredential(envelope, 'hub-key'), { apiKey: 'keep-this-on-hub' });
  assert.throws(() => decryptCredential(envelope, 'wrong-key'));
});

test('Hub account service validates, encrypts, and exposes only manual account metadata', async () => {
  const repository = new MemoryRepository();
  const seen = [];
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    refreshMs: 10_000,
    probe: async (provider, options, context, runtime) => {
      seen.push({ provider, options, context, runtime });
      return probeRow(provider);
    },
    now: () => Date.parse('2026-09-11T00:00:00.000Z')
  });

  const account = await service.addAccount({
    provider: 'deepseek',
    name: 'work',
    label: 'Work account',
    credential: { apiKey: 'secret-api-key' }
  });

  assert.equal(account.provider, 'deepseek');
  assert.equal(account.status, 'ok');
  assert.equal(account.accountEmail, 'deepseek-account@example.test');
  assert.equal(Object.prototype.hasOwnProperty.call(account, 'credential'), false);
  assert.equal(JSON.stringify(account).includes('secret-api-key'), false);

  const storedEnvelope = repository.hubCredentials.get(account.id);
  assert.ok(storedEnvelope);
  assert.equal(JSON.stringify(storedEnvelope).includes('secret-api-key'), false);
  assert.deepEqual(decryptCredential(storedEnvelope, 'hub-key'), { apiKey: 'secret-api-key' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.limitProviderAuthority, 'hub');
  assert.equal(seen[0].options.suppressAutoDetectedAccounts, true);
  assert.deepEqual({ ...seen[0].runtime.env }, {});
  assert.equal(seen[0].runtime.homeDir, '');

  const listed = await service.listAccounts();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes('secret-api-key'), false);

  const summary = await service.getLimitsSummary();
  assert.equal(summary.providers.length, 1);
  assert.equal(summary.providers[0].authority, 'hub');
  assert.equal(summary.providers[0].accountId, account.id);
});

test('Hub account service rejects duplicate provider identities and refreshes with stored credentials', async () => {
  const repository = new MemoryRepository();
  let probeCount = 0;
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    probe: async (provider) => {
      probeCount += 1;
      return probeRow(provider, 'same-account');
    }
  });

  const account = await service.addAccount({ provider: 'openrouter', credential: { apiKey: 'first-key' } });
  await assert.rejects(
    service.addAccount({ provider: 'openrouter', credential: { apiKey: 'second-key' } }),
    { code: 'account_duplicate' }
  );

  const refreshed = await service.refreshAccount(account.id);
  assert.equal(refreshed.status, 'ok');
  assert.equal(probeCount, 3);
  assert.deepEqual(
    decryptCredential(repository.hubCredentials.get(account.id), 'hub-key'),
    { apiKey: 'first-key' }
  );
});

test('Hub account summaries read all limit snapshots in one batch', async () => {
  const repository = new MemoryRepository();
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    probe: async (provider) => probeRow(provider, `${provider}-batch`)
  });
  await service.addAccount({ provider: 'deepseek', credential: { apiKey: 'deepseek-key' } });
  await service.addAccount({ provider: 'openrouter', credential: { apiKey: 'openrouter-key' } });

  let batchCalls = 0;
  const batch = repository.listHubAccountSnapshots.bind(repository);
  repository.listHubAccountSnapshots = async (ids) => {
    batchCalls += 1;
    assert.equal(ids.length, 2);
    return batch(ids);
  };
  repository.getHubAccountSnapshot = async () => {
    throw new Error('per-account snapshot lookup should not be used');
  };

  const summary = await service.getLimitsSummary();
  assert.equal(summary.providers.length, 2);
  assert.equal(batchCalls, 1);
});

test('a refresh that started before an account edit cannot publish its late result', async () => {
  const repository = new MemoryRepository();
  let clock = Date.parse('2026-09-12T00:00:00.000Z');
  let refreshing = false;
  let startedResolve;
  let releaseProbe;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    now: () => ++clock,
    probe: async (provider) => {
      if (refreshing) {
        startedResolve();
        await new Promise((resolve) => { releaseProbe = resolve; });
      }
      return probeRow(provider, refreshing ? 'late-refresh' : 'initial');
    }
  });
  const account = await service.addAccount({ provider: 'deepseek', credential: { apiKey: 'original-key' } });
  refreshing = true;
  const refresh = service.refreshAccount(account.id);
  await started;
  const edited = await service.updateAccount(account.id, { name: 'edited-name' });
  releaseProbe();

  assert.equal(await refresh, null);
  assert.equal(edited.name, 'edited-name');
  assert.equal(repository.hubAccounts.get(account.id).name, 'edited-name');
  assert.equal(decryptCredential(repository.hubCredentials.get(account.id), 'hub-key').apiKey, 'original-key');
});

test('disabling a Hub account clears its published quota snapshot until re-enabled', async () => {
  const repository = new MemoryRepository();
  let probeCount = 0;
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    probe: async (provider) => {
      probeCount += 1;
      return {
        ...probeRow(provider, 'toggle-account'),
        windows: [{ kind: 'weekly', usedPercent: 10, resetsAt: '2026-09-19T00:00:00Z' }]
      };
    },
    now: () => Date.parse('2026-09-12T00:00:00Z')
  });

  const account = await service.addAccount({ provider: 'codex', credential: { accessToken: 'oauth-token' } });
  assert.equal((await service.getLimitsSummary()).providers[0].windows.length, 1);

  const disabled = await service.updateAccount(account.id, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.limits.status, 'disabled');
  assert.deepEqual(disabled.limits.windows, []);
  assert.equal((await service.getLimitsSummary()).providers[0].status, 'disabled');
  assert.deepEqual((await service.getLimitsSummary()).providers[0].windows, []);

  const enabled = await service.updateAccount(account.id, { enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.status, 'ok');
  assert.equal(enabled.limits.status, 'ok');
  assert.equal(probeCount, 2);
});

test('Hub account service rotates an expired OAuth credential before probing', async () => {
  const repository = new MemoryRepository();
  const nowMs = Date.parse('2026-09-12T00:00:00Z');
  const seenTokens = [];
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    now: () => nowMs,
    oauthFetch: async (url, init) => {
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      assert.match(String(init.body), /grant_type=refresh_token/);
      return new Response(JSON.stringify({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    probe: async (provider, options) => {
      seenTokens.push(options.codexAccessToken);
      return {
        ...probeRow(provider, 'rotated-account'),
        windows: [{ kind: 'weekly', usedPercent: 10 }]
      };
    }
  });

  const account = await service.addAccount({
    provider: 'codex',
    credential: {
      accessToken: 'expired-access',
      refreshToken: 'refresh-token',
      expiresAt: nowMs - 1
    }
  });

  assert.deepEqual(seenTokens, ['rotated-access']);
  const stored = decryptCredential(repository.hubCredentials.get(account.id), 'hub-key');
  assert.equal(stored.accessToken, 'rotated-access');
  assert.equal(stored.refreshToken, 'rotated-refresh');
  assert.equal(stored.authJson.tokens.access_token, 'rotated-access');
});

test('Hub provider options do not carry ambient environment or local account discovery', () => {
  const options = providerOptions(
    { id: 'account-1', provider: 'openrouter', name: 'work' },
    { apiKey: 'manual-key' }
  );
  assert.equal(options.limitProviderAuthority, 'hub');
  assert.equal(options.limitProviderAutoDetectDisabled, 'openrouter');
  assert.equal(options.suppressAutoDetectedAccounts, true);
  assert.deepEqual(options.openrouterProfiles, { work: { apiKey: 'manual-key', enabled: true } });
});

test('Hub account edits preserve and merge nested third-party profiles', async () => {
  const repository = new MemoryRepository();
  const seenKeys = [];
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    probe: async (provider, options) => {
      seenKeys.push(options.thirdPartyProfiles?.work?.apiKey || '');
      return probeRow(provider, 'third-party-account');
    }
  });

  const account = await service.addAccount({
    provider: 'thirdparty',
    name: 'work',
    credential: {
      profile: {
        adapter: 'newapi',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'first-key'
      }
    }
  });

  const listed = await service.listAccounts({ includeCredentialMetadata: true });
  assert.deepEqual(listed[0].credentialMetadata, {
    adapter: 'newapi',
    baseUrl: 'https://api.example.test/v1'
  });

  await service.updateAccount(account.id, {
    credential: {
      adapter: 'newapi',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'second-key'
    },
    credentialMode: 'merge'
  });
  assert.deepEqual(seenKeys, ['first-key', 'second-key']);
  assert.equal(
    decryptCredential(repository.hubCredentials.get(account.id), 'hub-key').profile.apiKey,
    'second-key'
  );
});

test('Hub rejects third-party account targets that could reach local services', async () => {
  const repository = new MemoryRepository();
  let probed = false;
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    probe: async () => {
      probed = true;
      return probeRow('thirdparty');
    }
  });

  await assert.rejects(
    service.addAccount({
      provider: 'thirdparty',
      credential: {
        adapter: 'custom',
        baseUrl: 'http://127.0.0.1:8080',
        apiKey: 'local-service-key'
      }
    }),
    { code: 'credential_invalid' }
  );
  assert.equal(probed, false);
});

test('a provider probe that never settles is cut off by the Hub deadline', async () => {
  const repository = new MemoryRepository();
  let hang = false;
  let sawSignal = null;
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    probeDeadlineMs: 40,
    probe: (provider, options, context, runtime) => {
      sawSignal = runtime?.signal || null;
      // Never settles and never reacts to the signal: the deadline must still
      // release the caller.
      if (hang) return new Promise(() => {});
      return Promise.resolve(probeRow(provider));
    }
  });

  await service.addAccount({ provider: 'deepseek', name: 'slow', credential: { apiKey: 'slow-key' } });
  hang = true;

  const startedAt = Date.now();
  const results = await service.refreshAll('test');
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 3000, `refreshAll should return promptly, took ${elapsed}ms`);
  assert.ok(sawSignal && typeof sawSignal.aborted === 'boolean', 'the probe should receive an abort signal');
  assert.equal(sawSignal.aborted, true, 'the deadline should abort the forwarded signal');
  const failed = results.find((row) => row?.provider === 'deepseek');
  assert.ok(failed, 'the provider should still be reported after a timeout');
  // `statusFromError` maps a timeout onto the canonical 'error' status (the wire
  // vocabulary has no separate timeout state), but it must not read as ok.
  assert.equal(failed.status, 'error');
  assert.ok(
    elapsed >= 30 && elapsed < 2000,
    `the probe should be cut off near its 40ms deadline, took ${elapsed}ms`
  );
});

test('a stalled refresh cycle releases its latch instead of wedging limits', async () => {
  const repository = new MemoryRepository();
  let hang = false;
  let releaseProbe;
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    refreshMs: 60_000,
    probeDeadlineMs: 600,
    refreshCeilingOverride: 80,
    probe: (provider) => {
      if (hang) return new Promise((resolve) => { releaseProbe = () => resolve(probeRow(provider)); });
      return Promise.resolve(probeRow(provider));
    }
  });
  await service.addAccount({ provider: 'deepseek', name: 'stall', credential: { apiKey: 'k' } });

  // First cycle parks on a never-settling probe and is cut off only by the
  // per-probe deadline (600ms), which is well past the 80ms latch ceiling.
  hang = true;
  const stalledStarted = Date.now();
  const stalled = await service.refreshAll('test');
  assert.ok(Array.isArray(stalled), 'a stalled cycle still resolves');
  assert.ok(Date.now() - stalledStarted >= 500, 'the first cycle should hit the probe deadline');

  // The cycle latch is free, but a timeout is not evidence that its physical
  // probe stopped. Let it really finish before retrying the same version.
  hang = false;
  releaseProbe();
  await new Promise((resolve) => setImmediate(resolve));
  const healthy = await service.refreshAll('test');
  assert.ok(
    healthy.some((row) => row?.status === 'ok'),
    'a later cycle should run fresh and succeed'
  );
});

test('a failed refresh keeps the last good quota, marks it stale, and names the cause', async () => {
  const repository = new MemoryRepository();
  let clock = Date.parse('2026-10-29T15:31:21.000Z');
  let fail = false;
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    refreshMs: 5 * 60 * 1000,
    probe: async (provider) => {
      if (fail) {
        const error = new Error('Provider validation failed: unavailable (ECONNRESET)');
        error.status = 'unavailable';
        error.providerRow = { provider, status: 'unavailable', errorDetail: 'ECONNRESET' };
        throw error;
      }
      return {
        provider,
        status: 'ok',
        accountKey: `${provider}-account`,
        accountEmail: `${provider}@example.test`,
        updatedAt: new Date(clock).toISOString(),
        windows: [{ kind: 'session', label: '5-hour', usedPercent: 12, windowMinutes: 300 }]
      };
    },
    now: () => clock
  });

  const account = await service.addAccount({ provider: 'codex', credential: { accessToken: 'token' } });
  const goodAt = new Date(clock).toISOString();
  clock += 5 * 60 * 1000;
  fail = true;
  await service.refreshAccount(account.id);

  const provider = (await service.getLimitsSummary()).providers.find((row) => row.accountId === account.id);
  assert.equal(provider.status, 'unavailable');
  // The numbers are the previous observation, so they stay but are labelled.
  assert.equal(provider.stale, true);
  assert.equal(provider.windows.length, 1);
  // "Last fetched" must name when the numbers were observed, not this attempt.
  assert.equal(provider.updatedAt, goodAt);
  assert.equal(provider.errorDetail, 'ECONNRESET');

  const stored = await repository.getHubAccount(account.id);
  assert.equal(stored.status, 'unavailable');
  assert.match(stored.lastErrorMessage, /ECONNRESET/);
  assert.equal(stored.lastSuccessAt, goodAt);
});

test('a transport failure retries within 15 minutes instead of backing off to an hour', async () => {
  const repository = new MemoryRepository();
  let clock = Date.parse('2026-10-29T15:31:21.000Z');
  let fail = false;
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    refreshMs: 5 * 60 * 1000,
    probe: async (provider) => {
      if (fail) {
        const error = new Error('Provider validation failed: unavailable (ECONNRESET)');
        error.status = 'unavailable';
        throw error;
      }
      return { ...probeRow(provider), updatedAt: new Date(clock).toISOString() };
    },
    now: () => clock
  });

  const account = await service.addAccount({ provider: 'codex', credential: { accessToken: 'token' } });
  fail = true;
  // Enough consecutive failures to reach the old one-hour ceiling.
  for (let i = 0; i < 8; i += 1) {
    clock += 60 * 1000;
    await service.refreshAccount(account.id);
  }
  const stored = await repository.getHubAccount(account.id);
  const delayMs = Date.parse(stored.nextRefreshAt) - clock;
  assert.ok(delayMs <= 15 * 60 * 1000, `retry delay ${delayMs}ms should not exceed 15 minutes`);
});

test('Hub account service deletes an existing account, cleans credentials and limits, and reports 404 for missing', async () => {
  const repository = new MemoryRepository();
  const events = [];
  const service = createHubAccountService({
    store: repository,
    credentialKey: 'hub-key',
    probe: async (provider) => probeRow(provider, 'to-delete'),
    onUpdate: (event) => events.push(event)
  });

  const account = await service.addAccount({
    provider: 'deepseek',
    name: 'delete-me',
    credential: { apiKey: 'key-to-delete' }
  });
  assert.equal(account.status, 'ok');
  assert.ok(repository.hubAccounts.has(account.id));
  assert.ok(repository.hubCredentials.has(account.id));
  assert.ok(repository.hubSnapshots.has(account.id));

  const deleted = await service.deleteAccount(account.id);
  assert.equal(deleted, true);
  assert.equal(repository.hubAccounts.has(account.id), false);
  assert.equal(repository.hubCredentials.has(account.id), false);
  assert.equal(repository.hubSnapshots.has(account.id), false);

  const deletedAgain = await service.deleteAccount(account.id);
  assert.equal(deletedAgain, false);

  const deletedEvent = events.find((e) => e.type === 'account-deleted');
  assert.ok(deletedEvent);
  assert.equal(deletedEvent.accountId, account.id);
});
