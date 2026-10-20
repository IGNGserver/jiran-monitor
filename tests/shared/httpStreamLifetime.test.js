'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout } = require('../../src/shared/http');

test('caller abort remains linked to an unbuffered body after fetch headers return', async () => {
  const parent = new AbortController();
  let signal;
  await fetchWithTimeout(async (_url, options) => {
    signal = options.signal;
    return new Response('stream headers');
  }, 'https://hub.example/api/stats/stream', { signal: parent.signal }, 1000);
  assert.equal(signal.aborted, false);
  parent.abort();
  assert.equal(signal.aborted, true);
});
