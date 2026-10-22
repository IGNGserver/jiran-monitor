'use strict';

// The consolidated Management page: the single Administration destination.
//
// Three destinations that used to be separate views are now sections of one
// page. These tests pin the composition — which sections exist, what gates them,
// and that the view id that carries them is still `settings` (the persisted
// route and native-menu compatibility surface). A section that silently stopped
// rendering would only be visible by opening the page in a browser.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { installDom } = require('../helpers/domShim');

const viewPath = path.join(__dirname, '..', '..', 'src', 'shared-ui', 'views', 'settings.js');

// The module is browser ESM; evaluate it with its import graph stubbed so the
// test stays a pure unit test of the page composition.
function loadView({
  desktop = false,
  authenticated = true,
  capabilities = { hubAccounts: true, subscriptions: true, pricing: true },
  prefs = {},
  sessions = null,
  session = null,
  sessionsLoading = false
} = {}) {
  installDom(globalThis);
  const state = {
    prefs: { managementSection: 'accounts', managementTab: 'subscriptions', ...prefs },
    secret: '',
    authorization: { authenticated, capabilities },
    sessions,
    session,
    sessionsLoading,
    desktopSettings: {},
    desktopInfo: {}
  };
  const source = fs.readFileSync(viewPath, 'utf8')
    .replace(/^import \{[\s\S]*?\} from '\.\.\/transport\/index\.js';/m, `const isCapable = () => ${desktop};`)
    .replace(/^import \{[\s\S]*?\} from '\.\.\/core\/viewContext\.js';/m, `
      const tr = (key) => key;
      const escapeHtml = (value) => String(value ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      const settingsOptionList = () => '<listbox></listbox>';
      const appState = () => (${JSON.stringify(state)});
    `)
    .replace(/^import \{[\s\S]*?\} from '\.\.\/core\/data\.js';/m, `
      const clampHomeLimitAccountCount = (v, f) => v || f;
      const LANGUAGE_OPTIONS = [['auto', 'Auto']];
      const THEME_OPTIONS = [['system', 'System']];
      const CURRENCY_OPTIONS = [['USD', 'USD']];
    `)
    .replace(/^import \{ renderDesktopSettings \} from '\.\/settingsDesktop\.js';/m, "const renderDesktopSettings = () => '<desktop-settings></desktop-settings>';")
    .replace(/^import \{ renderTransferPanel \} from '\.\/transfer\.js';/m, "const renderTransferPanel = () => '<transfer-panel></transfer-panel>';")
    .replace(/^import \{ renderAccounts \} from '\.\/accounts\.js';/m, "const renderAccounts = () => '<accounts-body></accounts-body>';");
  const factory = new Function(`${source.replace(/^export /gm, '')}
    return { renderSettingsPage };`);
  return factory();
}

const sectionIds = (html) => [...html.matchAll(/data-settings-section="([a-z]+)"/g)].map(([, id]) => id);

test('the owner sees accounts, consumption, preferences and advanced', () => {
  const { renderSettingsPage } = loadView();
  const html = renderSettingsPage({ consumption: '<consumption-body></consumption-body>' });
  assert.deepEqual(sectionIds(html), ['accounts', 'consumption', 'preferences', 'advanced']);
  assert.match(html, /<accounts-body><\/accounts-body>/);
  assert.match(html, /<consumption-body><\/consumption-body>/);
  assert.match(html, /<transfer-panel><\/transfer-panel>/);
});

test('an unauthenticated reader keeps the same sections but loses advanced', () => {
  // Transfer is a Hub-web owner-only mutation, so the section must not exist for
  // a reader; accounts and preferences are still theirs.
  const { renderSettingsPage } = loadView({ authenticated: false });
  const html = renderSettingsPage({ consumption: '<consumption-body></consumption-body>' });
  assert.deepEqual(sectionIds(html), ['accounts', 'consumption', 'preferences']);
  assert.doesNotMatch(html, /<transfer-panel>/);
});

test('a Hub without accounts hides the accounts section', () => {
  const { renderSettingsPage } = loadView({ capabilities: { hubAccounts: false, subscriptions: true, pricing: true } });
  const html = renderSettingsPage({ consumption: '<consumption-body></consumption-body>' });
  assert.deepEqual(sectionIds(html), ['consumption', 'preferences', 'advanced']);
});

