#!/usr/bin/env node
'use strict';

/**
 * Deterministic cross-surface client icon synchronizer.
 *
 * Single source of truth:
 *   - src/shared-ui/icons/clients/*.svg
 *   - src/shared-ui/icons/manifest.json
 *
 * Generates / synchronizes:
 *   1. android/app/src/main/res/drawable/client_<id>.xml (Android VectorDrawable, API 26+)
 *   2. android/app/src/main/java/com/igng/tokenmonitor/android/ui/components/ClientIcons.kt
 *   3. website/src/assets/icons/clients/*.svg (byte-identical mirror)
 *   4. .github/assets/tools-icon/*.png (96x96 transparent rounded badges for docs/supported-tools.md)
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'src', 'shared-ui', 'icons', 'manifest.json');
const CLIENTS_DIR = path.join(ROOT, 'src', 'shared-ui', 'icons', 'clients');
const ANDROID_DRAWABLE_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'drawable');
const ANDROID_CLIENT_ICONS_KT = path.join(
  ROOT,
  'android', 'app', 'src', 'main', 'java',
  'com', 'igng', 'tokenmonitor', 'android', 'ui', 'components', 'ClientIcons.kt'
);
const WEBSITE_ICONS_DIR = path.join(ROOT, 'website', 'src', 'assets', 'icons', 'clients');
const DOCS_ICONS_DIR = path.join(ROOT, '.github', 'assets', 'tools-icon');

const SVG_CMD_ARITY = {
  M: 2, m: 2,
  L: 2, l: 2,
  H: 1, h: 1,
  V: 1, v: 1,
  C: 6, c: 6,
  S: 4, s: 4,
  Q: 4, q: 4,
  T: 2, t: 2,
  A: 7, a: 7,
  Z: 0, z: 0
};

const SVG_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

function normalizeSvgNumberToken(token) {
  let out = token.startsWith('+') ? token.slice(1) : token;
  if (out.startsWith('.')) out = `0${out}`;
  else if (out.startsWith('-.')) out = `-0.${out.slice(2)}`;
  return out;
}

/**
 * Expand SVG 1.1/2.0 pathData into canonical whitespace-delimited tokens safe for
 * Jetpack Compose's PathParser and AOSP VectorDrawable.
 *
 * SVGO-minified paths pack arc boolean flags without whitespace (e.g.
 * `a5.947 5.947 0 005.827-4.756` or `a1.273 1.273 0 100 2.547`). Browsers parse
 * those per SVG grammar, but Jetpack Compose 1.7's PathParser tokenizes `005.827`
 * or `100` as one float, leaving <7 args and silently dropping the entire arc.
 */
function normalizeAndroidPathData(raw, label = 'path') {
  const src = String(raw || '').trim();
  if (!src) return '';

  let pos = 0;
  const len = src.length;
  const out = [];

  const skipSep = () => {
    while (pos < len) {
      const ch = src[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        pos += 1;
      } else {
        break;
      }
    }
  };

  const readNumber = () => {
    skipSep();
    const match = SVG_NUMBER_RE.exec(src.slice(pos));
    if (!match) {
      throw new Error(`${label}: expected SVG number at offset ${pos} near "${src.slice(pos, pos + 24)}"`);
    }
    pos += match[0].length;
    return normalizeSvgNumberToken(match[0]);
  };

  const readArcFlag = () => {
    skipSep();
    const ch = src[pos];
    if (ch !== '0' && ch !== '1') {
      throw new Error(`${label}: expected SVG arc flag (0/1) at offset ${pos} near "${src.slice(pos, pos + 24)}"`);
    }
    pos += 1;
    return ch;
  };

  while (pos < len) {
    skipSep();
    if (pos >= len) break;

    const cmd = src[pos];
    if (!Object.prototype.hasOwnProperty.call(SVG_CMD_ARITY, cmd)) {
      throw new Error(`${label}: unexpected SVG path command "${cmd}" at offset ${pos}`);
    }
    pos += 1;

    const arity = SVG_CMD_ARITY[cmd];
    if (arity === 0) {
      out.push(cmd);
      continue;
    }

    let activeCmd = cmd;
    let firstTuple = true;
    while (pos < len) {
      skipSep();
      if (pos >= len) break;
      const peek = src[pos];
      if (/[A-Za-z]/.test(peek)) {
        if (firstTuple) {
          throw new Error(`${label}: command "${cmd}" missing parameters at offset ${pos}`);
        }
        break;
      }

      const args = [];
      if (activeCmd === 'A' || activeCmd === 'a') {
        args.push(readNumber(), readNumber(), readNumber());
        args.push(readArcFlag(), readArcFlag());
        args.push(readNumber(), readNumber());
      } else {
        for (let k = 0; k < arity; k += 1) {
          args.push(readNumber());
        }
      }
      out.push(`${activeCmd} ${args.join(' ')}`);
      firstTuple = false;
      if (activeCmd === 'M') activeCmd = 'L';
      else if (activeCmd === 'm') activeCmd = 'l';
    }
  }

  return out.join(' ');
}

