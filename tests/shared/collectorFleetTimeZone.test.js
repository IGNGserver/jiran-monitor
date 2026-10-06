'use strict';

// Applying the fleet calendar on a device: the tokscale pin and the one-time
// re-key. A zone change moves every day boundary, so artifacts keyed by the old
// calendar must be dropped and the next tick must be a full scan; a device
// already on the fleet zone (the steady state) must be a no-op.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applyFleetTimeZone, resolveTickTimeZone } = require('../../src/shared/collector');

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-fleet-collector-'));
  return {
    dir,
    env: { TOKEN_MONITOR_SHARED_DIR: dir, HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') }
  };
}

test('applyFleetTimeZone re-keys day-keyed artifacts when the calendar moves', () => {
  const { dir, env } = tempEnv();
  const artifacts = ['daily-history-archive.json', 'session-usage-archive.json', 'collector-anchor.json'];
  for (const name of artifacts) fs.writeFileSync(path.join(dir, name), '{}', 'utf8');

  const moved = applyFleetTimeZone('Asia/Shanghai', {
    env,
    homeDir: dir,
    platform: 'linux',
    ensureTokscaleBucketTimeZone: () => ({ ok: true, changed: true, previous: 'America/Los_Angeles' })
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.changed, true);
  for (const name of artifacts) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} must be cleared on re-key`);
  }

  // Same calendar again: the pin matches and this process already moved.
  const steady = applyFleetTimeZone('Asia/Shanghai', {
    env,
    homeDir: dir,
    platform: 'linux',
    ensureTokscaleBucketTimeZone: () => ({ ok: true, changed: false, previous: 'Asia/Shanghai' })
  });
  assert.equal(steady.changed, false);

  // Another process may have written the pin first; this process's in-memory
  // calendar still moved and must invalidate.
  fs.writeFileSync(path.join(dir, 'collector-anchor.json'), '{}', 'utf8');
  const externallyWritten = applyFleetTimeZone('UTC', {
    env,
    homeDir: dir,
    platform: 'linux',
    ensureTokscaleBucketTimeZone: () => ({ ok: true, changed: false, previous: 'UTC' })
  });
  assert.equal(externallyWritten.changed, true);
  assert.equal(fs.existsSync(path.join(dir, 'collector-anchor.json')), false);
});

test('applyFleetTimeZone is inert without a zone and surfaces an unreadable pin', () => {
  const { dir, env } = tempEnv();
  assert.deepEqual(
    applyFleetTimeZone('', { env, homeDir: dir, platform: 'linux' }),
    { ok: true, changed: false, timeZone: '' }
  );
  assert.deepEqual(
    applyFleetTimeZone('+09:00', { env, homeDir: dir, platform: 'linux' }),
    { ok: true, changed: false, timeZone: '' }
  );
  const failed = applyFleetTimeZone('Asia/Shanghai', {
    env,
    homeDir: dir,
    platform: 'linux',
    ensureTokscaleBucketTimeZone: () => ({ ok: false, reason: 'unreadable-settings' })
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'unreadable-settings');
  assert.equal(failed.changed, false);
});

test('resolveTickTimeZone prefers the explicit option, then the resolver, then env/state', () => {
  const { dir, env } = tempEnv();
  assert.equal(resolveTickTimeZone({ timeZone: 'UTC', env, homeDir: dir }), 'UTC');
  assert.equal(resolveTickTimeZone({ resolveTimeZone: () => 'Asia/Shanghai', env, homeDir: dir }), 'Asia/Shanghai');
  assert.equal(
    resolveTickTimeZone({ env: { ...env, TOKEN_MONITOR_FLEET_TIMEZONE: 'Asia/Shanghai' }, homeDir: dir }),
    'Asia/Shanghai'
  );
  assert.equal(resolveTickTimeZone({ env, homeDir: dir }), '');
});
