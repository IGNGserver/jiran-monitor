'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DARK_ACCENT_ARGB,
  LIGHT_ACCENT_ARGB,
  windowsAccentArgb,
  applyWindowsAccentBlur
} = require('../../src/electron/windowsBackdrop');

const {
  WINDOWS_BACKDROP_ACRYLIC,
  WINDOWS_BACKDROP_MICA,
  WINDOWS_SURFACE_NONE,
  WINDOWS_SURFACE_MICA,
  WINDOWS_SURFACE_ACRYLIC,
  WINDOWS_SURFACE_WIN10_FALLBACK,
  normalizeWindowsBackdropMode,
  windowsElectronBackgroundMaterial,
  normalizeWindowsSurface,
  windowsSurfaceProfile
} = require('../../src/electron/windowsBackdropMode');

test('normalizeWindowsBackdropMode normalizes correctly', () => {
  assert.equal(normalizeWindowsBackdropMode('mica'), WINDOWS_BACKDROP_MICA);
  assert.equal(normalizeWindowsBackdropMode('acrylic'), WINDOWS_BACKDROP_ACRYLIC);
  assert.equal(normalizeWindowsBackdropMode('transparent'), 'transparent');
  assert.equal(normalizeWindowsBackdropMode('unknown'), WINDOWS_BACKDROP_ACRYLIC);
});

test('windowsElectronBackgroundMaterial maps backdrop mode to Electron material', () => {
  assert.equal(windowsElectronBackgroundMaterial('mica'), 'mica');
  assert.equal(windowsElectronBackgroundMaterial('acrylic'), 'acrylic');
  assert.equal(windowsElectronBackgroundMaterial('transparent'), 'none');
});

test('normalizeWindowsSurface recognizes mica, acrylic, transparent, fallback, and none', () => {
  assert.equal(normalizeWindowsSurface('mica'), WINDOWS_SURFACE_MICA);
  assert.equal(normalizeWindowsSurface('acrylic'), WINDOWS_SURFACE_ACRYLIC);
  assert.equal(normalizeWindowsSurface('transparent'), 'transparent');
  assert.equal(normalizeWindowsSurface('win10-fallback'), WINDOWS_SURFACE_WIN10_FALLBACK);
  assert.equal(normalizeWindowsSurface('unknown'), WINDOWS_SURFACE_NONE);
});

test('windowsSurfaceProfile distinguishes mica, acrylic, and transparent kinds on supported Windows', () => {
  const micaProfile = windowsSurfaceProfile({
    platform: 'win32',
    osRelease: '10.0.22621',
    systemGlass: true,
    backdropMode: 'mica'
  });
  assert.equal(micaProfile.kind, WINDOWS_SURFACE_MICA);
  assert.equal(micaProfile.nativeBackdrop, true);
  assert.equal(micaProfile.nativeMaterial, 'mica');

  const acrylicProfile = windowsSurfaceProfile({
    platform: 'win32',
    osRelease: '10.0.22621',
    systemGlass: true,
    backdropMode: 'acrylic'
  });
  assert.equal(acrylicProfile.kind, WINDOWS_SURFACE_ACRYLIC);
  assert.equal(acrylicProfile.nativeBackdrop, true);
  assert.equal(acrylicProfile.nativeMaterial, 'acrylic');

  const transProfile = windowsSurfaceProfile({
    platform: 'win32',
    osRelease: '10.0.22621',
    systemGlass: true,
    backdropMode: 'transparent'
  });
  assert.equal(transProfile.kind, 'transparent');
  assert.equal(transProfile.nativeBackdrop, false);
  assert.equal(transProfile.nativeMaterial, 'none');
});

test('windowsSurfaceProfile turns off on non-Windows or disabled glass', () => {
  const nonWin = windowsSurfaceProfile({
    platform: 'linux',
    osRelease: '6.5.0',
    systemGlass: true,
    backdropMode: 'mica'
  });
  assert.equal(nonWin.kind, WINDOWS_SURFACE_NONE);
  assert.equal(nonWin.nativeBackdrop, false);

  const disabled = windowsSurfaceProfile({
    platform: 'win32',
    osRelease: '10.0.22621',
    systemGlass: false,
    backdropMode: 'mica'
  });
  assert.equal(disabled.kind, WINDOWS_SURFACE_NONE);
  assert.equal(disabled.nativeBackdrop, false);
});

test('Windows 10 accent tint adapts to dark and light themes', () => {
  assert.equal(windowsAccentArgb({ dark: true }), DARK_ACCENT_ARGB);
  assert.equal(windowsAccentArgb({ dark: false }), LIGHT_ACCENT_ARGB);
  assert.notEqual(LIGHT_ACCENT_ARGB, DARK_ACCENT_ARGB);

  const calls = [];
  const win = {
    isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.alloc(8)
  };
  const api = {
    apply(hwnd, argb) {
      calls.push({ hwnd, argb });
      return true;
    }
  };
  assert.equal(applyWindowsAccentBlur(win, { platform: 'win32', dark: false, api }), true);
  assert.equal(calls[0].argb, LIGHT_ACCENT_ARGB);
  assert.equal(applyWindowsAccentBlur(win, { platform: 'win32', dark: true, api }), true);
  assert.equal(calls[1].argb, DARK_ACCENT_ARGB);

  const mainSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.match(mainSource, /applyWindowsAccentBlur\(target,\s*\{\s*dark:\s*nativeTheme\.shouldUseDarkColors\s*\}\)/);
});