test('a Hub without subscriptions or pricing hides the consumption section', () => {
  const { renderSettingsPage } = loadView({ authenticated: false, capabilities: { hubAccounts: true, subscriptions: false, pricing: false } });
  const html = renderSettingsPage();
  assert.deepEqual(sectionIds(html), ['accounts', 'preferences']);
});

test('the desktop host renders its device groups and no Hub section', () => {
  // 账号 / 消费 / 偏好 are Hub surfaces: credentials and the shared ledger live on
  // the Hub, so the desktop page is only the device groups. Device transfer is a
  // Hub-web admin operation too, so `advanced` must not appear however the
  // scopes look.
  const { renderSettingsPage } = loadView({ desktop: true });
  const html = renderSettingsPage({ consumption: '<consumption-body></consumption-body>' });
  assert.deepEqual(sectionIds(html), []);
  assert.match(html, /<desktop-settings><\/desktop-settings>/);
  assert.doesNotMatch(html, /<accounts-body>/);
  assert.doesNotMatch(html, /<consumption-body>/);
  assert.doesNotMatch(html, /data-web-settings-form/);
  assert.doesNotMatch(html, /<transfer-panel>/);
  // The chrome header owns the visible description, but the page's own intro
  // must not promise accounts and consumption on a host that renders neither.
  assert.match(html, /<p>settings\.desktopDescription<\/p>/);
  assert.doesNotMatch(html, /page\.settings\.description/);
});

test('the Hub preferences section lists and revokes signed-in devices', () => {
  const { renderSettingsPage } = loadView({
    capabilities: { hubAccounts: true, subscriptions: true, pricing: true, sessionAuth: true },
    session: { id: 'session-1' },
    sessions: [
      { id: 'session-1', deviceName: 'MacBook', platform: 'desktop', lastSeenAt: '2026-10-22T10:00:00.000Z', current: true },
      { id: 'session-2', deviceName: 'Pixel', platform: 'android', lastSeenAt: '2026-10-21T10:00:00.000Z', current: false }
    ]
  });
  const html = renderSettingsPage();
  assert.match(html, /settings\.sessions/);
  assert.match(html, /MacBook/);
  assert.match(html, /Pixel/);
  assert.match(html, /data-session-revoke="session-1"/);
  assert.match(html, /data-session-revoke="session-2"/);
  assert.match(html, /data-session-revoke-all/);
});

test('the desktop host never renders the Hub device-session list', () => {
  const { renderSettingsPage } = loadView({
    desktop: true,
    capabilities: { hubAccounts: true, subscriptions: true, pricing: true, sessionAuth: true },
    sessions: [{ id: 'session-1', deviceName: 'MacBook', platform: 'desktop' }]
  });
  const html = renderSettingsPage();
  assert.doesNotMatch(html, /data-session-revoke/);
  assert.doesNotMatch(html, /settings\.sessions/);
});

test('the stored section marks exactly one section active', () => {
  // The rail highlights the section the route asked for; without the marker the
  // page would always open on the first section.
  const { renderSettingsPage } = loadView({ prefs: { managementSection: 'consumption' } });
  const html = renderSettingsPage({ consumption: '<consumption-body></consumption-body>' });
  const active = [...html.matchAll(/data-settings-section="([a-z]+)"( data-settings-active)?/g)]
    .filter(([, , marker]) => marker)
    .map(([, id]) => id);
  assert.deepEqual(active, ['consumption']);
});

test('both hosts read the appearance options from one table', () => {
  // The Hub offers language / theme / currency in 偏好 and the desktop in 显示.
  // Two inline lists is how one surface gains a locale the other does not have,
  // so both views must import the shared table.
  const views = ['settings.js', 'settingsDesktop.js'];
  for (const file of views) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared-ui', 'views', file), 'utf8');
    for (const table of ['LANGUAGE_OPTIONS', 'THEME_OPTIONS', 'CURRENCY_OPTIONS']) {
      assert.match(source, new RegExp(`\\b${table}\\b`), `${file} must use the shared ${table}`);
    }
    assert.doesNotMatch(source, /简体中文/, `${file} must not inline a locale list`);
  }
  const data = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared-ui', 'core', 'data.js'), 'utf8');
  for (const table of ['LANGUAGE_OPTIONS', 'THEME_OPTIONS', 'CURRENCY_OPTIONS']) {
    assert.match(data, new RegExp(`export const ${table} = Object\\.freeze\\(`), `${table} must be exported once`);
  }
});
