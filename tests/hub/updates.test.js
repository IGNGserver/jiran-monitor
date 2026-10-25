'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHub } = require('../../src/hub/server');
const {
  createUpdateService,
  isGithubDownloadUrl,
  isGithubReleaseUrl,
  normalizeRelease
} = require('../../src/hub/updates');
const { MemoryRepository } = require('./memory-repository');

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const REPO = 'IGNGserver/jiran-monitor';

function asset(name, { digest = `sha256:${SHA}`, url = `https://github.com/${REPO}/releases/download/v1.3.1/${name}` } = {}) {
  return {
    name,
    browser_download_url: url,
    size: 11_629_795,
    digest
  };
}

function release(version, {
  prerelease = true,
  assets = [asset(`Jiran-Android-${version}.apk`)],
  htmlUrl = `https://github.com/${REPO}/releases/tag/v${version}`,
  draft = false
} = {}) {
  return {
    tag_name: `v${version}`,
    html_url: htmlUrl,
    published_at: '2026-10-21T23:32:06Z',
    prerelease,
    draft,
    assets
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function serviceFor(releases, options = {}) {
  return createUpdateService({
    fetchImpl: options.fetchImpl || (async () => jsonResponse(releases)),
    cacheTtlMs: options.cacheTtlMs,
    timeoutMs: 1000,
    now: options.now
  });
}

test('a prerelease install follows the prerelease channel and returns the APK with its digest', async () => {
  const service = serviceFor([
    release('1.3.1'),
    release('1.3.0'),
    release('1.0.0', { prerelease: false })
  ]);
  const info = await service.getInfo({ platform: 'android', currentVersion: '1.3.0' });
  assert.equal(info.available, true);
  assert.equal(info.installable, true);
  assert.equal(info.currentChannel, 'test');
  assert.equal(info.latestVersion, '1.3.1');
  assert.equal(info.latestChannel, 'test');
  assert.equal(info.assetName, 'Jiran-Android-1.3.1.apk');
  assert.equal(info.sha256, SHA);
  assert.equal(info.assetSize, 11_629_795);
  assert.equal(info.releaseUrl, `https://github.com/${REPO}/releases/tag/v1.3.1`);
});

test('a formal install never receives a prerelease', async () => {
  const service = serviceFor([
    release('1.3.1'),
    release('1.0.0', { prerelease: false })
  ]);
  const info = await service.getInfo({ platform: 'android', currentVersion: '1.0.0' });
  assert.equal(info.available, false);
  assert.equal(info.installable, false);
  assert.equal(info.currentChannel, 'stable');
  assert.equal(info.latestVersion, null);
  assert.equal(info.message, 'up_to_date');
});

test('an unpublished plain version is treated as stable; a -rev build as test', async () => {
  const releases = [release('1.3.1')];
  const plain = await serviceFor(releases).getInfo({ platform: 'android', currentVersion: '1.9.9' });
  assert.equal(plain.currentChannel, 'stable');
  assert.equal(plain.available, false);

  const revision = await serviceFor(releases).getInfo({ platform: 'android', currentVersion: '1.9.9-rev.2' });
  assert.equal(revision.currentChannel, 'test');
  assert.equal(revision.available, false);
});

test('a newer release without an Android APK is reported, not silently skipped', async () => {
  const service = serviceFor([
    release('1.3.1', { assets: [asset('Jiran-1.3.1.dmg')] }),
    release('1.3.0')
  ]);
  const info = await service.getInfo({ platform: 'android', currentVersion: '1.3.0' });
  assert.equal(info.available, true);
  assert.equal(info.installable, false);
  assert.equal(info.latestVersion, '1.3.1');
  assert.equal(info.assetUrl, null);
  assert.equal(info.message, 'asset_missing');
});

test('an APK without a digest or checksum sidecar is not installable', async () => {
  const service = serviceFor([
    release('1.3.1', { assets: [asset('Jiran-Android-1.3.1.apk', { digest: null })] }),
    release('1.3.0')
  ]);
  const info = await service.getInfo({ platform: 'android', currentVersion: '1.3.0' });
  assert.equal(info.available, true);
  assert.equal(info.installable, false);
  assert.equal(info.sha256, null);
  assert.equal(info.message, 'checksum_missing');
});

test('a checksum sidecar is used when the asset has no digest', async () => {
  const apk = asset('Jiran-Android-1.3.1.apk', { digest: null });
  const checksum = asset('Jiran-Android-1.3.1.apk.sha256', {
    digest: null,
    url: `https://github.com/${REPO}/releases/download/v1.3.1/Jiran-Android-1.3.1.apk.sha256`
  });
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.sha256')) return new Response(`${OTHER_SHA}  Jiran-Android-1.3.1.apk\n`);
    return jsonResponse([release('1.3.1', { assets: [apk, checksum] }), release('1.3.0')]);
  };
  const info = await createUpdateService({ fetchImpl, cacheTtlMs: 1000 }).getInfo({
    platform: 'android',
    currentVersion: '1.3.0'
  });
  assert.equal(info.installable, true);
  assert.equal(info.sha256, OTHER_SHA);
});

test('the release document is cached and concurrent checks share one request', async () => {
  let calls = 0;
  let resolveFetch;
  const fetchImpl = () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };
  const service = createUpdateService({ fetchImpl, cacheTtlMs: 60_000, timeoutMs: 1000 });
  const first = service.getInfo({ platform: 'android', currentVersion: '1.3.0' });
  const second = service.getInfo({ platform: 'android', currentVersion: '1.3.0' });
  assert.equal(calls, 1);
  resolveFetch(jsonResponse([release('1.3.1'), release('1.3.0')]));
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.latestVersion, '1.3.1');
  assert.equal(right.latestVersion, '1.3.1');
  await service.getInfo({ platform: 'android', currentVersion: '1.3.0' });
  assert.equal(calls, 1, 'the second check must reuse the cached release document');
});

