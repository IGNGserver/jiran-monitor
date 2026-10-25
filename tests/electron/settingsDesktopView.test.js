'use strict';

// The desktop settings surface is deliberately small: 显示 / 行为 / 连接.
// These tests pin the mapping from form field to settings key, because a
// renamed `name` attribute would silently stop persisting a choice. They also
// pin the window-material folding: the single dropdown stores the legacy
// (systemGlass, windowsBackdrop) pair the window code reads.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { installDom } = require('../helpers/domShim');

const viewPath = path.join(__dirname, '..', '..', 'src', 'shared-ui', 'views', 'settingsDesktop.js');

// The module is browser ESM; evaluate it with its import graph stubbed so the
// test stays a pure unit test of the field mapping.
function loadView(state = {}) {
  installDom(globalThis);
  const source = fs.readFileSync(viewPath, 'utf8')
    .replace(/^import \{[\s\S]*?\} from '\.\.\/core\/viewContext\.js';/m, `
      const tr = (key) => key;
      const escapeHtml = (value) => String(value ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      const settingsOptionList = (options, selected) => options
        .map(([value, label]) => \`<option value="\${value}"\${String(value) === String(selected) ? ' selected' : ''}>\${label}</option>\`)
        .join('');
      // The update panel renders only what the main process pushed,
      // so the stub reports whatever the test provides.
      const appState = () => (${JSON.stringify({
    desktopAppUpdate: null, ...state
  })});
    `)
    .replace(/^import \{[\s\S]*?\} from '\.\.\/core\/data\.js';/m, `
      const LANGUAGE_OPTIONS = [['auto', 'Auto'], ['en', 'English'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어']];
      const THEME_OPTIONS = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
      const CURRENCY_OPTIONS = [['USD', 'USD'], ['CNY', 'CNY'], ['TWD', 'TWD'], ['HKD', 'HKD']];
    `);
  const factory = new Function(`${source.replace(/^export /gm, '')}
    return {
      renderDesktopSettings,
      readDesktopSettingsPatch,
      surfaceValueFromSettings,
      settingsPatchForSurface,
      appUpdateToastText,
      appUpdateInstallErrorText
    };`);
  return factory();
}

test('the three groups render and no legacy group remains', () => {
  const { renderDesktopSettings } = loadView();
  const html = renderDesktopSettings({ hubMode: 'client' }, { platform: 'win32', loginItemSupported: true });
  for (const id of ['display', 'behaviour', 'connection']) {
    assert.ok(html.includes(`data-desktop-group="${id}"`), `the ${id} group exists`);
  }
  for (const legacy of ['collection', 'engine', 'export', 'appearance', 'limitsDisplay', 'general', 'device', 'preferences', 'advanced']) {
    assert.ok(!html.includes(`data-desktop-group="${legacy}"`), `the ${legacy} group is gone`);
  }
});

test('every retained settings key has a form control', () => {
  const { renderDesktopSettings } = loadView();
  const html = renderDesktopSettings({
    hubUrl: '', hubMode: 'client', deviceId: 'box'
  }, { platform: 'win32', loginItemSupported: true });

  const required = [
    'language', 'theme', 'currency', 'windowSurface', 'reduceMotion',
    'startAtLogin', 'startHidden', 'closeToTray', 'updateChannel',
    'hubMode', 'hubUrl', 'allowInsecureHubHttp', 'deviceId'
  ];
  const missing = required.filter((key) => !html.includes(`name="${key}"`));
  assert.deepEqual(missing, [], `settings with no control: ${missing.join(', ')}`);
  assert.ok(html.includes('data-desktop-action="check-updates"'), 'a check-for-updates button exists');
  assert.ok(!html.includes('data-desktop-action="download-install-update"'),
    'the install action stays hidden until the pushed state has an update');
});

test('device ID is blank by default and connection errors have a persistent recovery surface', () => {
  const { renderDesktopSettings } = loadView();
  const html = renderDesktopSettings({ hubMode: 'client', deviceId: '' }, { platform: 'win32', loginItemSupported: true });
  assert.match(html, /name="deviceId"[^>]*value=""/);
  assert.match(html, /name="deviceId"[^>]*placeholder="desktop\.settings\.deviceIdHint"/);
  assert.match(html, /data-desktop-connection-error/);
  assert.match(html, /data-desktop-connection-message/);
  assert.match(html, /data-desktop-action="recover-sync"/);
});

