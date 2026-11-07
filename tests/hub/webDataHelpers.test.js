'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The UI is app.js plus its extracted view modules. Reading the whole package
// keeps these assertions about behaviour rather than about which file a renderer
// currently lives in.
function viewSources() {
  const dir = path.join(__dirname, '../../src/shared-ui/views');
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));
}

function uiSource() {
  return [fs.readFileSync(path.join(__dirname, '../../src/shared-ui/app.js'), 'utf8'), ...viewSources()].join('\n');
}

const dataPath = path.join(__dirname, '../../src/shared-ui/core/data.js');
const source = fs.readFileSync(dataPath, 'utf8');

/** @type {Awaited<typeof import('../../src/shared-ui/core/data.js')>} */
let dataApi;

test.before(async () => {
  dataApi = await import(pathToFileUrl(dataPath));
});

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath);
  const normalized = resolved.split(path.sep).join('/');
  if (/^[A-Za-z]:/.test(normalized)) return 'file:///' + normalized;
  return 'file://' + normalized;
}

test('hub web data exports expected helper surface', () => {
  assert.match(source, /export function devicePlatformLabel\(/);
  assert.match(source, /export function countActiveDays\(/);
  assert.match(source, /export function heatmapValue\(/);
  assert.match(source, /export function providerDisplayName\(/);
  assert.match(source, /export function statusRows\(/);
  assert.match(source, /export const MAX_SESSION_ROWS/);
  assert.match(source, /export function limitRemainingTone\(/);
  assert.match(source, /export function clampHomeLimitAccountCount\(/);
  assert.match(source, /openrouter:\s*'OpenRouter'/);
  assert.match(source, /export const HUB_ACCOUNT_PROVIDERS/);
});

test('openrouter client icon is published for hub web', () => {
  const icon = path.join(__dirname, '../../src/shared-ui/icons/clients/openrouter.svg');
  assert.equal(fs.existsSync(icon), true);
  const svg = fs.readFileSync(icon, 'utf8');
  assert.match(svg, /OpenRouter|openrouter/i);
});

test('hub web app wires status, heatmap, and active-days controls', () => {
  const app = uiSource();
  assert.match(app, /data-heatmap-metric|heatmap-metric/);
  assert.match(app, /data-active-days-window|active-days-window/);
  assert.match(app, /renderHeatmap\(/);
  assert.match(app, /devicePlatformLabel\(/);
  assert.match(app, /id: 'status'/);
  assert.match(app, /function renderStatus/);
  assert.match(app, /homeLimitAccountCount/);
  assert.match(app, /limitRemainingTone/);
  assert.match(app, /projects\.incomplete|sessions\.truncated/);
  assert.match(app, /id: 'subscriptions'/);
  assert.match(app, /id: 'pricing'/);
  assert.match(app, /function renderAccounts/);
  assert.match(app, /data-account-form/);
  assert.match(app, /data-account-form/);
  assert.match(app, /data-account-refresh/);
  assert.match(app, /data-account-delete/);
  assert.match(app, /data-account-provider-select/);
  assert.match(app, /<fluent-option value=/);
  assert.doesNotMatch(app, /<option(?:\s|>)/);
  assert.match(app, /data-account-provider-input/);
  assert.doesNotMatch(app, /data-account-provider-menu|accountProviderMenuOpen/);
  assert.doesNotMatch(app, /<select name="provider"/);
  assert.match(app, /historyRevision|deviceHistoryRevision/);
  assert.match(app, /data-subscription-form/);
  assert.match(app, /data-topup-ledger/);
  assert.match(app, /subscriptionTopUpRowHtml/);
  assert.match(app, /const canManage = state\.authorization\?\.authenticated === true/);
  assert.match(app, /data-pricing-form/);
  assert.match(app, /captureRenderState\(/);
  assert.match(app, /restoreRenderState\(/);
  assert.match(app, /new AbortController\(/);
  assert.match(app, /view render failed/);
  assert.match(app, /Promise\.allSettled\(/);
});

test('hub web navigation exposes the new page model and compatibility routes', () => {
  // Views are extracted into src/shared-ui/views/; read the whole package so an
  // assertion does not break merely because a renderer moved to its own module.
  // Administration is a single destination (settings, labelled 管理); the
  // accounts and consumption surfaces are sections inside it and are reached
  // through compatibility redirects rather than as their own views.
  const app = uiSource();
  for (const view of ['overview', 'usage', 'devices', 'limits', 'trends', 'settings']) {
    assert.match(app, new RegExp(`id: '${view}'`));
  }
  assert.doesNotMatch(app, /id: 'accounts'/);
  assert.doesNotMatch(app, /id: 'management'/);
  assert.match(app, /const LEGACY_ROUTE_ALIASES/);
  assert.match(app, /const VIEW_REDIRECTS = Object\.freeze\(\{ accounts: 'settings', management: 'settings' \}\)/);
  assert.match(app, /function renderUsage\(/);
  assert.match(app, /function renderConsumptionSection\(/);
  assert.match(app, /section\('accounts'/);
  assert.match(app, /section\('consumption'/);
  assert.match(app, /data-settings-section="preferences"/);
  assert.match(app, /section\('advanced'/);
  assert.match(app, /data-management-tab/);
  assert.match(app, /usage\.customRangeGlobal/);
  assert.match(app, /\['7', '30', '90', '365', 'all'\]/);
});

test('hub account UI keeps the shared form system and reports OAuth failures', () => {
  const app = uiSource();
  const index = fs.readFileSync(path.join(__dirname, '../../src/hub/web/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../src/shared-ui/styles/app.css'), 'utf8');

  assert.match(app, /const UI_ICON_PATHS/);
  assert.match(app, /data-account-mode="\$\{escapeHtml\(effectiveMode\)\}"/);
  assert.match(app, /event\.target\.closest\('fluent-button\[data-account-mode\]'\)/);
  assert.match(app, /void saveAccountFromForm\(accountForm\)\.catch/);
  assert.match(app, /account-form-error/);
  assert.doesNotMatch(index, /[☰↻⚙←×]/u);
  assert.match(css, /\.field input, \.field textarea/);
  assert.match(css, /\.field fluent-dropdown \{ display: block; width: 100%; min-height: 44px; \}/);
  assert.doesNotMatch(css, /\.field select/);
  assert.match(css, /\.account-oauth-redirect-input/);
  assert.match(css, /\.account-provider-dropdown/);
  assert.match(css, /\.account-provider-dropdown \{ display: block; width: 100%; \}/);
  assert.match(css, /--panel: var\(--bg-elevated\)/);
  assert.match(css, /@media \(max-width: 860px\)/);

  assert.match(index, /id="settingsDrawer"[^>]*aria-hidden="true"/);
  assert.match(index, /id="rangePopover"[^>]*aria-modal="true"/);
});

test('codex and antigravity only ever show the browser sign-in', () => {
  // Their manual shapes (`authJson`, `endpoint`/`csrfToken`) used to sit behind a
  // mode toggle that also reappeared on edit, so an OAuth account could be edited
  // into a token-paste form with empty fields. The wizard is now the only surface
  // for these two, on add and edit alike.
  const app = uiSource();
  assert.match(app, /isBrowserLoginProvider/);
  assert.match(app, /const browserLogin = isBrowserLoginProvider\(currentProvider\)/);
  assert.match(app, /const effectiveMode = browserLogin\s*\n?\s*\? 'oauth'/);
  // The toggle is only rendered for non-browser-login providers.
  assert.match(app, /\$\{browserLogin \? '' : `<div class="account-form-head-actions">/);
  assert.doesNotMatch(app, /isOAuthCandidate/);
  // The manual codex / antigravity field sets are gone.
  assert.doesNotMatch(app, /name="authJson"/);
  assert.doesNotMatch(app, /name="csrfToken"/);
  assert.doesNotMatch(app, /agyEndpoint/);
  // Re-authorization must target the edited account, not create a new one.
  assert.match(app, /oauthAccountId \? \{ accountId: oauthAccountId \} : \{\}/);
});

test('editing a browser-login account reports, clears, and replaces its credential', () => {
  const app = uiSource();
  assert.match(app, /data-account-clear-credential/);
  assert.match(app, /async function clearAccountCredential\(/);
  assert.match(app, /accounts\/\$\{encodeURIComponent\(accountId\)\}\/credential/);
  assert.match(app, /credentialConfigured === false \? 'accounts\.credentialMissing' : 'accounts\.credentialPresent'/);
  assert.match(app, /data-account-clear-credential="\$\{escapeHtml\(editing\?\.id \|\| ''\)\}"/);
  const css = fs.readFileSync(path.join(__dirname, '../../src/shared-ui/styles/app.css'), 'utf8');
  assert.match(css, /\.account-credential-status/);
});

test('devicePlatformLabel / countActiveDays / heatmapValue behavior', () => {
  const { devicePlatformLabel, countActiveDays, heatmapValue } = dataApi;
  assert.equal(devicePlatformLabel('win32', 'Windows', '11'), 'Windows 11');
  assert.equal(devicePlatformLabel('darwin', 'macOS', '14.5'), 'macOS 14.5');
  assert.equal(devicePlatformLabel('linux'), 'Linux');

  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const recent = new Date(today);
  recent.setUTCDate(recent.getUTCDate() - 10);
  const old = new Date(today);
  old.setUTCDate(old.getUTCDate() - 400);
  const days = [
    { date: iso(recent), tokens: 10, cost: 0.1 },
    { date: iso(old), tokens: 20, cost: 0.2 },
    { date: iso(today), tokens: 0, cost: 0 }
  ];
  assert.equal(countActiveDays(days, 'all'), 2);
  assert.equal(countActiveDays(days, 'year'), 1);
  assert.equal(heatmapValue({ tokens: 100, cost: 1.5 }, 'tokens'), 100);
  assert.equal(heatmapValue({ tokens: 100, cost: 1.5 }, 'cost'), 1.5);
});

test('agentRuntimeLabel normalizes common runtimes', () => {
  const { agentRuntimeLabel } = dataApi;
  assert.equal(agentRuntimeLabel('headless-agent'), 'headless-agent');
  // The wire value is still electron-widget; the label this product shows is not.
  assert.equal(agentRuntimeLabel('electron-widget'), 'desktop');
  assert.equal(agentRuntimeLabel('embedded-hub'), 'legacy');
  assert.equal(agentRuntimeLabel(''), '');
});

test('clientStatusEntries and wslStatusSummary filter wire shapes', () => {
  const { clientStatusEntries, wslStatusSummary } = dataApi;
  assert.deepEqual(
    clientStatusEntries({ codex: 'active', nope: 'weird', cursor: 'missing' }),
    [
      { client: 'codex', state: 'active' },
      { client: 'cursor', state: 'missing' }
    ]
  );
  assert.equal(wslStatusSummary({ state: 'broken' }), null);
  assert.deepEqual(wslStatusSummary({ state: 'active', detected: ['codex'], withData: ['codex'] }), {
    state: 'active',
    detected: ['codex'],
    withData: ['codex']
  });
});

test('deviceRows expose runtime and status fields', () => {
  const { deviceRows } = dataApi;
  const rows = deviceRows({
    devices: [{
      deviceId: 'd1',
      hostname: 'desk',
      platform: 'win32',
      osName: 'Windows',
      osVersion: '11',
      agentRuntime: 'headless-agent',
      clientStatus: { codex: 'active' },
      wslStatus: { state: 'not-running', detected: [], withData: [] },
      periods: { today: { totalTokens: 10, costUsd: 0.1 } }
    }]
  }, 'today');
  assert.equal(rows[0].agentRuntimeLabel, 'headless-agent');
  assert.equal(rows[0].clientStatus.codex, 'active');
  assert.equal(rows[0].wslStatus.state, 'not-running');
});

test('limitCards separates balance without inventing spend meter', () => {
  const { limitCards } = dataApi;
  const cards = limitCards({
    limits: {
      providers: [{
        provider: 'openrouter',
        accountLabel: 'or-main',
        balanceUsd: 12.5,
        balance: { amount: 80, currency: 'CNY' },
        resetCredits: { availableCount: 2, totalCount: 5 },
        windows: [{
          kind: 'weekly',
          label: 'Weekly',
          remainingPercent: 40,
          metric: 'credits'
        }]
      }]
    }
  });
  assert.equal(cards.length, 1);
  const kinds = cards[0].windows.map((w) => w.kind);
  assert.ok(kinds.includes('weekly'));
  assert.ok(kinds.includes('balanceUsd'));
  assert.ok(kinds.includes('balance'));
  assert.ok(kinds.includes('resetCredits'));
  const balance = cards[0].windows.find((w) => w.kind === 'balance');
  assert.equal(balance.showMeter, false);
  assert.equal(balance.value.includes('80'), true);
  const credits = cards[0].windows.find((w) => w.kind === 'weekly');
  assert.equal(credits.metric, 'credits');

  const zeroCards = limitCards({
    limits: {
      providers: [{
        provider: 'codex',
        balanceUsd: null,
        resetCredits: { availableCount: 0, nextExpiresAt: null },
        windows: [{ kind: 'weekly', remainingPercent: 10 }]
      }]
    }
  });
  assert.equal(zeroCards[0].windows.length, 1);
  assert.equal(zeroCards[0].windows[0].kind, 'weekly');
});

test('providerDisplayName and planLabel handle identity fields', () => {
  const { providerDisplayName, providerPlanLabel } = dataApi;
  assert.equal(
    providerDisplayName({ provider: 'openrouter', accountLabel: 'or-main', accountEmail: 'a@b.com' }),
    'or-main'
  );
  assert.equal(
    providerPlanLabel({ planLabel: 'Plus', plan: 'old', accountLabel: 'legacy' }),
    'Plus'
  );
  assert.equal(
    providerDisplayName({ provider: 'codex', accountEmail: 'u@x.com', workspaceKind: 'personal' }, [], 'en'),
    'u@x.com'
  );
  const peers = [
    { provider: 'codex', accountEmail: 'u@x.com', accountName: 'Work' },
    { provider: 'codex', accountEmail: 'u@x.com', accountName: 'Home' }
  ];
  assert.equal(providerDisplayName(peers[0], peers, 'en'), 'u@x.com · Work');

  assert.equal(
    providerDisplayName({ provider: 'antigravity', accountEmail: 'user@google.com', accountLabel: 'Antigravity' }),
    'user@google.com'
  );
  assert.equal(
    providerDisplayName({ provider: 'antigravity', accountName: 'agy-work', accountLabel: 'Antigravity' }),
    'agy-work'
  );
  const agyPeers = [
    { provider: 'antigravity', accountEmail: 'user@google.com', accountName: 'agy-work' },
    { provider: 'antigravity', accountEmail: 'user@google.com', accountName: 'agy-home' }
  ];
  assert.equal(
    providerDisplayName(agyPeers[0], agyPeers),
    'user@google.com · agy-work'
  );
});

test('projectRows returns incomplete flag and client color', () => {
  const { projectRows } = dataApi;
  const result = projectRows({
    projects: {
      p1: { label: 'Repo', tokens: 10, costUsd: 0.1, clients: { codex: 10 } }
    }
  }, { incomplete: true });
  assert.equal(result.incomplete, true);
  assert.equal(result.rows[0].name, 'Repo');
  assert.ok(result.rows[0].color);
});

test('sessionRows truncates large collections', () => {
  const { sessionRows, MAX_SESSION_ROWS } = dataApi;
  const sessions = {};
  for (let i = 0; i < 5; i += 1) {
    sessions['codex:s' + i] = {
      client: 'codex',
      sessionId: 's' + i,
      totalTokens: 10 + i,
      costUsd: 0.01,
      lastUsedAt: '2026-01-0' + (i + 1) + 'T00:00:00Z'
    };
  }
  const result = sessionRows({ sessions }, { limit: 3 });
  assert.equal(result.total, 5);
  assert.equal(result.rows.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(MAX_SESSION_ROWS, 200);
});

test('deviceBreakdownRows includes nested client models', () => {
  const { deviceBreakdownRows } = dataApi;
  const breakdown = deviceBreakdownRows({
    periods: {
      today: {
        totalTokens: 100,
        costUsd: 1,
        clients: { codex: 100 },
        clientCosts: { codex: 1 },
        models: { 'gpt-5': 100 },
        modelCosts: { 'gpt-5': 1 },
        clientModels: { codex: { 'gpt-5': 100 } },
        clientModelCosts: { codex: { 'gpt-5': 1 } }
      }
    }
  }, 'today');
  assert.equal(breakdown.tools[0].models[0].key, 'gpt-5');
  assert.equal(breakdown.tools[0].models[0].value, 100);
});

test('usage rows expose desktop-aligned token mix fields', () => {
  const { periodTokenMetrics, toolRows, modelRows } = dataApi;
  const period = {
    totalTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 400,
    cacheWriteTokens: 50,
    clients: { codex: 700 },
    clientCacheReads: { codex: 300 },
    clientCacheWrites: { codex: 20 },
    clientOutputs: { codex: 80 },
    models: { 'gpt-5': 700 },
    modelCacheReads: { 'gpt-5': 300 },
    modelCacheWrites: { 'gpt-5': 20 },
    modelOutputs: { 'gpt-5': 80 }
  };
  assert.deepEqual(periodTokenMetrics(period), {
    totalTokens: 1000,
    inputTokens: 900,
    outputTokens: 100,
    cacheReadTokens: 400,
    cacheWriteTokens: 50,
    uncachedInputTokens: 450,
    available: true,
    cacheHitPercent: 400 / 900 * 100
  });
  assert.equal(toolRows(period)[0].metrics.cacheReadTokens, 300);
  assert.equal(toolRows(period)[0].metrics.totalTokens, 700);
  assert.equal(modelRows(period)[0].metrics.outputTokens, 80);
});

test('statusRows marks health from stale/status', () => {
  const { statusRows } = dataApi;
  const rows = statusRows({
    limits: {
      providers: [
        { provider: 'openrouter', status: 'ok', windows: [] },
        { provider: 'deepseek', status: 'error', stale: true, windows: [] }
      ]
    }
  });
  assert.ok(rows.some((r) => r.health === 'ok'));
  assert.ok(rows.some((r) => r.health === 'stale'));
});

test('limitCards uses planLabel and openrouter identity', () => {
  const { limitCards } = dataApi;
  const cards = limitCards({
    limits: {
      providers: [{
        provider: 'openrouter',
        accountName: 'OR Key',
        planLabel: 'Credits',
        accountEmail: 'or@example.com',
        windows: [{ kind: 'weekly', label: 'Weekly', remainingPercent: 20, metric: 'credits', detail: 'mgmt key' }]
      }]
    }
  });
  assert.equal(cards[0].name, 'OR Key');
  assert.equal(cards[0].plan, 'Credits');
  assert.equal(cards[0].windows[0].detail, 'mgmt key');
});


test('limitRemainingTone matches desktop thresholds', () => {
  const { limitRemainingTone, clampHomeLimitAccountCount } = dataApi;
  assert.equal(limitRemainingTone(100), 'ok');
  assert.equal(limitRemainingTone(50), 'ok');
  assert.equal(limitRemainingTone(49.9), 'warn');
  assert.equal(limitRemainingTone(20), 'warn');
  assert.equal(limitRemainingTone(19.9), 'critical');
  assert.equal(limitRemainingTone(null), 'unknown');
  assert.equal(clampHomeLimitAccountCount(3), 3);
  assert.equal(clampHomeLimitAccountCount(0), 1);
  assert.equal(clampHomeLimitAccountCount(99), 12);
  assert.equal(clampHomeLimitAccountCount('x', 3), 3);
});


test('hub web app wires tool drill and trends stack', () => {
  const app = uiSource();
  assert.match(app, /function renderTools\(/);
  assert.match(app, /data-select-tool/);
  assert.match(app, /selectedToolId/);
  assert.match(app, /clientModels/);
  assert.match(app, /trendsStack/);
  assert.match(app, /ensureHistory/);
  assert.match(app, /\/api\/history/);
  assert.match(app, /modelColor/);
  // modelColor must actually be imported by whichever module renders the model
  // rows. The previous assertion pinned two adjacent import lines in app.js,
  // which broke the moment a view moved to its own file without anything
  // behavioural changing.
  assert.match(app, /import\s*\{[^}]*\bmodelColor\b[^}]*\}\s*from/);
  assert.match(app, /clampHomeLimitAccountCount/);
  assert.match(app, /VIEW_PATHS/);
  assert.match(app, /data-jump-view/);
  assert.match(app, /data-jump-usage-tab="models"/);
  assert.match(app, /switchView\(/);
});

test('limitCards surfaces named Codex allowances, credit counts and fetch time', () => {
  const { limitCards } = dataApi;
  const cards = limitCards({
    limits: {
      providers: [{
        provider: 'codex',
        accountEmail: 'user@example.com',
        updatedAt: '2026-09-17T10:00:00.000Z',
        windows: [
          { kind: 'session', usedPercent: 2, resetsAt: '2026-09-17T15:00:00.000Z' },
          { kind: 'named', label: 'Luna Reserve Weekly', usedPercent: 0, resetsAt: '2026-09-19T16:00:00.000Z' },
          { kind: 'credits', metric: 'credits', label: 'Credits', remaining: 820, showMeter: false, detail: '~12-40 local messages' }
        ]
      }]
    }
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].updatedAt, '2026-09-17T10:00:00.000Z');
  const reserve = cards[0].windows.find((window) => window.kind === 'named');
  assert.equal(reserve.label, 'Luna Reserve Weekly');
  assert.equal(reserve.remaining, 100);
  assert.equal(reserve.showMeter, true);
  const credits = cards[0].windows.find((window) => window.kind === 'credits');
  // A count-only pool keeps its amount visible even though it has no percentage.
  assert.equal(credits.remaining, null);
  assert.equal(credits.value, '820');
  assert.equal(credits.showMeter, false);
  assert.equal(credits.detail, '~12-40 local messages');
});

test('every id the dashboard can request an icon for resolves to a shipped file', async () => {
  // clientIconPath() builds /icons/clients/<id>.svg (after ICON_ALIASES) and the
  // <img> falls back to onerror="display:none" — except inline event handlers are
  // blocked by the Hub's own CSP, so a missing file renders a broken-image glyph
  // and re-requests it on every re-render (responses are cache-control: no-store).
  // `claude-desktop` (a default client), `commandcode`, `kimi` and `zcode` were
  // all missing this way.
  const iconsDir = path.join(__dirname, '../../src/shared-ui/icons/clients');
  const shipped = new Set(
    fs.readdirSync(iconsDir).filter((name) => name.endsWith('.svg')).map((name) => name.replace(/\.svg$/, ''))
  );

  const aliasesBlock = source.match(/const ICON_ALIASES = \{([\s\S]*?)\n\};/);
  assert.ok(aliasesBlock, 'ICON_ALIASES should exist');
  const aliases = Object.fromEntries(
    [...aliasesBlock[1].matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'([a-z0-9-]+)'/gm)].map((match) => [match[1], match[2]])
  );

  const labelBlocks = [...source.matchAll(/const (?:CLIENT_LABELS|PROVIDER_LABELS) = \{([\s\S]*?)\n\};/g)];
  assert.ok(labelBlocks.length >= 2, 'expected the client and provider label maps');
  const ids = new Set();
  for (const block of labelBlocks) {
    for (const match of block[1].matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'/gm)) ids.add(match[1]);
  }

  const missing = [...ids]
    .filter((id) => id !== 'default')
    .filter((id) => !shipped.has(aliases[id] || id))
    .sort();
  assert.deepEqual(missing, [], `ids that would 404 their icon: ${missing.join(', ')}`);

  // Any alias target must itself exist, so the table cannot point at nothing.
  const dangling = Object.entries(aliases)
    .filter(([, target]) => !shipped.has(target))
    .map(([id, target]) => `${id}->${target}`);
  assert.deepEqual(dangling, [], `icon aliases pointing at missing files: ${dangling.join(', ')}`);
});

test('the shared client list is fully branded on the dashboard', async () => {
  const shared = require('../../src/shared/clientTracking.js').TRACKED_CLIENTS.split(',');
  const aliasBlock = source.match(/const ICON_ALIASES = \{([\s\S]*?)\n\};/)[1];
  const aliases = Object.fromEntries(
    [...aliasBlock.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'([a-z0-9-]+)'/gm)].map((match) => [match[1], match[2]])
  );
  const iconsDir = path.join(__dirname, '../../src/shared-ui/icons/clients');
  const shipped = new Set(
    fs.readdirSync(iconsDir).filter((name) => name.endsWith('.svg')).map((name) => name.replace(/\.svg$/, ''))
  );
  const unbranded = shared.filter((id) => !shipped.has(aliases[id] || id));
  assert.deepEqual(unbranded, [], `tracked clients with no dashboard icon: ${unbranded.join(', ')}`);
});

test('the dashboard rate table is configurable and falls back to shared defaults', async () => {
  const formatPath = path.join(__dirname, '../../src/shared-ui/core/format.js');
  const format = await import(pathToFileUrl(formatPath));

  // Defaults must match src/shared/currency.js so the two clients agree before the
  // /api/rates fetch resolves.
  const shared = require('../../src/shared/currency.js').CURRENCY_RATES;
  const initial = format.currentRates();
  for (const code of Object.keys(shared)) {
    assert.equal(
      initial.rates[code].rate,
      shared[code].rate,
      `${code} default rate should match the shared module`
    );
  }

  // The Hub's live rates are applied.
  format.configureRates({ CNY: 7.2, TWD: 32.4, HKD: 7.9 }, { source: 'hub', date: '2026-09-18' });
  const updated = format.currentRates();
  assert.equal(updated.rates.CNY.rate, 7.2);
  assert.equal(updated.source, 'hub');
  assert.equal(updated.date, '2026-09-18');
  assert.equal(format.formatCost(1, 'CNY'), '¥7.20');

  // A partial or hostile payload cannot blank a currency or break USD.
  format.configureRates({ CNY: 'nonsense', USD: 99, EUR: 5 }, { source: 'hub' });
  const guarded = format.currentRates();
  assert.equal(guarded.rates.CNY.rate, 7.2, 'a non-numeric rate must be ignored');
  assert.equal(guarded.rates.USD.rate, 1, 'USD must stay pinned to 1');
  assert.equal(guarded.rates.EUR, undefined, 'unsupported currencies are ignored');
  assert.equal(format.formatCost(2, 'USD'), '$2.00');
});

test('the dashboard fetches its rates through the transport during boot', () => {
  // Both hosts serve /api/rates, so the shared UI asks for it by path like every
  // other data call. A direct fetch() would break the desktop host, which has no
  // origin to resolve against; the boundary guard enforces that separately.
  const appSource = uiSource();
  assert.match(appSource, /fetchJson\('\/api\/rates'\)/, 'the dashboard should read the rate feed through the transport');
  assert.match(appSource, /configureRates\(payload\.rates/, 'the fetched rates should be applied');
});

test('every tracked client is labelled and coloured on the dashboard', () => {
  // The dashboard kept its own copies of these maps, which had drifted: three
  // ids (commandcode, deepseek-harness, reasonix) plus the Qoder sites rendered
  // as raw slugs with hashed fallback colours.
  const shared = require('../../src/shared/clientTracking.js').TRACKED_CLIENTS.split(',');
  const labelsBlock = source.match(/const CLIENT_LABELS = \{([\s\S]*?)\n\};/)[1];
  const colorsBlock = source.match(/const CLIENT_COLORS = \{([\s\S]*?)\n\};/)[1];
  const keysOf = (block) => [...block.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'/gm)].map((match) => match[1]);

  const labels = new Set(keysOf(labelsBlock));
  const colors = new Set(keysOf(colorsBlock));
  const unlabelled = shared.filter((id) => !labels.has(id));
  const uncoloured = shared.filter((id) => !colors.has(id));
  assert.deepEqual(unlabelled, [], `tracked clients with no label: ${unlabelled.join(', ')}`);
  assert.deepEqual(uncoloured, [], `tracked clients with no colour: ${uncoloured.join(', ')}`);

  // Provider labels must cover the canonical provider list too.
  const providers = require('../../src/shared/limitProviders.js').LIMIT_PROVIDER_IDS;
  const providerBlock = source.match(/const PROVIDER_LABELS = \{([\s\S]*?)\n\};/)[1];
  const providerLabels = new Set([...providerBlock.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'/gm)].map((match) => match[1]));
  const missingProviders = providers.filter((id) => !providerLabels.has(id));
  assert.deepEqual(missingProviders, [], `providers with no label: ${missingProviders.join(', ')}`);
});

test('every hub-authority provider is addable from the accounts UI', () => {
  // A provider can be fully implemented (fetcher, capability entry, credential
  // store path) and still be unreachable if it is missing from the accounts
  // dropdown. That is exactly how `amp` and `sakana` shipped: LIMIT_PROVIDER_IDS
  // grew but HUB_ACCOUNT_PROVIDERS did not, so neither could be added from the
  // Hub even though both declared authority:'hub'.
  const capabilities = require('../../src/shared/limitProviderSources.js')
    .LIMIT_PROVIDER_SOURCE_CAPABILITIES;
  const expected = Object.entries(capabilities)
    .filter(([, capability]) => capability.authority === 'hub' && capability.manual === true)
    .map(([id]) => id)
    .sort();

  const block = source.match(/HUB_ACCOUNT_PROVIDERS = \[([\s\S]*?)\n\];/)[1];
  const addable = [...block.matchAll(/id:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]).sort();

  assert.deepEqual(addable, expected, 'HUB_ACCOUNT_PROVIDERS must match the hub-authority provider set');
  // Every addable provider must also carry a label for the dropdown.
  const providerBlock = source.match(/const PROVIDER_LABELS = \{([\s\S]*?)\n\};/)[1];
  const labels = new Set([...providerBlock.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'/gm)].map((match) => match[1]));
  const unlabelled = addable.filter((id) => !labels.has(id));
  assert.deepEqual(unlabelled, [], `addable providers with no label: ${unlabelled.join(', ')}`);
});

test('the dashboard detects an idle stream and reports how old its data is', () => {
  // A half-open socket leaves reader.read() pending forever, so the badge used to
  // read "live" while the numbers were arbitrarily old. The widget solved this
  // with an idle watchdog; the dashboard must too.
  const apiSource = fs.readFileSync(path.join(__dirname, '../../src/shared-ui/transport/httpTransport.js'), 'utf8');
  assert.match(apiSource, /SSE_IDLE_TIMEOUT_MS/, 'the stream needs an idle timeout');
  assert.match(apiSource, /onStatus\?\.\('idle-timeout'/, 'an idle stream should report a distinct status');
  assert.match(apiSource, /if \(event === 'heartbeat'\) continue;/, 'heartbeats prove liveness but not freshness');

  const appSource = uiSource();
  assert.match(appSource, /'idle-timeout': 'status\.idleTimeout'/, 'the new status needs a label');
  assert.match(appSource, /state\.dataAsOf/, 'the app should record when the data last arrived');
  assert.match(appSource, /tr\('status\.dataAsOf'\)/, 'the UI should state the data age');
});

test('a custom range derives the per-client model split from its sessions', () => {
  // /api/usage/range returns flat clients/models maps, so the nested split the
  // Usage -> Tools view renders was empty ("No usage") for every custom range
  // while the preset periods showed it.
  const appSource = uiSource();
  assert.match(appSource, /function deriveClientModels\(/, 'the derivation helper should exist');
  assert.match(appSource, /clientModels: payload\.clientModels \|\| deriveClientModels\(payload\.sessions, 'models'\)/);
  assert.match(appSource, /clientModelCosts: payload\.clientModelCosts \|\| deriveClientModels\(payload\.sessions, 'modelCosts'\)/);
});

test('every locale defines every shared-UI translation key', async () => {
  // Inspect the assembled runtime dictionaries. Source-regex checks miss keys
  // introduced through a locale-scoped spread even when t() can resolve them.
  const { MESSAGE_KEYS } = await import(pathToFileUrl(path.join(__dirname, '../../src/shared-ui/core/i18n.js')));
  const en = new Set(MESSAGE_KEYS.en);
  assert.ok(en.size > 200, 'the English dictionary should be substantial');
  for (const locale of ['zh-CN', 'zh-TW', 'ja', 'ko']) {
    const other = new Set(MESSAGE_KEYS[locale]);
    const missing = [...en].filter((key) => !other.has(key));
    assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(', ')}`);
  }
});
