'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { formatRelative, formatReset } = require('../../src/shared-ui/core/format.js');
const { sessionRows } = require('../../src/shared-ui/core/data.js');

test('session pagination preserves ordering and avoids formatting off-page sessions', () => {
  const sessions = {};
  let modelReads = 0;
  for (let index = 0; index < 1000; index++) {
    sessions[`s${index}`] = {
      client: 'codex', totalTokens: index + 1,
      lastUsedAt: '2026-09-19T00:00:00Z',
      get models() { modelReads++; return { 'gpt-5': 1 }; }
    };
  }
  sessions.zero = { totalTokens: 0 };
  sessions.negative = { totalTokens: -1 };
  const result = sessionRows({ sessions }, { limit: 2 });
  assert.equal(result.total, 1000);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows.map(row => row.key), ['s999', 's998']);
  assert.equal(modelReads, 2);
  assert.equal(result.rows[0].metrics.totalTokens, 1000);
  const all = sessionRows({ sessions }, { limit: 2000 });
  assert.equal(all.truncated, false);
  assert.equal(all.rows.length, 1000);
});

test('cached formatters preserve every supported locale and invalid-date behavior', async () => {
  const iso = '2026-09-19T06:23:00.000Z';
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
    const expected = new Date(iso).toLocaleString(locale, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    assert.equal(formatReset(iso, locale), expected);
    assert.equal(formatReset(iso, locale), expected);
    await Promise.resolve();
    assert.equal(formatReset(iso, locale), expected);
    assert.equal(formatRelative(new Date().toISOString(), locale),
      new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-0, 'second'));
  }
  assert.equal(formatReset('invalid'), '');
  assert.equal(formatRelative('invalid'), '—');
});

test('hidden snapshots avoid DOM work and restore only the latest state', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared-ui/app.js'), 'utf8');
  const renderSource = source.slice(source.indexOf('let renderPending = false;'), source.indexOf('async function ensureHistory'));
  let onVisibility;
  let writes = 0;
  let html;
  const content = { set innerHTML(value) { writes++; html = value; } };
  const context = {
    document: { hidden: true, addEventListener: (_, callback) => { onVisibility = callback; } },
    state: { prefs: { view: 'overview' }, stats: { value: 0 } },
    els: { content }, captureRenderState: () => ({}), restoreRenderState() {},
    isCapable: () => false,
    renderChrome() {}, renderHero() {},
    renderHome: () => String(context.state.stats.value)
  };
  vm.createContext(context);
  vm.runInContext(renderSource, context);
  for (let index = 1; index <= 100; index++) {
    context.state.stats.value = index;
    context.render();
  }
  assert.equal(writes, 0);
  context.document.hidden = false;
  onVisibility();
  assert.equal(writes, 1);
  assert.equal(html, '100');
  onVisibility();
  assert.equal(writes, 1);
  context.state.stats.value = 101;
  context.render();
  assert.equal(html, '101');
});

test('boot never waits for optional rates and retains failure fallbacks', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared-ui/app.js'), 'utf8');
  const start = source.indexOf("  void fetchJson('/api/rates')");
  const end = source.indexOf('  if (!state.health.secretRequired)', start);
  const boot = `(async () => { ${source.slice(start, end)} })()`;
  let finishRates;
  let finishHealth;
  const state = {};
  const pending = vm.runInNewContext(boot, {
    state, configureRates() {}, isCapable: () => false,
    fetchJson: () => new Promise(resolve => { finishRates = resolve; }),
    fetchHealth: () => new Promise(resolve => { finishHealth = resolve; })
  });
  assert.equal(typeof finishRates, 'function');
  assert.equal(typeof finishHealth, 'function');
  finishHealth({ secretRequired: false });
  await pending;
  assert.equal(state.health.secretRequired, false);
  finishRates({});
  await vm.runInNewContext(boot, {
    state, isCapable: () => false, configureRates() { assert.fail('failed rates must not replace defaults'); },
    fetchJson: async () => { throw new Error('offline'); },
    fetchHealth: async () => { throw new Error('offline'); }
  });
  assert.equal(state.health.secretRequired, true);
});
