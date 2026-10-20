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

// Node 22.13+ / Electron support require(esm); both hosts share the bounded parser.
module.exports = require('../shared-ui/core/sseFrames.js');
