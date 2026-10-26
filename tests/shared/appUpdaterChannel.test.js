'use strict';

// The update channel is an explicit user setting, not something inferred from
// the installed version string: normal project releases are published as GitHub
// prereleases while their version is plain semver (1.4.3), so the old suffix
// heuristic classified them as stable and filtered them out.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeUpdateChannel,
  parseLatestReleasePayload,
  parseReleaseListPayload,
  releaseChannel,
  releaseMatchesChannel,
  selectLatestForChannel
} = require('../../src/shared/appUpdater');

function releasePayload(tag, prerelease) {
  return {
    tag_name: tag,
    prerelease,
    name: tag,
    html_url: `https://github.com/IGNGserver/jiran-monitor/releases/tag/${tag}`,
    published_at: '2026-10-25T00:00:00Z'
  };
}

function fixture() {
  return parseReleaseListPayload([
    releasePayload('v1.4.3', true),
    releasePayload('v1.2.1', false),
    releasePayload('v1.0.0', false)
  ]);
}

test('the channel setting only accepts the two supported values', () => {
  assert.equal(normalizeUpdateChannel('stable'), 'stable');
  assert.equal(normalizeUpdateChannel('PRERELEASE'), 'preview');
  assert.equal(normalizeUpdateChannel('beta'), 'stable', 'unknown values fall back to stable');
  assert.equal(normalizeUpdateChannel(undefined), 'stable');
  assert.equal(normalizeUpdateChannel('nonsense', 'preview'), 'preview');
});

test('the GitHub flag and the -rev suffix both identify prereleases', () => {
  assert.equal(releaseChannel(parseLatestReleasePayload(releasePayload('v1.4.3', true))), 'preview');
  assert.equal(releaseChannel(parseLatestReleasePayload(releasePayload('v1.4.3', false))), 'stable');
  assert.equal(releaseChannel(parseLatestReleasePayload(releasePayload('v1.4.3-rev.1', false))), 'preview',
    'a mislabelled -rev.N release must never reach a stable install');
});

test('stable rejects prereleases while the prerelease channel accepts both', () => {
  const prerelease = { version: '1.4.3', prerelease: true };
  const formal = { version: '1.2.1', prerelease: false };
  assert.equal(releaseMatchesChannel(prerelease, 'stable'), false);
  assert.equal(releaseMatchesChannel(formal, 'stable'), true);
  assert.equal(releaseMatchesChannel(prerelease, 'preview'), true);
  assert.equal(releaseMatchesChannel(formal, 'preview'), true);
  assert.equal(releaseMatchesChannel({ version: '0.47.0-rev.2', prerelease: false }, 'stable'), false);
});

test('a stable install never selects a prerelease even when it is newest', () => {
  const selection = selectLatestForChannel(fixture(), '1.0.0', 'stable');
  assert.equal(selection.latest.version, '1.2.1');
  assert.equal(selection.newer, true);
  assert.equal(selection.currentAhead, false);
  assert.equal(selection.installedChannel, 'stable');
  assert.equal(selection.noChannelRelease, false);
});

test('a prerelease install sees the newest publish on the prerelease channel', () => {
  const selection = selectLatestForChannel(fixture(), '1.4.3', 'preview');
  assert.equal(selection.latest.version, '1.4.3');
  assert.equal(selection.newer, false);
  assert.equal(selection.currentAhead, false);
  assert.equal(selection.installedChannel, 'preview');
});

test('a plain-version build installed from a prerelease keeps its channel label', () => {
  const selection = selectLatestForChannel(fixture(), '1.4.3', 'stable');
  assert.equal(selection.latest.version, '1.2.1');
  assert.equal(selection.newer, false);
  assert.equal(selection.currentAhead, true);
  assert.equal(selection.installedChannel, 'preview');
});

test('a legacy -rev.N build is offered the newer plain release', () => {
  const selection = selectLatestForChannel(fixture(), '0.47.0-rev.39', 'preview');
  assert.equal(selection.latest.version, '1.4.3');
  assert.equal(selection.newer, true);
  assert.equal(selection.installedChannel, 'preview');
});

test('a channel with no matching release reports an empty state, not an error', () => {
  const releases = parseReleaseListPayload([releasePayload('v1.4.3', true)]);
  const selection = selectLatestForChannel(releases, '1.2.1', 'stable');
  assert.equal(selection.latest, null);
  assert.equal(selection.newer, false);
  assert.equal(selection.currentAhead, false);
  assert.equal(selection.noChannelRelease, true);
});
