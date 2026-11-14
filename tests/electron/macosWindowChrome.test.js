'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MACOS_TRAFFIC_LIGHT_POSITION,
  applyMacosNativeWindowButtons
} = require('../../src/electron/macosWindowChrome');

const ROOT = path.join(__dirname, '..', '..');

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

test('macOS native traffic lights are positioned and shown for normal windows', () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    setWindowButtonPosition: (position) => calls.push(['position', position]),
    setWindowButtonVisibility: (visible) => calls.push(['visibility', visible])
  };

  assert.equal(applyMacosNativeWindowButtons(win, { platform: 'darwin' }), true);
  assert.deepEqual(calls, [
    ['position', MACOS_TRAFFIC_LIGHT_POSITION],
    ['visibility', true]
  ]);
});

test('collapsed macOS floating bubbles hide native traffic lights', () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    setWindowButtonPosition: (position) => calls.push(['position', position]),
    setWindowButtonVisibility: (visible) => calls.push(['visibility', visible])
  };

  assert.equal(applyMacosNativeWindowButtons(win, { platform: 'darwin', visible: false }), true);
  assert.deepEqual(calls, [['visibility', false]]);
});

test('native traffic-light helper is inert off macOS', () => {
  const calls = [];
  const win = {
    setWindowButtonPosition: () => calls.push('position'),
    setWindowButtonVisibility: () => calls.push('visibility')
  };

  assert.equal(applyMacosNativeWindowButtons(win, { platform: 'linux' }), false);
  assert.deepEqual(calls, []);
});

test('the main window uses native controls with an inset title bar on macOS', () => {
  const main = read('src', 'electron', 'main.js');
  // A normal window keeps its frame; on macOS the title bar is inset so the
  // traffic lights sit on the app's own toolbar above the sidebar.
  assert.match(main, /applyMacosNativeWindowButtons\(win\)/);
  assert.match(main, /titleBarStyle: 'hiddenInset'/, 'macOS uses an inset title bar');
  assert.match(main, /platform:\s*process\.platform/, 'loadWindowFile passes platform synchronously for first paint');
  assert.match(main, /win\.setVibrancy\(enabled \? 'under-window' : null\)/, 'vibrancy uses adaptive under-window material rather than HUD');
  assert.doesNotMatch(main, /setVisualEffectState\(/, 'dead BrowserWindow.setVisualEffectState calls are removed');
  assert.match(main, /const macosTransparencyChanged = process\.platform === 'darwin'[\s\S]*previousNativeMaterial !== nextNativeMaterial/, 'macOS rebuilds window when toggling opaque vs glass surface');
  assert.match(main, /createWindow\(bounds,\s*\{\s*waitForContent:\s*true,\s*inactive:\s*!wasFocused\s*\}\)/, 'rebuildWindow waits for content before revealing');
  assert.match(main, /win\.once\('closed',\s*\(\)\s*=>\s*\{\s*clearMacosGlass\(win\);/, 'closing window cleans up macOS glass view');

  // Desktop width clears traffic lights over the sidebar without indenting main topbar;
  // compact drawer width indents the topbar and drawer sidebar below traffic lights.
  const desktopCss = read('src', 'electron', 'renderer', 'desktop.css');
  assert.match(desktopCss, /body\.is-mac \.sidebar\s*\{\s*padding-top:\s*calc\(44px \+ var\(--safe-top\)\)/);
  const topbarBase = desktopCss.match(/(?:^|\n)body\.is-mac \.topbar\s*\{([^}]*)\}/);
  assert.ok(topbarBase, 'the topbar must define macOS drag styling');
  assert.doesNotMatch(topbarBase[1], /padding-left\s*:\s*78px/,
    'desktop layout must not indent topbar because traffic lights sit over the sidebar');
  assert.match(desktopCss, /@media \(max-width:\s*860px\)\s*\{[\s\S]*body\.is-mac \.topbar\s*\{\s*padding-left:\s*78px;[\s\S]*body\.is-mac \.sidebar\s*\{\s*padding-top:\s*calc\(48px \+ var\(--safe-top\)\);/);
  assert.match(desktopCss, /-webkit-app-region: drag/, 'the topbar is a drag region on macOS');
  assert.match(desktopCss, /-webkit-app-region: no-drag/, 'interactive children must opt out of dragging');
});
