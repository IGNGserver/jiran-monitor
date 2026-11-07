'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { configureViewContext } = require('../../src/shared-ui/core/viewContext.js');
const { renderUsageSessions } = require('../../src/shared-ui/views/usage.js');

function context(selectedSessionId = '') {
  const state = {
    prefs: { selectedSessionId, sessionQuery: '', sessionSort: 'tokens-desc', currency: 'USD' },
    locale: 'en', customPeriod: null,
    sessionAnalytics: {
      enabled: true, key: 'scope', total: 3, nextCursor: 'next-page', loading: false, loaded: true, stale: false,
      rows: [
        { key: 'device:claude:one', sessionId: 'one', deviceId: 'device', client: 'claude', totalTokens: 100, costUsd: 1, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, models: { m1: 100 }, lastUsedAt: '2026-11-07T01:00:00.000Z' },
        { key: 'device:claude:two', sessionId: 'two', deviceId: 'device', client: 'claude', totalTokens: 200, costUsd: 2, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 0, models: { m2: 200 }, lastUsedAt: '2026-11-06T01:00:00.000Z' }
      ]
    }
  };
  configureViewContext({
    state,
    tr: (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, value), key),
    escapeHtml: (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    panel: (title, body) => `<section>${title}${body}</section>`,
    renderTokenMix: () => '<div>mix</div>',
    emptyHtml: (key) => `<div>${key}</div>`,
    renderListView: () => '',
    loadingHtml: () => '<div>loading</div>',
    uiIcon: () => ''
  });
  return state;
}

test('server session pages render totals, more pages and second-page details', () => {
  const state = context();
  const html = renderUsageSessions({ sessions: {} });
  assert.match(html, /sessions\.pageCount/);
  assert.match(html, /data-load-more-sessions/);
  assert.ok(html.indexOf('device:claude:two') < html.indexOf('device:claude:one'));
  state.prefs.selectedSessionId = 'device:claude:two';
  const detail = renderUsageSessions({ sessions: {} });
  assert.match(detail, /session-detail-view/);
  assert.match(detail, /m2/);
});

test('session requests use the advanced cursor contract and debounce search', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared-ui/app.js'), 'utf8');
  assert.match(source, /payload\.sessions/);
  assert.match(source, /query\.set\('cursor', cursor\)/);
  assert.match(source, /limit: '100'/);
  assert.match(source, /sessionQueryDebounce = setTimeout/);
  assert.match(source, /state\.customPeriod && !isCapable\('desktopSettings'\)|!state\.customPeriod && !isCapable\('desktopSettings'\)/);
});
