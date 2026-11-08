'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyUserData, LEGACY_APP_NAME } = require('../../src/electron/userDataMigration');

function tempAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-userdata-'));
}

test('copies the legacy Token Monitor profile into the new Jiran userData folder', (t) => {
  const appData = tempAppData();
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  fs.mkdirSync(path.join(appData, LEGACY_APP_NAME, 'mimo-credentials'), { recursive: true });
  fs.writeFileSync(path.join(appData, LEGACY_APP_NAME, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(appData, LEGACY_APP_NAME, 'credentials.json'), '{}');
  fs.writeFileSync(path.join(appData, LEGACY_APP_NAME, 'mimo-credentials', 'cookie.txt'), 'x');

  const result = migrateLegacyUserData({ appDataDir: appData });
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(appData, 'Jiran', 'settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.ok(fs.existsSync(path.join(appData, 'Jiran', 'credentials.json')));
  assert.ok(fs.existsSync(path.join(appData, 'Jiran', 'mimo-credentials', 'cookie.txt')));
  // the legacy folder stays as an accidental backup, untouched
  assert.ok(fs.existsSync(path.join(appData, LEGACY_APP_NAME, 'settings.json')));
});

test('no-ops when the legacy folder does not exist', (t) => {
  const appData = tempAppData();
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  const result = migrateLegacyUserData({ appDataDir: appData });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'no-legacy-dir');
  assert.equal(fs.existsSync(path.join(appData, 'Jiran')), false);
});

test('never clobbers a target profile that already has settings.json', (t) => {
  const appData = tempAppData();
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  fs.mkdirSync(path.join(appData, LEGACY_APP_NAME), { recursive: true });
  fs.writeFileSync(path.join(appData, LEGACY_APP_NAME, 'settings.json'), '{"from":"legacy"}');
  fs.mkdirSync(path.join(appData, 'Jiran'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Jiran', 'settings.json'), '{"from":"current"}');

  const result = migrateLegacyUserData({ appDataDir: appData });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'target-has-settings');
  assert.equal(fs.readFileSync(path.join(appData, 'Jiran', 'settings.json'), 'utf8'), '{"from":"current"}');
});

test('fills gaps in a partially migrated profile without overwriting existing entries', (t) => {
  const appData = tempAppData();
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  fs.mkdirSync(path.join(appData, LEGACY_APP_NAME), { recursive: true });
  fs.writeFileSync(path.join(appData, LEGACY_APP_NAME, 'settings.json'), '{"from":"legacy"}');
  fs.writeFileSync(path.join(appData, LEGACY_APP_NAME, 'exchange-rates.json'), '{"legacy":1}');
  fs.mkdirSync(path.join(appData, 'Jiran'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Jiran', 'exchange-rates.json'), '{"new":1}');

  const result = migrateLegacyUserData({ appDataDir: appData });
  assert.equal(result.migrated, true);
  assert.deepEqual(result.copied, ['settings.json']);
  assert.deepEqual(result.preserved, ['exchange-rates.json']);
  assert.equal(fs.readFileSync(path.join(appData, 'Jiran', 'settings.json'), 'utf8'), '{"from":"legacy"}');
  assert.equal(fs.readFileSync(path.join(appData, 'Jiran', 'exchange-rates.json'), 'utf8'), '{"new":1}');
});

test('skips Chromium caches, session stores and stale singleton locks', (t) => {
  const appData = tempAppData();
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  const legacy = path.join(appData, LEGACY_APP_NAME);
  fs.mkdirSync(path.join(legacy, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Cache', 'data_0'), 'cache');
  fs.mkdirSync(path.join(legacy, 'GPUCache'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'Session Storage'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Session Storage', 'LOG'), 'session');
  fs.writeFileSync(path.join(legacy, 'SingletonLock'), 'host-1234');
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(legacy, 'exchange-rates.json'), '{"usd":7}');
  fs.mkdirSync(path.join(legacy, 'managed-codex-homes', 'home-1'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'managed-codex-homes', 'home-1', 'auth.json'), '{"token":"x"}');

  const result = migrateLegacyUserData({ appDataDir: appData });
  assert.equal(result.migrated, true);
  assert.deepEqual([...result.skipped].sort(), ['Cache', 'GPUCache', 'Session Storage', 'SingletonLock']);
  assert.deepEqual(result.copied.sort(), ['exchange-rates.json', 'managed-codex-homes', 'settings.json']);
  // App-owned profile data still arrives; the disposable entries do not.
  assert.ok(fs.existsSync(path.join(appData, 'Jiran', 'managed-codex-homes', 'home-1', 'auth.json')));
  assert.equal(fs.existsSync(path.join(appData, 'Jiran', 'Cache')), false);
  assert.equal(fs.existsSync(path.join(appData, 'Jiran', 'SingletonLock')), false);
  // The legacy folder is untouched, cache included.
  assert.ok(fs.existsSync(path.join(legacy, 'Cache', 'data_0')));
});
