'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { measureLoading } = require('../../scripts/measure-loading');

test('loading diagnostics are bounded, read-only and never return credentials or payloads', async () => {
  const calls = [];
  const result = await measureLoading({ url: 'https://hub.example', samples: 1, secret: 'private-value', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('private-payload');
  } });
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ options }) => options.method === undefined));
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(result.results[0].decodedBytes, 15);
});

test('loading diagnostics reject credential URLs and authenticated public HTTP', async () => {
  await assert.rejects(measureLoading({ url: 'https://user:password@hub.example' }));
  await assert.rejects(measureLoading({ url: 'http://hub.example', secret: 'private-value' }));
});
