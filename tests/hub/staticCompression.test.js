'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHub } = require('../../src/hub/server');
const { MemoryRepository } = require('./memory-repository');

test('public static files negotiate compression, revalidate and preserve security headers', async () => {
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', repository: new MemoryRepository(), logger: { warn() {}, error() {} } });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const response = await fetch(`${base}/ui/vendor/fluent.js`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(response.headers.get('vary'), 'accept-encoding');
    assert.ok(response.headers.get('content-security-policy'));
    assert.match(response.headers.get('server-timing'), /app;dur=/);
    const etag = response.headers.get('etag');
    assert.ok((await response.text()).length > 200_000);
    const unchanged = await fetch(`${base}/ui/vendor/fluent.js`, { headers: { 'if-none-match': etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), '');
    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    await sw.text();
  } finally { await hub.stop(); }
});
