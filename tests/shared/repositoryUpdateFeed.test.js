'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepositoryFeedClient, FEED_URL, retryAfterMs } = require('../../src/shared/repositoryUpdateFeed');
const { checkLatestRelease, releaseHasPlatformAssets, selectLatestForChannel } = require('../../src/shared/appUpdater');
const payload = { schemaVersion: 1, repository: 'IGNGserver/jiran-monitor', generatedAt: '2026-10-26T00:00:00Z', releases: [] };
function fixture(fetchImpl) {
  let state = {};
  let time = Date.parse(payload.generatedAt);
  return {
    client: createRepositoryFeedClient({ fetchImpl, readState: () => state, writeState: (next) => { state = next; }, now: () => time, random: () => 0 }),
    state: () => state, advance: (ms) => { time += ms; }
  };
}
function ok(value = payload) { return new Response(JSON.stringify(value), { headers: { etag: '"feed-1"' } }); }

test('device feed coalesces requests, persists ETag and enforces manual cooldown', async () => {
  let calls = 0;
  const f = fixture(async (url, options) => { calls++; assert.equal(url, FEED_URL); assert.equal(options.headers.authorization, undefined); return ok(); });
  await Promise.all([f.client.load({ manual: true }), f.client.load({ manual: true })]);
  await f.client.load({ manual: true });
  assert.equal(calls, 1);
  assert.equal(f.state().etag, '"feed-1"');
  f.advance(60_001);
  await f.client.load();
  assert.equal(calls, 1, 'automatic check respects six-hour cache');
  await f.client.load({ manual: true });
  assert.equal(calls, 2);
});

test('persisted conditional cache survives a new process and 304 retains payload', async () => {
  let state;
  const first = createRepositoryFeedClient({ readState: () => state, writeState: (value) => { state = value; }, fetchImpl: async () => ok(), now: () => 1_000_000 });
  await first.load();
  const second = createRepositoryFeedClient({ readState: () => state, writeState: (value) => { state = value; }, fetchImpl: async (_, options) => { assert.equal(options.headers['if-none-match'], '"feed-1"'); return new Response(null, { status: 304 }); }, now: () => 1_060_001 });
  assert.deepEqual((await second.load({ manual: true })).payload, payload);
});

test('429 cooldown cannot be bypassed by manual checks or process restart', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); });
  await assert.rejects(f.client.load(), /429/);
  f.advance(61_000);
  await assert.rejects(f.client.load({ manual: true }), /cooling down/);
  const second = createRepositoryFeedClient({ readState: f.state, fetchImpl: () => { throw new Error('must not request'); }, now: () => f.state().lastAttemptAt + 120_000 });
  await assert.rejects(second.load({ manual: true }), /cooling down/);
  assert.equal(calls, 1);
});

test('503 Retry-After, HTTP date and reset headers are honored', () => {
  const time = Date.parse('2026-10-26T00:00:00Z');
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '120' }), time), 120000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Mon, 26 Oct 2026 00:02:00 GMT' }), time), 120000);
  assert.equal(retryAfterMs(new Headers({ 'x-ratelimit-reset': String(time / 1000 + 300) }), time), 300000);
});

test('invalid feed is rejected and does not replace a trusted cache', async () => {
  const f = fixture(async () => ok({ ...payload, repository: 'other/repo' }));
  await assert.rejects(f.client.load(), /Invalid update feed/);
  assert.equal(f.state().payload, undefined);
  assert.ok(f.state().retryAt > f.state().lastAttemptAt);
});

test('platform selection requires installer and metadata from the same tagged release', () => {
  const tag = 'v1.5.0';
  const release = { tag, assets: ['latest.yml', 'Jiran-Setup-1.5.0.exe'].map((name) => ({ name, state: 'uploaded', size: 100, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: `https://github.com/IGNGserver/jiran-monitor/releases/download/${tag}/${name}` })) };
  assert.equal(releaseHasPlatformAssets(release, { platform: 'win32' }), true);
  assert.equal(releaseHasPlatformAssets({ ...release, assets: release.assets.slice(0, 1) }, { platform: 'win32' }), false);
  assert.equal(releaseHasPlatformAssets({ ...release, tag: 'v1.4.0' }, { platform: 'win32' }), false);
});

test('legacy revisions use the released project ordering and never offer lower revisions', () => {
  assert.equal(selectLatestForChannel([{ version: '0.47.0-rev.40', prerelease: true }], '0.47.0-rev.39', 'preview').newer, true);
  assert.equal(selectLatestForChannel([{ version: '0.47.0', prerelease: false }], '0.47.0-rev.39', 'stable').newer, false);
});

test('feed check does not offer a newer release missing this platform assets', async () => {
  const result = await checkLatestRelease('1.0.0', 'preview', { feedClient: { load: async () => ({ payload: { ...payload, releases: [{ tag_name: 'v1.5.0', html_url: 'https://github.com/IGNGserver/jiran-monitor/releases/tag/v1.5.0', assets: [] }] } }) }, platformOptions: { platform: 'win32' } });
  assert.equal(result.ok, true);
  assert.equal(result.newer, false);
  assert.equal(result.noChannelRelease, true);
});
test('the native compatibility exception accepts only a proven legacy-revision upgrade', () => {
  const { needsLegacyRevisionCompatibility } = require('../../src/shared/appUpdater');
  assert.equal(needsLegacyRevisionCompatibility('0.47.0-rev.1', '0.47.0'), true);
  assert.equal(needsLegacyRevisionCompatibility('0.47.0-rev.2', '0.47.0-rev.1'), false, 'normal native SemVer increase needs no exception');
  assert.equal(needsLegacyRevisionCompatibility('0.47.0', '0.47.0-rev.1'), false);
  assert.equal(needsLegacyRevisionCompatibility('0.47.0-rev.1', '0.47.0-rev.2'), false);
  assert.equal(needsLegacyRevisionCompatibility('0.46.0-rev.99', '0.47.0'), false);
  assert.equal(needsLegacyRevisionCompatibility('1.0.0', '0.47.0-rev.39'), false);
  assert.equal(needsLegacyRevisionCompatibility('bad', '0.47.0'), false);
});
test('a full 200 response without ETag clears the old validator', async () => {
  let state = { payload, etag: 'old', lastAttemptAt: 1 };
  const client = createRepositoryFeedClient({ readState: () => state, writeState: (next) => { state = next; }, fetchImpl: async () => new Response(JSON.stringify(payload)) });
  await client.load({ manual: true });
  assert.equal(state.etag, null);
});

test('a synchronous transport failure still releases the single-flight slot', async () => {
  let state = {};
  let time = 1_000_000;
  let calls = 0;
  const client = createRepositoryFeedClient({ readState: () => state, writeState: (next) => { state = next; }, now: () => time, fetchImpl: () => { calls++; throw new Error('offline'); } });
  await assert.rejects(client.load(), /offline/);
  time += 61_000;
  await assert.rejects(client.load({ manual: true }), /offline/);
  assert.equal(calls, 2);
});
test('cached results retain the real validation time instead of postponing background refresh', async () => {
  const f = fixture(async () => ok());
  const checked = await f.client.load();
  f.advance(6 * 60 * 60 * 1000 - 1000);
  const cached = await f.client.load();
  assert.equal(cached.cached, true);
  assert.equal(cached.checkedAt, checked.checkedAt);
});