function toAndroidDrawableName(slug) {
  return `client_${slug.replace(/-/g, '_')}`;
}

function normalizeHexToAndroid(rawColor, fallback = '#FF000000') {
  if (!rawColor) return fallback;
  const trimmed = rawColor.trim();
  if (!trimmed || trimmed.toLowerCase() === 'currentcolor') return '#FF000000';
  if (trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'transparent') return null;
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      const [r, g, b] = hex;
      return `#FF${r}${r}${g}${g}${b}${b}`.toUpperCase();
    }
    if (hex.length === 6) return `#FF${hex}`.toUpperCase();
    if (hex.length === 8) return `#${hex}`.toUpperCase();
  }
  return fallback;
}

function parseStyle(styleText) {
  const map = {};
  if (!styleText) return map;
  for (const part of styleText.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const val = part.slice(idx + 1).trim();
    if (key && val) map[key] = val;
  }
  return map;
}

function parseAttrs(tagText) {
  const attrs = {};
  for (const match of tagText.matchAll(/([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  for (const match of tagText.matchAll(/([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*'([^']*)'/g)) {
    if (!(match[1] in attrs)) attrs[match[1]] = match[2];
  }
  return attrs;
}

function parseGradients(svgText) {
  const gradients = new Map();
  const re = /<(linearGradient|radialGradient)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(svgText)) !== null) {
    const type = match[1].toLowerCase() === 'radialgradient' ? 'radial' : 'linear';
    const attrs = parseAttrs(match[2]);
    if (!attrs.id) continue;
    const stops = [];
    for (const stopMatch of match[3].matchAll(/<stop\b([^>]*)\/?>/gi)) {
      const sAttrs = parseAttrs(stopMatch[1]);
      const style = parseStyle(sAttrs.style);
      const rawOffset = sAttrs.offset ?? '0';
      const offset = rawOffset.endsWith('%')
        ? (parseFloat(rawOffset) / 100)
        : parseFloat(rawOffset);
      const colorHex = normalizeHexToAndroid(sAttrs['stop-color'] || style['stop-color'] || '#000000');
      const opacityRaw = sAttrs['stop-opacity'] ?? style['stop-opacity'];
      let color = colorHex || '#FF000000';
      if (opacityRaw !== undefined && Number.isFinite(parseFloat(opacityRaw))) {
        const alpha = Math.round(Math.max(0, Math.min(1, parseFloat(opacityRaw))) * 255)
          .toString(16).padStart(2, '0').toUpperCase();
        color = `#${alpha}${color.slice(3)}`;
      }
      stops.push({ offset: Number.isFinite(offset) ? offset : 0, color });
    }
    if (stops.length >= 2) {
      gradients.set(attrs.id, { type, attrs, stops });
    }
  }
  return gradients;
}

/**
 * Antigravity's canonical web SVG uses <mask> + <feGaussianBlur> soft colour blobs.
 * Android VectorDrawable (API 26+) has no Gaussian blur filter, so we clip to the
 * exact official Antigravity arch silhouette and layer four smooth radial gradients
 * matching the exact Google Antigravity rainbow mesh.
 */
function buildAntigravityAndroidXml(svgText) {
  const maskMatch = svgText.match(/<mask\b[^>]*>[\s\S]*?<path\b[^>]*\bd="([^"]+)"/i);
  if (!maskMatch) {
    throw new Error('antigravity.svg: expected <mask> with silhouette <path>');
  }
  const archPath = normalizeAndroidPathData(maskMatch[1], 'antigravity.svg');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generated by npm run sync:icons. Do not edit. -->',
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    '  xmlns:aapt="http://schemas.android.com/aapt"',
    '  android:width="24dp"',
    '  android:height="24dp"',
    '  android:viewportWidth="24"',
    '  android:viewportHeight="24">',
    '  <group>',
    `    <clip-path android:pathData="${archPath}" />`,
    '    <path',
    '      android:fillColor="#FF3186FF"',
    '      android:pathData="M 0 0 H 24 V 24 H 0 Z" />',
    '    <path android:pathData="M 0 0 H 24 V 24 H 0 Z">',
    '      <aapt:attr name="android:fillColor">',
    '        <gradient',
    '          android:type="radial"',
    '          android:centerX="5.5"',
    '          android:centerY="11.5"',
    '          android:gradientRadius="12.5">',
    '          <item android:offset="0" android:color="#FF00B95C" />',
    '          <item android:offset="0.65" android:color="#D900B95C" />',
    '          <item android:offset="1" android:color="#0000B95C" />',
    '        </gradient>',
    '      </aapt:attr>',
    '    </path>',
    '    <path android:pathData="M 0 0 H 24 V 24 H 0 Z">',
    '      <aapt:attr name="android:fillColor">',
    '        <gradient',
    '          android:type="radial"',
    '          android:centerX="10.2"',
    '          android:centerY="2.2"',
    '          android:gradientRadius="10.5">',
    '          <item android:offset="0" android:color="#FFFFE432" />',
    '          <item android:offset="0.55" android:color="#EEFBBC04" />',
    '          <item android:offset="1" android:color="#00FBBC04" />',
    '        </gradient>',
    '      </aapt:attr>',
    '    </path>',
    '    <path android:pathData="M 0 0 H 24 V 24 H 0 Z">',
    '      <aapt:attr name="android:fillColor">',
    '        <gradient',
    '          android:type="radial"',
    '          android:centerX="18.2"',
    '          android:centerY="7.5"',
    '          android:gradientRadius="10.8">',
    '          <item android:offset="0" android:color="#FFFC413D" />',
    '          <item android:offset="0.58" android:color="#DCFC413D" />',
    '          <item android:offset="1" android:color="#00FC413D" />',
    '        </gradient>',
    '      </aapt:attr>',
    '    </path>',
    '    <path android:pathData="M 0 0 H 24 V 24 H 0 Z">',
    '      <aapt:attr name="android:fillColor">',
    '        <gradient',
    '          android:type="radial"',
    '          android:centerX="18.5"',
    '          android:centerY="20.5"',
    '          android:gradientRadius="11.5">',
    '          <item android:offset="0" android:color="#FF3186FF" />',
    '          <item android:offset="0.6" android:color="#CC5592FF" />',
    '          <item android:offset="1" android:color="#003186FF" />',
    '        </gradient>',
    '      </aapt:attr>',
    '    </path>',
    '  </group>',
    '</vector>',
    ''
  ].join('\n');
}

function renderGradientAttr(grad, indent) {
  const lines = [];
  lines.push(`${indent}<aapt:attr name="android:fillColor">`);
  if (grad.type === 'radial') {
    const cx = grad.attrs.cx ?? '12';
    const cy = grad.attrs.cy ?? '12';
    const r = grad.attrs.r ?? '12';
    lines.push(`${indent}  <gradient`);
    lines.push(`${indent}    android:type="radial"`);
    lines.push(`${indent}    android:centerX="${cx}"`);
    lines.push(`${indent}    android:centerY="${cy}"`);
    lines.push(`${indent}    android:gradientRadius="${r}">`);
  } else {
    const x1 = grad.attrs.x1 ?? '0';
    const y1 = grad.attrs.y1 ?? '0';
    const x2 = grad.attrs.x2 ?? '24';
    const y2 = grad.attrs.y2 ?? '24';
    lines.push(`${indent}  <gradient`);
    lines.push(`${indent}    android:type="linear"`);
    lines.push(`${indent}    android:startX="${x1}"`);
    lines.push(`${indent}    android:startY="${y1}"`);
    lines.push(`${indent}    android:endX="${x2}"`);
    lines.push(`${indent}    android:endY="${y2}">`);
  }
  for (const stop of grad.stops) {
    lines.push(`${indent}    <item android:offset="${stop.offset}" android:color="${stop.color}" />`);
  }
  lines.push(`${indent}  </gradient>`);
  lines.push(`${indent}</aapt:attr>`);
  return lines.join('\n');
}

function svgToAndroidXml(slug, svgText) {
  if (slug === 'antigravity') {
    return buildAntigravityAndroidXml(svgText);
  }

  const rootMatch = svgText.match(/<svg\b([^>]*)>/i);
  if (!rootMatch) throw new Error(`${slug}.svg: missing <svg> root`);
  const rootAttrs = parseAttrs(rootMatch[1]);
  const rootStyle = parseStyle(rootAttrs.style);

  if (/\btransform\s*=/.test(svgText)) {
    throw new Error(`${slug}.svg: contains unbaked transform attribute — bake transforms into path coordinates first`);
  }

  const vbParts = String(rootAttrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
  if (vbParts.length !== 4 || vbParts.some((n) => !Number.isFinite(n))) {
    throw new Error(`${slug}.svg: invalid viewBox "${rootAttrs.viewBox || ''}"`);
  }
  const [minX, minY, vw, vh] = vbParts;
  if (minX !== 0 || minY !== 0) {
    throw new Error(`${slug}.svg: non-zero viewBox origin (${minX}, ${minY}) — normalize to 0 0 24 24 first`);
  }

  const gradients = parseGradients(svgText);
  // Strip <defs>...</defs> before scanning drawable <path> elements.
  const body = svgText.replace(/<defs\b[\s\S]*?<\/defs>/gi, '');

  const rootFill = rootAttrs.fill || rootStyle.fill || 'currentColor';
  const rootFillRule = (rootAttrs['fill-rule'] || rootStyle['fill-rule'] || '').toLowerCase();

  let usesAapt = false;
  const pathBlocks = [];
  for (const match of body.matchAll(/<path\b([^>]*)\/?>(?:<\/path>)?/gi)) {
    const attrs = parseAttrs(match[1]);
    const style = parseStyle(attrs.style);
    const d = normalizeAndroidPathData(attrs.d || '', `${slug}.svg`);
    if (!d) continue;

    const rawFill = attrs.fill || style.fill || rootFill;
    const fillRule = (attrs['fill-rule'] || style['fill-rule'] || rootFillRule).toLowerCase();
    const fillOpacity = attrs['fill-opacity'] ?? style['fill-opacity'] ?? attrs.opacity ?? style.opacity;
    const rawStroke = attrs.stroke || style.stroke;
    const strokeWidth = attrs['stroke-width'] || style['stroke-width'];

    const urlMatch = String(rawFill || '').match(/^url\(#([^)]+)\)$/);
    const grad = urlMatch ? gradients.get(urlMatch[1]) : null;
    if (urlMatch && !grad) {
      throw new Error(`${slug}.svg: unresolved gradient fill "${rawFill}"`);
    }

    const xmlAttrs = [];
    if (!grad) {
      const fillColor = normalizeHexToAndroid(rawFill);
      if (fillColor) xmlAttrs.push(`android:fillColor="${fillColor}"`);
    }
    if (fillRule === 'evenodd') {
      xmlAttrs.push('android:fillType="evenOdd"');
    }
    if (fillOpacity !== undefined && Number.isFinite(parseFloat(fillOpacity)) && parseFloat(fillOpacity) < 1) {
      xmlAttrs.push(`android:fillAlpha="${parseFloat(fillOpacity)}"`);
    }
    if (rawStroke && rawStroke.toLowerCase() !== 'none') {
      const strokeColor = normalizeHexToAndroid(rawStroke);
      if (strokeColor) xmlAttrs.push(`android:strokeColor="${strokeColor}"`);
      if (strokeWidth) xmlAttrs.push(`android:strokeWidth="${strokeWidth}"`);
    }
    xmlAttrs.push(`android:pathData="${d}"`);

    if (grad) {
      usesAapt = true;
      pathBlocks.push([
        '  <path',
        ...xmlAttrs.map((a, idx) => `    ${a}${idx === xmlAttrs.length - 1 ? '>' : ''}`),
        renderGradientAttr(grad, '    '),
        '  </path>'
      ].join('\n'));
    } else {
      pathBlocks.push([
        '  <path',
        ...xmlAttrs.map((a, idx) => `    ${a}${idx === xmlAttrs.length - 1 ? ' />' : ''}`)
      ].join('\n'));
    }
  }

  if (pathBlocks.length === 0) {
    throw new Error(`${slug}.svg: no renderable <path> elements found`);
  }

  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generated by npm run sync:icons. Do not edit. -->',
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"'
  ];
  if (usesAapt) lines.push('  xmlns:aapt="http://schemas.android.com/aapt"');
  lines.push(
    '  android:width="24dp"',
    '  android:height="24dp"',
    `  android:viewportWidth="${vw}"`,
    `  android:viewportHeight="${vh}">`,
    ...pathBlocks,
    '</vector>',
    ''
  );
  return lines.join('\n');
}

function buildClientIconsKt(slugs, manifest) {
  const drawableEntries = slugs
    .map((slug) => `    "${slug}" to R.drawable.${toAndroidDrawableName(slug)}`)
    .join(',\n');
  const aliasEntries = Object.entries(manifest.aliases)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, target]) => `    "${id}" to "${target}"`)
    .join(',\n');
  const colorEntries = [...manifest.colorIcons]
    .sort()
    .map((slug) => `    "${slug}"`)
    .join(',\n');

  return `package com.igng.tokenmonitor.android.ui.components

import com.igng.tokenmonitor.android.R

/**
 * Tracked-client and quota-provider brand marks, keyed by the same client id
 * every other surface uses.
 *
 * Generated by \`npm run sync:icons\` from \`src/shared-ui/icons/clients/\`
 * and \`src/shared-ui/icons/manifest.json\`. Do not edit by hand — run the sync
 * script after adding or updating an SVG so Android drawables, [aliases], and
 * [multicolorIds] stay locked to the shared UI.
 */
object ClientIcons {
  private val drawables: Map<String, Int> = mapOf(
${drawableEntries}
  )

  /**
   * Ids that share a mark with another id, mirroring ICON_ALIASES in
   * src/shared-ui/core/data.js. Every target must be a key of [drawables].
   */
  private val aliases: Map<String, String> = mapOf(
${aliasEntries}
  )

  /**
   * Brand marks that carry authored multi-colour or brand-colour artwork and must
   * render with \`Color.Unspecified\` (no single-colour tint) so their layers are
   * not flattened into a solid silhouette.
   */
  private val multicolorIds: Set<String> = setOf(
${colorEntries}
  )

  private fun canonicalKey(clientId: String): String {
    val normalized = clientId.trim().lowercase()
    return aliases[normalized] ?: normalized
  }

  /** 0 when no mark was vendored for this client, i.e. "use the monogram". */
  fun drawable(clientId: String): Int = drawables[canonicalKey(clientId)] ?: 0

  /** True when the resolved drawable carries authored colours and must not be monochrome-tinted. */
  fun isMulticolor(clientId: String): Boolean = multicolorIds.contains(canonicalKey(clientId))
}
`;
}

