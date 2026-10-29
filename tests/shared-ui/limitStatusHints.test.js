'use strict';

// A limit card that is not producing numbers must name the FIX, not just the
// status. A bare "Error" leaves the user unable to tell an expired cookie from a
// vendor outage or a retired plan — three situations with different actions.

const assert = require('node:assert/strict');
const test = require('node:test');

// Views read tr()/escapeHtml() through the view-context facade, which the app
// installs at boot. A test installs a minimal one so the modules stay importable.
const { configureViewContext } = require('../../src/shared-ui/core/viewContext.js');
const { t } = require('../../src/shared-ui/core/i18n.js');

function lookup(key, params) {
  return t('en', key, params);
}

configureViewContext({
  tr: lookup,
  escapeHtml: (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
});

const { formatLimitBadge, formatLimitHint } = require('../../src/shared-ui/views/limits.js');

test('an unauthorized card is labelled as expired credentials', () => {
  const html = formatLimitBadge({ status: 'unauthorized' });
  assert.match(html, /Credentials expired/);
});

// Gemini marks a retired plan with region:'retired'; that needs a different
// action (switch products) than re-pasting a credential.
test('a retired plan is labelled distinctly from expired credentials', () => {
  const html = formatLimitBadge({ status: 'unauthorized', region: 'retired' });
  assert.match(html, /Plan retired/);
  assert.doesNotMatch(html, /Credentials expired/);
});

test('a healthy card keeps the healthy badge', () => {
  // The label comes from the locale table, so assert the badge class instead of
  // a copy string that a translation edit would break.
  assert.match(formatLimitBadge({ status: 'ok' }), /class="badge ok"/);
});

test('a not-configured card is labelled rather than shown as an error', () => {
  assert.match(formatLimitBadge({ status: 'notConfigured' }), /Not configured/);
});

test('an unavailable card is labelled instead of printing the raw status code', () => {
  const html = formatLimitBadge({ status: 'unavailable' });
  assert.match(html, /Temporarily unavailable/);
  assert.doesNotMatch(html, />\s*unavailable\s*</);
});

test('the unavailable badge is localized, not an English literal', () => {
  configureViewContext({
    tr: (key, params) => t('zh-CN', key, params),
    escapeHtml: (value) => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  });
  try {
    assert.match(formatLimitBadge({ status: 'unavailable' }), /暂时无法获取/);
  } finally {
    configureViewContext({
      tr: lookup,
      escapeHtml: (value) => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    });
  }
});

test('a stale card still wins over its status', () => {
  assert.match(formatLimitBadge({ status: 'ok', stale: true }), /stale|Stale/i);
});

test('the hint tells the user to update an expired credential', () => {
  assert.match(formatLimitHint({ status: 'unauthorized' }), /Update it in Accounts/);
});

test('the hint points a retired plan at the current offering', () => {
  const hint = formatLimitHint({ status: 'unauthorized', region: 'retired' });
  assert.match(hint, /no longer served/);
  assert.doesNotMatch(hint, /Update it in Accounts/);
});

test('the hint distinguishes transient failures from credential problems', () => {
  assert.match(formatLimitHint({ status: 'sourceRateLimited' }), /rate limiting/);
  assert.match(formatLimitHint({ status: 'unavailable' }), /could not be reached/);
  assert.match(formatLimitHint({ status: 'error' }), /could not be reached/);
  assert.match(formatLimitHint({ status: 'notConfigured' }), /Add a credential/);
});

test('a healthy or deliberately disabled card carries no hint', () => {
  assert.equal(formatLimitHint({ status: 'ok' }), '');
  assert.equal(formatLimitHint({ status: 'disabled' }), '');
});

test('a stale card explains that the values are the last known ones', () => {
  assert.match(formatLimitHint({ status: 'ok', stale: true }), /last known/);
});

const { limitAttentionLevel } = require('../../src/shared-ui/core/data.js');

test('limitAttentionLevel identifies critical, warning, stale and healthy statuses', () => {
  assert.equal(limitAttentionLevel(null), 'none');
  assert.equal(limitAttentionLevel({ status: 'ok' }), 'none');
  assert.equal(limitAttentionLevel({ status: 'disabled' }), 'none');
  assert.equal(limitAttentionLevel({ status: 'unauthorized' }), 'critical');
  assert.equal(limitAttentionLevel({ status: 'unavailable' }), 'warn');
  assert.equal(limitAttentionLevel({ status: 'error' }), 'warn');
  assert.equal(limitAttentionLevel({ status: 'rateLimited' }), 'warn');
  assert.equal(limitAttentionLevel({ status: 'sourceRateLimited' }), 'warn');
  assert.equal(limitAttentionLevel({ status: 'notConfigured' }), 'warn');
  assert.equal(limitAttentionLevel({ status: 'ok', stale: true }), 'stale');
});

test('an unknown status falls back to no hint rather than inventing one', () => {
  assert.equal(formatLimitHint({ status: 'something-new' }), '');
  assert.equal(formatLimitHint({}), '');
});
