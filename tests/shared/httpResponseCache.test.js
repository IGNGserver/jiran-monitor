'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createJsonResponseCache, sendBuffer } = require('../../src/shared/http');

const MiB = 1024 * 1024;

function response(encoding = 'identity') {
  return {
    req: { headers: { 'accept-encoding': encoding } },
    destroyed: false,
    writableEnded: false,
    writes: 0,
    ends: 0,
    body: null,
    headers: null,
    writeHead(status, headers) { this.writes += 1; this.status = status; this.headers = headers; },
    end(body) { this.ends += 1; this.body = body; this.writableEnded = true; }
  };
}

function decoded(res) {
  if (res.headers['content-encoding'] === 'gzip') return zlib.gunzipSync(res.body);
  if (res.headers['content-encoding'] === 'br') return zlib.brotliDecompressSync(res.body);
  return res.body;
}

function holdCompression(t) {
  const pending = [];
  const stub = (encoding) => (buffer, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    pending.push({ encoding, buffer, done, settled: false });
  };
  t.mock.method(zlib, 'gzip', stub('gzip'));
  t.mock.method(zlib, 'brotliCompress', stub('br'));
  const finish = (item, error = null) => {
    if (item.settled) return;
    item.settled = true;
    const encoded = error ? null : (item.encoding === 'gzip' ? zlib.gzipSync(item.buffer) : zlib.brotliCompressSync(item.buffer));
    item.done(error, encoded);
  };
  // Always release module-global permits, even if an assertion fails.
  t.after(async () => {
    for (const item of pending) finish(item);
    await nextTurn();
  });
  return { pending, finish };
}

function child(script) {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('cached identity, gzip and brotli preserve exactly the same compact UTF-8 JSON bytes', async () => {
  const cache = createJsonResponseCache();
  const payload = { title: '计然 / Jiran 🚀', devices: Array.from({ length: 80 }, (_, id) => ({ id, note: '中枢'.repeat(20) })) };
  const expected = Buffer.from(JSON.stringify(payload));
  for (const encoding of ['identity', 'gzip', 'br', 'identity', 'gzip', 'br']) {
    const res = response(encoding);
    await cache.send(res, 201, payload, { etag: '"fleet-revision"' });
    assert.deepEqual(decoded(res), expected);
    assert.equal(res.status, 201);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['content-encoding'], encoding === 'identity' ? undefined : encoding);
    assert.equal(Number(res.headers['content-length']), res.body.length);
    assert.equal(res.headers.vary, 'accept-encoding');
    assert.equal(res.headers.etag, '"fleet-revision"');
  }
  assert.equal(cache.metrics().serializations, 1);
  assert.equal(cache.metrics().compressions, 2);
});

test('concurrent cached requests singleflight JSON serialization and each encoding compression', async (t) => {
  const { pending, finish } = holdCompression(t);
  const cache = createJsonResponseCache();
  let serializations = 0;
  const payload = { toJSON() { serializations += 1; return { text: 'x'.repeat(4096) }; } };
  const responses = Array.from({ length: 24 }, (_, index) => response(index % 2 ? 'gzip' : 'br'));
  const sends = responses.map((res) => cache.send(res, 200, payload));
  assert.equal(serializations, 1);
  assert.equal(pending.length, 2);
  assert.equal(cache.metrics().compressionJobs, 2);
  assert.equal(cache.metrics().compressions, 2);
  for (const item of pending) finish(item);
  await Promise.all(sends);
  assert.ok(responses.every((res) => decoded(res).equals(Buffer.from('{"text":"' + 'x'.repeat(4096) + '"}'))));
  assert.equal(cache.metrics().compressionJobs, 0);
  assert.equal(cache.metrics().compressionBytes, 0);
});

test('identity LRU respects entry count, refreshes recency and serializes evicted objects again', async () => {
  const cache = createJsonResponseCache({ maxEntries: 2, maxBytes: 4096 });
  const first = { id: 'first' };
  const second = { id: 'second' };
  const third = { id: 'third' };
  const send = (payload) => cache.send(response(), 200, payload);
  await send(first);
  await send(second);
  await send(first);
  await send(third);
  assert.equal(cache.metrics().entries, 2);
  assert.equal(cache.metrics().serializations, 3);
  await send(first);
  assert.equal(cache.metrics().serializations, 3, 'a hit moves the first object past the eviction boundary');
  await send(second);
  assert.equal(cache.metrics().serializations, 4);
  assert.equal(cache.metrics().entries, 2);
  cache.clear();
  assert.equal(cache.metrics().bytes, 0);
  assert.equal(cache.metrics().entries, 0);
});

