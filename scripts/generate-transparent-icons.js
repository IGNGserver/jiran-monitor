'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');
const ICONS_DIR = path.join(ASSETS_DIR, 'icons');
const BUILD_ICONS_DIR = path.join(ROOT, 'build', 'icons');
const TEMP_HTML = path.join(ROOT, 'build', 'temp_icon_render.html');
const ANDROID_ICON_PATH = path.join(ROOT, 'src', 'hub', 'web', 'icons', 'icon-512.png');

const TRAY_TEMPLATE_NAME = 'tray-token-monitorTemplate.png';
const TRAY_TEMPLATE_2X_NAME = 'tray-token-monitorTemplate@2x.png';
const LEGACY_TRAY_NAME = 'tray-token-monitor.png';
const TRAY_ICON_SIZES = Object.freeze({ oneX: 20, twoX: 40 });

/**
 * Monochrome template SVG matching the Dock/app emblem geometry (split-top ring,
 * separated bottom-left dot, and upright T joined into the bottom-right arc).
 */
function buildTrayTemplateSvg(size = TRAY_ICON_SIZES.oneX) {
  // Normalized 20x20 pt grid (17pt glyph centered with 1.5pt breathing margin inside
  // the 22pt macOS menu bar); key orthogonal edges snap cleanly on @1x and @2x.
  const cx = 10;
  const cy = 10;
  const rOut = 8.5;
  const stroke = 2.5;
  const rIn = rOut - stroke;
  const rMid = (rOut + rIn) / 2;
  const gapHalf = 1.0;

  const yOutTop = cy - Math.sqrt(rOut * rOut - gapHalf * gapHalf);
  const yInTop = cy - Math.sqrt(rIn * rIn - gapHalf * gapHalf);

  const tHalfBar = 4.0;
  const tHalfStem = stroke / 2;
  const tTop = cy - 1.5;
  const tBot = tTop + stroke;
  const xStemL = cx - tHalfStem;
  const xStemR = cx + tHalfStem;
  const yStemBotL = cy + Math.sqrt(rOut * rOut - tHalfStem * tHalfStem);
  const yStemInnerR = cy + Math.sqrt(rIn * rIn - tHalfStem * tHalfStem);

  const angleOf = (x, y) => Math.atan2(y - cy, x - cx);
  const cwSpan = (a0, a1) => ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const outLarge = cwSpan(angleOf(cx + gapHalf, yOutTop), angleOf(xStemL, yStemBotL)) > Math.PI ? 1 : 0;
  const inLarge = cwSpan(angleOf(cx + gapHalf, yInTop), angleOf(xStemR, yStemInnerR)) > Math.PI ? 1 : 0;

  const dotAngle = (144.4 * Math.PI) / 180;
  const dotCx = cx + rMid * Math.cos(dotAngle);
  const dotCy = cy + rMid * Math.sin(dotAngle);
  const dotR = 1.8;
  const cutR = 2.85;

  // Intersect the concentric dot-gap circle with the outer/inner ring boundaries
  // on the upper (9 o'clock) side so no SVG <mask> is needed.
  const deltaOut = Math.acos((rOut * rOut + rMid * rMid - cutR * cutR) / (2 * rOut * rMid));
  const deltaIn = Math.acos((rIn * rIn + rMid * rMid - cutR * cutR) / (2 * rIn * rMid));
  const aOutEnd = dotAngle + deltaOut;
  const aInEnd = dotAngle + deltaIn;
  const xOutEnd = cx + rOut * Math.cos(aOutEnd);
  const yOutEnd = cy + rOut * Math.sin(aOutEnd);
  const xInEnd = cx + rIn * Math.cos(aInEnd);
  const yInEnd = cy + rIn * Math.sin(aInEnd);

  const f = (n) => n.toFixed(3);
  const rightAndT = [
    `M ${f(cx + gapHalf)} ${f(yOutTop)}`,
    `A ${f(rOut)} ${f(rOut)} 0 ${outLarge} 1 ${f(xStemL)} ${f(yStemBotL)}`,
    `L ${f(xStemL)} ${f(tBot)}`,
    `L ${f(cx - tHalfBar)} ${f(tBot)}`,
    `L ${f(cx - tHalfBar)} ${f(tTop)}`,
    `L ${f(cx + tHalfBar)} ${f(tTop)}`,
    `L ${f(cx + tHalfBar)} ${f(tBot)}`,
    `L ${f(xStemR)} ${f(tBot)}`,
    `L ${f(xStemR)} ${f(yStemInnerR)}`,
    `A ${f(rIn)} ${f(rIn)} 0 ${inLarge} 0 ${f(cx + gapHalf)} ${f(yInTop)}`,
    'Z'
  ].join(' ');

  const leftArc = [
    `M ${f(cx - gapHalf)} ${f(yInTop)}`,
    `L ${f(cx - gapHalf)} ${f(yOutTop)}`,
    `A ${f(rOut)} ${f(rOut)} 0 0 0 ${f(xOutEnd)} ${f(yOutEnd)}`,
    `A ${f(cutR)} ${f(cutR)} 0 0 1 ${f(xInEnd)} ${f(yInEnd)}`,
    `A ${f(rIn)} ${f(rIn)} 0 0 1 ${f(cx - gapHalf)} ${f(yInTop)}`,
    'Z'
  ].join(' ');

  // macOS template images use only the alpha channel; keep every pixel pure black.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20">
  <path d="${rightAndT}" fill="#000000" />
  <path d="${leftArc}" fill="#000000" />
  <circle cx="${f(dotCx)}" cy="${f(dotCy)}" r="${f(dotR)}" fill="#000000" />
</svg>`;
}

function buildLogoSvg(size = 1024, isTray = false, androidIconDataUrl = '') {
  const scale = size / 1024;

  if (isTray) {
    return buildTrayTemplateSvg(size);
  }

  // Reuse the original Android/PWA T mark as the desktop source. Keeping the
  // source artwork intact avoids the old low-resolution cutout and any logo
  // drift between desktop surfaces. Only the outer canvas gets rounded.
  const cornerRadius = 160 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <clipPath id="appIconClip">
      <rect width="${size}" height="${size}" rx="${cornerRadius}" />
    </clipPath>
  </defs>
  <image href="${androidIconDataUrl}" width="${size}" height="${size}" preserveAspectRatio="none" clip-path="url(#appIconClip)" />
</svg>`;
}

