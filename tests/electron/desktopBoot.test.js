'use strict';

// Boot contract for the desktop renderer.
//
// The desktop shell loads the shared UI through a boot module that installs the
// IPC transport first. If that ordering regresses, or if the shell stops
// providing an element the shared UI binds at startup, the window comes up
// blank with no error — exactly the failure mode this project already hit once
// with the old renderer. These assertions are cheap and catch that class of
// drift.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const sharedDir = path.join(__dirname, '..', '..', 'src', 'shared-ui');

const read = (file) => fs.readFileSync(file, 'utf8');

test('all local shell imports, stylesheets and icon bases resolve on disk', () => {
  const html = read(path.join(rendererDir, 'index.html'));
  const boot = read(path.join(rendererDir, 'boot.js'));
  const targets = [
    ...[...html.matchAll(/(?:src|href)="(\.[^"]+)"/g)].map(match => match[1]),
    ...[...boot.matchAll(/(?:from\s+|import\()['"](\.[^'"]+)['"]/g)].map(match => match[1]),
    ...[...boot.matchAll(/configureIconBase\(['"]([^'"]+)['"]\)/g)].map(match => match[1])
  ];
  assert.ok(targets.length >= 6);
  for (const target of targets) {
    assert.ok(fs.existsSync(path.resolve(rendererDir, target)), `unreachable desktop resource: ${target}`);
  }
});

test('the renderer shell loads the shared stylesheet and its own boot module', () => {
  const html = read(path.join(rendererDir, 'index.html'));
  assert.match(html, /shared-ui\/styles\/app\.css/, 'the shared stylesheet must be the base');
  assert.match(html, /src="boot\.js"/, 'the shell must load the boot module');
  assert.doesNotMatch(html, /floatingBubbleBoot/, 'the widget boot must be gone');
});

test('the shell provides every element the shared UI binds at startup', () => {
  const html = read(path.join(rendererDir, 'index.html'));
  // Ids the shared UI dereferences while rendering chrome or binding events. A
  // missing one throws during module evaluation and blanks the window.
  const required = [
    'app', 'primaryNav', 'streamStatus', 'streamStatusText', 'settingsOpen',
    'deviceFilter', 'periodTabs', 'customRangeBtn', 'refreshBtn', 'content',
    'heroStrip', 'totalTokens', 'totalCost', 'deviceCount', 'liveLabel',
    'brandSubtitle', 'streamStatusDetail', 'desktopSyncStatus', 'desktopSnapshotSource',
    'authGate', 'settingsDrawer', 'rangePopover', 'rangeFrom', 'rangeTo',
    'rangeApply', 'rangeClear', 'rangeError', 'toast', 'navScrim'
  ];
  const missing = required.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `shell is missing required element ids: ${missing.join(', ')}`);
});

test('the desktop shell exposes a visible local/cache status surface', () => {
  const html = read(path.join(rendererDir, 'index.html'));
  assert.match(html, /class="desktop-window-strip"/, 'Windows needs a renderer-owned title-bar surface');
  for (const channel of ['local', 'upload', 'rest', 'stream']) {
    assert.match(html, new RegExp(`data-sync-channel="${channel}"`), `desktop sync status should show ${channel}`);
  }
});

test('the boot module installs the transport before importing the shared UI', () => {
  const boot = read(path.join(rendererDir, 'boot.js'));
  // A static import would evaluate the shared UI before configureTransport ran,
  // because ES module imports are evaluated ahead of the importing module body.
  assert.match(boot, /await import\(/, 'the shared app must be imported dynamically');
  assert.doesNotMatch(boot, /^import ['"].*shared-ui\/app\.js/m, 'a static app import would break transport ordering');
  const configureIndex = boot.indexOf('configureTransport(');
  const importIndex = boot.indexOf("await import('../../shared-ui/app.js')");
  assert.ok(configureIndex >= 0, 'the boot module must configure a transport');
  assert.ok(importIndex > configureIndex, 'the transport must be configured before the app loads');
});

test('the boot module points client icons at the shared UI asset tree', () => {
  const boot = read(path.join(rendererDir, 'boot.js'));
  assert.match(boot, /configureIconBase\(/, 'the desktop icon base must be injected');
  assert.match(boot, /shared-ui\/icons\/clients/, 'icons resolve from the shared UI assets directory');
});

test('the desktop transport keeps hash routing and drops PWA surfaces', () => {
  const transport = read(path.join(sharedDir, 'transport', 'ipcTransport.js'));
  assert.match(transport, /routing: 'hash'/, 'file:// has no SPA fallback');
  assert.match(transport, /pwa: false/, 'the desktop client has no install prompt or service worker');
  assert.match(transport, /__configured__/, 'the renderer must never receive the raw secret');
});

test('desktop secret input is not retained in shared renderer state', () => {
  const app = read(path.join(sharedDir, 'app.js'));
  assert.match(app, /const desktopOwnsSecret = isCapable\('desktopSettings'\)/);
  assert.match(app, /state\.secret = desktopOwnsSecret \? '' : candidateSecret/);
  assert.match(app, /testSecret\(candidateSecret\)/, 'new desktop credentials must be validated through the main process');
  assert.match(app, /els\.settingsSecret\.value = ''/);
});

test('the desktop exchanges the owner secret for a revocable device session', () => {
  const main = read(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'));
  const credentials = read(path.join(__dirname, '..', '..', 'src', 'shared', 'credentialStore.js'));
  assert.match(main, /async function loginHubSession\(secret\)/);
  assert.match(main, /settings\.sessionToken/);
  assert.match(main, /async function ensureHubSession\(\)/);
  assert.match(main, /void ensureHubSession\(\)/, 'client-mode startup must migrate an existing secret');
  assert.match(main, /previousToken\) await revokeHubToken\(previousToken\)/);
  assert.match(credentials, /sessionToken: \['hub', 'sessionToken'\]/);
});

test('the preload bridge exposes the transport contract the shared UI requires', () => {
  const preload = read(path.join(__dirname, '..', '..', 'src', 'electron', 'preload.js'));
  for (const member of ['request:', 'validateSecret:', 'connectHub:', 'logoutHub:', 'getSettings:', 'hasSecret:', 'prefsFromSettings', 'prefsToSettingsPatch', 'confirm:', 'onStatsPush:']) {
    assert.ok(preload.includes(member), `preload must expose ${member}`);
  }
  // The prefs mapping is what lets one shared preference model survive in both
  // hosts; a dropped key silently stops persisting a user's choice.
  for (const key of ['language', 'currency', 'period', 'usageTab', 'managementTab', 'view']) {
    assert.ok(preload.includes(`'${key}'`), `prefs mapping must include ${key}`);
  }
});
