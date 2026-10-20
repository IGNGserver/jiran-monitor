'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSseFrameSplitter } = require('../../src/electron/sseFrames');

test('both hosts split chunked CRLF boundaries without rescanning whole frames', () => {
  const input = 'event: stats\r\ndata: {"stats":{}}\r\n\r\nevent: heartbeat\n\n';
  for (let size = 1; size < input.length; size++) {
    const split = createSseFrameSplitter();
    const result = [];
    for (let i = 0; i < input.length; i += size) result.push(...split(input.slice(i, i + size)));
    assert.deepEqual(result, ['event: stats\r\ndata: {"stats":{}}', 'event: heartbeat']);
  }
});

test('unterminated and complete oversized frames are bounded, not whole reads', () => {
  const split = createSseFrameSplitter({ maxChars: 5 });
  split('123');
  assert.throws(() => split('456'), /stream_frame_too_large/);
  assert.throws(() => createSseFrameSplitter({ maxChars: 5 })('123456\n\n'), /stream_frame_too_large/);
  assert.equal(createSseFrameSplitter({ maxChars: 5 })('1\n\n2\n\n3\n\n').length, 3);
});
