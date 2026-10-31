'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const {
  QODER_CN_MODEL_DISPLAY_NAMES,
  QODER_CLIENT_IDS,
  QODER_SITES,
  QODER_SITE_BY_CLIENT_ID,
  QODER_SITE_IDS,
  SHARED_QODER_MAIN_BUNDLE_IDS,
  buildQoderCnHistoryGraph,
  buildQoderCnPeriods,
  collectQoderCnMainRows,
  collectQoderCnRows,
  collectQoderCnTranscriptRows,
  estimateQoderCnContentTokens,
  mergeQoderCnRows,
  normalizeQoderCnDbRow,
  normalizeQoderCnMainMessage,
  normalizeQoderClientId,
  normalizeQoderSite,
  QODER_CN_SQLITE_BACKEND_UNAVAILABLE,
  qoderCnDataPaths,
  qoderDataPaths,
  qoderSourceFingerprint,
  readQoderCnDbRows,
  readQoderCnMainDbRows,
  resolveQoderCnPricing,
  resolveQoderSiteOptions,
  selectQoderMainDbPaths,
  resetQoderCnChatSessionProbe,
  resetQoderCnPricingCache
} = require('../../src/shared/qoderCnUsage');

const QODER_CN_DB_FIXTURE = path.join(__dirname, '..', 'fixtures', 'qoder-cn-local.db');

// The Qoder CN runtime exports QODERCN_CONFIG_DIR into every child process, and
// qoderCnDataPaths() honours it *over* homeDir — correct in production, since
// that is how a relocated profile is found, but it made these fixtures resolve
// the real ~/.qoder-cn transcript tree whenever the suite ran from inside the
// app. Pass an explicit empty env so a fixture homeDir is always authoritative.
const FIXTURE_ENV = Object.freeze({});

function skipOnlyWhenSqliteBackendIsMissing(t, error) {
  if (error?.code === QODER_CN_SQLITE_BACKEND_UNAVAILABLE) {
    t.skip(`no sqlite backend available: ${error.message}`);
    return true;
  }
  throw error;
}

test('QODER_CN_MODEL_DISPLAY_NAMES covers every official model code and the retired ones', () => {
  // Codes verified 2026-09-26 against the client's own i18n bundle
  // (`modelSelector.item.<code>` in ~/.qoder/.auth/dynamic-texts.json), which is
  // the authoritative source; Qoder CN ships no such file so this table is its
  // only mapping. Retired codes stay because historical rows reference them.
  for (const code of [
    'qmodel', 'qmodel_latest', 'qmodel_preview', 'qmodel_38max', 'qfmodel',
    'gm51model', 'gmodel', 'gfmodel', 'kmodel', 'kmodel_latest',
    'dmodel', 'dfmodel', 'mmodel', 'cmodel', 'smodel', 'q35model', 'q35model_preview',
    'q36fmodel', 'q37fmodel', 'dashscope_qmodel', 'dashscope_qwen3_coder', 'dashscope_qwen_max_latest'
  ]) {
    assert.ok(QODER_CN_MODEL_DISPLAY_NAMES[code], `${code} must be mapped`);
  }

  // The dominant code in current transcripts. It was unmapped until 2026-09, so
  // ~99% of real rows displayed as the raw code and never resolved a price.
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.qfmodel, 'Qwen3.8-Flash');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.qmodel_38max, 'Qwen3.8-Max');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.gmodel, 'GLM-5.3');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.kmodel, 'Kimi-K2.8-Preview');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.kmodel_latest, 'Kimi-K3');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.cmodel, 'Cantus');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.smodel, 'Sonus');

  // Retired codes keep the name they had, or old rows regress to raw codes.
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.qmodel_latest, 'Qwen3.7-Max');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.gm51model, 'GLM-5.2');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.qmodel_preview, 'Qwen3.8-Max-Preview');

  // Names must stay catalog-resolvable: tokscale prices these case-insensitively
  // against models.dev, so a marketing or program label silently prices as
  // nothing. `q35model_preview` is sold as "Qwen3.7-Max-DogFooding" and
  // `dfmodel` as "DeepSeek-Flash", but both must map to the underlying model.
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.q35model_preview, 'Qwen3.7-Max');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.dfmodel, 'DeepSeek-V4.1-Flash');
  for (const [code, name] of Object.entries(QODER_CN_MODEL_DISPLAY_NAMES)) {
    assert.ok(!/dogfooding|preview program/i.test(name), `${code} must not map to a program label`);
  }

  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.custom_model, undefined, 'custom models stay unmapped');
});

test('normalizeQoderCnDbRow separates cached input without double-counting', () => {
  assert.deepEqual(normalizeQoderCnDbRow({
    row_id: 7,
    id: 'message-1',
    session_id: 'session-1',
    token_info: JSON.stringify({ prompt_tokens: 58_299, cached_tokens: 57_853, completion_tokens: 2_812 }),
    model_info: JSON.stringify({ model_key: 'qmodel_latest' }),
    gmt_create: 1_784_681_696_263
  }, 'cn'), {
    sessionId: 'qodercn:cn:session-1',
    messageId: 'qodercn:cn:session-1:message-1',
    model: 'Qwen3.7-Max', // qmodel_latest
    input: 446,
    output: 2_812,
    cacheRead: 57_853,
    cacheWrite: 0,
    createdAt: 1_784_681_696_263,
    projectLabel: '',
    messages: 1
  });
});

test('Qoder CN normalizers reject malformed and zero-only usage', () => {
  assert.equal(normalizeQoderCnDbRow({ token_info: '{}' }, 'cn'), null);
  assert.equal(normalizeQoderCnDbRow({
    token_info: JSON.stringify({ prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 })
  }, 'cn'), null);
});

test('normalizeQoderCnDbRow does not resolve inherited model names', () => {
  for (const modelKey of ['constructor', 'toString']) {
    const row = normalizeQoderCnDbRow({
      token_info: JSON.stringify({ prompt_tokens: 1, completion_tokens: 1 }),
      model_info: JSON.stringify({ model_key: modelKey })
    }, 'cn');
    assert.equal(row.model, modelKey);
  }
});

test('buildQoderCnPeriods keeps day boundaries and tokscale-compatible totals', () => {
  const now = Date.parse('2026-07-29T18:00:00Z');
  const rows = [
    { sessionId: 's1', messageId: 'm1', model: 'qmodel', input: 10, output: 2, cacheRead: 3, cacheWrite: 0, createdAt: now - 24 * 60 * 60 * 1000, messages: 1 },
    { sessionId: 's1', messageId: 'm2', model: 'qmodel', input: 20, output: 4, cacheRead: 5, cacheWrite: 0, createdAt: now - 2 * 60 * 60 * 1000, messages: 1 }
  ];
  const periods = buildQoderCnPeriods({ now: new Date(now).toISOString(), allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.totalInput, 20);
  assert.equal(periods.today.totalCacheRead, 5);
  assert.equal(periods.month.totalInput, 30);
  assert.equal(periods.allTime.entries[0].client, 'qodercn');
  assert.equal(periods.allTime.entries[0].messageCount, 2);
});

test('the tracked client id, not the site, namespaces row ids and wire entries', () => {
  // usage.js keys a period's published sessions by `${client}:${sessionId}`, so
  // two sites reading the same table shape must not collide on `cn:session-1`
  // and the international client must never publish a `qodercn:`-prefixed id.
  const dbRow = {
    id: 'message-1',
    session_id: 'session-1',
    token_info: JSON.stringify({ prompt_tokens: 10, completion_tokens: 2 }),
    model_info: JSON.stringify({ model_key: 'qmodel' }),
    gmt_create: 1_784_681_696_263
  };
  assert.equal(normalizeQoderCnDbRow(dbRow, 'cn', 'qodercn').sessionId, 'qodercn:cn:session-1');
  assert.equal(normalizeQoderCnDbRow(dbRow, 'cn', 'qoder').sessionId, 'qoder:cn:session-1');
  assert.equal(normalizeQoderCnDbRow(dbRow, 'cn', 'qoder').messageId, 'qoder:cn:session-1:message-1');
  // The namespace defaults to CN, so every pre-existing call site is unchanged.
  assert.equal(normalizeQoderCnDbRow(dbRow, 'cn').sessionId, 'qodercn:cn:session-1');
  // An untracked id falls back rather than inventing a namespace of its own.
  assert.equal(normalizeQoderCnDbRow(dbRow, 'cn', 'nope').sessionId, 'qodercn:cn:session-1');
  assert.equal(normalizeQoderClientId('  QODER  '), 'qoder');
  assert.equal(normalizeQoderClientId('nope'), 'qodercn');

  const now = Date.parse('2026-07-29T18:00:00Z');
  const rows = [{
    sessionId: 's1',
    messageId: 'm1',
    model: 'qmodel',
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: now,
    messages: 1
  }];
  const globalPeriods = buildQoderCnPeriods({ now: new Date(now), allTimeSince: '2026-01-01', rows, clientId: 'qoder' });
  assert.equal(globalPeriods.today.entries[0].client, 'qoder');
  assert.equal(globalPeriods.today.entries[0].provider, 'qoder');
  assert.equal(globalPeriods.today.entries[0].sessionId, 's1');
  assert.equal(buildQoderCnHistoryGraph({ rows, pricingByModel: {}, clientId: 'qoder' }).contributions[0].clients[0].client, 'qoder');
  assert.equal(buildQoderCnHistoryGraph({ rows, pricingByModel: {} }).contributions[0].clients[0].client, 'qodercn');
});

test('resolveQoderSiteOptions lets a known client id win over an explicit site', () => {
  // The collector already knows the tracked id. If a mismatched `site` could
  // override it, one site's roots would be read and stamped with the other's
  // client id — usage attributed to an installer that was never opened.
  assert.deepEqual(resolveQoderSiteOptions({ clientId: 'qoder', site: 'cn' }), { site: 'global', clientId: 'qoder' });
  assert.deepEqual(resolveQoderSiteOptions({ clientId: 'qodercn', site: 'global' }), { site: 'cn', clientId: 'qodercn' });
  assert.deepEqual(resolveQoderSiteOptions({ site: 'global' }), { site: 'global', clientId: 'qoder' });
  assert.deepEqual(resolveQoderSiteOptions({ clientId: 'nope' }), { site: 'cn', clientId: 'qodercn' });
  assert.deepEqual(resolveQoderSiteOptions({}), { site: 'cn', clientId: 'qodercn' });
  assert.deepEqual(
    Object.keys(QODER_SITE_BY_CLIENT_ID).sort(),
    [...QODER_CLIENT_IDS].sort(),
    'the reverse index and the client-id list must stay in step'
  );

  // A client id alone is enough to reach that site's roots.
  const byClientId = qoderDataPaths({ clientId: 'qoder', homeDir: '/home/test', platform: 'linux', env: FIXTURE_ENV });
  const bySite = qoderDataPaths({ site: 'global', homeDir: '/home/test', platform: 'linux', env: FIXTURE_ENV });
  assert.deepEqual(byClientId.dbPaths, bySite.dbPaths);
  assert.equal(byClientId.site, 'global');
  assert.equal(byClientId.clientId, 'qoder');
});

test('Qoder CN routing modes do not inherit unrelated catalog prices', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const tiers = ['Auto', 'Ultimate', 'Performance', 'Efficient', 'Lite'];
  const rows = tiers.map((model, index) => ({
    sessionId: `s${index}`,
    messageId: `m${index}`,
    model,
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: now,
    messages: 1
  }));
  const pricingByModel = Object.fromEntries(tiers.map((tier) => [tier.toLowerCase(), {
    inputCostPerToken: 1,
    outputCostPerToken: 1
  }]));
  const periods = buildQoderCnPeriods({
    now: new Date(now).toISOString(),
    allTimeSince: '2026-01-01',
    rows,
    // Routing tiers name model pools, not the selected underlying model. A
    // same-named catalog or custom-pricing entry must never price these rows.
    pricingByModel
  });

  assert.equal(periods.today.totalInput + periods.today.totalOutput, 12 * tiers.length);
  assert.equal(periods.today.totalCost, 0);
  const clients = buildQoderCnHistoryGraph({ rows, pricingByModel }).contributions[0].clients;
  assert.deepEqual(clients.map((client) => client.cost), tiers.map(() => 0));
});

