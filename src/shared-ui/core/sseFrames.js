// Search each incoming chunk once, retaining only three boundary characters.
// Joining once per completed frame avoids quadratic copying on slow links.
export function createSseFrameSplitter({ maxChars = 8 * 1024 * 1024 } = {}) {
  let pending = [];
  let pendingSize = 0;
  let carry = '';
  const boundary = /\r?\n\r?\n/g;
  return function push(text) {
    const frames = [];
    let rest = String(text || '');
    for (;;) {
      const probe = carry + rest;
      boundary.lastIndex = 0;
      const match = boundary.exec(probe);
      if (!match) {
        pendingSize += rest.length;
        if (pendingSize > maxChars) throw new Error('stream_frame_too_large');
        if (rest) pending.push(rest);
        carry = probe.slice(-3);
        return frames;
      }
      const cut = match.index - carry.length;
      if (pendingSize + cut > maxChars) throw new Error('stream_frame_too_large');
      let frame = pending.join('');
      frame = cut >= 0 ? frame + rest.slice(0, cut) : frame.slice(0, frame.length + cut);
      frames.push(frame);
      rest = rest.slice(match.index + match[0].length - carry.length);
      pending = [];
      pendingSize = 0;
      carry = '';
    }
  };
}