test('LRU byte accounting includes identity plus both compressed representations', async () => {
  const cache = createJsonResponseCache({ maxEntries: 8, maxBytes: 5000 });
  const payload = { text: 'x'.repeat(4000) };
  const raw = response();
  const gzip = response('gzip');
  const br = response('br');
  await cache.send(raw, 200, payload);
  await cache.send(gzip, 200, payload);
  await cache.send(br, 200, payload);
  assert.equal(cache.metrics().bytes, raw.body.length + gzip.body.length + br.body.length);
  for (let index = 0; index < 10; index += 1) {
    await cache.send(response('gzip'), 200, { index, text: 'y'.repeat(3000) });
    assert.ok(cache.metrics().bytes <= 5000);
    assert.ok(cache.metrics().entries <= 8);
  }
  const exact = createJsonResponseCache({ maxBytes: raw.body.length, maxEntries: 1 });
  await exact.send(response('gzip'), 200, payload);
  await nextTurn();
  assert.equal(exact.metrics().bytes, raw.body.length, 'a representation that does not fit must not inflate retained bytes');
  await exact.send(response('gzip'), 200, payload);
  assert.equal(exact.metrics().compressions, 2, 'the unretained compressed representation must be recomputed');
});

test('oversized payloads and a disabled cache never retain JSON representations', async () => {
  for (const options of [{ maxBytes: 64, maxEntries: 2 }, { maxBytes: MiB, maxEntries: 0 }]) {
    const cache = createJsonResponseCache(options);
    const payload = { text: 'z'.repeat(4096) };
    for (let index = 0; index < 2; index += 1) {
      const res = response('gzip');
      await cache.send(res, 200, payload);
      assert.deepEqual(JSON.parse(decoded(res)), payload);
    }
    assert.equal(cache.metrics().serializations, 2);
    assert.equal(cache.metrics().entries, 0);
    assert.equal(cache.metrics().bytes, 0);
  }
});

test('evicted entries and large buffers are collectable even while their source object is alive', () => {
  child(`
    const assert = require('node:assert/strict');
    const { setImmediate: turn } = require('node:timers/promises');
    const OriginalWeakRef = WeakRef;
    const seen = [];
    globalThis.WeakRef = class extends OriginalWeakRef {
      constructor(value) { super(value); seen.push(this); }
    };
    const { createJsonResponseCache } = require(${JSON.stringify(require.resolve('../../src/shared/http'))});
    const response = () => ({ req: { headers: {} }, writeHead() {}, end() {} });
    (async () => {
      const cache = createJsonResponseCache({ maxBytes: 6 * 1024 * 1024, maxEntries: 1 });
      globalThis.retainedCache = cache;
      globalThis.retainedPayload = { text: 'large'.repeat(800000) };
      await cache.send(response(), 200, globalThis.retainedPayload);
      const buffer = new OriginalWeakRef(seen[0].deref().buffer);
      await cache.send(response(), 200, { replacement: true });
      assert.equal(cache.metrics().entries, 1);
      for (let index = 0; index < 30; index += 1) {
        await turn();
        global.gc();
        if (!seen[0].deref() && !buffer.deref()) break;
      }
      assert.equal(seen[0].deref(), undefined, 'WeakMap must not keep the evicted entry alive');
      assert.equal(buffer.deref(), undefined, 'the evicted multi-megabyte UTF-8 buffer must be reclaimed');
      assert.equal(globalThis.retainedPayload.text.length, 4000000);
      assert.equal(globalThis.retainedCache.metrics().entries, 1);
      globalThis.WeakRef = OriginalWeakRef;
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `);
});

test('asynchronous gzip and brotli failures fall back to identity and release all compression permits', async (t) => {
  const { pending, finish } = holdCompression(t);
  const cache = createJsonResponseCache();
  const payload = { text: 'x'.repeat(4096) };
  for (const encoding of ['gzip', 'br']) {
    const res = response(encoding);
    const send = cache.send(res, 200, payload);
    finish(pending.at(-1), new Error('compression failed'));
    await send;
    assert.equal(res.headers['content-encoding'], undefined);
    assert.deepEqual(res.body, Buffer.from(JSON.stringify(payload)));
    assert.equal(cache.metrics().compressionJobs, 0);
    assert.equal(cache.metrics().compressionBytes, 0);
  }
});