test('Qoder CN pricing is resolved and cached independently', async () => {
  resetQoderCnPricingCache();
  let lookups = 0;
  const lookupModelPricing = async (modelId) => {
    lookups += 1;
    assert.equal(modelId, 'qwen3.7-max');
    return {
      pricing: {
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
        cacheReadInputTokenCost: 0.0000001,
        cacheCreationInputTokenCost: 0.000003
      }
    };
  };
  const rows = [
    { model: 'Qwen3.7-Max' },
    ...['Auto', 'Ultimate', 'Performance', 'Efficient', 'Lite'].map((model) => ({ model }))
  ];
  const first = await resolveQoderCnPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 1000 });
  const second = await resolveQoderCnPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 2000 });

  assert.deepEqual(first, {
    'qwen3.7-max': {
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000002,
      cacheReadInputTokenCost: 0.0000001,
      cacheCreationInputTokenCost: 0.000003
    }
  });
  assert.deepEqual(second, first);
  assert.equal(lookups, 1, 'routing tiers have no selected underlying model and must not trigger catalog lookups');
  resetQoderCnPricingCache();
});

test('Qoder CN cost uses input, output, cache-read, and cache-write rates', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const rows = [{
    sessionId: 's1', messageId: 'm1', model: 'Qwen3.7-Max', input: 10, output: 2,
    cacheRead: 5, cacheWrite: 1, createdAt: now, messages: 1
  }];
  const pricingByModel = {
    'qwen3.7-max': {
      inputCostPerToken: 2,
      outputCostPerToken: 3,
      cacheReadInputTokenCost: 4,
      cacheCreationInputTokenCost: 5
    }
  };
  const periods = buildQoderCnPeriods({ now: new Date(now).toISOString(), allTimeSince: '2026-01-01', rows, pricingByModel });
  const graph = buildQoderCnHistoryGraph({ rows, pricingByModel });
  assert.equal(periods.today.totalCost, 51);
  assert.equal(graph.contributions[0].clients[0].cost, 51);
});

