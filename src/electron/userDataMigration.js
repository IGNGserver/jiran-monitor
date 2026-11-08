'use strict';
/*
 * One-time userData migration for the 计然 / Jiran rename.
 *
 * Electron derives `userData` from `app.getName()`, so renaming the product would
 * silently strand `settings.json`, `credentials.json`, the stats cache and every
 * other profile file in the legacy `Token Monitor` folder. Copy that folder's
 * contents into the new one before anything reads it, but only when the target
 * has no settings.json yet — a fresh or already-migrated profile is never
 * clobbered, and per-entry conflicts resolve in favour of the new profile. The
 * legacy folder is intentionally left in place as an accidental backup.
 *
 * Chromium writes a large set of disposable caches, session stores and process
 * lock files into the same folder. Copying them would duplicate hundreds of
 * megabytes of data the new profile rebuilds on its own, and a copied
 * `SingletonLock` can make the new profile believe another instance is running.
 * They are skipped and reported instead; everything the app actually owns
 * (settings, credentials, managed homes, caches we wrote ourselves, logs) is
 * copied exactly as before.
 */
const fs = require('node:fs');
const path = require('node:path');

const LEGACY_APP_NAME = 'Token Monitor';

// Electron/Chromium ephemera. This list is deliberately explicit rather than a
// pattern: a new app-owned file must never be dropped by accident, so an
// unknown entry is copied.
const EPHEMERAL_ENTRIES = new Set([
  'blob_storage',
  'Cache',
  'Code Cache',
  'component_crx_cache',
  'Crash Reports',
  'Crashpad',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Dictionaries',
  'extensions_crx_cache',
  'GraphiteDawnCache',
  'GPUCache',
  'GrShaderCache',
  'lockfile',
  'Service Worker',
  'Session Storage',
  'ShaderCache',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket'
]);

function migrateLegacyUserData({ appDataDir, appName = 'Jiran', legacyName = LEGACY_APP_NAME } = {}) {
  if (!appDataDir) return { migrated: false, reason: 'missing-appDataDir' };
  const target = path.join(appDataDir, appName);
  const source = path.join(appDataDir, legacyName);
  if (source === target) return { migrated: false, reason: 'same-path' };
  if (!fs.existsSync(source)) return { migrated: false, reason: 'no-legacy-dir' };
  if (fs.existsSync(path.join(target, 'settings.json'))) return { migrated: false, reason: 'target-has-settings' };
  fs.mkdirSync(target, { recursive: true });
  const copied = [];
  const preserved = [];
  const skipped = [];
  for (const entry of fs.readdirSync(source)) {
    if (EPHEMERAL_ENTRIES.has(entry)) {
      skipped.push(entry);
      continue;
    }
    if (fs.existsSync(path.join(target, entry))) {
      preserved.push(entry);
      continue;
    }
    fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
    copied.push(entry);
  }
  return { migrated: true, copied, preserved, skipped, source, target };
}

module.exports = { migrateLegacyUserData, LEGACY_APP_NAME, EPHEMERAL_ENTRIES };
