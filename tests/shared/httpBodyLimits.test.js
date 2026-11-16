'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const zlib = require('node:zlib');
const { readJsonBody } = require('../../src/shared/http');

function request(headers = {}) {
  const req = new PassThrough();
  req.headers = headers;
  return req;
}

test('readJsonBody rejects an oversized Content-Length before reading', async () => {
  const req = request({ 'content-length': '1025' });
  await assert.rejects(
    readJsonBody(req, 1024),
    (error) => error.code === 'payload_too_large'
      && error.statusCode === 413
      && error.closeConnection === true
  );
  assert.equal(req.listenerCount('data'), 0);
  req.destroy();
});

test('readJsonBody rejects malformed Content-Length without consuming the stream', async () => {
  const req = request({ 'content-length': '12.5' });
  await assert.rejects(
    readJsonBody(req, 1024),
    (error) => error.code === 'body_read_failed' && error.statusCode === 400
  );
  assert.equal(req.listenerCount('data'), 0);
  req.destroy();
});

test('readJsonBody enforces its byte cap for a chunked request and cleans up listeners', async () => {
  const req = request();
  const rejected = assert.rejects(
    readJsonBody(req, 8),
    (error) => error.code === 'payload_too_large'
      && error.statusCode === 413
      && error.closeConnection === true
  );
  req.write('{"x":"');
  req.write('too large"}');
  await rejected;
  assert.equal(req.listenerCount('data'), 0);
  assert.equal(req.listenerCount('end'), 0);
  req.destroy();
});

test('readJsonBody applies an overall deadline to a slow chunked body', async () => {
  const req = request();
  const started = Date.now();
  const rejected = assert.rejects(
    readJsonBody(req, 1024, 40),
    (error) => error.code === 'body_timeout'
      && error.statusCode === 408
      && error.closeConnection === true
  );
  req.write('{"stillOpen":');
  await rejected;
  assert.ok(Date.now() - started < 500, 'the deadline must not wait for request end');
  assert.equal(req.listenerCount('data'), 0);
  assert.equal(req.listenerCount('error'), 1, 'one late-error guard remains until socket close');
  req.destroy();
});

test('readJsonBody still parses ordinary JSON and empty bodies', async () => {
  const json = '{"value":"计然"}';
  const populated = request({ 'content-length': String(Buffer.byteLength(json)) });
  const reading = readJsonBody(populated, 1024);
  populated.end(json);
  assert.deepEqual(await reading, { value: '计然' });
  assert.equal(populated.listenerCount('data'), 0);

  const empty = request({ 'content-length': '0' });
  const emptyReading = readJsonBody(empty, 1024);
  empty.end();
  assert.deepEqual(await emptyReading, {});
});

test('readJsonBody decodes gzip and x-gzip JSON bodies and tolerates empty gzip streams', async () => {
  const payload = { deviceId: 'dev-gzip', value: '计然', tokens: 12345 };
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));

  const gzipReq = request({
    'content-encoding': 'gzip',
    'content-length': String(compressed.length)
  });
  const gzipReading = readJsonBody(gzipReq, 4096);
  gzipReq.end(compressed);
  assert.deepEqual(await gzipReading, payload);
  assert.equal(gzipReq.listenerCount('data'), 0);

  const xGzipReq = request({ 'Content-Encoding': 'x-gzip' });
  const xGzipReading = readJsonBody(xGzipReq, 4096);
  xGzipReq.end(compressed);
  assert.deepEqual(await xGzipReading, payload);

  const emptyGzip = request({ 'content-encoding': 'gzip', 'content-length': '0' });
  const emptyReading = readJsonBody(emptyGzip, 4096);
  emptyGzip.end();
  assert.deepEqual(await emptyReading, {});
});

test('readJsonBody aborts a gzip bomb when decompressed output exceeds maxBytes', async () => {
  const largeJson = JSON.stringify({ pad: 'a'.repeat(32 * 1024) });
  const compressed = zlib.gzipSync(Buffer.from(largeJson, 'utf8'));
  assert.ok(compressed.length < 512, 'compressed wire size should sit well below maxBytes');

  const req = request({
    'content-encoding': 'gzip',
    'content-length': String(compressed.length)
  });
  const rejected = assert.rejects(
    readJsonBody(req, 1024),
    (error) => error.code === 'payload_too_large'
      && error.statusCode === 413
      && error.closeConnection === true
  );
  req.end(compressed);
  await rejected;
  assert.equal(req.listenerCount('data'), 0);
  req.destroy();
});

test('readJsonBody rejects malformed gzip bytes and unsupported Content-Encoding headers', async () => {
  const corrupt = request({ 'content-encoding': 'gzip' });
  const corruptRejected = assert.rejects(
    readJsonBody(corrupt, 1024),
    (error) => error.code === 'invalid_json'
      && error.statusCode === 400
      && error.closeConnection === true
  );
  corrupt.end(Buffer.from('not-a-gzip-stream', 'utf8'));
  await corruptRejected;
  corrupt.destroy();

  const deflateReq = request({ 'content-encoding': 'deflate' });
  await assert.rejects(
    readJsonBody(deflateReq, 1024),
    (error) => error.code === 'unsupported_encoding'
      && error.statusCode === 415
      && error.closeConnection === true
  );
  assert.equal(deflateReq.listenerCount('data'), 0);
  deflateReq.destroy();
});