test('compression job cap is global across caches and uncached responses, with no waiting queue', async (t) => {
  const { pending, finish } = holdCompression(t);
  const first = createJsonResponseCache();
  const second = createJsonResponseCache();
  const payloads = Array.from({ length: 4 }, (_, index) => ({ index, text: 'x'.repeat(4096) }));
  const sends = payloads.map((payload, index) => (index % 2 ? second : first).send(response('gzip'), 200, payload));
  assert.equal(pending.length, 4);
  assert.equal(first.metrics().compressionJobs, 4);
  const overloaded = response('br');
  await second.send(overloaded, 200, { text: 'overflow'.repeat(1024) });
  const uncached = response('gzip');
  sendBuffer(uncached, 200, Buffer.alloc(4096, 'u'), 'text/plain');
  assert.equal(overloaded.headers['content-encoding'], undefined);
  assert.equal(uncached.headers['content-encoding'], undefined);
  assert.equal(pending.length, 4, 'overload must not enqueue an additional zlib job');
  finish(pending[0]);
  await nextTurn();
  const retry = second.send(response('br'), 200, { text: 'retry'.repeat(1024) });
  assert.equal(pending.length, 5, 'a physically completed job releases capacity immediately');
  for (const item of pending) finish(item);
  await Promise.all([...sends, retry]);
  assert.equal(first.metrics().compressionJobs, 0);
  assert.equal(first.metrics().compressionBytes, 0);
});

test('compression input bytes never exceed 16 MiB even below the four-job ceiling', async (t) => {
  const { pending, finish } = holdCompression(t);
  const cache = createJsonResponseCache({ maxBytes: 20 * MiB });
  const first = cache.send(response('gzip'), 200, { text: 'a'.repeat(8 * MiB - 11) });
  const second = cache.send(response('br'), 200, { text: 'b'.repeat(8 * MiB - 11) });
  assert.equal(cache.metrics().compressionJobs, 2);
  assert.equal(cache.metrics().compressionBytes, 16 * MiB);
  const blocked = response('gzip');
  await cache.send(blocked, 200, { text: 'c'.repeat(2048) });
  assert.equal(blocked.headers['content-encoding'], undefined);
  assert.equal(pending.length, 2);
  for (const item of pending) finish(item);
  await Promise.all([first, second]);
  assert.equal(cache.metrics().compressionBytes, 0);
});

test('destroyed or already-ended responses are never written from compression success or failure callbacks', async (t) => {
  const { pending, finish } = holdCompression(t);
  const cache = createJsonResponseCache();
  for (const [flag, error] of [['destroyed', null], ['destroyed', new Error('failure')], ['writableEnded', null], ['writableEnded', new Error('failure')]]) {
    const res = response('gzip');
    const send = cache.send(res, 200, { text: 'x'.repeat(2048), sequence: pending.length });
    res[flag] = true;
    finish(pending.at(-1), error);
    await send;
    assert.equal(res.writes, 0);
    assert.equal(res.ends, 0);
  }
});

test('clearing a cache during compression cannot repopulate evicted representations on late completion', async (t) => {
  const { pending, finish } = holdCompression(t);
  const cache = createJsonResponseCache();
  const payload = { text: 'x'.repeat(4096) };
  const res = response('gzip');
  const send = cache.send(res, 200, payload);
  cache.clear();
  finish(pending[0]);
  await send;
  assert.deepEqual(JSON.parse(decoded(res)), payload);
  assert.equal(cache.metrics().bytes, 0);
  assert.equal(cache.metrics().entries, 0);
  await cache.send(response(), 200, payload);
  assert.equal(cache.metrics().serializations, 2);
});

test('a synchronous zlib failure must not permanently leak global compression capacity', () => {
  // Isolate the global compression counters: the regression itself leaks permits
  // on the broken implementation and must not contaminate other test cases.
  child(`
    const assert = require('node:assert/strict');
    const zlib = require('node:zlib');
    const { createJsonResponseCache } = require(${JSON.stringify(require.resolve('../../src/shared/http'))});
    zlib.gzip = () => { throw new Error('synchronous compressor failure'); };
    const cache = createJsonResponseCache();
    const res = { req: { headers: { 'accept-encoding': 'gzip' } }, writeHead() {}, end() {} };
    (async () => {
      await cache.send(res, 200, { text: 'x'.repeat(4096) });
      assert.equal(cache.metrics().compressionJobs, 0, 'synchronous failure leaked a compression job');
      assert.equal(cache.metrics().compressionBytes, 0, 'synchronous failure leaked retained input bytes');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `);
});