test('undated Qoder CN rows count for allTime only, mirroring the proma includeUndated rule', () => {
  const now = Date.parse('2026-07-29T18:00:00Z');
  const rows = [
    { sessionId: 's1', messageId: 'm1', model: 'qmodel', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 },
    { sessionId: 's1', messageId: 'm2', model: 'qmodel', input: 20, output: 4, cacheRead: 0, cacheWrite: 0, createdAt: now - 2 * 60 * 60 * 1000, messages: 1 }
  ];
  const periods = buildQoderCnPeriods({ now: new Date(now).toISOString(), allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.totalInput, 20, 'undated row must not leak into today');
  assert.equal(periods.month.totalInput, 20, 'undated row must not leak into month');
  assert.equal(periods.allTime.totalInput, 30, 'undated row must count in allTime');

  const graph = buildQoderCnHistoryGraph({ rows });
  assert.equal(graph.contributions.length, 1, 'undated rows must not create a history day');
  assert.equal(graph.contributions[0].clients[0].tokens.input, 20);
});

test('qoderCnDataPaths resolves QoderCN DB path per platform', () => {
  const suffix = path.join('QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db');
  // `com.qodercn.app.stable` is the bundle id observed on Qoder CN 0.4.2/Linux,
  // `com.qoder.app.stable` the older spelling. Both are candidates, in that
  // order, so a reader picks the current one first.
  const mainSuffixes = ['com.qodercn.app.stable', 'com.qoder.app.stable']
    .map((bundleId) => path.join(bundleId, 'main.sqlite'));

  const darwin = qoderCnDataPaths({ homeDir: '/Users/test', platform: 'darwin', env: {} });
  assert.deepEqual(darwin.dbPaths, [path.join('/Users/test', 'Library', 'Application Support', suffix)]);
  assert.deepEqual(
    darwin.mainDbPaths,
    mainSuffixes.map((mainSuffix) => path.join('/Users/test', 'Library', 'Application Support', mainSuffix))
  );
  const darwinArm = qoderCnDataPaths({ homeDir: '/Users/test', platform: 'darwin-arm64', env: {} });
  assert.deepEqual(darwinArm.dbPaths, darwin.dbPaths);

  const win = qoderCnDataPaths({ homeDir: '/home/test', platform: 'win32', env: { APPDATA: '/home/test/AppData/Roaming' } });
  assert.deepEqual(win.dbPaths, [path.join('/home/test/AppData/Roaming', suffix)]);
  assert.deepEqual(
    win.mainDbPaths,
    mainSuffixes.map((mainSuffix) => path.join('/home/test/AppData/Roaming', mainSuffix))
  );
  const winX64 = qoderCnDataPaths({ homeDir: '/home/test', platform: 'win32-x64', env: { APPDATA: '/home/test/AppData/Roaming' } });
  assert.deepEqual(winX64.dbPaths, win.dbPaths);

  const linux = qoderCnDataPaths({ homeDir: '/home/test', platform: 'linux', env: {} });
  assert.deepEqual(linux.dbPaths, [path.join('/home/test/.config', suffix)]);
  assert.deepEqual(
    linux.mainDbPaths,
    mainSuffixes.map((mainSuffix) => path.join('/home/test/.config', mainSuffix))
  );
  assert.equal(linux.site, 'cn');
  assert.equal(linux.clientId, 'qodercn');

  const customConfig = qoderCnDataPaths({
    homeDir: '/home/test',
    platform: 'linux',
    env: { QODERCN_CONFIG_DIR: '/var/lib/qodercn' }
  });
  // Configured roots go through path.resolve, so build the expectation the same
  // way: on Windows the POSIX-style input resolves onto the current drive.
  assert.deepEqual(customConfig.transcriptRoots, [path.join(path.resolve('/var/lib/qodercn'), 'projects')]);

  const relativeConfig = qoderCnDataPaths({
    homeDir: '/home/test',
    platform: 'linux',
    env: { QODERCN_CONFIG_DIR: 'qoder-config' }
  });
  assert.deepEqual(relativeConfig.transcriptRoots, [path.resolve('qoder-config', 'projects')]);
});

test('qoderDataPaths resolves the international site without touching the CN profile', () => {
  assert.deepEqual([...QODER_SITE_IDS], ['cn', 'global']);
  assert.equal(QODER_SITES.cn.clientId, 'qodercn');
  assert.equal(QODER_SITES.global.clientId, 'qoder');
  assert.equal(normalizeQoderSite('GLOBAL'), 'global');
  assert.equal(normalizeQoderSite('nope'), 'cn', 'unknown sites fall back rather than resolve nothing');

  const global = qoderDataPaths({ site: 'global', homeDir: '/home/test', platform: 'linux', env: {} });
  assert.equal(global.site, 'global');
  assert.equal(global.clientId, 'qoder');
  assert.deepEqual(global.dbPaths, [
    path.join('/home/test/.config', 'Qoder', 'SharedClientCache', 'cache', 'db', 'local.db')
  ]);
  assert.deepEqual(global.transcriptRoots, [path.join('/home/test', '.qoder', 'projects')]);

  const cn = qoderDataPaths({ site: 'cn', homeDir: '/home/test', platform: 'linux', env: {} });
  for (const key of ['dbPaths', 'transcriptRoots']) {
    assert.deepEqual(global[key].filter((value) => cn[key].includes(value)), [], `${key} must not overlap between sites`);
  }
  // `com.qoder.app.stable` is claimed by both sites: it is the international
  // app's bundle id and the one Qoder CN 0.1.x used. The descriptor lists it for
  // both and marks it gated; selectQoderMainDbPaths resolves the ambiguity.
  assert.deepEqual([...SHARED_QODER_MAIN_BUNDLE_IDS], ['com.qoder.app.stable']);
  const shared = path.join('/home/test/.config', 'com.qoder.app.stable', 'main.sqlite');
  assert.deepEqual(cn.mainDbPaths.filter((value) => global.mainDbPaths.includes(value)), [shared]);
  assert.deepEqual(global.gatedMainDbPaths, [shared]);
  assert.deepEqual(cn.gatedMainDbPaths, [shared]);
  assert.deepEqual(global.siteFootprintDirs, [
    path.join('/home/test/.config', 'Qoder'),
    path.join('/home/test', '.qoder')
  ]);
});

test('selectQoderMainDbPaths resolves a bundle id both sites claim', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-footprint-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const appSupport = path.join(homeDir, '.config');
  const sharedDb = path.join(appSupport, 'com.qoder.app.stable', 'main.sqlite');
  const cnDb = path.join(appSupport, 'com.qodercn.app.stable', 'main.sqlite');
  const options = { homeDir, platform: 'linux', env: FIXTURE_ENV };
  const write = (target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'x'); };

  // Only the shared database exists and neither site has a footprint: nobody may
  // claim it, because it cannot be attributed.
  write(sharedDb);
  assert.deepEqual(selectQoderMainDbPaths(qoderDataPaths({ ...options, site: 'global' })), []);
  assert.deepEqual(selectQoderMainDbPaths(qoderDataPaths({ ...options, site: 'cn' })), []);

  // An international footprint assigns it to `qoder` and keeps it away from CN.
  fs.mkdirSync(path.join(homeDir, '.qoder'), { recursive: true });
  assert.deepEqual(selectQoderMainDbPaths(qoderDataPaths({ ...options, site: 'global' })), [sharedDb]);
  assert.deepEqual(selectQoderMainDbPaths(qoderDataPaths({ ...options, site: 'cn' })), []);

  // A Qoder CN 0.1.x footprint does the opposite.
  fs.rmSync(path.join(homeDir, '.qoder'), { recursive: true, force: true });
  fs.mkdirSync(path.join(homeDir, '.qoder-cn'), { recursive: true });
  assert.deepEqual(selectQoderMainDbPaths(qoderDataPaths({ ...options, site: 'global' })), []);
  assert.deepEqual(selectQoderMainDbPaths(qoderDataPaths({ ...options, site: 'cn' })), [sharedDb]);

  // Once the current CN bundle id exists it wins outright: it is not shared, so
  // no footprint is needed and the stale copy is never read on top of it.
  write(cnDb);
  assert.deepEqual(selectQoderMainDbPaths(qoderDataPaths({ ...options, site: 'cn' })), [cnDb]);

  // An explicit override is an operator decision and bypasses the gate.
  const overridden = qoderDataPaths({
    ...options,
    site: 'global',
    env: { TOKEN_MONITOR_QODER_MAIN_DB_PATH: '/srv/qoder/main.sqlite' }
  });
  assert.deepEqual(overridden.mainDbPaths, [path.resolve('/srv/qoder/main.sqlite')]);
  assert.deepEqual(overridden.gatedMainDbPaths, []);
  assert.deepEqual(overridden.siteFootprintDirs, []);
});

test('collectQoderCnMainRows reads the footprint-selected candidate only once', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-main-candidates-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const appSupport = path.join(homeDir, '.config');
  // Both spellings present, as an in-place upgrade can leave them, plus the CN
  // profile so the shared one is attributable at all.
  for (const bundleId of ['com.qodercn.app.stable', 'com.qoder.app.stable']) {
    fs.mkdirSync(path.join(appSupport, bundleId), { recursive: true });
    fs.writeFileSync(path.join(appSupport, bundleId, 'main.sqlite'), 'not a database');
  }
  fs.mkdirSync(path.join(homeDir, '.qoder-cn'), { recursive: true });

  const read = [];
  await collectQoderCnMainRows({
    homeDir,
    platform: 'linux',
    env: FIXTURE_ENV,
    readMainDbRows: async (dbPath) => { read.push(dbPath); return []; }
  });

  assert.deepEqual(read, [path.join(appSupport, 'com.qodercn.app.stable', 'main.sqlite')]);
});

test('the global site ignores an ambient QODER_CONFIG_DIR but honours its own overrides', () => {
  // The Qoder CN runtime exports *both* QODER_CONFIG_DIR and QODERCN_CONFIG_DIR
  // into every child process it spawns, and on a machine where only Qoder CN is
  // installed QODER_CONFIG_DIR points at ~/.qoder-cn (verified 2026-09-26).
  // Honouring it for `global` would bill CN usage to the `qoder` client.
  const ambient = qoderDataPaths({
    site: 'global',
    homeDir: '/home/test',
    platform: 'linux',
    env: { QODER_CONFIG_DIR: '/home/test/.qoder-cn', QODERCN_CONFIG_DIR: '/home/test/.qoder-cn' }
  });
  assert.deepEqual(ambient.transcriptRoots, [path.join('/home/test', '.qoder', 'projects')]);

  // The CN site still relocates through its own variable.  Configured roots go through
  // `path.resolve`, so the expectation is built the same way: on Windows the POSIX-style
  // input resolves onto the current drive, exactly as the sibling override test above
  // asserts.
  const cn = qoderDataPaths({
    site: 'cn',
    homeDir: '/home/test',
    platform: 'linux',
    env: { QODERCN_CONFIG_DIR: '/home/test/.qoder-cn' }
  });
  assert.deepEqual(
    cn.transcriptRoots,
    [path.join(path.resolve('/home/test/.qoder-cn'), 'projects')]
  );

  // TOKEN_MONITOR-namespaced overrides work for both sites and stay separate.
  const overridden = qoderDataPaths({
    site: 'global',
    homeDir: '/home/test',
    platform: 'linux',
    env: {
      TOKEN_MONITOR_QODER_DB_PATH: '/srv/qoder/local.db',
      TOKEN_MONITOR_QODER_MAIN_DB_PATH: '/srv/qoder/main.sqlite',
      TOKEN_MONITOR_QODER_TRANSCRIPTS_DIR: '/srv/qoder/projects'
    }
  });
  assert.deepEqual(overridden.dbPaths, [path.resolve('/srv/qoder/local.db')]);
  assert.deepEqual(overridden.mainDbPaths, [path.resolve('/srv/qoder/main.sqlite')]);
  assert.deepEqual(overridden.transcriptRoots, [path.resolve('/srv/qoder/projects')]);

  const cnUnaffected = qoderDataPaths({ site: 'cn', homeDir: '/home/test', platform: 'linux', env: {
    TOKEN_MONITOR_QODER_DB_PATH: '/srv/qoder/local.db',
    TOKEN_MONITOR_QODER_MAIN_DB_PATH: '/srv/qoder/main.sqlite',
    TOKEN_MONITOR_QODER_TRANSCRIPTS_DIR: '/srv/qoder/projects'
  } });
  assert.deepEqual(cnUnaffected.dbPaths, [
    path.join('/home/test/.config', 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db')
  ]);
  assert.deepEqual(cnUnaffected.transcriptRoots, [path.join('/home/test', '.qoder-cn', 'projects')]);
});

test('qoderSourceFingerprint separates the two sites and tracks their roots', () => {
  const options = { homeDir: '/home/test', platform: 'linux', env: {} };
  const cn = qoderSourceFingerprint({ ...options, site: 'cn' });
  const global = qoderSourceFingerprint({ ...options, site: 'global' });
  assert.notEqual(cn, global);
  assert.match(cn, /^cn\|/);
  assert.match(global, /^global\|/);
  assert.equal(cn, qoderSourceFingerprint({ ...options }), 'cn is the default site');

  const relocated = qoderSourceFingerprint({
    homeDir: '/home/test',
    platform: 'linux',
    env: { QODERCN_CONFIG_DIR: '/var/lib/qodercn' }
  });
  assert.notEqual(relocated, cn, 'a relocated profile must invalidate a persisted anchor');
});

test('Qoder 0.1.x main.sqlite rows estimate message content without exposing source ids', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-main-usage-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const first = Date.parse('2026-09-03T10:00:00.000Z');
  const second = Date.parse('2026-09-03T10:01:00.000Z');
  const rows = await collectQoderCnMainRows({
    homeDir,
    platform: 'win32',
    env: {},
    mainDbPaths: ['/virtual/main.sqlite'],
    readMainDbRows: async () => [
      {
        session_id: 'private-session',
        message_id: 'private-user',
        sequence: 1,
        created_at: first,
        session_model: 'custom_model',
        payload_json: JSON.stringify({ role: 'user', text: 'prompt' })
      },
      {
        session_id: 'private-session',
        message_id: 'private-assistant',
        sequence: 2,
        created_at: first + 1_000,
        session_model: 'custom_model',
        payload_json: JSON.stringify({
          role: 'assistant',
          text: 'answer',
          timestamp: new Date(first + 1_000).toISOString(),
          parts: [
            { type: 'thinking', text: 'think' },
            { type: 'text', text: 'answer' },
            { type: 'tool', tool: { name: 'Read', input: { path: 'file' }, response: 'result' } }
          ]
        })
      },
      {
        session_id: 'private-session',
        message_id: 'private-user-2',
        sequence: 3,
        created_at: second,
        session_model: 'custom_model',
        payload_json: JSON.stringify({ role: 'user', text: 'next' })
      },
      {
        session_id: 'private-session',
        message_id: 'private-assistant-2',
        sequence: 4,
        created_at: second + 1_000,
        session_model: 'custom_model',
        payload_json: JSON.stringify({ role: 'assistant', text: 'done', parts: [{ type: 'text', text: 'done' }] })
      }
    ]
  });

  assert.equal(rows.length, 2);
  // The fixture deliberately uses a code no Qoder release has ever shipped: an
  // unmapped BYOK/custom code must stay explicit. (This used to assert on
  // `qfmodel`, which was unknown in the 2026-07 build but is now Qwen3.8-Flash
  // and the dominant code in real transcripts — pinning the passthrough rule to
  // a rotating upstream code made the test expire.)
  assert.equal(rows[0].model, 'custom_model', 'unknown model codes remain explicit, not falsely mapped');
  assert.equal(rows[0].projectLabel, '', 'main.sqlite does not provide a safe project label by default');
  assert.equal(rows[0].input, 2, 'the user prompt is the first request context');
  assert.equal(rows[0].output, 10, 'assembled text, thinking, tool input and tool response are estimated once');
  assert.equal(rows[1].input, 13,
    'a later request includes the full preceding conversation (2 + 10 + 1 = 13)');
  assert.equal(rows[1].output, 1);
  assert.equal(rows.reduce((total, row) => total + row.input + row.output, 0), 26,
    'the two rows sum input and output per standard turn request semantics');
  assert.equal(rows[0].estimated, true);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'cacheRead', 'cacheWrite', 'createdAt', 'estimated', 'input', 'messageId',
    'messages', 'model', 'output', 'projectLabel', 'sessionId'
  ]);
  assert.deepEqual(rows[0].sourceIdentities, ['private-assistant']);
  assert.equal(rows[0].messageId.includes('private-assistant'), false);
});

