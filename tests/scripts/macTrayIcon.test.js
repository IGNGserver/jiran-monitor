'use strict';

// The macOS menu bar icon must match the Dock/app emblem (split-top ring,
// separated 8 o'clock dot, and upright geometric T whose stem joins the bottom
// of the right arc), provide both 1x (20x20) and @2x (40x40) template assets,
// and keep every visible pixel pure black so macOS tints solely via alpha.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { TRAY_ICON_PATH } = require('../../src/electron/tray');
const {
  TRAY_ICON_SIZES,
  TRAY_TEMPLATE_NAME,
  TRAY_TEMPLATE_2X_NAME,
  buildTrayTemplateSvg
} = require('../../scripts/generate-transparent-icons');

const ROOT = path.join(__dirname, '..', '..');
const ICONS_DIR = path.join(ROOT, 'assets', 'icons');
const TRAY_1X_PATH = path.join(ICONS_DIR, TRAY_TEMPLATE_NAME);
const TRAY_2X_PATH = path.join(ICONS_DIR, TRAY_TEMPLATE_2X_NAME);
const LEGACY_TRAY_PATH = path.join(ICONS_DIR, 'tray-token-monitor.png');

function decodeRgbaPng(file) {
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

function alphaAt(image, x, y) {
  return image.pixels[(y * image.width + x) * 4 + 3];
}

function opaqueBounds(image, threshold = 128) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (alphaAt(image, x, y) < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

test('macOS tray icon uses 1x/2x template assets and retires the legacy crooked-T PNG', () => {
  assert.equal(TRAY_ICON_PATH, TRAY_1X_PATH);
  assert.equal(fs.existsSync(TRAY_1X_PATH), true, '1x template tray icon must exist');
  assert.equal(fs.existsSync(TRAY_2X_PATH), true, '2x Retina template tray icon must exist');
  assert.equal(fs.existsSync(LEGACY_TRAY_PATH), false, 'legacy tray-token-monitor.png must be removed');

  const packageJson = require(path.join(ROOT, 'package.json'));
  assert.ok(packageJson.build.files.includes('assets/icons/**/*'), 'packaged Electron build must ship tray template icons');
  assert.doesNotMatch(buildTrayTemplateSvg(20), /c0 1\.8/, 'tray SVG must not contain the old curved T stem');
});

test('1x and 2x tray template PNGs are pure monochrome alpha masks sized for the macOS menu bar', () => {
  for (const [file, expectedSize] of [
    [TRAY_1X_PATH, TRAY_ICON_SIZES.oneX],
    [TRAY_2X_PATH, TRAY_ICON_SIZES.twoX]
  ]) {
    const image = decodeRgbaPng(file);
    assert.equal(image.width, expectedSize);
    assert.equal(image.height, expectedSize);

    for (let i = 0; i < image.pixels.length; i += 4) {
      if (image.pixels[i + 3] === 0) continue;
      assert.equal(image.pixels[i], 0, `${path.basename(file)} visible pixel red channel must be 0`);
      assert.equal(image.pixels[i + 1], 0, `${path.basename(file)} visible pixel green channel must be 0`);
      assert.equal(image.pixels[i + 2], 0, `${path.basename(file)} visible pixel blue channel must be 0`);
    }

    const bounds = opaqueBounds(image);
    assert.ok(bounds.minX >= 1 && bounds.minY >= 1, `${path.basename(file)} needs breathing padding`);
    assert.ok(bounds.maxX <= expectedSize - 2 && bounds.maxY <= expectedSize - 2);
  }
});

test('2x tray template PNG renders the split-top ring, separated 8 o\'clock dot, and upright T', () => {
  const image = decodeRgbaPng(TRAY_2X_PATH);

  // Top-center split between the left and right outer arcs (around x=19..20, y=4..8)
  for (const y of [4, 5, 6, 7]) {
    assert.equal(alphaAt(image, 19, y), 0, `expected top gap at (19, ${y})`);
    assert.equal(alphaAt(image, 20, y), 0, `expected top gap at (20, ${y})`);
    assert.ok(alphaAt(image, 15, y) > 200, `expected left arc near top gap at (15, ${y})`);
    assert.ok(alphaAt(image, 24, y) > 200, `expected right arc near top gap at (24, ${y})`);
  }

  // Upright centered T crossbar (y=18..20, x=13..26) and straight vertical stem (x=19..20, y=18..35)
  for (let x = 13; x <= 26; x++) {
    assert.ok(alphaAt(image, x, 19) > 200, `expected T crossbar at (${x}, 19)`);
  }
  for (let y = 18; y <= 34; y++) {
    assert.ok(alphaAt(image, 19, y) > 200, `expected upright T stem at (19, ${y})`);
    assert.ok(alphaAt(image, 20, y) > 200, `expected upright T stem at (20, ${y})`);
  }

  // No crooked rightward tail inside the open space between stem and right arc
  for (let x = 23; x <= 27; x++) {
    assert.equal(alphaAt(image, x, 27), 0, `expected open interior right of T stem at (${x}, 27)`);
  }

  // Bottom-left dot present around (8, 28) with a clear transparent gap above/right of it
  assert.ok(alphaAt(image, 8, 28) > 200, 'expected separated 8 o\'clock dot at (8, 28)');
  assert.equal(alphaAt(image, 9, 24), 0, 'expected clean separation gap above the dot at (9, 24)');
  assert.equal(alphaAt(image, 13, 30), 0, 'expected open gap between dot and T stem at (13, 30)');
});
