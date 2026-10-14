'use strict';

// The macOS Dock scales the whole icon canvas into its tile, so an icon whose
// artwork fills the canvas reads ~24% larger than every neighbouring app. The
// property that keeps it honest is pixel-level — the opaque footprint must stay
// inside Apple's 824/1024 art box — and that is not something a filename or a
// size check can assert. The decoder below is the minimum needed to measure the
// alpha footprint with Node built-ins, for the 8-bit RGBA PNGs the icon
// generator writes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..', '..');
const MAC_ICON_PATH = path.join(ROOT, 'assets', 'icon-mac.png');
const APPLE_GRID = { canvas: 1024, art: 824, inset: 100 };

function decodePng(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'expected 8-bit channels');
      assert.equal(data[9], 6, 'expected RGBA');
      assert.equal(data[12], 0, 'expected a non-interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  assert.ok(width > 0 && height > 0, `${file} has no IHDR`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else {
        assert.equal(filter, 0, `unknown PNG row filter ${filter}`);
      }
      row[i] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

function opaqueBounds({ width, height, pixels }, threshold = 128) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

test('the macOS app icon keeps Apple\'s 824/1024 art box', () => {
  const image = decodePng(MAC_ICON_PATH);
  assert.equal(image.width, APPLE_GRID.canvas);
  assert.equal(image.height, APPLE_GRID.canvas);

  // The baked shadow never reaches the opaque threshold, so this footprint is
  // the plate itself; allow the antialiased edge a couple of pixels.
  const bounds = opaqueBounds(image);
  const tolerance = 3;
  assert.ok(
    Math.abs(bounds.width - APPLE_GRID.art) <= tolerance && Math.abs(bounds.height - APPLE_GRID.art) <= tolerance,
    `art box is ${bounds.width}x${bounds.height}, expected ~${APPLE_GRID.art}x${APPLE_GRID.art}`
  );
  assert.ok(
    Math.abs(bounds.minX - APPLE_GRID.inset) <= tolerance && Math.abs(bounds.minY - APPLE_GRID.inset) <= tolerance,
    `art box starts at (${bounds.minX}, ${bounds.minY}), expected ~(${APPLE_GRID.inset}, ${APPLE_GRID.inset})`
  );
});

test('macOS packaging and the runtime Dock icon both use the padded asset', () => {
  const packageJson = require(path.join(ROOT, 'package.json'));
  assert.equal(packageJson.build.mac.icon, 'assets/icon-mac.png', 'the packaged .icns must come from the padded asset');
  assert.ok(
    packageJson.build.files.includes('assets/icon-mac.png'),
    'the runtime Dock icon must ship inside the package'
  );

  // app.dock.setIcon() overrides the bundle icon, so the runtime path has to
  // select the same padded asset on macOS (and fall back when it is absent).
  const main = fs.readFileSync(path.join(ROOT, 'src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /MAC_ICON_PATH = path\.join\(__dirname, '\.\.', '\.\.', 'assets', 'icon-mac\.png'\)/);
  assert.match(main, /const DOCK_ICON_PATH = process\.platform === 'darwin' && fs\.existsSync\(MAC_ICON_PATH\)/);
  assert.match(main, /app\.dock\.setIcon\(DOCK_ICON_PATH\)/);
});