(sqlite ? test : test.skip)('Qoder 0.1.x main.sqlite schema is read end to end', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-main-sqlite-'));
  const dbPath = path.join(tmp, 'main.sqlite');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec(`CREATE TABLE chat_sessions (
    session_id TEXT PRIMARY KEY,
    model TEXT,
    cwd TEXT,
    workspace_id TEXT
  );
  CREATE TABLE chat_session_messages (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    turn_id TEXT,
    sequence INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    feedback TEXT,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  database.prepare('INSERT INTO chat_sessions (session_id, model) VALUES (?, ?)').run('s1', 'lite');
  const insert = database.prepare(`INSERT INTO chat_session_messages
    (session_id, message_id, sequence, payload_json, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'completed', 'local', ?, ?)`);
  const timestamp = Date.parse('2026-09-03T10:00:00.000Z');
  insert.run('s1', 'u1', 1, JSON.stringify({ role: 'user', text: 'hi', timestamp: new Date(timestamp).toISOString() }), timestamp, timestamp);
  insert.run('s1', 'a1', 2, JSON.stringify({ role: 'assistant', text: 'hello', timestamp: new Date(timestamp + 1_000).toISOString(), parts: [{ type: 'text', text: 'hello' }] }), timestamp + 1_000, timestamp + 1_000);
  database.close();

  const rawRows = await readQoderCnMainDbRows(dbPath);
  assert.equal(rawRows.length, 2);
  assert.equal(rawRows[1].session_model, 'lite');
  const rows = await collectQoderCnMainRows({ mainDbPaths: [dbPath] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'Lite');
  assert.equal(rows[0].input, 1);
  assert.equal(rows[0].output, 2);
});

test('collectQoderCnRows reads DB rows and deduplicates by messageId', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-usage-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const rows = await collectQoderCnRows({
    homeDir,
    platform: 'darwin',
    env: {},
    readDbRows: async () => [{
      row_id: 1,
      id: 'm1',
      session_id: 's1',
      token_info: JSON.stringify({ prompt_tokens: 12, cached_tokens: 10, completion_tokens: 3 }),
      model_info: JSON.stringify({ model_key: 'qmodel_latest' }),
      gmt_create: Date.parse('2026-07-29T08:00:00.000Z')
    }, {
      row_id: 2,
      id: 'm1',
      session_id: 's1',
      token_info: JSON.stringify({ prompt_tokens: 12, cached_tokens: 10, completion_tokens: 3 }),
      model_info: JSON.stringify({ model_key: 'qmodel_latest' }),
      gmt_create: Date.parse('2026-07-29T08:00:00.000Z')
    }],
    dbPaths: ['/virtual/qoder.db']
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 2);
  assert.equal(rows[0].cacheRead, 10);
  assert.equal(rows[0].output, 3);
});

test('readQoderCnDbRows fails loudly when both sqlite backends are unavailable', async () => {
  const logged = [];
  await assert.rejects(
    readQoderCnDbRows('/virtual/qoder.db', {
      execFile: async () => { throw new Error('sqlite3: ENOENT'); },
      requireFn: () => { throw new Error('node:sqlite not available'); },
      logger: (message) => logged.push(message)
    }),
    /qodercn sqlite read failed: sqlite3 CLI: sqlite3: ENOENT; node:sqlite: node:sqlite not available/
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0], /sqlite3 CLI: sqlite3: ENOENT/);
  assert.match(logged[0], /node:sqlite: node:sqlite not available/);
});

test('sqlite3 maxBuffer failures do not fall through to an unbounded Node read', async () => {
  resetQoderCnChatSessionProbe();
  let nodeFallbackCalled = false;
  const execFile = async (_command, args) => {
    if (String(args.at(-1)).includes('sqlite_master')) return { stdout: '[{"1":1}]' };
    const error = new Error('stdout maxBuffer length exceeded');
    error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    throw error;
  };

  await assert.rejects(
    readQoderCnDbRows('/virtual/qoder-budget.db', {
      execFile,
      requireFn: () => {
        nodeFallbackCalled = true;
        throw new Error('Node fallback must not run');
      }
    }),
    (error) => error.code === 'QODER_CN_READ_BUDGET_EXCEEDED'
      && /bytes limit/.test(error.message)
  );
  assert.equal(nodeFallbackCalled, false);
  resetQoderCnChatSessionProbe();
});

(sqlite ? test : test.skip)('Qoder SQLite fixture passes an integrity check', (t) => {
  let database;
  try {
    database = new sqlite.DatabaseSync(QODER_CN_DB_FIXTURE, { readOnly: true });
    const result = database.prepare('PRAGMA quick_check').get();
    assert.equal(result?.quick_check, 'ok');
  } catch (error) {
    if (error?.code === 'ENOENT' || /cannot find|not available/i.test(String(error?.message || ''))) {
      t.skip(`no sqlite backend available: ${error.message}`);
      return;
    }
    throw error;
  } finally {
    database?.close();
  }
});

(sqlite ? test : test.skip)('node:sqlite reads fail closed when the row budget is exceeded', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-row-budget-'));
  const dbPath = path.join(tmp, 'local.db');
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); resetQoderCnChatSessionProbe(); });
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec(`CREATE TABLE chat_message (
    id TEXT, session_id TEXT, request_id TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER, role TEXT
  )`);
  const insert = database.prepare(`INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, 'assistant')`);
  for (const id of ['m1', 'm2']) {
    insert.run(id, 's1', `r-${id}`, '{"prompt_tokens":5,"completion_tokens":2}', '{"model_key":"qmodel"}', Date.now());
  }
  database.close();
  resetQoderCnChatSessionProbe();

  await assert.rejects(
    readQoderCnDbRows(dbPath, {
      execFile: async () => { throw new Error('sqlite3 unavailable'); },
      maxReadRows: 1
    }),
    (error) => error.code === 'QODER_CN_READ_BUDGET_EXCEEDED'
      && /rows limit 1/.test(error.message)
  );

  await assert.rejects(
    readQoderCnDbRows(dbPath, {
      execFile: async () => { throw new Error('sqlite3 unavailable'); },
      maxReadBytes: 32
    }),
    (error) => error.code === 'QODER_CN_READ_BUDGET_EXCEEDED'
      && /bytes limit 32/.test(error.message)
  );
});

(sqlite ? test : test.skip)('a cached absent chat_session capability expires after the negative TTL', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-schema-cache-'));
  const dbPath = path.join(tmp, 'local.db');
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); resetQoderCnChatSessionProbe(); });
  let database = new sqlite.DatabaseSync(dbPath);
  database.exec(`CREATE TABLE chat_message (
    id TEXT, session_id TEXT, request_id TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER, role TEXT
  )`);
  database.prepare(`INSERT INTO chat_message VALUES ('m1','s1','r1','{"prompt_tokens":5,"completion_tokens":2}','{"model_key":"qmodel"}',?,'assistant')`).run(Date.now());
  database.close();
  const options = {
    execFile: async () => { throw new Error('sqlite3 unavailable'); },
    negativeSchemaCacheTtlMs: 1_000
  };
  resetQoderCnChatSessionProbe();

  const beforeMigration = await readQoderCnDbRows(dbPath, { ...options, nowMs: 100 });
  assert.equal(beforeMigration[0].project_name, undefined);

  database = new sqlite.DatabaseSync(dbPath);
  database.exec('CREATE TABLE chat_session (session_id TEXT PRIMARY KEY, project_name TEXT)');
  database.prepare('INSERT INTO chat_session VALUES (?, ?)').run('s1', 'migrated-project');
  database.close();

  const cached = await readQoderCnDbRows(dbPath, { ...options, nowMs: 500 });
  assert.equal(cached[0].project_name, undefined, 'negative cache avoids probing every tick');
  const refreshed = await readQoderCnDbRows(dbPath, { ...options, nowMs: 1_101 });
  assert.equal(refreshed[0].project_name, 'migrated-project');
});

(sqlite ? test : test.skip)('readQoderCnDbRows handles second and millisecond Qoder timestamps in anchored reads', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-since-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, 'local.db');
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec(`CREATE TABLE chat_message (
    id TEXT,
    session_id TEXT,
    request_id TEXT,
    token_info TEXT,
    model_info TEXT,
    gmt_create INTEGER,
    role TEXT
  )`);
  database.exec(`CREATE TABLE chat_session (
    session_id varchar(64) primary key,
    user_id varchar(64) not null,
    user_name varchar(64),
    session_title varchar(256) not null,
    project_id varchar(64) not null,
    project_uri varchar(512),
    project_name varchar(64),
    gmt_create INTEGER,
    gmt_modified INTEGER
  )`);
  const insert = database.prepare(`
    INSERT INTO chat_message (id, session_id, request_id, token_info, model_info, gmt_create, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const sinceMs = Date.parse('2026-07-29T00:00:00Z');
  const add = (id, gmtCreate) => insert.run(
    id, `session-${id}`, `request-${id}`,
    JSON.stringify({ prompt_tokens: 2, completion_tokens: 1 }),
    JSON.stringify({ model_key: 'qmodel' }), gmtCreate, 'assistant'
  );
  add('old-ms', sinceMs - 1);
  add('new-ms', sinceMs + 1_000);
  add('new-seconds', Math.floor((sinceMs + 2_000) / 1_000));
  add('new-iso', '2026-07-29T00:00:03.000Z');
  database.close();

  const rows = await readQoderCnDbRows(dbPath, {
    sinceMs,
    execFile: async () => { throw new Error('sqlite3 unavailable'); }
  });

  assert.deepEqual(rows.map((row) => row.id).sort(), ['new-iso', 'new-ms', 'new-seconds']);
});

