'use strict';

// Splits an SSE byte stream (already decoded to text) into frames.
//
// A Hub stats frame is the whole fleet snapshot — about a megabyte for a
// handful of devices — and it arrives in many small network chunks. The old
// reader appended every chunk to one string and re-ran the boundary regex from
// the start, which is quadratic in the frame size; and because V8 flattens a
// concatenated (cons) string before a regex can run on it, even resuming the
// search part-way would still copy the whole buffer per chunk. Here each chunk
// is searched on its own (plus the last three characters of the previous one,
// so a `\r\n\r\n` split across chunks is still found) and the pieces of a
// frame are joined exactly once, when its boundary arrives.

const BOUNDARY = /\r?\n\r?\n/g;
const CARRY = 3;

function createSseFrameSplitter() {
  let pending = [];
  let carry = '';

  return function push(text) {
    const frames = [];
    let rest = String(text || '');
    for (;;) {
      const probe = carry + rest;
      BOUNDARY.lastIndex = 0;
      const match = BOUNDARY.exec(probe);
      if (!match) {
        if (rest) pending.push(rest);
        carry = probe.slice(-CARRY);
        return frames;
      }
      // `carry` is already part of `pending`, so offsets into `probe` shift by
      // its length when mapped back onto `rest`. A boundary that started inside
      // the carry ends the frame a few characters before the pending text does.
      const cut = match.index - carry.length;
      let frame = pending.join('');
      if (cut >= 0) frame += rest.slice(0, cut);
      else frame = frame.slice(0, frame.length + cut);
      frames.push(frame);
      rest = rest.slice(match.index + match[0].length - carry.length);
      pending = [];
      carry = '';
    }
  };
}

module.exports = { createSseFrameSplitter };