// Apple's macOS app-icon grid: a 1024px canvas whose 824px "art box" carries a
// continuous-corner rounded square (radius 185.4) and a baked shadow. The Dock
// scales the whole canvas into its tile, so a full-bleed icon (art box = canvas)
// reads ~24% larger than every neighbour. Windows/Linux have no such grid, so
// they keep the full-bleed render and only macOS gets this one.
const MAC_ICON_GRID = {
  canvas: 1024,
  art: 824,
  radius: 185.4,
  smoothing: 0.7, // continuous-corner term; 0 is a plain circular arc
  shadowAlpha: 0.26, // the template's baked shadow, fitted to shipping system icons
  shadowBlur: 16,
  shadowOffsetY: 6
};

// Continuous corners (the shape Apple's template uses): each corner is a
// circular arc flanked by two cubic Bezier handles, so curvature carries
// smoothly out to the straight edges instead of snapping from arc to line.
function squirclePath(side, radius, smoothing, x = 0, y = 0) {
  const r = radius;
  const s = smoothing;
  const p = (1 + s) * r;
  const arcMeasure = 90 * (1 - s);
  const arc = Math.sin((arcMeasure / 2) * (Math.PI / 180)) * r * Math.SQRT2;
  const alpha = ((90 - arcMeasure) / 2) * (Math.PI / 180);
  const beta = 45 * s * (Math.PI / 180);
  const c = r * Math.tan(alpha / 2) * Math.cos(beta);
  const d = c * Math.tan(beta);
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const n = (value) => value.toFixed(4);

  return [
    `M ${n(x + side - p)} ${n(y)}`,
    `c ${n(a)} 0 ${n(a + b)} 0 ${n(a + b + c)} ${n(d)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(arc)}`,
    `c ${n(d)} ${n(c)} ${n(d)} ${n(b + c)} ${n(d)} ${n(a + b + c)}`,
    `L ${n(x + side)} ${n(y + side - p)}`,
    `c 0 ${n(a)} 0 ${n(a + b)} ${n(-d)} ${n(a + b + c)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(arc)}`,
    `c ${n(-c)} ${n(d)} ${n(-(b + c))} ${n(d)} ${n(-(a + b + c))} ${n(d)}`,
    `L ${n(x + p)} ${n(y + side)}`,
    `c ${n(-a)} 0 ${n(-(a + b))} 0 ${n(-(a + b + c))} ${n(-d)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(-arc)}`,
    `c ${n(-d)} ${n(-c)} ${n(-d)} ${n(-(b + c))} ${n(-d)} ${n(-(a + b + c))}`,
    `L ${n(x)} ${n(y + p)}`,
    `c 0 ${n(-a)} 0 ${n(-(a + b))} ${n(d)} ${n(-(a + b + c))}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(-arc)}`,
    `c ${n(c)} ${n(-d)} ${n(b + c)} ${n(-d)} ${n(a + b + c)} ${n(-d)}`,
    'Z'
  ].join(' ');
}