test('Qoder SQLite fixture is queried and normalized end to end', async (t) => {
  let rows;
  try {
    rows = await collectQoderCnRows({ dbPaths: [QODER_CN_DB_FIXTURE] });
  } catch (error) {
    skipOnlyWhenSqliteBackendIsMissing(t, error);
    return;
  }

  assert.equal(rows.length, 10);
  const byId = new Map(rows.map((row) => [row.messageId.split(':').pop(), row]));
  assert.deepEqual(
    {
      model: byId.get('msg-1').model,
      input: byId.get('msg-1').input,
      cacheRead: byId.get('msg-1').cacheRead,
      output: byId.get('msg-1').output
    },
    { model: 'Qwen3.7-Max', input: 446, cacheRead: 57_853, output: 2_812 }
  );
  assert.equal(byId.get('msg-8').model, 'qoder-agent');
  // ISO text timestamps (Z-suffixed so SQL and JS agree on UTC everywhere)
  // parse to milliseconds; unparseable text becomes 0 (undated), never a fake
  // 1970 timestamp. Numeric text scales like numeric columns: seconds ×1000,
  // milliseconds ≥1e12 pass through unchanged.
  assert.equal(byId.get('msg-9').createdAt, Date.parse('2026-07-29T09:00:00Z'));
  assert.equal(byId.get('msg-10').createdAt, 0);
  assert.equal(byId.get('msg-11').createdAt, 1_750_000_000 * 1000);
  assert.equal(byId.get('msg-12').createdAt, 1_785_286_800_000);
  // project_name from chat_session flows through as the session project label.
  assert.equal(byId.get('msg-1').projectLabel, 'token-monitor-main');
  assert.equal(byId.get('msg-3').projectLabel, 'ZCodeProject');
  assert.equal(byId.get('msg-10').projectLabel, '', 'the "." sentinel is filtered out');
  assert.equal(byId.get('msg-13').projectLabel, 'qoder-demo');
});

test('anchored read applies a lenient window to text timestamps and filters in SQL', async (t) => {
  let rows;
  try {
    rows = await readQoderCnDbRows(QODER_CN_DB_FIXTURE, { sinceMs: 1_785_286_800_000 });
  } catch (error) {
    skipOnlyWhenSqliteBackendIsMissing(t, error);
    return;
  }
  const ids = rows.map((row) => row.id);
  // msg-9 (Z-suffixed ISO, 15 h below sinceMs) and msg-12 (text milliseconds)
  // survive the anchored read via the lenient 24 h text window; msg-10
  // (unparseable text → 0) must still be filtered out by SQL, and msg-2
  // (numeric ms below sinceMs) must be filtered by the exact numeric branch.
  assert.ok(ids.includes('msg-9'), 'Z-suffixed ISO at sinceMs must be kept');
  assert.ok(ids.includes('msg-12'), 'text milliseconds within the window must be kept');
  // Discriminating case: msg-13 is a text ISO 8h below sinceMs — it survives
  // ONLY because of the lenient one-day window; msg-14 is a numeric row at the
  // same instant, which the exact numeric branch must still filter out.
  assert.ok(ids.includes('msg-13'), 'text row inside the lenient window must be kept');
  assert.ok(!ids.includes('msg-14'), 'numeric row at the same instant must be filtered exactly');
  assert.ok(!ids.includes('msg-10'), 'unparseable text must not survive the filter');
  assert.ok(!ids.includes('msg-2'), 'numeric row below sinceMs must be filtered exactly');
});

test('sessions reach the projects rollup with project labels end to end', async (t) => {
  const { collectQoderCnRows, buildQoderCnPeriods } = require('../../src/shared/qoderCnUsage');
  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  resetQoderCnChatSessionProbe();
  let rows;
  try {
    rows = await collectQoderCnRows({ dbPaths: [QODER_CN_DB_FIXTURE] });
  } catch (error) {
    skipOnlyWhenSqliteBackendIsMissing(t, error);
    return;
  }
  const periods = buildQoderCnPeriods({ now: new Date(), allTimeSince: '2024-01-01', rows });
  const period = extractUsageFromTokscale(periods.allTime);
  const sessions = Object.values(period.sessions);
  const withProject = sessions.filter((s) => s.projectLabel);
  assert.ok(withProject.length >= 2, 'sessions must carry project labels');
  assert.ok(withProject.some((s) => s.projectLabel === 'token-monitor-main'));
  assert.ok(withProject.some((s) => s.projectLabel === 'ZCodeProject'));
  assert.ok(!withProject.some((s) => s.projectLabel === '.'), 'the "." sentinel must stay unattributed');
});

test('reads survive a database without the chat_session table (fallback SQL)', async (t) => {
  const { readQoderCnDbRows, resetQoderCnChatSessionProbe } = require('../../src/shared/qoderCnUsage');
  const fs = require('node:fs');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-no-session-'));
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); resetQoderCnChatSessionProbe(); });
  const dbPath = path.join(tmp, 'local.db');
  let sql;
  try {
    const { DatabaseSync } = require('node:sqlite');
    sql = new DatabaseSync(dbPath);
  } catch (error) {
    t.skip(`node:sqlite unavailable: ${error.message}`);
    return;
  }
  try {
    sql.exec(`CREATE TABLE chat_message (
      id TEXT, session_id TEXT, request_id TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER, role TEXT
    )`);
    sql.prepare(`INSERT INTO chat_message VALUES ('m1','s1','r1','{"prompt_tokens":5,"completion_tokens":2}','{"model_key":"qmodel"}',${Date.now()},'assistant')`).run();
    sql.close();
  } catch (error) {
    sql.close();
    throw error;
  }
  resetQoderCnChatSessionProbe();
  let rows;
  try {
    rows = await readQoderCnDbRows(dbPath);
  } catch (error) {
    t.fail(`read must not fail without chat_session: ${error.message}`);
    return;
  }
  assert.equal(rows.length, 1, 'fallback query still returns rows');
  assert.equal(rows[0].project_name, undefined, 'no project column in fallback');
});