test('every desktop switch emits a real checked state for the Fluent component', () => {
  const { renderDesktopSettings } = loadView();
  const html = renderDesktopSettings({
    hubMode: 'client',
    startAtLogin: true,
    startHidden: false,
    closeToTray: true,
    allowInsecureHubHttp: true
  }, { platform: 'win32', loginItemSupported: true });
  assert.match(html, /id="desktop-setting-startAtLogin"[^>]*checked/);
  assert.match(html, /id="desktop-setting-closeToTray"[^>]*checked/);
  assert.match(html, /id="desktop-setting-allowInsecureHubHttp"[^>]*checked/);
  assert.doesNotMatch(html, /id="desktop-setting-startHidden"[^>]*checked/);
});

test('hub-owned fields are offered only in hub mode', () => {
  const { renderDesktopSettings } = loadView();
  const client = renderDesktopSettings({ hubMode: 'client' }, { platform: 'linux', loginItemSupported: true });
  for (const key of ['hubUrl', 'allowInsecureHubHttp', 'deviceId']) {
    assert.ok(client.includes(`name="${key}"`), `${key} appears in hub mode`);
  }
  const local = renderDesktopSettings({ hubMode: 'local' }, { platform: 'linux', loginItemSupported: true });
  for (const key of ['hubUrl', 'allowInsecureHubHttp', 'deviceId']) {
    assert.ok(!local.includes(`name="${key}"`), `${key} is hidden in local mode`);
  }
  assert.ok(local.includes('name="hubMode"'), 'the mode toggle itself always shows');
});

test('the window material folds into the legacy (systemGlass, windowsBackdrop) pair', () => {
  const { settingsPatchForSurface, surfaceValueFromSettings } = loadView();
  assert.deepEqual(settingsPatchForSurface('regular'), { systemGlass: false });
  assert.deepEqual(settingsPatchForSurface('transparent'), { systemGlass: true, windowsBackdrop: 'transparent' });
  assert.deepEqual(settingsPatchForSurface('acrylic'), { systemGlass: true, windowsBackdrop: 'acrylic' });
  assert.deepEqual(settingsPatchForSurface('mica'), { systemGlass: true, windowsBackdrop: 'mica' });

  assert.equal(surfaceValueFromSettings({ systemGlass: false }, { platform: 'win32' }), 'regular');
  assert.equal(surfaceValueFromSettings({ systemGlass: true, windowsBackdrop: 'mica' }, { platform: 'win32' }), 'mica');
  assert.equal(surfaceValueFromSettings({ systemGlass: true, windowsBackdrop: 'acrylic' }, { platform: 'win32' }), 'acrylic');
  assert.equal(surfaceValueFromSettings({ systemGlass: true, windowsBackdrop: 'transparent' }, { platform: 'win32' }), 'transparent');
  assert.equal(surfaceValueFromSettings({ systemGlass: true, windowsBackdrop: 'mica' }, { platform: 'darwin' }), 'transparent',
    'a material another platform cannot apply reads as plain transparency');
  assert.equal(surfaceValueFromSettings({ systemGlass: true, macosGlassStyle: 'liquid-glass' }, { platform: 'darwin', macosGlassLiquidAvailable: true }), 'liquid-glass');
  assert.equal(surfaceValueFromSettings({ systemGlass: true, macosGlassStyle: 'liquid-glass' }, { platform: 'darwin', macosGlassLiquidAvailable: false }), 'vibrancy');
  assert.equal(surfaceValueFromSettings({ systemGlass: true, macosGlassStyle: 'vibrancy' }, { platform: 'darwin' }), 'vibrancy');
  assert.deepEqual(settingsPatchForSurface('liquid-glass'), { systemGlass: true, macosGlassStyle: 'liquid-glass' });
  assert.deepEqual(settingsPatchForSurface('vibrancy'), { systemGlass: true, macosGlassStyle: 'vibrancy' });
});

