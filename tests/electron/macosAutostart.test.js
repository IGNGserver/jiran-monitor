'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  autostartSupported,
  plistFilePath,
  plistFileContents,
  readAutostartEntry,
  isAutostartEnabled,
  setAutostartEnabled,
  LAUNCH_AGENT_LABEL,
  PLIST_FILE_NAME,
  HIDDEN_LAUNCH_ARG
} = require('../../src/electron/macosAutostart');

function tmpHomeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-macos-autostart-'));
}

test('autostartSupported requires darwin and a non-empty executable path', () => {
  assert.equal(autostartSupported({ platform: 'darwin', appPath: '/Applications/Jiran.app/Contents/MacOS/Jiran' }), true);
  assert.equal(autostartSupported({ platform: 'darwin', appPath: '' }), false);
  assert.equal(autostartSupported({ platform: 'darwin' }), false);
  assert.equal(autostartSupported({ platform: 'linux', appPath: '/Applications/Jiran.app/Contents/MacOS/Jiran' }), false);
  assert.equal(autostartSupported({ platform: 'win32', appPath: 'C:\\Jiran.exe' }), false);
});

test('plistFilePath resolves under ~/Library/LaunchAgents', () => {
  assert.equal(
    plistFilePath({ env: { HOME: '/Users/alice' } }),
    `/Users/alice/Library/LaunchAgents/${PLIST_FILE_NAME}`
  );
  assert.equal(
    plistFilePath({ env: {}, homeDir: '/Users/bob' }),
    `/Users/bob/Library/LaunchAgents/${PLIST_FILE_NAME}`
  );
});

test('plistFileContents emits a valid LaunchAgent plist with optional --hidden arg', () => {
  const appPath = '/Applications/Jiran.app/Contents/MacOS/Jiran';
  const visible = plistFileContents(appPath, { hidden: false });
  assert.match(visible, new RegExp(`<key>Label</key>\\s*<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.match(visible, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(visible, /<string>\/Applications\/Jiran\.app\/Contents\/MacOS\/Jiran<\/string>/);
  assert.ok(!visible.includes(HIDDEN_LAUNCH_ARG));

  const hidden = plistFileContents(appPath, { hidden: true });
  assert.match(hidden, new RegExp(`<string>${HIDDEN_LAUNCH_ARG}</string>`));
});

test('plistFileContents escapes XML special characters in executable paths and round-trips cleanly', () => {
  const homeDir = tmpHomeDir();
  const appPath = '/Users/a&b/<Jiran>/"app\'s"/Contents/MacOS/Jiran';
  assert.equal(setAutostartEnabled(true, { env: { HOME: homeDir }, appPath, hidden: true }), true);
  const written = fs.readFileSync(path.join(homeDir, 'Library', 'LaunchAgents', PLIST_FILE_NAME), 'utf8');
  assert.ok(written.includes('&amp;'));
  assert.ok(written.includes('&lt;Jiran&gt;'));
  assert.ok(written.includes('&quot;'));
  assert.ok(written.includes('&apos;'));
  assert.deepEqual(readAutostartEntry({ env: { HOME: homeDir }, appPath }), {
    enabled: true,
    hidden: true,
    appPath
  });
});

test('setAutostartEnabled writes, updates hidden flag, detects stale path, and removes idempotently', () => {
  const homeDir = tmpHomeDir();
  const env = { HOME: homeDir };
  const appPath = '/Users/alice/Applications/Jiran.app/Contents/MacOS/Jiran';

  assert.equal(isAutostartEnabled({ env, appPath }), false);
  assert.equal(setAutostartEnabled(true, { env, appPath, hidden: true }), true);
  assert.equal(isAutostartEnabled({ env, appPath }), true);
  assert.equal(isAutostartEnabled({ env, appPath, hidden: true }), true);
  assert.equal(isAutostartEnabled({ env, appPath, hidden: false }), false);

  assert.equal(setAutostartEnabled(true, { env, appPath, hidden: false }), true);
  assert.equal(isAutostartEnabled({ env, appPath, hidden: false }), true);
  assert.equal(isAutostartEnabled({ env, appPath, hidden: true }), false);

  assert.equal(isAutostartEnabled({ env, appPath: '/Applications/Jiran.app/Contents/MacOS/Jiran' }), false);

  assert.equal(setAutostartEnabled(false, { env, appPath }), false);
  assert.equal(isAutostartEnabled({ env, appPath }), false);
  assert.equal(setAutostartEnabled(false, { env, appPath }), false);
});

test('readAutostartEntry rejects malformed or mismatched LaunchAgent plists', () => {
  const homeDir = tmpHomeDir();
  const env = { HOME: homeDir };
  const appPath = '/Applications/Jiran.app/Contents/MacOS/Jiran';
  const dir = path.join(homeDir, 'Library', 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, PLIST_FILE_NAME), '<plist><dict><key>Label</key><string>other</string></dict></plist>', 'utf8');
  assert.equal(isAutostartEnabled({ env, appPath }), false);

  fs.writeFileSync(
    path.join(dir, PLIST_FILE_NAME),
    plistFileContents(appPath, { hidden: false }).replace('<true/>', '<false/>'),
    'utf8'
  );
  assert.equal(isAutostartEnabled({ env, appPath }), false);
});

test('setAutostartEnabled(true) without an executable path reports failure', () => {
  const homeDir = tmpHomeDir();
  assert.equal(setAutostartEnabled(true, { env: { HOME: homeDir }, appPath: '' }), false);
  assert.equal(isAutostartEnabled({ env: { HOME: homeDir }, appPath: '' }), false);
});
