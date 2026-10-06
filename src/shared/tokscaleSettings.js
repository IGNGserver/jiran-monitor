'use strict';

// Align the tokscale binary's day bucketing with Jiran's fleet calendar.
//
// tokscale 4.17+ pins `scanner.bucketTimezone` on first run and refuses to change
// a valid pin through `tokscale config` (its own server merges submitted day rows
// monotonically). Jiran therefore maintains the value directly in the settings
// file whose location it already mirrors for custom pricing and cache paths.
//
// The write is a read-modify-write that preserves every other key, refuses an
// unreadable or malformed file rather than replacing it with defaults (the same
// posture tokscale itself takes), and reports whether the value actually changed
// so the caller can run its one-time re-key migration. Every tokscale invocation
// reads this file, so `--today`, `--month` and `graph` all bucket in the same
// zone the collector stamps into periodWindows.

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./config');
const { tokscaleConfigDir } = require('./tokscaleConfig');
const { isValidTimeZone } = require('./fleetTimeZone');

function tokscaleSettingsPath(options = {}) {
  return options.path || path.join(tokscaleConfigDir(options), 'settings.json');
}

// `null` = no settings file yet; `false` = present but unreadable or not a JSON
// object (never overwrite); otherwise the parsed object.
function readTokscaleSettings(options = {}) {
  const filePath = tokscaleSettingsPath(options);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return false;
  }
  if (!text.trim()) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : false;
  } catch (_) {
    return false;
  }
}

function readTokscaleBucketTimeZone(options = {}) {
  const settings = readTokscaleSettings(options);
  if (!settings || typeof settings !== 'object') return '';
  const scanner = settings.scanner;
  const zone = scanner && typeof scanner === 'object' ? scanner.bucketTimezone : '';
  return typeof zone === 'string' ? zone.trim() : '';
}

// Set `scanner.bucketTimezone` to `timeZone`.
//
// Returns `{ ok: true, changed, previous }`, or `{ ok: false, reason }` with
// reason `invalid-zone` or `unreadable-settings`. `changed` is true only when the
// stored value moved, which is the signal to run the re-key migration exactly
// once; a device already on the fleet zone (the common case) is a no-op.
function ensureTokscaleBucketTimeZone(timeZone, options = {}) {
  const zone = String(timeZone || '').trim();
  if (!isValidTimeZone(zone)) return { ok: false, reason: 'invalid-zone' };
  const filePath = tokscaleSettingsPath(options);
  const settings = readTokscaleSettings(options);
  if (settings === false) return { ok: false, reason: 'unreadable-settings' };
  const base = settings === null ? {} : settings;
  const scanner = base.scanner && typeof base.scanner === 'object' && !Array.isArray(base.scanner)
    ? base.scanner
    : {};
  const previous = typeof scanner.bucketTimezone === 'string' ? scanner.bucketTimezone.trim() : '';
  if (previous === zone) return { ok: true, changed: false, previous };
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(filePath, { ...base, scanner: { ...scanner, bucketTimezone: zone } }, { pretty: true });
  return { ok: true, changed: true, previous };
}

module.exports = {
  ensureTokscaleBucketTimeZone,
  readTokscaleBucketTimeZone,
  readTokscaleSettings,
  tokscaleSettingsPath
};