test('acrylic and mica are offered only on Windows, while liquid and frosted glass are offered on macOS', () => {
  const { renderDesktopSettings } = loadView();
  const win = renderDesktopSettings({}, { platform: 'win32' });
  assert.ok(win.includes('value="acrylic"'), 'Windows offers acrylic');
  assert.ok(win.includes('value="mica"'), 'Windows offers mica');
  assert.ok(!win.includes('value="liquid-glass"'), 'Windows does not offer liquid glass');
  assert.ok(!win.includes('value="vibrancy"'), 'Windows does not offer vibrancy');

  const macModern = renderDesktopSettings({}, { platform: 'darwin', macosGlassLiquidAvailable: true });
  assert.ok(!macModern.includes('value="acrylic"'), 'macOS does not offer acrylic');
  assert.ok(!macModern.includes('value="mica"'), 'macOS does not offer mica');
  assert.ok(macModern.includes('value="vibrancy"'), 'macOS offers frosted glass / vibrancy');
  assert.ok(macModern.includes('value="liquid-glass"'), 'macOS 26+ offers liquid glass');

  const macLegacy = renderDesktopSettings({}, { platform: 'darwin', macosGlassLiquidAvailable: false });
  assert.ok(macLegacy.includes('value="vibrancy"'), 'legacy macOS offers frosted glass');
  assert.ok(!macLegacy.includes('value="liquid-glass"'), 'legacy macOS does not offer liquid glass');

  const linux = renderDesktopSettings({}, { platform: 'linux' });
  assert.ok(!linux.includes('value="acrylic"'), 'Linux does not offer acrylic');
  assert.ok(!linux.includes('value="mica"'), 'Linux does not offer mica');
  assert.ok(!linux.includes('value="liquid-glass"'), 'Linux does not offer liquid glass');
  assert.ok(!linux.includes('value="vibrancy"'), 'Linux does not offer vibrancy');
});

test('start at login is hidden when the platform has no login item', () => {
  const { renderDesktopSettings } = loadView();
  const unsupported = renderDesktopSettings({}, { platform: 'linux', loginItemSupported: false });
  assert.ok(!unsupported.includes('name="startAtLogin"'), 'a control that cannot work must not be offered');
  assert.ok(!unsupported.includes('name="startHidden"'), 'silent start presupposes a login item');
});

test('reading the form back produces the right value types', () => {
  const { renderDesktopSettings, readDesktopSettingsPatch } = loadView();
  const html = renderDesktopSettings({ hubMode: 'client', deviceId: 'box' }, { platform: 'linux', loginItemSupported: true });
  assert.ok(html.length > 0);

  const fields = [
    ['startAtLogin', 'checkbox', true], ['closeToTray', 'checkbox', false],
    ['updateChannel', 'text', 'preview'],
    ['deviceId', 'text', ' renamed '], ['hubUrl', 'text', ' http://hub:17321 ']
  ];
  const nodes = fields.map(([name, type, value]) => ({ name, type, value: String(value), checked: value === true }));
  const form = {
    querySelector(selector) {
      if (selector === '[name="windowSurface"]') return { value: 'regular' };
      if (selector === '[name="language"]') return { value: 'zh-CN' };
      if (selector === '[name="reduceMotion"]') return { value: 'on' };
      if (selector === '[name="theme"]') return { value: 'dark' };
      if (selector === '[name="currency"]') return { value: 'CNY' };
      if (selector === 'fluent-radio-group[name="hubMode"]') return { value: 'client' };
      const m = /^\[name="([^"]+)"\]$/.exec(selector);
      if (m) return nodes.find((n) => n.name === m[1]) || null;
      return null;
    },
    querySelectorAll: () => []
  };

  const patch = readDesktopSettingsPatch(form);
  assert.equal(patch.startAtLogin, true, 'checkboxes read as booleans');
  assert.equal(patch.closeToTray, false);
  assert.equal(patch.deviceId, 'renamed', 'text fields are trimmed');
  assert.equal(patch.hubUrl, 'http://hub:17321');
  assert.equal(patch.updateChannel, 'preview');
  assert.equal(patch.hubMode, 'client');
  assert.equal(patch.language, 'zh-CN');
  assert.equal(patch.reduceMotion, 'on');
  assert.equal(patch.theme, 'dark', 'the appearance keys the Hub keeps in 偏好 persist here');
  assert.equal(patch.currency, 'CNY');
  assert.equal(patch.systemGlass, false, 'the surface control unfolds to the legacy pair');
  assert.equal(patch.windowsBackdrop, undefined, 'regular carries no material');
});