function buildMacAppIconSvg(size, androidIconDataUrl) {
  const k = size / MAC_ICON_GRID.canvas;
  const art = MAC_ICON_GRID.art * k;
  const inset = (size - art) / 2;
  const path = squirclePath(art, MAC_ICON_GRID.radius * k, MAC_ICON_GRID.smoothing, inset, inset);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <clipPath id="macAppIconClip"><path d="${path}" /></clipPath>
    <filter id="macAppIconShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${MAC_ICON_GRID.shadowBlur * k}" />
    </filter>
  </defs>
  <g opacity="${MAC_ICON_GRID.shadowAlpha}" transform="translate(0 ${MAC_ICON_GRID.shadowOffsetY * k})">
    <path d="${path}" fill="#000000" filter="url(#macAppIconShadow)" />
  </g>
  <image href="${androidIconDataUrl}" x="${inset}" y="${inset}" width="${art}" height="${art}" preserveAspectRatio="none" clip-path="url(#macAppIconClip)" />
</svg>`;
}

function packIco(pngItems) {
  const count = pngItems.length;
  const headerSize = 6 + 16 * count;
  let dataOffset = headerSize;

  const entries = [];
  const buffers = [];

  for (const item of pngItems) {
    const entryBuf = Buffer.alloc(16);
    const sizeByte = item.size >= 256 ? 0 : item.size;
    entryBuf.writeUInt8(sizeByte, 0); // width
    entryBuf.writeUInt8(sizeByte, 1); // height
    entryBuf.writeUInt8(0, 2);        // color count
    entryBuf.writeUInt8(0, 3);        // reserved
    entryBuf.writeUInt16LE(1, 4);     // color planes
    entryBuf.writeUInt16LE(32, 6);    // bits per pixel
    entryBuf.writeUInt32LE(item.buffer.length, 8); // size of image data
    entryBuf.writeUInt32LE(dataOffset, 12);        // offset of image data

    entries.push(entryBuf);
    buffers.push(item.buffer);
    dataOffset += item.buffer.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(count, 4);

  return Buffer.concat([header, ...entries, ...buffers]);
}

async function renderSvgToPng(win, svgContent, size) {
  win.setSize(size, size);
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
  svg { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>${svgContent}</body>
</html>`;

  fs.writeFileSync(TEMP_HTML, html, 'utf8');
  await win.loadFile(TEMP_HTML);
  await new Promise((r) => setTimeout(r, 60));
  let image;
  try {
    // Explicitly keep the hidden page in the compositor. This avoids an
    // UnknownVizError on hosted Windows runners while keeping CI headless.
    image = await win.webContents.capturePage(undefined, { stayHidden: true });
  } catch (_) {
    // Older Electron builds may not support hidden capture options reliably;
    // retry once after activating the off-screen helper window.
    win.showInactive();
    try {
      image = await win.webContents.capturePage();
    } finally {
      win.hide();
    }
  }
  const pngBuf = image.resize({ width: size, height: size, quality: 'best' }).toPNG();
  return pngBuf;
}

async function renderSvgWithSharp(svgContent, size) {
  const sharp = require('sharp');
  return sharp(Buffer.from(svgContent))
    .resize(size, size)
    .png()
    .toBuffer();
}

