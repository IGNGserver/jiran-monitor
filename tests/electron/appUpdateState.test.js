'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  assert.notEqual(end, -1, `${endMarker} should exist after ${startMarker}`);
  return main.slice(start, end);
}

test('manual update checks restore a matching dismissed version', () => {
  const check = sourceBetween('async function runAppUpdateCheck', 'function maybeRunBackgroundUpdateCheck');
  assert.match(check, /if \(force && result\.newer\) restoreDismissedAppUpdate\(result\.latest\?\.version\)/);
});

test('manual checks preserve feedback when reusing an in-flight background check', () => {
  const check = sourceBetween('async function runAppUpdateCheck', 'function maybeRunBackgroundUpdateCheck');
  assert.match(check, /if \(force\) sendAppUpdatePush\(\);\s*const activeResult = await appUpdateCheckPromise/);
  assert.match(check, /if \(activeResult\.newer\) restoreDismissedAppUpdate\(activeResult\.latest\?\.version\)/);
  assert.match(check, /appUpdateLastError = activeResult\?\.error \|\| 'Update check failed'/);
  assert.match(check, /return \{ ok: false, newer: false, latest: null, error: message/);
});

test('starting a user-requested download restores its dismissed notification', () => {
  const download = sourceBetween('async function downloadAndPrepareAppUpdate', 'function installDownloadedAppUpdate');
  assert.match(download, /restoreDismissedAppUpdate\(latest\?\.version\)/);
});

test('the release-list check receives the selected channel', () => {
  const check = sourceBetween('async function runAppUpdateCheck', 'function maybeRunBackgroundUpdateCheck');
  assert.match(check, /checkLatestRelease\(app\.getVersion\(\), normalizeUpdateChannel\(settings\?\.updateChannel\)\)/);
});

test('the native updater follows the selected channel and never overwrites the release-list latest', () => {
  const channel = sourceBetween('function applyAppUpdateChannel', 'function configureNativeAppUpdater');
  assert.match(channel, /autoUpdater\.allowPrerelease = channel === UPDATE_CHANNEL_PRERELEASE/);
  assert.match(channel, /autoUpdater\.allowDowngrade = false/, 'downgrades stay disabled');
  const native = sourceBetween('function configureNativeAppUpdater', 'function deriveAppUpdateState');
  assert.doesNotMatch(native, /rememberLatestAppUpdate/,
    'native updater events must not replace the channel-selected release');
});

test('the download path applies the channel before asking the native updater', () => {
  const download = sourceBetween('async function downloadAndPrepareAppUpdate', 'async function installDownloadedAppUpdate');
  assert.match(download, /configureNativeAppUpdater\(\);\s*applyAppUpdateChannel\(\);/);
  assert.match(download, /errorKind: 'channel-mismatch'/);
});

test('the update state exposes the selected channel, installed channel and channel-relative status', () => {
  const derive = sourceBetween('function deriveAppUpdateState', 'function restoreDismissedAppUpdate');
  assert.match(derive, /const channel = normalizeUpdateChannel\(settings\?\.updateChannel\)/);
  assert.match(derive, /channel,/);
  assert.match(derive, /installedChannel/);
  assert.match(derive, /currentAhead/);
  assert.match(derive, /noChannelRelease/);
  assert.match(derive, /lastErrorKind: appUpdateLastErrorKind/);
  assert.match(derive, /releaseListUrl: RELEASES_HTML_URL/);
});
