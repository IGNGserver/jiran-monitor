#!/usr/bin/env node
/**
 * 由静帧母版（PNG，design/tools/stills.mjs 的输出）生成站点用的图片资产。设计期运行，产物提交进仓库：
 *   src/assets/renders/hero-{wide,tall,macro}.webp   Astro 构建时再按视口生成多尺寸
 *   public/og/og-{zh,en}.jpg                         1200×630 社交卡片（静帧 + 标题）
 *   public/apple-touch-icon.png                      180×180
 *
 * 用法：node design/tools/media.mjs <母版目录> <输出根目录>
 * 母版目录里应有 wide-base.png、tall-base.png、macro-base.png。需要 sharp（随 astro 安装）。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node design/tools/media.mjs <masters-dir> <out-root>');
  process.exit(1);
}

const palette = JSON.parse(await readFile(new URL('../palette.json', import.meta.url), 'utf8')).palette;

await mkdir(join(out, 'src/assets/renders'), { recursive: true });
await mkdir(join(out, 'public/og'), { recursive: true });

const renders = [
  ['wide-base.png', 'hero-wide.webp', 2400],
  ['tall-base.png', 'hero-tall.webp', 1200],
  ['macro-base.png', 'hero-macro.webp', 1600],
];
for (const [from, to, width] of renders) {
  const info = await sharp(join(src, from))
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 86, effort: 6, smartSubsample: true })
    .toFile(join(out, 'src/assets/renders', to));
  console.log(to, info.width, 'x', info.height, Math.round(info.size / 1024), 'KB');
}

/** 标识：与 src/components/Mark.astro 同一几何（开口计量环 + T 形中轴 + 信号原点） */
const mark = (gradId) => `
  <rect width="32" height="32" rx="7.5" fill="#050a18" stroke="#38bdf8" stroke-opacity="0.35" stroke-width="1"/>
  <path d="M14.65 6.2A9.9 9.9 0 0 0 7.15 20.3" fill="none" stroke="url(#${gradId})" stroke-width="2.75" stroke-linecap="round"/>
  <path d="M17.35 6.2A9.9 9.9 0 0 1 16 25.9V15.1M11.7 15.1h8.6" fill="none" stroke="url(#${gradId})" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="9.35" cy="22.75" r="2.1" fill="#38bdf8"/>`;

const cards = {
  zh: {
    eyebrow: 'LOCAL-FIRST AI TELEMETRY',
    title: '计然 Jiran',
    line1: '59 款 AI 编程工具与供应商的本地 Token、',
    line2: '模型成本拆解与订阅额度遥测平台。',
    foot: '52 USAGE · 26 QUOTAS · DOCKER COMPOSE HUB · ZERO TELEMETRY',
  },
  en: {
    eyebrow: 'LOCAL-FIRST AI TELEMETRY',
    title: 'Jiran · 计然',
    line1: 'Token usage, model cost &amp; plan quota telemetry',
    line2: 'across 59 AI coding tools — metered locally.',
    foot: '52 USAGE · 26 QUOTAS · DOCKER COMPOSE HUB · ZERO TELEMETRY',
  },
};

const W = 1200;
const H = 630;
for (const [lang, c] of Object.entries(cards)) {
  const sans = "'PingFang SC', 'Helvetica Neue', Arial, sans-serif";
  const mono = "'JetBrains Mono', Menlo, Consolas, monospace";
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${palette.bg}" stop-opacity="0.97"/>
      <stop offset="0.48" stop-color="${palette.bg}" stop-opacity="0.84"/>
      <stop offset="0.78" stop-color="${palette.bg}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="${palette.bg}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="mg" x1="25" y1="4" x2="6" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.cyan}"/>
      <stop offset="0.52" stop-color="${palette.cobalt}"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  <g transform="translate(68 64) scale(1.65)">${mark('mg')}</g>
  <text x="136" y="96" fill="${palette.cyan}" font-family="${mono}" font-size="15" letter-spacing="3">${c.eyebrow}</text>
  <text x="68" y="258" fill="${palette.ink}" font-family="${sans}" font-size="96" font-weight="700" letter-spacing="-2">${c.title}</text>
  <text x="70" y="346" fill="${palette.ink}" font-family="${sans}" font-size="31" font-weight="500">${c.line1}</text>
  <text x="70" y="394" fill="${palette.inkDim}" font-family="${sans}" font-size="31">${c.line2}</text>
  <rect x="70" y="518" width="36" height="3" rx="1.5" fill="${palette.cyan}"/>
  <text x="120" y="525" fill="${palette.inkDim}" font-family="${mono}" font-size="15" letter-spacing="2.2">${c.foot}</text>
</svg>`);

  await sharp(join(src, 'wide-base.png'))
    .resize(W, H, { fit: 'cover', position: 'right' })
    .composite([{ input: overlay }])
    .jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(join(out, `public/og/og-${lang}.jpg`));
  console.log(`og-${lang}.jpg`);
}

const icon = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="180" height="180">
  <defs>
    <linearGradient id="ig" x1="25" y1="4" x2="6" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.cyan}"/>
      <stop offset="0.52" stop-color="${palette.cobalt}"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" fill="#040814"/>
  <path d="M14.65 6.2A9.9 9.9 0 0 0 7.15 20.3" fill="none" stroke="url(#ig)" stroke-width="2.75" stroke-linecap="round"/>
  <path d="M17.35 6.2A9.9 9.9 0 0 1 16 25.9V15.1M11.7 15.1h8.6" fill="none" stroke="url(#ig)" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="9.35" cy="22.75" r="2.1" fill="${palette.cyan}"/>
</svg>`);
await sharp(icon).png().toFile(join(out, 'public/apple-touch-icon.png'));
console.log('apple-touch-icon.png');
