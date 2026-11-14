#!/usr/bin/env node
/**
 * 由 Blender Cycles 静帧母版（hero.png / hero-portrait.png / exploded.png）生成站点静态图像资产：
 *   src/assets/renders/{hero,hero-portrait,exploded}.webp   Astro 构建期再输出 AVIF / WebP 多尺寸
 *   public/og/og-{zh,en}.jpg                                1200×630 社交分享卡
 *   public/apple-touch-icon.png                             180×180
 *
 * 用法：node design/tools/media.mjs <masters-dir> <out-root>
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node design/tools/media.mjs <masters-dir> <out-root>');
  process.exit(1);
}

const palette = JSON.parse(await readFile(new URL('../meter.json', import.meta.url), 'utf8')).palette;

await mkdir(join(out, 'src/assets/renders'), { recursive: true });
await mkdir(join(out, 'public/og'), { recursive: true });

const renders = [
  ['hero.png', 'hero.webp', 2560],
  ['hero-portrait.png', 'hero-portrait.webp', 1080],
  ['exploded.png', 'exploded.webp', 1400],
];
for (const [from, to, width] of renders) {
  const info = await sharp(join(src, from))
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 86, effort: 6, smartSubsample: true })
    .toFile(join(out, 'src/assets/renders', to));
  console.log(to, info.width, 'x', info.height, Math.round(info.size / 1024), 'KB');
}

/** 计然精密标识（与 Mark.astro 同构：开口计量环 + T 字擒纵桥 + 信号原点） */
const mark = (gradId) => `
  <rect width="32" height="32" rx="4" fill="${palette.void}" stroke="${palette.platinum}" stroke-opacity="0.22" stroke-width="1"/>
  <path d="M14.65 6.2A9.9 9.9 0 0 0 7.15 20.3" fill="none" stroke="url(#${gradId})" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M17.35 6.2A9.9 9.9 0 0 1 16 25.9V15.1M11.7 15.1h8.6" fill="none" stroke="url(#${gradId})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="9.35" cy="22.75" r="2.05" fill="${palette.brass}"/>`;

const cards = {
  zh: {
    eyebrow: 'JR-01 · LOCAL-FIRST AI METROLOGY',
    title: '计然 Jiran',
    line1: '59 款 AI 工具与供应商的本地 Token 计量、',
    line2: '模型成本对账与订阅配额光学遥测平台。',
    foot: '52 TOKEN LEDGERS · 26 QUOTAS · DOCKER COMPOSE HUB · ZERO EGRESS',
  },
  en: {
    eyebrow: 'JR-01 · LOCAL-FIRST AI METROLOGY',
    title: 'Jiran · 计然',
    line1: 'Local-first token metering, model cost &amp; quota',
    line2: 'telemetry across 59 AI coding tools &amp; providers.',
    foot: '52 TOKEN LEDGERS · 26 QUOTAS · DOCKER COMPOSE HUB · ZERO EGRESS',
  },
};

const W = 1200;
const H = 630;
for (const [lang, c] of Object.entries(cards)) {
  const sans = "'PingFang SC', 'Noto Sans CJK SC', 'Helvetica Neue', Arial, sans-serif";
  const mono = "'JetBrains Mono', Menlo, Consolas, monospace";
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${palette.void}" stop-opacity="0.98"/>
      <stop offset="0.46" stop-color="${palette.void}" stop-opacity="0.88"/>
      <stop offset="0.76" stop-color="${palette.void}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${palette.void}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="mg" x1="25" y1="4" x2="6" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.platinum}"/>
      <stop offset="0.55" stop-color="${palette.cyan}"/>
      <stop offset="1" stop-color="#2fa4cf"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  <line x1="68" y1="54" x2="1132" y2="54" stroke="${palette.platinum}" stroke-opacity="0.12" stroke-width="1"/>
  <line x1="68" y1="576" x2="1132" y2="576" stroke="${palette.platinum}" stroke-opacity="0.12" stroke-width="1"/>
  <g transform="translate(68 78) scale(1.55)">${mark('mg')}</g>
  <text x="132" y="108" fill="${palette.cyan}" font-family="${mono}" font-size="14" letter-spacing="3.2">${c.eyebrow}</text>
  <text x="68" y="268" fill="${palette.platinum}" font-family="${sans}" font-size="94" font-weight="300" letter-spacing="-2">${c.title}</text>
  <text x="70" y="352" fill="${palette.platinum}" font-family="${sans}" font-size="30" font-weight="400">${c.line1}</text>
  <text x="70" y="398" fill="#9aa1ae" font-family="${sans}" font-size="30" font-weight="300">${c.line2}</text>
  <rect x="70" y="524" width="28" height="2" fill="${palette.cyan}"/>
  <rect x="104" y="524" width="12" height="2" fill="${palette.brass}"/>
  <text x="130" y="530" fill="#9aa1ae" font-family="${mono}" font-size="14" letter-spacing="2.2">${c.foot}</text>
</svg>`);

  await sharp(join(src, 'hero.png'))
    .resize(W, H, { fit: 'cover', position: 'right' })
    .composite([{ input: overlay }])
    .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(join(out, `public/og/og-${lang}.jpg`));
  console.log(`og-${lang}.jpg`);
}

const icon = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="180" height="180">
  <defs>
    <linearGradient id="ig" x1="25" y1="4" x2="6" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.platinum}"/>
      <stop offset="0.55" stop-color="${palette.cyan}"/>
      <stop offset="1" stop-color="#2fa4cf"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" fill="${palette.void}"/>
  <path d="M14.65 6.2A9.9 9.9 0 0 0 7.15 20.3" fill="none" stroke="url(#ig)" stroke-width="2.65" stroke-linecap="round"/>
  <path d="M17.35 6.2A9.9 9.9 0 0 1 16 25.9V15.1M11.7 15.1h8.6" fill="none" stroke="url(#ig)" stroke-width="2.65" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="9.35" cy="22.75" r="2.1" fill="${palette.brass}"/>
</svg>`);
await sharp(icon).png().toFile(join(out, 'public/apple-touch-icon.png'));
console.log('apple-touch-icon.png');