test('estimateQoderCnContentTokens: pure CJK rounds correctly', () => {
  // 4 CJK chars -> ceil(4/1.5) = ceil(2.67) = 3
  const result = estimateQoderCnContentTokens({ content: '你好世界' });
  assert.equal(result, 3, '4 CJK chars should produce 3 tokens');
});

test('estimateQoderCnContentTokens: pure ASCII rounds correctly', () => {
  // 11 ASCII chars -> ceil(11/4) = ceil(2.75) = 3
  const result = estimateQoderCnContentTokens({ content: 'hello world' });
  assert.equal(result, 3, '11 ASCII chars should produce 3 tokens');
});

test('estimateQoderCnContentTokens: mixed content rounds once', () => {
  // 2 CJK + 3 ASCII -> ceil(2/1.5 + 3/4) = ceil(1.333 + 0.75) = ceil(2.083) = 3
  const result = estimateQoderCnContentTokens({ content: '你好abc' });
  assert.equal(result, 3, 'mixed content should produce 3 tokens (single blend)');
});

test('estimateQoderCnContentTokens: emoji code points do not inflate CJK count', () => {
  // 2 emoji (surrogate pairs) + 2 CJK -> 2 other + 2 CJK -> ceil(2/1.5 + 2/4) = ceil(1.333 + 0.5) = ceil(1.833) = 2
  const result = estimateQoderCnContentTokens({ content: '😀😀你好' });
  assert.equal(result, 2, 'emoji should not be counted as CJK (surrogate pairs)');
});

test('collectQoderCnTranscriptRows: nested directory walk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-test-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'myproj', 'sub', 'deeper');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  const line = JSON.stringify({
    timestamp: '2026-08-15T10:00:00Z',
    message: { role: 'assistant', content: 'hello', model: 'dfmodel', usage: { credits: 1 } }
  });
  fs.writeFileSync(sessionFile, line + '\n');
  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  assert.equal(rows.length, 1, 'nested directory file should be collected');
  assert.equal(rows[0].model, 'DeepSeek-V4.1-Flash', 'model should be resolved from display names');
  assert.equal(rows[0].input, 0, 'first request has 0 cumulative context');
  assert.equal(rows[0].output, 2, 'hello = ceil(5/4) = 2 tokens');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('collectQoderCnTranscriptRows: skips oversized lines and bad JSON', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-test-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  const validLine = JSON.stringify({
    timestamp: '2026-08-15T10:00:00Z',
    message: { role: 'assistant', content: 'hi', model: 'dfmodel', usage: { credits: 1 } }
  });
  const validLine2 = JSON.stringify({
    timestamp: '2026-08-15T10:30:00Z',
    message: { role: 'assistant', content: 'ok', model: 'dfmodel', usage: { credits: 2 } }
  });
  const oversizedLine = 'x'.repeat(3000000);
  const badJsonLine = 'not json at all';
  fs.writeFileSync(sessionFile, [validLine, oversizedLine, badJsonLine, validLine2].join('\n') + '\n');
  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  assert.equal(rows.length, 1, 'two valid lines for same day/model merge into one row');
  assert.equal(rows[0].messages, 2, 'both valid lines contributed to the bucket');
  assert.equal(rows[0].input, 1, 'second request sends the first turn as context ("hi" = 1 token)');
  assert.equal(rows[0].output, 2, 'hi(1 token) + ok(1 token) = 2 output tokens');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a sessions context is billed per LLM request (cumulative prompt context)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-context-once-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const line = (role, content, uuid, credits) => JSON.stringify({
    type: role,
    uuid,
    timestamp: '2026-08-15T10:00:00Z',
    message: { role, content, model: 'dfmodel', usage: { request_id: uuid, credits } }
  });
  const lines = [];
  for (let index = 0; index < 6; index += 1) {
    lines.push(line('user', 'aaa bbb ccc', `user-${index}`, 0));
    lines.push(line('assistant', 'reply', `assistant-${index}`, 1));
  }
  fs.writeFileSync(path.join(projectsDir, 'session.jsonl'), `${lines.join('\n')}\n`);

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  const totalTokens = (list) => list.reduce((sum, row) => sum + row.input + row.output, 0);
  const summed = totalTokens(rows);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(rows.length, 6);
  assert.equal(rows.reduce((sum, row) => sum + row.credits, 0), 6, 'credits stay per request');
  // Prompt context grows with each round: 3, 8, 13, 18, 23, 28 (sum 93) + 12 output = 105 total tokens
  assert.equal(summed, 105, 'the session bills cumulative prompt context for each LLM turn');
});

test('an anchored read of a session that began earlier bills full prompt context for in-window requests', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-context-anchor-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const line = (role, content, uuid, timestamp, credits) => JSON.stringify({
    type: role,
    uuid,
    timestamp,
    message: { role, content, model: 'dfmodel', usage: { request_id: uuid, credits } }
  });
  const yesterday = [
    line('user', 'aaa bbb ccc ddd', 'u0', '2026-08-14T10:00:00Z', 0),
    line('assistant', 'old reply', 'a0', '2026-08-14T10:00:05Z', 5)
  ];
  const today = [
    line('user', 'eee fff', 'u1', '2026-08-15T10:00:00Z', 0),
    line('assistant', 'new reply', 'a1', '2026-08-15T10:00:05Z', 2)
  ];
  fs.writeFileSync(
    path.join(projectsDir, 'session.jsonl'),
    `${[...yesterday, ...today].join('\n')}\n`
  );

  const rows = collectQoderCnTranscriptRows({
    homeDir: tmpDir,
    sinceMs: Date.parse('2026-08-15T00:00:00'),
    env: FIXTURE_ENV
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(rows.length, 1, 'only todays request is in the window');
  assert.equal(rows[0].credits, 2);
  assert.equal(rows[0].output, 3, '"new reply" = ceil(9/4) = 3 tokens');
  assert.equal(rows[0].input, 9,
    'input includes the conversation context prior to this request (u0 + a0 + u1 = 4 + 3 + 2 = 9)');
});

test('collectQoderCnTranscriptRows streams transcript files without readFileSync', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-stream-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  const userLine = JSON.stringify({
    type: 'user',
    timestamp: '2026-08-15T10:00:00Z',
    message: { role: 'user', content: `${'x'.repeat(65 * 1024)}你好` }
  });
  const assistantLine = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-15T10:00:01Z',
    message: { role: 'assistant', content: 'answer', model: 'dfmodel' }
  });
  fs.writeFileSync(sessionFile, `${userLine}\n${assistantLine}\n`);

  const originalReadFileSync = fs.readFileSync;
  let readFileSyncCalled = false;
  fs.readFileSync = (...args) => {
    if (String(args[0]) === sessionFile) readFileSyncCalled = true;
    return originalReadFileSync(...args);
  };
  try {
    const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messages, 1);
    assert.equal(readFileSyncCalled, false, 'transcript content must be consumed in bounded chunks');
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('collectQoderCnTranscriptRows only bills assistant messages', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-role-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  const line = (type, role, content, credits, uuid) => JSON.stringify({
    type,
    uuid,
    timestamp: '2026-08-15T10:00:00Z',
    message: { role, content, model: 'dfmodel', usage: { credits } }
  });
  fs.writeFileSync(sessionFile, [
    line('user', 'user', 'prompt', 99, 'user-1'),
    line('assistant', 'assistant', 'answer', 1, 'assistant-1')
  ].join('\n') + '\n');

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messages, 1, 'user messages must not be billed as model requests');
  assert.equal(rows[0].input, 2, 'user content still contributes to the next request context');
  assert.equal(rows[0].output, 2);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('collectQoderCnTranscriptRows keeps assistant requests when Credits fields are absent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-optional-credits-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  fs.writeFileSync(sessionFile, JSON.stringify({
    type: 'assistant',
    uuid: 'assistant-legacy',
    timestamp: '2026-08-15T10:00:00Z',
    message: { role: 'assistant', content: 'hello', model: 'dfmodel' }
  }) + '\n');

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  assert.equal(rows.length, 1, 'missing Credits must not discard a complete assistant request');
  assert.equal(rows[0].messages, 1);
  assert.equal(rows[0].output, 2, 'hello = ceil(5/4) = 2 estimated tokens');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('mergeQoderCnRows drops only an overlapping identified transcript request', () => {
  const now = Date.parse('2026-08-15T10:00:00Z');
  const databaseRow = normalizeQoderCnDbRow({
    id: 'db-message-a',
    request_id: 'request-a',
    session_id: 'db-session',
    project_name: 'p1',
    token_info: JSON.stringify({ prompt_tokens: 4, completion_tokens: 2 }),
    model_info: JSON.stringify({ model_key: 'dfmodel' }),
    gmt_create: now
  }, 'db');
  const transcriptRows = ['request-a', 'request-b'].map((requestId, index) => {
    const row = {
      sessionId: `transcript-${index}`,
      messageId: `transcript-${index}`,
      model: 'DeepSeek-V4.1-Flash',
      projectLabel: 'p1',
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      createdAt: now,
      messages: 1,
      estimated: true
    };
    Object.defineProperty(row, 'sourceIdentities', { value: [requestId], enumerable: false });
    return row;
  });

  const merged = mergeQoderCnRows([databaseRow], transcriptRows);
  assert.equal(merged.length, 2);
  assert.equal(merged.filter((row) => row.sourceIdentities?.[0] === 'request-a').length, 1);
  assert.equal(merged.some((row) => row.sourceIdentities?.[0] === 'request-b'), true);
});

