'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureTokscaleBucketTimeZone,
  readTokscaleBucketTimeZone,
  readTokscaleSettings
} = require('../../src/shared/tokscaleSettings');

function tempSettingsPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-tokscale-settings-'));
  return path.join(dir, 'settings.json');
}

test('ensureTokscaleBucketTimeZone pre-seeds a missing settings file', () => {
  const settingsPath = tempSettingsPath();
  const result = ensureTokscaleBucketTimeZone('Asia/Shanghai', { path: settingsPath });
  assert.deepEqual(result, { ok: true, changed: true, previous: '' });
  assert.equal(readTokscaleBucketTimeZone({ path: settingsPath }), 'Asia/Shanghai');
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(written.scanner.bucketTimezone, 'Asia/Shanghai');
});

test('ensureTokscaleBucketTimeZone preserves every other setting', () => {
  const settingsPath = tempSettingsPath();
  fs.writeFileSync(settingsPath, JSON.stringify({
    colorPalette: 'blue',
    scanner: { opencodeDbPaths: ['/tmp/db'], extraScanPaths: { codex: ['/x'] }, bucketTimezone: 'America/Los_Angeles' },
    defaultClients: ['opencode']
  }), 'utf8');

  const result = ensureTokscaleBucketTimeZone('Asia/Shanghai', { path: settingsPath });
  assert.deepEqual(result, { ok: true, changed: true, previous: 'America/Los_Angeles' });
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(written.scanner.bucketTimezone, 'Asia/Shanghai');
  assert.deepEqual(written.scanner.opencodeDbPaths, ['/tmp/db']);
  assert.deepEqual(written.scanner.extraScanPaths, { codex: ['/x'] });
  assert.equal(written.colorPalette, 'blue');
  assert.deepEqual(written.defaultClients, ['opencode']);
});

test('ensureTokscaleBucketTimeZone is a no-op when the pin already matches', () => {
  const settingsPath = tempSettingsPath();
  ensureTokscaleBucketTimeZone('Asia/Shanghai', { path: settingsPath });
  const before = fs.readFileSync(settingsPath, 'utf8');
  const result = ensureTokscaleBucketTimeZone('Asia/Shanghai', { path: settingsPath });
  assert.deepEqual(result, { ok: true, changed: false, previous: 'Asia/Shanghai' });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);
});

test('ensureTokscaleBucketTimeZone refuses malformed settings instead of replacing them', () => {
  const settingsPath = tempSettingsPath();
  const malformed = '{ this is not json';
  fs.writeFileSync(settingsPath, malformed, 'utf8');
  const result = ensureTokscaleBucketTimeZone('Asia/Shanghai', { path: settingsPath });
  assert.deepEqual(result, { ok: false, reason: 'unreadable-settings' });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformed);
  assert.equal(readTokscaleSettings({ path: settingsPath }), false);
});

test('ensureTokscaleBucketTimeZone rejects fixed offsets and unknown zones', () => {
  const settingsPath = tempSettingsPath();
  assert.deepEqual(
    ensureTokscaleBucketTimeZone('+09:00', { path: settingsPath }),
    { ok: false, reason: 'invalid-zone' }
  );
  assert.deepEqual(
    ensureTokscaleBucketTimeZone('Mars/Olympus_Mons', { path: settingsPath }),
    { ok: false, reason: 'invalid-zone' }
  );
  assert.equal(fs.existsSync(settingsPath), false);
});
