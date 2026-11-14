#!/usr/bin/env node
/**
 * 由高清三维模型静帧母版（hero.png / hero-portrait.png / hero-og.png / mix.png / quota.png / hub.png）
 * 生成站点静态图像资产：
 *   src/assets/renders/{hero,hero-portrait,mix,quota,hub}.webp  Astro 构建期再输出 AVIF / WebP 多尺寸
 *   public/og/og-{zh,en}.jpg                                    1200×630 社交分享卡
 *   public/apple-touch-icon.png                                 180×180
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

const palette = JSON.parse(await readFile(new URL('../tokens.json', import.meta.url), 'utf8')).palette;

await mkdir(join(out, 'src/assets/renders'), { recursive: true });
await mkdir(join(out, 'public/og'), { recursive: true });

const renders = [
  ['hero.png', 'hero.webp', 1920],
  ['hero-portrait.png', 'hero-portrait.webp', 1080],
  ['mix.png', 'mix.webp', 1600],
  ['quota.png', 'quota.webp', 1600],
  ['hub.png', 'hub.webp', 1880],
];

for (const [from, to, width] of renders) {
  const info = await sharp(join(src, from))
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 86, effort: 6, smartSubsample: true })
    .toFile(join(out, 'src/assets/renders', to));
  console.log(to, info.width, 'x', info.height, Math.round(info.size / 1024), 'KB');
}

const mark = (gradId) => `
  <rect width="32" height="32" rx="6" fill="${palette.void}" stroke="${palette.platinum}" stroke-opacity="0.22" stroke-width="1"/>
  <path d="M14.65 6.2A9.9 9.9 0 0 0 7.15 20.3" fill="none" stroke="url(#${gradId})" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M17.35 6.2A9.9 9.9 0 0 1 16 25.9V15.1M11.7 15.1h8.6" fill="none" stroke="url(#${gradId})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="9.35" cy="22.75" r="2.05" fill="${palette.brass}"/>`;

const cards = {
  zh: {
    eyebrow: '本地优先 · AI 用量与配额看板',
    title: '计然 Jiran',
    line1: '59 款 AI 工具与供应商的本地 Token 账本、',
    line2: '模型成本对比与订阅剩余配额看板。',
    foot: '52 TOKEN 统计 · 26 配额监控 · DOCKER COMPOSE 自建同步 · 零遥测',
  },
  en: {
    eyebrow: 'LOCAL-FIRST · AI USAGE &amp; QUOTA DASHBOARD',
    title: 'Jiran · 计然',
    line1: 'Local token usage, model cost comparison &amp;',
    line2: 'plan quota tracking across 59 AI coding tools.',
    foot: '52 TOKEN LEDGERS · 26 QUOTAS · SELF-HOSTED HUB · ZERO TELEMETRY',
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
      <stop offset="0.48" stop-color="${palette.void}" stop-opacity="0.9"/>
      <stop offset="0.72" stop-color="${palette.void}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${palette.void}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="mg" x1="25" y1="4" x2="6" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.platinum}"/>
      <stop offset="0.55" stop-color="${palette.cyan}"/>
      <stop offset="1" stop-color="#299bd1"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  <line x1="68" y1="54" x2="1132" y2="54" stroke="${palette.platinum}" stroke-opacity="0.1" stroke-width="1"/>
  <line x1="68" y1="576" x2="1132" y2="576" stroke="${palette.platinum}" stroke-opacity="0.1" stroke-width="1"/>
  <g transform="translate(68 78) scale(1.55)">${mark('mg')}</g>
  <text x="132" y="108" fill="${palette.cyan}" font-family="${mono}" font-size="14" font-weight="600" letter-spacing="1.6">${c.eyebrow}</text>
  <text x="68" y="264" fill="${palette.platinum}" font-family="${sans}" font-size="88" font-weight="600" letter-spacing="-2">${c.title}</text>
  <text x="70" y="348" fill="${palette.platinum}" font-family="${sans}" font-size="29" font-weight="500">${c.line1}</text>
  <text x="70" y="394" fill="#9ba3b2" font-family="${sans}" font-size="29" font-weight="400">${c.line2}</text>
  <rect x="70" y="522" width="24" height="3" rx="1.5" fill="${palette.cyan}"/>
  <rect x="100" y="522" width="12" height="3" rx="1.5" fill="${palette.brass}"/>
  <text x="124" y="529" fill="#9ba3b2" font-family="${mono}" font-size="13.5" letter-spacing="1.2">${c.foot}</text>
</svg>`);

  await sharp(join(src, 'hero-og.png'))
    .resize(W, H, { fit: 'cover', position: 'center' })
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
      <stop offset="1" stop-color="#299bd1"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" fill="${palette.void}"/>
  <path d="M14.65 6.2A9.9 9.9 0 0 0 7.15 20.3" fill="none" stroke="url(#ig)" stroke-width="2.65" stroke-linecap="round"/>
  <path d="M17.35 6.2A9.9 9.9 0 0 1 16 25.9V15.1M11.7 15.1h8.6" fill="none" stroke="url(#ig)" stroke-width="2.65" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="9.35" cy="22.75" r="2.1" fill="${palette.brass}"/>
</svg>`);
await sharp(icon).png().toFile(join(out, 'public/apple-touch-icon.png'));
console.log('apple-touch-icon.png');
