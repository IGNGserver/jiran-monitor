'use strict';

// Measurement provenance in the shared UI.
//
// Qoder's token totals are reconstructed from content while its credit meter is
// exact. The `~` prefix was removed from every surface, so these tests pin the
// remaining contract: the row model still carries `estimated`, credits stay a
// separate unit, and no rendered number grows a marker back.

const assert = require('node:assert/strict');
const test = require('node:test');

const { configureViewContext } = require('../../src/shared-ui/core/viewContext.js');
const { t } = require('../../src/shared-ui/core/i18n.js');
const { formatCredits } = require('../../src/shared-ui/core/format.js');

function lookup(key, params) {
  return t('en', key, params);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const data = require('../../src/shared-ui/core/data.js');
const appStateValue = { prefs: { currency: 'USD', selectedToolId: 'qoder' }, locale: 'en' };

// Views resolve helpers lazily through the facade, so a render test only has to
// install the context it actually reads before calling into the view. `toolIconHtml`
// and the display flags are gone with their settings keys, so it needs `state` and nothing else.
function installContext(period) {
  configureViewContext({
    tr: lookup,
    escapeHtml,
    state: appStateValue,
    activePeriod: () => period,
    toolRows: (nextPeriod) => toolRows(nextPeriod),
    emptyHtml: () => '<div class="empty"></div>',
    shareBarHtml: () => '<div class="share-bar"></div>',
    renderTokenMix: () => '<div class="token-mix"></div>'
  });
}

const { renderTools } = require('../../src/shared-ui/views/usage.js');
const { toolRows, deviceBreakdownRows, clientMeasurementFields } = data;

function qoderPeriod(overrides = {}) {
  return {
    totalTokens: 2200,
    costUsd: 0.03,
    clients: { qoder: 1200, claude: 1000 },
    clientCosts: { qoder: 0.03, claude: 0.01 },
    clientCredits: { qoder: 812.4 },
    clientEstimated: { qoder: true },
    clientModels: { qoder: { 'Qwen3.7-Plus': 1200 } },
    clientModelCosts: { qoder: { 'Qwen3.7-Plus': 0.03 } },
    estimated: true,
    ...overrides
  };
}

test('formatCredits renders a provider figure without inventing a currency', () => {
  assert.equal(formatCredits(812.4), '812');
  assert.equal(formatCredits(0.323132128), '0.32');
  assert.equal(formatCredits(12345), '12,345');
  assert.equal(formatCredits(0), '', 'absent must not render as a reading of zero');
  assert.equal(formatCredits(undefined), '');
  assert.equal(formatCredits(-1), '', 'a negative consumption figure is not displayable');
});

test('values are rendered with no estimate prefix', () => {
  // The glyph was removed from every surface; provenance still exists in the
  // data model, but it must not leak back into a rendered number.
  installContext(qoderPeriod());
  const html = renderTools();
  assert.doesNotMatch(html, /~/);
});

test('clientMeasurementFields reads both per-client maps', () => {
  assert.deepEqual(clientMeasurementFields(qoderPeriod(), 'qoder'), { estimated: true, credits: 812.4 });
  assert.deepEqual(clientMeasurementFields(qoderPeriod(), 'claude'), { estimated: false, credits: 0 });
  assert.deepEqual(clientMeasurementFields({}, 'qoder'), { estimated: false, credits: 0 },
    'a device on an older agent reports neither field');
});

test('toolRows attach provenance to the client rows only', () => {
  const rows = toolRows(qoderPeriod());
  const qoder = rows.find((row) => row.key === 'qoder');
  const claude = rows.find((row) => row.key === 'claude');

  assert.equal(qoder.estimated, true);
  assert.equal(qoder.credits, 812.4);
  assert.equal(claude.estimated, false);
  assert.equal(claude.credits, 0);
});

test('deviceBreakdownRows carry the same provenance into the devices view', () => {
  const breakdown = deviceBreakdownRows({ periods: { today: qoderPeriod() } }, 'today');
  const qoder = breakdown.tools.find((row) => row.key === 'qoder');

  assert.equal(qoder.estimated, true);
  assert.equal(qoder.credits, 812.4);
});

test('the Tools view renders estimated and exact clients identically', () => {
  installContext(qoderPeriod());

  const html = renderTools();

  // No glyph on Qoder's tokens or cost, and none on Claude's either.
  assert.match(html, /<div class="row-value">1,200<\/div>/);
  assert.match(html, /<div class="row-value">1,000<\/div>/);
  assert.match(html, /<div class="row-cost">\$0\.0300<\/div>/);
  assert.match(html, /<div class="row-cost">\$0\.0100<\/div>/);
  assert.doesNotMatch(html, /~/);
  // Credits still read as a separate unit beside the percentage, never as money.
  assert.match(html, /55% · 812 Credits/);
  // The detail panel keeps the explanation even though the values no longer
  // carry a marker, so provenance is not silently erased.
  assert.match(html, /class="usage-measurement-note tiny"/);
  assert.match(html, /estimated from stored message content/);
  assert.match(html, /aria-label="Qoder, 1,200 tokens, \$0\.0300, 812 Credits"/);
  assert.match(html, /aria-label="Claude Code, 1,000 tokens, \$0\.0100"/);
});

test('the Tools view omits every provenance affordance when nothing was estimated', () => {
  installContext(qoderPeriod({
    clientCredits: {}, clientEstimated: {}, estimated: undefined
  }));

  const html = renderTools();

  assert.doesNotMatch(html, /~/);
  assert.doesNotMatch(html, /usage-measurement-note/);
  assert.doesNotMatch(html, /Credits/);
});

test('every locale labels credits and the estimate caveat', () => {
  // Views render these strings in all five languages, and the parity guard only
  // compares keys across locales — this pins that the English copy each locale
  // resolves to is actually non-empty and distinct from the key itself.
  const { SUPPORTED_LOCALES } = require('../../src/shared-ui/core/i18n.js');
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ['stats.credits', 'usage.estimatedHint']) {
      const value = t(locale, key);
      assert.ok(value && value !== key, `${locale}/${key} must resolve to real copy`);
    }
  }
});
