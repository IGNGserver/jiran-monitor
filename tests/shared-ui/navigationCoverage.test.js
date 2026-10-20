'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MESSAGE_KEYS, SUPPORTED_LOCALES } = require('../../src/shared-ui/core/i18n.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const APP_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/shared-ui/app.js'), 'utf8');
const SETTINGS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/shared-ui/views/settings.js'), 'utf8');
const LIMITS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/shared-ui/views/limits.js'), 'utf8');
const TRANSFER_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/shared-ui/views/transfer.js'), 'utf8');
const DESKTOP_ROUTER_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/electron/desktopRequestRouter.js'), 'utf8');

/** Every id the rendered navigation groups list, in source order. */
function navigationGroupIds() {
  const groups = [...APP_SOURCE.matchAll(/\['nav\.(group[A-Za-z]+)',\s*\[([^\]]*)\]\]/g)];
  assert.ok(groups.length >= 3, 'the navigation group table must still be parseable');
  return groups.flatMap(([, , ids]) => [...ids.matchAll(/'([a-z]+)'/g)].map(([, id]) => id));
}

test('every navigation id has a label in every supported locale', () => {
  // `tr()` falls back to English, so a missing translation is invisible at runtime.
  // The reverse is checked here: an id that navigation renders must be labelled everywhere.
  for (const id of navigationGroupIds()) {
    for (const locale of SUPPORTED_LOCALES) {
      assert.ok(
        MESSAGE_KEYS[locale].includes(`nav.${id}`),
        `nav.${id} is missing from the ${locale} catalogue`
      );
    }
  }
});

test('device transfer is not a navigation destination', () => {
  // Transfer is a Hub-web admin operation with exactly one entry point: the
  // Advanced group inside the web settings page. It must not reappear in the
  // sidebar, which is what the previous release briefly did (and what made the
  // standalone page reachable only by typing `/transfer` before that).
  const ids = navigationGroupIds();
  assert.ok(!ids.includes('transfer'), 'transfer must not appear in a navigation group');
  assert.doesNotMatch(APP_SOURCE, /VIEW_PATHS[\s\S]*?\btransfer:/, 'transfer must not have a route');
  assert.doesNotMatch(APP_SOURCE, /case 'transfer':/, 'transfer must not have a render case');
  assert.doesNotMatch(APP_SOURCE, /renderTransfer\(/, 'the standalone transfer view must be gone');
});

test('transfer is owner-gated and lives in the web Management page Advanced section', () => {
  // The Hub exposes transfer only on the web host, and only to the connected
  // owner. Both halves are asserted — the page's own gate and the panel's submit
  // gate — so a reader without owner rights can never see the action.
  assert.match(SETTINGS_SOURCE, /!desktopHost && owner/);
  assert.match(SETTINGS_SOURCE, /section\('advanced'/);
  assert.match(SETTINGS_SOURCE, /management\.section\.advanced/);
  assert.match(TRANSFER_SOURCE, /authenticated === true/);
  assert.match(TRANSFER_SOURCE, /transfer\.needsAdmin/);
});

test('the desktop host has no transfer code path', () => {
  // The transfer endpoint is Hub-owned and owner-only; the desktop client must
  // neither render the panel nor proxy the request. The only rendering site is
  // gated on the web host, so `capabilities.desktopSettings === true` can never
  // reach it.
  assert.doesNotMatch(DESKTOP_ROUTER_SOURCE, /transfer/, 'the desktop router must not proxy transfer');
  assert.match(SETTINGS_SOURCE, /!desktopHost && owner/);
});

test('the transfer panel is not a standalone page with desktop settings scaffolding', () => {
  // `settings-layout` is a two-column grid and the `desktop-settings-*` classes
  // are styled only by the Electron renderer, so a single-panel page built out of
  // them renders in an empty column on the web dashboard. The panel is now a
  // group inside the settings page and must not reintroduce a standalone shell.
  assert.doesNotMatch(TRANSFER_SOURCE, /export function renderTransfer\(\)/);
  assert.doesNotMatch(TRANSFER_SOURCE, /class="[^"]*desktop-settings-body/);
  assert.doesNotMatch(TRANSFER_SOURCE, /class="[^"]*settings-layout/);
});

test('the desktop host renders no Hub management sections and fetches no Hub ledger', () => {
  // 账号 / 消费 / 偏好 are Hub surfaces. Deleting them from the desktop page is
  // only half the change: the router must stop naming sections the desktop never
  // renders, the boot prefetch must stop proxying accounts and ledger reads
  // nothing displays, and the 额度 cards must stop offering a jump to a section
  // that is not there. One list in the page module keeps all three honest.
  assert.match(SETTINGS_SOURCE, /const WEB_MANAGEMENT_SECTIONS = Object\.freeze\(\['accounts', 'consumption', 'preferences', 'advanced'\]\)/);
  assert.match(SETTINGS_SOURCE, /const DESKTOP_MANAGEMENT_SECTIONS = Object\.freeze\(\[\]\)/);
  for (const helper of ['managementSections', 'canRenderManagementSection', 'normalizeManagementSection']) {
    assert.match(SETTINGS_SOURCE, new RegExp(`export function ${helper}\\(`), `settings.js must export ${helper}`);
  }
  assert.match(APP_SOURCE, /import \{ managementSections, normalizeManagementSection, renderSettingsPage \} from '\.\/views\/settings\.js';/,
    'the router must ask the page which sections exist, not keep its own list');
  assert.equal((APP_SOURCE.match(/\['accounts',\s*'consumption',\s*'preferences',\s*'advanced'\]/g) || []).length, 0,
    'app.js must not keep its own copy of the section list');
  assert.match(APP_SOURCE, /managementSections\(\)\.length > 0 && state\.prefs\.view === 'settings'/,
    'management reads require a visible Hub-only management section');
  assert.match(LIMITS_SOURCE, /canRenderManagementSection\('accounts'\)/,
    'the 账号 jump on a failing limit card must ask whether this host renders that section');
});

test('both transfer device pickers are Fluent dropdowns backed by a listbox', () => {
  // Fluent Dropdown binds its listbox through the default slot; options placed
  // directly on the dropdown leave `dropdown.listbox` undefined, so the trigger
  // neither opens nor shows a value. That was the source-device bug.
  assert.doesNotMatch(TRANSFER_SOURCE, /fluent-text-input[^>]*name="targetDevice"/);
  for (const name of ['sourceDevice', 'targetDevice']) {
    assert.match(
      TRANSFER_SOURCE,
      new RegExp(`<fluent-dropdown name="${name}">`),
      `${name} must be a dropdown`
    );
  }
  // The options helper is the single place that builds a picker's contents, and
  // it must wrap them in a listbox with one selected option.
  const helper = TRANSFER_SOURCE.match(/function deviceOptions\([\s\S]*?\n}/);
  assert.ok(helper, 'a deviceOptions helper must exist');
  assert.match(helper[0], /<fluent-listbox>/);
  assert.match(helper[0], /<fluent-option /);
  assert.match(helper[0], /selected/);
});