async function generateTrayIcons(renderSvg = renderSvgWithSharp, iconsDir = ICONS_DIR) {
  fs.mkdirSync(iconsDir, { recursive: true });
  const oneXPng = await renderSvg(buildTrayTemplateSvg(TRAY_ICON_SIZES.oneX), TRAY_ICON_SIZES.oneX);
  const twoXPng = await renderSvg(buildTrayTemplateSvg(TRAY_ICON_SIZES.twoX), TRAY_ICON_SIZES.twoX);
  fs.writeFileSync(path.join(iconsDir, TRAY_TEMPLATE_NAME), oneXPng);
  fs.writeFileSync(path.join(iconsDir, TRAY_TEMPLATE_2X_NAME), twoXPng);
  const legacyPath = path.join(iconsDir, LEGACY_TRAY_NAME);
  if (fs.existsSync(legacyPath)) {
    fs.unlinkSync(legacyPath);
  }
}

async function generateAllWithElectron() {
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  try {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    fs.mkdirSync(ICONS_DIR, { recursive: true });
    fs.mkdirSync(BUILD_ICONS_DIR, { recursive: true });

    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false
      }
    });

    const androidIconDataUrl = `data:image/png;base64,${fs.readFileSync(ANDROID_ICON_PATH).toString('base64')}`;
    const main1024Png = await renderSvgToPng(win, buildLogoSvg(1024, false, androidIconDataUrl), 1024);

    fs.writeFileSync(path.join(ASSETS_DIR, 'icon.png'), main1024Png);
    fs.writeFileSync(path.join(ASSETS_DIR, 'icon-win.png'), main1024Png);

    // macOS Dock/Finder icon: Apple's 824/1024 art box, so the tile matches the
    // size of every other app icon in the Dock. The packaged .icns and the
    // runtime app.dock.setIcon() both read this file.
    const mac1024Png = await renderSvgToPng(win, buildMacAppIconSvg(1024, androidIconDataUrl), 1024);
    fs.writeFileSync(path.join(ASSETS_DIR, 'icon-mac.png'), mac1024Png);

    // macOS 1x/2x template tray icons (20x20 and 40x40)
    await generateTrayIcons((svg, sz) => renderSvgToPng(win, svg, sz), ICONS_DIR);

    // Sizes for ICO container
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const icoItems = [];

    for (const sz of sizes) {
      const pngBuf = await renderSvgToPng(win, buildLogoSvg(sz, false, androidIconDataUrl), sz);
      fs.writeFileSync(path.join(BUILD_ICONS_DIR, `${sz}x${sz}.png`), pngBuf);
      icoItems.push({ size: sz, buffer: pngBuf });
    }

    const sz512Png = await renderSvgToPng(win, buildLogoSvg(512, false, androidIconDataUrl), 512);
    fs.writeFileSync(path.join(BUILD_ICONS_DIR, '512x512.png'), sz512Png);
    fs.writeFileSync(path.join(BUILD_ICONS_DIR, '1024x1024.png'), main1024Png);

    const icoBuf = packIco(icoItems);
    fs.writeFileSync(path.join(BUILD_ICONS_DIR, 'icon.ico'), icoBuf);

    win.destroy();
    if (fs.existsSync(TEMP_HTML)) fs.unlinkSync(TEMP_HTML);

    console.log('Successfully generated crisp high-DPI app icons (full-bleed + macOS grid) and tray icons!');
    app.exit(0);
  } catch (err) {
    console.error('Error generating icons:', err);
    if (fs.existsSync(TEMP_HTML)) fs.unlinkSync(TEMP_HTML);
    app.exit(1);
  }
}

if (require.main === module) {
  const trayOnly = process.argv.includes('--tray-only') || !process.versions.electron;
  if (trayOnly) {
    generateTrayIcons()
      .then(() => {
        console.log('Successfully generated 1x/2x macOS template tray icons!');
      })
      .catch((err) => {
        console.error('Error generating tray icons:', err);
        process.exit(1);
      });
  } else {
    generateAllWithElectron();
  }
}

module.exports = {
  TRAY_ICON_SIZES,
  TRAY_TEMPLATE_NAME,
  TRAY_TEMPLATE_2X_NAME,
  buildTrayTemplateSvg,
  buildLogoSvg,
  buildMacAppIconSvg,
  squirclePath,
  packIco,
  generateTrayIcons
};