test('mergeQoderCnRows gives SQLite precedence when a matching bucket lacks identity', () => {
  const now = Date.parse('2026-08-15T10:00:00Z');
  const databaseRow = {
    sessionId: 'sqlite-session',
    messageId: 'sqlite-message',
    model: 'DeepSeek-V4.1-Flash',
    projectLabel: 'p1',
    input: 4,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: now,
    messages: 1
  };
  const transcriptRow = {
    sessionId: 'transcript-session',
    messageId: 'transcript-message',
    model: 'DeepSeek-V4.1-Flash',
    projectLabel: 'p1',
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: now,
    messages: 1,
    estimated: true
  };
  Object.defineProperty(transcriptRow, 'sourceIdentities', {
    value: ['transcript-request'],
    enumerable: false
  });
  const diagnostics = {};
  const merged = mergeQoderCnRows([databaseRow], [transcriptRow], diagnostics);

  assert.deepEqual(merged, [databaseRow]);
  assert.equal(diagnostics.duplicateRows, 1);
  assert.deepEqual(diagnostics.usedSources, ['sqlite']);
});

// A `main.sqlite` message row for session `session-1`, shaped the way the
// desktop store does it. Only main rows carry a `sourceSession`, which is what
// makes them suppressible; legacy rows never do.
function mainMessageRow(sessionId, messageId, createdAt, text = 'hello') {
  return normalizeQoderCnMainMessage({
    session_id: sessionId,
    message_id: messageId,
    sequence: 1,
    created_at: createdAt,
    session_model: 'qfmodel',
    payload_json: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text }], timestamp: createdAt })
  }, 'main:/virtual/main.sqlite', { cumulativeTokens: 10 }, 5);
}

function transcriptRowForSession(sessionId, messageId, createdAt) {
  const row = {
    sessionId: `qodercn:transcript:2026-08-15:${messageId}`,
    messageId,
    model: 'Qwen3-Max',
    projectLabel: 'p1',
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt,
    messages: 1,
    estimated: true
  };
  Object.defineProperty(row, 'sourceIdentities', { value: [messageId], enumerable: false });
  Object.defineProperty(row, 'sourceSession', { value: sessionId, enumerable: false });
  return row;
}

test('mergeQoderCnRows drops main.sqlite rows for a session the transcript tree covers', () => {
  const now = Date.parse('2026-08-15T10:00:00Z');
  const coveredMain = mainMessageRow('session-1', 'main-1', now);
  const uncoveredMain = mainMessageRow('session-2', 'main-2', now);
  const transcript = [transcriptRowForSession('session-1', 'transcript-1', now)];
  const diagnostics = {};

  const merged = mergeQoderCnRows([coveredMain, uncoveredMain], transcript, diagnostics, {
    databaseSources: { legacy: false, main: true }
  });

  assert.deepEqual(merged.map((row) => row.messageId).sort(), [
    uncoveredMain.messageId,
    'transcript-1'
  ].sort());
  assert.equal(diagnostics.suppressedMainRows, 1);
  assert.deepEqual(diagnostics.usedSources, ['main-sqlite', 'transcript']);
});

test('mergeQoderCnRows stops reporting main-sqlite once every main row is suppressed', () => {
  const now = Date.parse('2026-08-15T10:00:00Z');
  const diagnostics = {};
  const merged = mergeQoderCnRows(
    [mainMessageRow('session-1', 'main-1', now)],
    [transcriptRowForSession('session-1', 'transcript-1', now)],
    diagnostics,
    { databaseSources: { legacy: false, main: true } }
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].messageId, 'transcript-1');
  assert.equal(diagnostics.suppressedMainRows, 1);
  assert.deepEqual(diagnostics.usedSources, ['transcript']);
  assert.equal(diagnostics.source, 'transcript', 'a fully suppressed database must not claim to be the source');
});

test('mergeQoderCnRows keeps exact legacy rows even when the transcript covers the session', () => {
  const now = Date.parse('2026-08-15T10:00:00Z');
  const legacyRow = normalizeQoderCnDbRow({
    id: 'db-message-a',
    request_id: 'request-a',
    session_id: 'session-1',
    project_name: 'p1',
    token_info: JSON.stringify({ prompt_tokens: 40, completion_tokens: 20 }),
    model_info: JSON.stringify({ model_key: 'qfmodel' }),
    gmt_create: now
  }, 'db');
  assert.equal(legacyRow.sourceSession, undefined, 'legacy rows must not be suppressible');

  const diagnostics = {};
  const transcript = transcriptRowForSession('session-1', 'transcript-1', now);
  const merged = mergeQoderCnRows(
    [legacyRow],
    [transcript],
    diagnostics,
    { databaseSources: { legacy: true, main: false } }
  );

  // The legacy row survives the session suppression untouched; the transcript
  // row is a distinct request identity, so the request-level rule still decides
  // it (here: additive).
  assert.equal(merged.includes(legacyRow), true, 'the exact token_info outranks a transcript estimate');
  assert.equal(merged.includes(transcript), true);
  assert.equal(diagnostics.suppressedMainRows, 0);
  assert.deepEqual(diagnostics.usedSources, ['sqlite', 'transcript']);
});

test('mergeQoderCnRows leaves main rows alone when no transcript declares a session', () => {
  const now = Date.parse('2026-08-15T10:00:00Z');
  const anonymousTranscript = {
    sessionId: 'transcript-anon',
    messageId: 'transcript-anon',
    model: 'Qwen3-Max',
    projectLabel: 'p2',
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: now,
    messages: 1,
    estimated: true
  };
  const diagnostics = {};
  const main = mainMessageRow('session-1', 'main-1', now);
  const merged = mergeQoderCnRows([main], [anonymousTranscript], diagnostics, {
    databaseSources: { legacy: false, main: true }
  });

  assert.equal(merged.length, 2, 'without a session key there is nothing to suppress on');
  assert.equal(diagnostics.suppressedMainRows, 0);
});