test('an upstream failure surfaces as a 502 update error', async () => {
  const service = createUpdateService({
    fetchImpl: async () => new Response('rate limited', { status: 403 }),
    timeoutMs: 1000
  });
  await assert.rejects(
    service.getInfo({ platform: 'android', currentVersion: '1.3.1' }),
    (error) => error.name === 'UpdateCheckError' && error.statusCode === 502
  );
});

test('invalid versions and platforms are request errors, not upstream failures', async () => {
  const service = serviceFor([release('1.3.1')]);
  await assert.rejects(
    service.getInfo({ platform: 'android', currentVersion: 'latest' }),
    (error) => error.statusCode === 400 && error.code === 'invalid_current_version'
  );
  await assert.rejects(
    service.getInfo({ platform: 'ios', currentVersion: '1.3.1' }),
    (error) => error.statusCode === 400 && error.code === 'unsupported_platform'
  );
});

test('release URLs and assets are restricted to the Jiran GitHub repository', () => {
  assert.equal(isGithubReleaseUrl(`https://github.com/${REPO}/releases/tag/v1.3.1`), true);
  assert.equal(isGithubReleaseUrl('https://github.com/IGNGserver/jiran/releases/tag/v1.3.1'), true);
  assert.equal(isGithubReleaseUrl('https://evil.example/IGNGserver/jiran-monitor/releases/tag/v1.3.1'), false);
  assert.equal(isGithubDownloadUrl(`https://github.com/${REPO}/releases/download/v1.3.1/Jiran-Android-1.3.1.apk`), true);
  assert.equal(isGithubDownloadUrl('http://github.com/IGNGserver/jiran/releases/download/v1.3.1/a.apk'), false);
});

test('draft releases and release tags outside the project version scheme are dropped', () => {
  assert.equal(normalizeRelease(release('1.3.1', { draft: true })), null);
  const nightly = release('1.4.0', { assets: [] });
  nightly.tag_name = 'v1.4.0-beta.1';
  assert.equal(normalizeRelease(nightly), null);
  const untrusted = release('1.4.0', { htmlUrl: 'https://evil.example/releases/tag/v1.4.0' });
  assert.equal(normalizeRelease(untrusted), null);
});

test('the Hub route serves update metadata and advertises the capability', async () => {
  const repository = new MemoryRepository();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: '',
    repository,
    logger: { error() {}, warn() {} },
    updateService: {
      async getInfo(input) {
        return { currentVersion: input.currentVersion, platform: input.platform, available: false };
      }
    }
  });
  await hub.start();
  try {
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    const updates = await fetch(`${base}/api/updates?platform=android&currentVersion=1.3.1`);
    assert.equal(updates.status, 200);
    assert.deepEqual(await updates.json(), {
      currentVersion: '1.3.1',
      platform: 'android',
      available: false
    });

    const capabilities = await fetch(`${base}/api/capabilities`);
    const body = await capabilities.json();
    assert.equal(body.capabilities.updateCheck, true);
  } finally {
    await hub.stop();
  }
});

test('legacy Hub clients respect Retry-After and exponential failure cooldown', async () => {
  let time = 1_000_000;
  let calls = 0;
  const service = serviceFor([], {
    now: () => time,
    fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); }
  });
  await assert.rejects(service.getInfo({ platform: 'android', currentVersion: '1.0.0' }), /github_release_api_429/);
  time += 120_000;
  await assert.rejects(service.getInfo({ platform: 'android', currentVersion: '1.0.0' }), /github_release_api_429/);
  assert.equal(calls, 1);
  time += 3_600_000;
  await assert.rejects(service.getInfo({ platform: 'android', currentVersion: '1.0.0' }), /github_release_api_429/);
  assert.equal(calls, 2);
});
test('legacy checksum requests also respect the upstream Retry-After cooldown', async () => {
  let time = 1_000_000;
  let checksumCalls = 0;
  const data = release('1.3.1', { assets: [asset('Jiran-Android-1.3.1.apk', { digest: null }), asset('Jiran-Android-1.3.1.apk.sha256')] });
  const service = serviceFor([data], {
    now: () => time,
    fetchImpl: async (url) => {
      if (url.endsWith('.sha256')) { checksumCalls++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); }
      return jsonResponse([data]);
    }
  });
  assert.equal((await service.getInfo({ platform: 'android', currentVersion: '1.0.0-rev.1' })).installable, false);
  time += 120_000;
  await service.getInfo({ platform: 'android', currentVersion: '1.0.0-rev.1' });
  assert.equal(checksumCalls, 1);
});