async function renderDocsBadgePng(svgText, { isColor, color = '#181c24', tileBg = '#f6f8fa' }) {
  const size = 96;
  const iconSize = isColor ? 62 : 58;
  const iconOffset = Math.round((size - iconSize) / 2);

  // For monochrome SVGs, substitute currentColor with the tool's brand tint.
  const preparedSvg = isColor
    ? svgText
    : svgText.replace(/currentColor/gi, color);

  const glyphPng = await sharp(Buffer.from(preparedSvg), { density: 384 })
    .resize(iconSize, iconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const borderStroke = tileBg.toLowerCase() === '#f6f8fa' ? '#d8dee6' : '#d6d45e';
  const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}" rx="22" fill="${tileBg}" stroke="${borderStroke}" stroke-width="1.5"/>
  </svg>`;

  return sharp(Buffer.from(badgeSvg))
    .composite([{ input: glyphPng, left: iconOffset, top: iconOffset }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const slugs = fs.readdirSync(CLIENTS_DIR)
    .filter((name) => name.endsWith('.svg'))
    .map((name) => name.replace(/\.svg$/, ''))
    .sort();
  const slugSet = new Set(slugs);
  const colorSet = new Set(manifest.colorIcons);

  // Sanity check manifest integrity before writing anything.
  for (const c of manifest.colorIcons) {
    if (!slugSet.has(c)) throw new Error(`manifest.colorIcons references missing SVG "${c}"`);
  }
  for (const [id, target] of Object.entries(manifest.aliases)) {
    if (!slugSet.has(target)) throw new Error(`manifest.aliases["${id}"] -> missing SVG "${target}"`);
    if (slugSet.has(id)) throw new Error(`manifest.aliases["${id}"] conflicts with shipped SVG "${id}.svg"`);
  }

  // 1. Sync Android VectorDrawables
  const expectedXmls = new Set();
  for (const slug of slugs) {
    const svgText = fs.readFileSync(path.join(CLIENTS_DIR, `${slug}.svg`), 'utf8');
    const xmlName = `${toAndroidDrawableName(slug)}.xml`;
    expectedXmls.add(xmlName);
    const xmlContent = svgToAndroidXml(slug, svgText);
    fs.writeFileSync(path.join(ANDROID_DRAWABLE_DIR, xmlName), xmlContent, 'utf8');
  }
  // Remove stale client_*.xml drawables no longer in canonical set
  for (const name of fs.readdirSync(ANDROID_DRAWABLE_DIR)) {
    if (name.startsWith('client_') && name.endsWith('.xml') && !expectedXmls.has(name)) {
      fs.unlinkSync(path.join(ANDROID_DRAWABLE_DIR, name));
      console.log(`Removed stale Android drawable: ${name}`);
    }
  }

  // 2. Regenerate ClientIcons.kt
  fs.writeFileSync(ANDROID_CLIENT_ICONS_KT, buildClientIconsKt(slugs, manifest), 'utf8');

  // 3. Mirror SVGs to website/src/assets/icons/clients/
  fs.mkdirSync(WEBSITE_ICONS_DIR, { recursive: true });
  for (const name of fs.readdirSync(WEBSITE_ICONS_DIR)) {
    if (name.endsWith('.svg') && !slugSet.has(name.replace(/\.svg$/, ''))) {
      fs.unlinkSync(path.join(WEBSITE_ICONS_DIR, name));
      console.log(`Removed stale website SVG: ${name}`);
    }
  }
  for (const slug of slugs) {
    fs.copyFileSync(
      path.join(CLIENTS_DIR, `${slug}.svg`),
      path.join(WEBSITE_ICONS_DIR, `${slug}.svg`)
    );
  }

  // 4. Regenerate .github/assets/tools-icon/*.png
  fs.mkdirSync(DOCS_ICONS_DIR, { recursive: true });
  const expectedDocFiles = new Set();
  for (const [docId, spec] of Object.entries(manifest.docsIcons)) {
    if (!slugSet.has(spec.slug)) {
      throw new Error(`manifest.docsIcons["${docId}"] -> missing SVG "${spec.slug}"`);
    }
    const svgText = fs.readFileSync(path.join(CLIENTS_DIR, `${spec.slug}.svg`), 'utf8');
    const outName = `${docId}.png`;
    expectedDocFiles.add(outName);
    const pngBuf = await renderDocsBadgePng(svgText, {
      isColor: colorSet.has(spec.slug),
      color: spec.color || '#181c24',
      tileBg: spec.tileBg || '#f6f8fa'
    });
    fs.writeFileSync(path.join(DOCS_ICONS_DIR, outName), pngBuf);
  }
  for (const name of fs.readdirSync(DOCS_ICONS_DIR)) {
    if (!expectedDocFiles.has(name)) {
      fs.unlinkSync(path.join(DOCS_ICONS_DIR, name));
      console.log(`Removed stale docs icon: ${name}`);
    }
  }

  console.log(
    `Synced ${slugs.length} canonical SVGs -> ` +
    `${expectedXmls.size} Android drawables, ClientIcons.kt, ` +
    `${slugs.length} website SVGs, ${expectedDocFiles.size} docs badge PNGs.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  svgToAndroidXml,
  buildClientIconsKt,
  toAndroidDrawableName,
  normalizeAndroidPathData
};
