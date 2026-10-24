'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { resolveStaticAsset, tryServeStatic } = require('../../src/hub/static');
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

async function staticFixture(t) {
  const scratch = process.env.BUILD_SCRATCH_ROOT || path.join(os.homedir(), '.build');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'jiran-static-test-'));
  const server = http.createServer((req, res) => {
    void tryServeStatic(req, res, { webRoot: root }).then((served) => {
      if (!served) { res.writeHead(404); res.end(); }
    }).catch((error) => res.destroy(error));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  async function write(name, body) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    return target;
  }
  return { root, request, write };
}

test('precompressed streams preserve representation bytes, validators, HEAD and cache policy', async (t) => {
  const { request, write } = await staticFixture(t);
  const body = Buffer.from('/* bundled browser resource */\n'.repeat(100));
  // Deliberately different compression settings from the dynamic fallback:
  // exact wire bytes and Content-Length prove the sibling was streamed as-is.
  const gzip = zlib.gzipSync(body, { level: 0 });
  const br = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 0 } });
  for (const name of ['assets/app-ABCDEFGH.js', 'index.html', 'sw.js', 'js/boot.js', 'manifest.webmanifest']) {
    await write(name, body);
    await write(`${name}.gz`, gzip);
    await write(`${name}.br`, br);
    const identity = await request(`/${name}`, { headers: { 'accept-encoding': 'identity' } });
    assert.deepEqual(identity.body, body);
    assert.equal(identity.headers['content-length'], String(body.length));
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.equal(identity.headers['cache-control'], name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    for (const [encoding, encoded] of [['gzip', gzip], ['br', br]]) {
      const headers = { 'accept-encoding': encoding };
      const response = await request(`/${name}`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, encoded);
      assert.equal(response.headers['content-encoding'], encoding);
      assert.equal(response.headers['content-length'], String(encoded.length));
      assert.equal(response.headers['etag'], identity.headers['etag']);
      assert.equal(response.headers['cache-control'], identity.headers['cache-control']);
      assert.equal(response.headers['content-type'], identity.headers['content-type']);
      assert.equal(response.headers.vary, 'accept-encoding');
      assert.match(response.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      if (name === 'sw.js') assert.equal(response.headers['service-worker-allowed'], '/');
      const head = await request(`/${name}`, { method: 'HEAD', headers });
      assert.equal(head.body.length, 0);
      for (const key of ['content-length', 'content-encoding', 'content-type', 'cache-control', 'etag', 'vary']) {
        assert.equal(head.headers[key], response.headers[key], key);
      }
      const unchanged = await request(`/${name}`, { headers: { ...headers, 'if-none-match': `"other", ${identity.headers.etag}` } });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.body.length, 0);
      assert.equal(unchanged.headers['content-length'], undefined);
      assert.equal(unchanged.headers['content-encoding'], encoding);
      assert.ok(unchanged.headers['content-security-policy']);
      assert.equal(unchanged.headers.vary, 'accept-encoding');
    }
    const negotiated = await request(`/${name}`, { headers: { 'accept-encoding': 'gzip, br' } });
    assert.deepEqual(negotiated.body, br);
    const excluded = await request(`/${name}`, { headers: { 'accept-encoding': 'gzip;q=0, br;q=0' } });
    assert.deepEqual(excluded.body, body);
  }
});

test('missing, stale and symlinked siblings fall back to dynamically compressed current source', async (t) => {
  const { root, write, request } = await staticFixture(t);
  const current = Buffer.from('/* current unbuilt source */\n'.repeat(100));
  await write('source.js', current);
  const stale = await write('source.js.gz', zlib.gzipSync('previous deployment'));
  await fs.utimes(stale, new Date('2020-01-01'), new Date('2020-01-01'));
  const external = await write('private.txt', zlib.brotliCompressSync(Buffer.from('not the resource')));
  await fs.symlink(external, path.join(root, 'source.js.br'));
  await write('fallback.js', current);
  for (const name of ['source.js', 'fallback.js']) {
    for (const encoding of ['gzip', 'br']) {
      const headers = { 'accept-encoding': encoding };
      const response = await request(`/${name}`, { headers });
      assert.equal(response.headers['content-encoding'], encoding);
      assert.equal(response.headers['content-length'], undefined);
      assert.deepEqual(encoding === 'gzip' ? zlib.gunzipSync(response.body) : zlib.brotliDecompressSync(response.body), current);
      const head = await request(`/${name}`, { method: 'HEAD', headers });
      assert.equal(head.body.length, 0);
      assert.equal(head.headers['content-encoding'], encoding);
      assert.equal(head.headers['content-length'], undefined);
    }
  }
});

test('compressed siblings are private, require an original and cannot traverse the web root', async (t) => {
  const { root, write, request } = await staticFixture(t);
  await write('index.html', 'shell');
  await write('script.js', 'small script');
  await write('script.js.br', 'not a public module');
  await write('orphan.js.gz', 'no original');
  for (const url of ['/script.js.br', '/script.js%2ebr', '/script.js.BR', '/orphan.js.gz', '/orphan.js', '/script.js.gz']) {
    assert.equal((await request(url)).status, 404, url);
  }
  for (const url of ['/../script.js.br', '/a/../../script.js', '/%2e%2e/private.txt', '/%5c..%5cprivate.txt', '/%00.js']) {
    assert.equal(await resolveStaticAsset(root, url), null, url);
  }
  const small = await request('/script.js', { headers: { 'accept-encoding': 'br' } });
  assert.equal(small.headers['content-encoding'], undefined);
  assert.equal(small.body.toString(), 'small script');
});
