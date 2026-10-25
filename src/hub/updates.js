'use strict';

const { retryAfterMs } = require('../shared/repositoryUpdateFeed');

const {
  compareProjectVersions,
  parseProjectTag,
  parseProjectVersion
} = require('../shared/versioning');

// The repository was renamed from IGNGserver/jiran to IGNGserver/jiran-monitor.
// GitHub's API follows the old slug, but every URL in the response uses the
// canonical name, so the canonical slug is what update metadata is built from.
const GITHUB_REPOSITORY = 'IGNGserver/jiran-monitor';
const DEFAULT_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases?per_page=100`;
const DEFAULT_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const FAILURE_COOLDOWN_MS = 60 * 1000;
const MAX_RELEASE_BYTES = 4 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 16 * 1024;
const MAX_CHECKSUM_CACHE_ENTRIES = 128;
const ANDROID_ASSET_PREFIX = 'Jiran-Android-';
const ANDROID_ASSET_SUFFIX = '.apk';
const SHA256_DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/i;
const SHA256_TEXT_PATTERN = /\b([a-f0-9]{64})\b/i;

class UpdateCheckError extends Error {
  constructor(message, { code = 'update_check_failed', statusCode = 502 } = {}) {
    super(message);
    this.name = 'UpdateCheckError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isGithubReleaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return false;
    return url.pathname.startsWith(`/${GITHUB_REPOSITORY}/releases/`)
      || url.pathname.startsWith('/IGNGserver/jiran/releases/');
  } catch (_) {
    return false;
  }
}

function isGithubDownloadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return false;
    return url.pathname.startsWith(`/${GITHUB_REPOSITORY}/releases/download/`)
      || url.pathname.startsWith('/IGNGserver/jiran/releases/download/');
  } catch (_) {
    return false;
  }
}

function normalizeAsset(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const downloadUrl = typeof payload.browser_download_url === 'string'
    ? payload.browser_download_url.trim()
    : '';
  if (!name || !isGithubDownloadUrl(downloadUrl)) return null;
  const digest = typeof payload.digest === 'string' ? SHA256_DIGEST_PATTERN.exec(payload.digest.trim()) : null;
  const size = Number(payload.size);
  return {
    name,
    downloadUrl,
    size: Number.isFinite(size) && size > 0 ? size : null,
    sha256: digest ? digest[1].toLowerCase() : null
  };
}

function normalizeRelease(payload) {
  if (!payload || typeof payload !== 'object' || payload.draft === true) return null;
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
  const version = parseProjectTag(tag);
  const htmlUrl = typeof payload.html_url === 'string' ? payload.html_url : '';
  if (!version || !isGithubReleaseUrl(htmlUrl)) return null;
  return {
    version: version.version,
    tag,
    prerelease: payload.prerelease === true,
    htmlUrl,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : '',
    assets: Array.isArray(payload.assets)
      ? payload.assets.map(normalizeAsset).filter(Boolean)
      : []
  };
}

function androidAssetName(version) {
  return `${ANDROID_ASSET_PREFIX}${version}${ANDROID_ASSET_SUFFIX}`;
}

function selectInstalledRelease(releases, currentVersion) {
  const matches = releases.filter((release) => release.version === currentVersion);
  return matches.find((release) => !release.prerelease) || matches[0] || null;
}

function currentChannelOf(installed, parsedCurrent) {
  if (installed) return installed.prerelease ? 'test' : 'stable';
  // A local/dev build that has not been published yet is treated as a test
  // build; a published formal version that fell out of the release window is
  // treated as stable so it is never silently offered a prerelease.
  return parsedCurrent.revision !== null ? 'test' : 'stable';
}

async function readBoundedText(response, maxBytes, signal) {
  if (Number(response.headers?.get?.('content-length')) > maxBytes) {
    void response.body?.cancel?.().catch(() => {});
    throw new UpdateCheckError('update_response_too_large');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new UpdateCheckError('update_response_too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new UpdateCheckError('update_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function fetchDocument(fetchImpl, url, { timeoutMs, headers, maxBytes, json = false } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new UpdateCheckError('update_request_timeout');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const operation = (async () => {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    if (controller.signal.aborted) void response.body?.cancel?.().catch(() => {});
    controller.signal.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel?.().catch(() => {});
      const error = new UpdateCheckError(`github_release_api_${response.status}`);
      error.retryDelayMs = retryAfterMs(response.headers, Date.now());
      throw error;
    }
    const text = await readBoundedText(response, maxBytes, controller.signal);
    return json ? JSON.parse(text) : text;
  })();
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function createUpdateService({
  fetchImpl = globalThis.fetch,
  token = '',
  releasesUrl = DEFAULT_RELEASES_URL,
  cacheTtlMs = DEFAULT_CACHE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createUpdateService requires a fetch implementation');
  }
  const cacheTtl = Math.max(0, Number(cacheTtlMs) || 0);
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  let cached = null;
  let inFlight = null;
  let failure = null;
  const checksums = new Map();

  function requestHeaders() {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'jiran-hub-update-check',
      'x-github-api-version': '2022-11-28'
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  async function fetchReleases() {
    const nowMs = now();
    if (cached && cached.expiresAt > nowMs) return cached.releases;
    if (inFlight) return inFlight;
    if (failure && failure.retryAt > nowMs) throw failure.error;
    inFlight = (async () => {
      try {
        const payload = await fetchDocument(fetchImpl, releasesUrl, {
          timeoutMs: timeout,
          headers: requestHeaders(),
          maxBytes: MAX_RELEASE_BYTES,
          json: true
        });
        if (!Array.isArray(payload)) {
          throw new UpdateCheckError('github_release_api_invalid_response');
        }
        const releases = payload
          .map(normalizeRelease)
          .filter(Boolean)
          .sort((left, right) => compareProjectVersions(right.version, left.version) ?? 0);
        cached = { releases, expiresAt: now() + cacheTtl };
        failure = null;
        return releases;
      } catch (error) {
        const count = Math.min(10, (failure?.count || 0) + 1);
        const delay = Math.max(error.retryDelayMs || 0, Math.min(6 * 60 * 60 * 1000, FAILURE_COOLDOWN_MS * 2 ** (count - 1)));
        failure = { error, count, retryAt: now() + delay };
        throw error;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function resolveSha256(release, asset) {
    if (asset.sha256) return asset.sha256;
    const checksum = release.assets.find((item) => (
      item.name === `${asset.name}.sha256` || item.name === `${asset.name}.sha256.txt`
    ));
    if (!checksum) return null;
    const key = `${checksum.downloadUrl}:${checksum.sha256 || ''}`;
    const previous = checksums.get(key);
    if (previous) {
      if (previous.promise) return previous.promise;
      if (previous.expiresAt > now()) {
        checksums.delete(key);
        checksums.set(key, previous);
        return previous.sha256;
      }
      checksums.delete(key);
    }
    // Do not evict in-flight entries: that would permit duplicate downloads.
    if (checksums.size >= MAX_CHECKSUM_CACHE_ENTRIES) {
      const victim = [...checksums].find(([, entry]) => !entry.promise);
      if (!victim) return null;
      checksums.delete(victim[0]);
    }
    const entry = { promise: null, sha256: null, expiresAt: 0, failureCooldownMs: FAILURE_COOLDOWN_MS };
    checksums.set(key, entry);
    entry.promise = (async () => {
      try {
        const text = await fetchDocument(fetchImpl, checksum.downloadUrl, {
          timeoutMs: timeout,
          headers: { accept: 'text/plain', 'user-agent': 'jiran-hub-update-check' },
          maxBytes: MAX_CHECKSUM_BYTES
        });
        const match = SHA256_TEXT_PATTERN.exec(text);
        entry.sha256 = match ? match[1].toLowerCase() : null;
      } catch (error) {
        entry.sha256 = null;
        entry.failureCooldownMs = Math.max(FAILURE_COOLDOWN_MS, error.retryDelayMs || 0);
      } finally {
        entry.expiresAt = now() + (entry.sha256 ? cacheTtl : entry.failureCooldownMs);
        entry.promise = null;
      }
      return entry.sha256;
    })();
    return entry.promise;
  }

  async function getInfo({ platform = 'android', currentVersion } = {}) {
    if (platform !== 'android') {
      throw new UpdateCheckError('unsupported_platform', {
        code: 'unsupported_platform',
        statusCode: 400
      });
    }
    const normalizedCurrent = String(currentVersion || '').trim().replace(/^v/i, '');
    const parsedCurrent = parseProjectVersion(normalizedCurrent);
    if (!parsedCurrent) {
      throw new UpdateCheckError('invalid_current_version', {
        code: 'invalid_current_version',
        statusCode: 400
      });
    }

    const releases = await fetchReleases();
    const installed = selectInstalledRelease(releases, parsedCurrent.version);
    const currentChannel = currentChannelOf(installed, parsedCurrent);
    const candidate = releases.find((release) => {
      if (compareProjectVersions(release.version, parsedCurrent.version) !== 1) return false;
      return currentChannel !== 'stable' || release.prerelease !== true;
    }) || null;

    const base = {
      platform,
      currentVersion: parsedCurrent.version,
      currentChannel,
      available: false,
      installable: false,
      latestVersion: null,
      latestChannel: null,
      releaseTag: null,
      releaseUrl: null,
      notesUrl: null,
      publishedAt: null,
      assetName: null,
      assetUrl: null,
      assetSize: null,
      sha256: null,
      installMode: 'apk',
      message: 'up_to_date'
    };
    if (!candidate) return base;

    const asset = candidate.assets.find((item) => item.name === androidAssetName(candidate.version)) || null;
    const sha256 = asset ? await resolveSha256(candidate, asset) : null;
    const installable = Boolean(asset && sha256);
    return {
      ...base,
      available: true,
      installable,
      latestVersion: candidate.version,
      latestChannel: candidate.prerelease ? 'test' : 'stable',
      releaseTag: candidate.tag,
      releaseUrl: candidate.htmlUrl,
      notesUrl: candidate.htmlUrl,
      publishedAt: candidate.publishedAt || null,
      assetName: asset?.name ?? null,
      assetUrl: asset?.downloadUrl ?? null,
      assetSize: asset?.size ?? null,
      sha256,
      message: installable ? null : (asset ? 'checksum_missing' : 'asset_missing')
    };
  }

  return Object.freeze({ getInfo, clearCache: () => { cached = null; failure = null; checksums.clear(); } });
}

module.exports = {
  ANDROID_ASSET_PREFIX,
  ANDROID_ASSET_SUFFIX,
  DEFAULT_CACHE_MS,
  DEFAULT_RELEASES_URL,
  GITHUB_REPOSITORY,
  UpdateCheckError,
  androidAssetName,
  createUpdateService,
  isGithubDownloadUrl,
  isGithubReleaseUrl,
  normalizeAsset,
  normalizeRelease
};