test('the surface control round-trips through the dropdown', () => {
  const { readDesktopSettingsPatch } = loadView();
  const formFor = (value) => ({
    querySelector: (selector) => (selector === '[name="windowSurface"]' ? { value } : null),
    querySelectorAll: () => []
  });
  assert.equal(readDesktopSettingsPatch(formFor('mica')).windowsBackdrop, 'mica');
  assert.equal(readDesktopSettingsPatch(formFor('mica')).systemGlass, true);
  assert.equal(readDesktopSettingsPatch(formFor('regular')).systemGlass, false);
});

test('the update panel shows the channel and only offers an install that can work', () => {
  const { renderDesktopSettings } = loadView({
    desktopAppUpdate: {
      currentVersion: '1.4.3', installedChannel: 'preview', channel: 'stable',
      latest: { version: '1.2.1', prerelease: false }, hasUpdate: false, currentAhead: true,
      downloaded: false, installSupported: true, lastCheckedAt: '2026-10-25T12:00:00Z'
    }
  });
  const html = renderDesktopSettings({ updateChannel: 'stable' }, { platform: 'win32' });
  assert.match(html, /data-desktop-action="check-updates"/);
  assert.match(html, /name="updateChannel"/);
  assert.match(html, /value="stable" selected/);
  assert.match(html, /desktop\.settings\.currentVersion/);
  assert.match(html, /desktop\.settings\.latestVersion/);
  assert.match(html, /desktop\.settings\.prereleaseNotice/);
  assert.match(html, /data-desktop-action="switch-to-prerelease-channel"/);
  assert.doesNotMatch(html, /data-desktop-action="download-install-update"/,
    'no install action while the channel has nothing newer to install');

  const available = loadView({
    desktopAppUpdate: {
      currentVersion: '1.0.0', installedChannel: 'stable', channel: 'stable',
      latest: { version: '1.2.1', prerelease: false }, hasUpdate: true, currentAhead: false,
      downloaded: false, installSupported: true
    }
  }).renderDesktopSettings({ updateChannel: 'stable' }, { platform: 'win32' });
  assert.match(available, /data-desktop-action="download-install-update"/);
  assert.match(available, /desktop\.settings\.downloadInstallUpdate/);
  assert.match(available, /desktop\.settings\.latestVersion/);

  const blocked = loadView({
    desktopAppUpdate: {
      currentVersion: '1.0.0', installedChannel: 'stable', channel: 'stable',
      latest: { version: '1.2.1', prerelease: false }, hasUpdate: true,
      downloaded: false, installSupported: false, installSupportReason: 'windows-portable'
    }
  }).renderDesktopSettings({ updateChannel: 'stable' }, { platform: 'win32' });
  assert.doesNotMatch(blocked, /data-desktop-action="download-install-update"/);
  assert.match(blocked, /data-desktop-action="open-release-page"/);
  assert.match(blocked, /desktop\.settings\.installBlockedWindowsPortable/);
});

test('the manual-check toast and install errors share the panel wording', () => {
  const { appUpdateToastText, appUpdateInstallErrorText } = loadView();
  assert.equal(appUpdateToastText({ lastError: 'boom', lastErrorKind: 'timeout' }), 'desktop.settings.updateErrorTimeout');
  assert.equal(appUpdateToastText({
    hasUpdate: true, latest: { version: '1.1.0', prerelease: false }
  }), 'desktop.settings.updateAvailableWithVersion');
  assert.equal(appUpdateToastText({
    latest: { version: '1.0.0', prerelease: false }, hasUpdate: false
  }), 'desktop.settings.upToDate');
  assert.equal(appUpdateToastText({
    noChannelRelease: true, channel: 'stable'
  }), 'desktop.settings.noChannelRelease');
  assert.equal(appUpdateInstallErrorText({ installErrorKind: 'channel-mismatch' }), 'desktop.settings.installErrorChannelMismatch');
  assert.equal(appUpdateInstallErrorText({}), 'desktop.settings.installErrorUnknown');
});
