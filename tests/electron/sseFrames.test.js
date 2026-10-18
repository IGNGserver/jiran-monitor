'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createSseFrameSplitter } = require('../../src/electron/sseFrames');

function splitAll(chunks) {
  const push = createSseFrameSplitter();
  return chunks.flatMap((chunk) => push(chunk));
}

// Reference: the previous whole-buffer implementation.
function reference(text) {
  const frames = [];
  let buffer = text;
  let frame;
  while ((frame = buffer.match(/\r?\n\r?\n/)) !== null) {
    frames.push(buffer.slice(0, frame.index));
    buffer = buffer.slice(frame.index + frame[0].length);
  }
  return frames;
}

test('frames are split on every SSE boundary spelling', () => {
  const stream = 'event: a\ndata: 1\n\nevent: b\r\ndata: 2\r\n\r\n: hb\n\r\ndata: 3\r\n\n';
  assert.deepEqual(splitAll([stream]), reference(stream));
  assert.deepEqual(splitAll([stream]), ['event: a\ndata: 1', 'event: b\r\ndata: 2', ': hb', 'data: 3']);
});

test('a boundary split across chunks at every offset still yields identical frames', () => {
  const stream = 'event: stats\r\ndata: {"x":1}\r\n\r\nevent: snapshot\ndata: {"y":2}\n\n: hb\r\n\r\ndata: tail';
  const expected = reference(stream);
  for (let a = 1; a < stream.length; a += 1) {
    for (let b = a + 1; b <= stream.length; b += 7) {
      const chunks = [stream.slice(0, a), stream.slice(a, b), stream.slice(b)];
      assert.deepEqual(splitAll(chunks), expected, `split at ${a}/${b}`);
    }
  }
  const singleChars = splitAll([...stream]);
  assert.deepEqual(singleChars, expected);
});

test('an incomplete trailing frame is held until its boundary arrives', () => {
  const push = createSseFrameSplitter();
  assert.deepEqual(push('data: {"a"'), []);
  assert.deepEqual(push(':1}\n'), []);
  assert.deepEqual(push('\nevent: next'), ['data: {"a":1}']);
  assert.deepEqual(push('\ndata: 2\n\n'), ['event: next\ndata: 2']);
});

test('a megabyte frame in small chunks is split in linear time', () => {
  const payload = `data: ${JSON.stringify({ blob: 'x'.repeat(4 * 1024 * 1024) })}`;
  const stream = `${payload}\n\n`;
  const push = createSseFrameSplitter();
  const started = process.hrtime.bigint();
  const frames = [];
  for (let i = 0; i < stream.length; i += 16 * 1024) frames.push(...push(stream.slice(i, i + 16 * 1024)));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, payload.length);
  // The quadratic reader took seconds here; a linear one is a few milliseconds.
  assert.ok(elapsedMs < 1000, `took ${elapsedMs}ms`);
});