test('collectQoderCnTranscriptRows tags rows with the upstream session id, subagents included', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-session-'));
  const projectDir = path.join(homeDir, '.qoder-cn', 'projects', 'p1');
  const sessionDir = path.join(projectDir, 'aaaaaaaa-1111-2222-3333-444444444444');
  fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });

  const event = (sessionId, uuid, text) => `${JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid,
    timestamp: '2026-08-15T10:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })}\n`;

  fs.writeFileSync(
    path.join(sessionDir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
    event('aaaaaaaa-1111-2222-3333-444444444444', 'u1', 'parent turn')
  );
  // A subagent file is named after the agent run, not the session; it declares
  // its parent's session id, which is the value main.sqlite keys on.
  fs.writeFileSync(
    path.join(sessionDir, 'subagents', 'agent-ageneral-purpose-deadbeef.jsonl'),
    event('aaaaaaaa-1111-2222-3333-444444444444', 'u2', 'subagent turn')
  );
  // A session whose records never declare sessionId still resolves through its
  // file name.
  fs.writeFileSync(
    path.join(projectDir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'u3',
      timestamp: '2026-08-15T10:00:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'path derived' }] }
    })}\n`
  );

  try {
    const rows = collectQoderCnTranscriptRows({ homeDir, platform: 'linux', env: FIXTURE_ENV });
    const sessions = rows.map((row) => row.sourceSession).sort();
    assert.deepEqual(sessions, [
      'aaaaaaaa-1111-2222-3333-444444444444',
      'aaaaaaaa-1111-2222-3333-444444444444',
      'bbbbbbbb-1111-2222-3333-444444444444'
    ]);
    assert.equal(
      Object.keys(rows[0]).includes('sourceSession'),
      false,
      'the session id must stay non-enumerable so it cannot reach the wire'
    );
    assert.equal(JSON.stringify(rows[0]).includes('aaaaaaaa'), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('collectQoderCnTranscriptRows: respects sinceMs filter', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-test-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  const oldLine = JSON.stringify({
    timestamp: '2026-08-01T10:00:00Z',
    message: { role: 'assistant', content: 'old', model: 'dfmodel', usage: { credits: 1 } }
  });
  const newLine = JSON.stringify({
    timestamp: '2026-08-15T10:00:00Z',
    message: { role: 'assistant', content: 'new', model: 'dfmodel', usage: { credits: 1 } }
  });
  fs.writeFileSync(sessionFile, [oldLine, newLine].join('\n') + '\n');
  const sinceMs = Date.parse('2026-08-10T00:00:00Z');
  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, sinceMs, env: FIXTURE_ENV });
  assert.equal(rows.length, 1, 'only line after sinceMs should be included');
  assert.ok(rows[0].sessionId.includes('2026-08-15'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('collectQoderCnTranscriptRows filters same-day events by their actual timestamp', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-since-day-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  const event = (timestamp, content) => JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content, model: 'dfmodel', usage: { credits: 1 } }
  });
  fs.writeFileSync(sessionFile, [
    event('2026-08-15T09:00:00Z', 'before'),
    event('2026-08-15T11:00:00Z', 'after')
  ].join('\n') + '\n');
  const rows = collectQoderCnTranscriptRows({
    homeDir: tmpDir,
    sinceMs: Date.parse('2026-08-15T10:00:00Z'),
    env: FIXTURE_ENV
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messages, 1, 'the event before sinceMs must be excluded');
  assert.equal(rows[0].output, 2, 'only the retained event contributes output');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('collectQoderCnTranscriptRows ignores cumulative Result usage instead of double-counting it', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-result-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  fs.writeFileSync(sessionFile, [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-15T10:00:00Z',
      message: { role: 'assistant', content: 'answer', model: 'dfmodel', usage: { credits: 1 } }
    }),
    JSON.stringify({
      type: 'result',
      timestamp: '2026-08-15T10:00:01Z',
      total_credits: 1,
      message: { role: 'result', content: 'final' }
    })
  ].join('\n') + '\n');
  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messages, 1, 'Result cumulative credits are not another request');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('collectQoderCnTranscriptRows inherits the model from a system init record', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-model-init-'));
  const projectsDir = path.join(tmpDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionFile = path.join(projectsDir, 'session.jsonl');
  fs.writeFileSync(sessionFile, [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'q35model_preview',
      session_id: 'session-1'
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-08-15T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] }
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      timestamp: '2026-08-15T10:00:01Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }]
      }
    })
  ].join('\n') + '\n');

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  assert.equal(rows.length, 1);
  // q35model_preview is the "Qwen3.7-Max-DogFooding" slot; it maps to the
  // underlying model so the row stays priceable.
  assert.equal(rows[0].model, 'Qwen3.7-Max');
  assert.equal(rows[0].input, 2, 'the preceding user content remains part of the request context');
  assert.equal(rows[0].output, 2);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Qoder bills in credits, not tokens: every token field of its `usage` block is
// structurally present and always 0 (verified across 5617 records in both
// editions' transcript trees on 2026-09-26), while `credits` is the provider's
// own exact per-request meter. These pin that the one non-estimated Qoder number
// survives from `message.usage.credits` into the period the collector consumes.

function creditsLine({ requestId = 'request-1', credits = 0.323132128, content = 'answer' } = {}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: requestId,
    timestamp: '2026-08-15T10:00:00Z',
    message: {
      role: 'assistant',
      content,
      model: 'dfmodel',
      usage: { request_id: requestId, credits, billable: true }
    }
  });
}

function writeCreditsTranscript(homeDir, lines) {
  const projectsDir = path.join(homeDir, '.qoder-cn', 'projects', 'p1');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, 'session.jsonl'), `${lines.join('\n')}\n`);
}

test('a transcript row carries the credit meter verbatim beside its estimated tokens', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-credits-exact-'));
  writeCreditsTranscript(tmpDir, [creditsLine()]);

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].credits, 0.323132128, 'a credit is a provider figure, not something to round');
  assert.equal(rows[0].estimated, true, 'the token totals alongside it remain content estimates');
});

test('a transcript that reports real token counts is exact and keeps its cache buckets', () => {
  // Current Qoder builds zero every token field, but the parser must not bake
  // that in: a future build that starts reporting usage has to become exact
  // automatically instead of inheriting the content-estimate flag forever.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-exact-tokens-'));
  writeCreditsTranscript(tmpDir, [JSON.stringify({
    type: 'assistant',
    uuid: 'request-exact',
    timestamp: '2026-08-15T10:00:00Z',
    message: {
      role: 'assistant',
      content: 'answer',
      model: 'dfmodel',
      usage: {
        request_id: 'request-exact',
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        credits: 0.5
      }
    }
  })]);

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].estimated, false, 'provider-reported tokens must not stay marked as an estimate');
  assert.equal(rows[0].tokenProvenance, 'exact');
  assert.equal(rows[0].input, 1200);
  assert.equal(rows[0].output, 80);
  assert.equal(rows[0].cacheRead, 900, 'cache reads were accumulated but used to be dropped on the row');
  assert.equal(rows[0].cacheWrite, 100);
});

test('a bucket that mixes exact and reconstructed requests stays estimated', () => {
  // One identity can appear twice (a usage-bearing record and an older one
  // without counts). Splitting it would double-count the request; keeping it in
  // one bucket and downgrading the row is the conservative choice.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-mixed-tokens-'));
  writeCreditsTranscript(tmpDir, [
    JSON.stringify({
      type: 'assistant',
      uuid: 'request-mixed',
      timestamp: '2026-08-15T10:00:00Z',
      message: {
        role: 'assistant',
        content: 'answer',
        model: 'dfmodel',
        usage: { request_id: 'request-mixed', input_tokens: 100, output_tokens: 10, credits: 0.2 }
      }
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'request-mixed',
      timestamp: '2026-08-15T10:01:00Z',
      message: { role: 'assistant', content: 'answer', model: 'dfmodel', usage: { credits: 0.3 } }
    })
  ]);

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(rows.length, 1, 'the same identity must not become two rows');
  assert.equal(rows[0].estimated, true);
  assert.equal(rows[0].tokenProvenance, 'estimated');
});

test('requests folded into one bucket sum their credits', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-credits-bucket-'));
  // No uuid and no request_id: both records fall in the conservative same-day
  // bucket, which is also where the credits have to add up.
  writeCreditsTranscript(tmpDir, [0.25, 0.75].map((credits) => JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-15T10:00:00Z',
    message: { role: 'assistant', content: 'answer', model: 'dfmodel', usage: { credits } }
  })));

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].messages, 2);
  assert.equal(rows[0].credits, 1);
});

test('a request with no usage block credits zero rather than going missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-credits-absent-'));
  writeCreditsTranscript(tmpDir, [JSON.stringify({
    type: 'assistant',
    uuid: 'legacy-no-usage',
    timestamp: '2026-08-15T10:00:00Z',
    message: { role: 'assistant', content: 'answer', model: 'dfmodel' }
  })]);

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(rows.length, 1, 'an older CLI that never wrote usage must still be billed in tokens');
  assert.equal(rows[0].credits, 0);
});

test('buildQoderCnPeriods publishes credits so the collector folds them into clientCredits', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-credits-period-'));
  writeCreditsTranscript(tmpDir, [creditsLine({ requestId: 'r1', credits: 0.5 }), creditsLine({ requestId: 'r2', credits: 0.25 })]);
  const { extractUsageFromTokscale } = require('../../src/shared/usage');

  const rows = collectQoderCnTranscriptRows({ homeDir: tmpDir, env: FIXTURE_ENV });
  const periods = buildQoderCnPeriods({
    now: Date.parse('2026-08-15T12:00:00Z'),
    allTimeSince: Date.parse('2026-01-01T00:00:00Z'),
    rows,
    pricingByModel: {},
    clientId: 'qodercn'
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const credits = periods.allTime.entries.map((entry) => entry.credits);
  assert.deepEqual(credits, [0.75],
    'entries are grouped by session and model, so two requests in one session sum into one entry');
  const period = extractUsageFromTokscale(periods.allTime);
  assert.equal(period.clientCredits.qodercn, 0.75);
  assert.equal(period.costUsd, Object.values(period.clientCosts).reduce((total, value) => total + value, 0),
    'credits never leak into the USD totals');
});

test('mergeQoderCnRows drops a duplicated transcript request along with its credits', () => {
  // The dedup removes whole row objects, so a request the legacy database
  // already covers cannot contribute its credits a second time.
  const databaseRow = normalizeQoderCnDbRow({
    id: 'db-1',
    request_id: 'shared-request',
    session_id: 'db-session',
    token_info: JSON.stringify({ prompt_tokens: 4, completion_tokens: 2 }),
    model_info: JSON.stringify({ model_key: 'dfmodel' }),
    gmt_create: Date.parse('2026-08-15T10:00:00Z')
  }, 'db');
  const transcriptRow = {
    sessionId: 'transcript-1',
    messageId: 'transcript-1',
    model: 'DeepSeek-V4.1-Flash',
    projectLabel: 'p1',
    input: 4,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: Date.parse('2026-08-15T10:00:00Z'),
    messages: 1,
    credits: 3,
    estimated: true
  };
  Object.defineProperty(transcriptRow, 'sourceIdentities', { value: ['shared-request'], enumerable: false });

  const merged = mergeQoderCnRows([databaseRow], [transcriptRow], null);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].credits, undefined, 'the surviving row is the database one, which has no credit meter');
  assert.equal(mergeQoderCnRows([], [transcriptRow], null).reduce((total, row) => total + (row.credits || 0), 0), 3,
    'the same row does credit when nothing else already covered it');
});

test('the SQLite adapters contribute no credits, so a database-only period reports none', () => {
  const dbRow = normalizeQoderCnDbRow({
    id: 'db-1',
    session_id: 'db-session',
    token_info: JSON.stringify({ prompt_tokens: 4, completion_tokens: 2 }),
    model_info: JSON.stringify({ model_key: 'dfmodel' }),
    gmt_create: Date.parse('2026-08-15T10:00:00Z')
  }, 'db');

  assert.equal('credits' in dbRow, false, 'local.db token_info has no credit column to read');

  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  const periods = buildQoderCnPeriods({
    now: Date.parse('2026-08-15T12:00:00Z'),
    allTimeSince: Date.parse('2026-01-01T00:00:00Z'),
    rows: [dbRow],
    pricingByModel: {},
    clientId: 'qodercn'
  });

  assert.deepEqual(extractUsageFromTokscale(periods.allTime).clientCredits, {},
    'absent must stay absent rather than becoming a zero the UI would present as a reading');
});
