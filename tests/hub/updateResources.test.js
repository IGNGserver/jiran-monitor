'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createUpdateService } = require('../../src/hub/updates');

const BASE = 'https://github.com/IGNGserver/jiran-monitor/releases';
const SHA = 'c'.repeat(64);
const INPUT = { currentVersion: '1.0.0' };

function releases() {
  return [{
    tag_name: 'v2.0.0',
    prerelease: false,
    html_url: `${BASE}/tag/v2.0.0`,
    assets: ['Jiran-Android-2.0.0.apk', 'Jiran-Android-2.0.0.apk.sha256'].map((name) => ({
      name, browser_download_url: `${BASE}/download/v2.0.0/${name}`, size: 100
    }))
  }];
}

function metadata() { return new Response(JSON.stringify(releases())); }

test('update fetch deadline covers a hanging release body and failures have a cooldown', async () => {
  let calls = 0;
  let canceled = false;
  let clock = 1000;
  const service = createUpdateService({
    timeoutMs: 30,
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return new Response(new ReadableStream({ cancel() { canceled = true; } }));
    }
  });
  await assert.rejects(service.getInfo(INPUT), /update_request_timeout/);
  assert.equal(canceled, true);
  await assert.rejects(service.getInfo(INPUT), /update_request_timeout/);
  assert.equal(calls, 1);
  clock += 60_001;
  await assert.rejects(service.getInfo(INPUT), /update_request_timeout/);
  assert.equal(calls, 2);
});

test('checksum requests are singleflight and cached independently of release metadata', async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const service = createUpdateService({
    fetchImpl: async (url) => {
      if (!url.endsWith('.sha256')) return metadata();
      calls += 1;
      await blocked;
      return new Response(`${SHA} Jiran-Android-2.0.0.apk`);
    }
  });
  const first = service.getInfo(INPUT);
  const second = service.getInfo(INPUT);
  await nextTurn();
  assert.equal(calls, 1);
  release();
  const answers = await Promise.all([first, second]);
  assert.ok(answers.every((answer) => answer.sha256 === SHA));
  assert.equal((await service.getInfo(INPUT)).sha256, SHA);
  assert.equal(calls, 1);
});

test('checksum body deadlines retain checksum_missing shape and cache failures before retry', async () => {
  let clock = 1000;
  let calls = 0;
  let hanging = true;
  let canceled = false;
  const service = createUpdateService({
    timeoutMs: 30,
    now: () => clock,
    fetchImpl: async (url) => {
      if (!url.endsWith('.sha256')) return metadata();
      calls += 1;
      if (hanging) return new Response(new ReadableStream({ cancel() { canceled = true; } }));
      return new Response(SHA);
    }
  });
  const missing = await service.getInfo(INPUT);
  assert.equal(missing.message, 'checksum_missing');
  assert.equal(missing.installable, false);
  assert.equal(canceled, true);
  hanging = false;
  assert.equal((await service.getInfo(INPUT)).message, 'checksum_missing');
  assert.equal(calls, 1);
  clock += 60_001;
  assert.equal((await service.getInfo(INPUT)).sha256, SHA);
  assert.equal(calls, 2);
});

test('release and checksum streaming reads enforce size budgets without trusting Content-Length', async () => {
  let canceled = false;
  const oversized = (bytes) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(bytes)); },
    cancel() { canceled = true; }
  }));
  const service = createUpdateService({ fetchImpl: async () => oversized(4 * 1024 * 1024 + 1) });
  await assert.rejects(service.getInfo(INPUT), /update_response_too_large/);
  assert.equal(canceled, true);
  canceled = false;
  const checksum = createUpdateService({
    fetchImpl: async (url) => url.endsWith('.sha256') ? oversized(16 * 1024 + 1) : metadata()
  });
  assert.equal((await checksum.getInfo(INPUT)).message, 'checksum_missing');
  assert.equal(canceled, true);
});

test('release HTTP failures cool down and clearCache deliberately permits a new check', async () => {
  let calls = 0;
  const service = createUpdateService({
    fetchImpl: async () => { calls += 1; return new Response('', { status: 429 }); }
  });
  await assert.rejects(service.getInfo(INPUT), /github_release_api_429/);
  await assert.rejects(service.getInfo(INPUT), /github_release_api_429/);
  assert.equal(calls, 1);
  service.clearCache();
  await assert.rejects(service.getInfo(INPUT), /github_release_api_429/);
  assert.equal(calls, 2);
});
