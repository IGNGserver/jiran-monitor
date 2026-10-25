#!/usr/bin/env node
/**
 * 由静帧母版（PNG，design/tools/stills.mjs 的输出）生成站点用的图片资产。设计期运行，产物提交进仓库：
 *   src/assets/renders/kelou-{wide,tall,macro}.webp   Astro 构建时再按视口生成多尺寸
 *   public/og/og-{zh,en}.jpg                           1200×630 社交卡片（静帧 + 标题）
 *   public/apple-touch-icon.png                        180×180
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

const palette = JSON.parse(await readFile(new URL('../kelou.json', import.meta.url), 'utf8')).palette;

await mkdir(join(out, 'src/assets/renders'), { recursive: true });
await mkdir(join(out, 'public/og'), { recursive: true });

const renders = [
  ['wide-base.png', 'kelou-wide.webp', 2400],
  ['tall-base.png', 'kelou-tall.webp', 1200],
  ['macro-base.png', 'kelou-macro.webp', 1600],
];
for (const [from, to, width] of renders) {
  const info = await sharp(join(src, from))
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 86, effort: 6, smartSubsample: true })
    .toFile(join(out, 'src/assets/renders', to));
  console.log(to, info.width, 'x', info.height, Math.round(info.size / 1024), 'KB');
}

/** 标识：开口刻度环 + 指针刻线 + 一滴朱砂（与 src/components/Mark.astro 同一几何） */
const mark = (stroke, drop, width = 2) => `
    <circle cx="16" cy="16" r="10" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-dasharray="54.8 8" transform="rotate(-69 16 16)" stroke-linecap="round"/>
    <path d="M16 7.6v5.2" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>
    <path d="M8.9 18.6c1.6 2.2 3.2 3.6 3.2 5.2a3.2 3.2 0 0 1-6.4 0c0-1.6 1.6-3 3.2-5.2z" fill="${drop}"/>`;

/** 社交卡片：左侧铺纸色留出标题区，右侧是刻漏。文字用 SVG 叠加。 */
const cards = {
  zh: { title: '计然', motto: '点滴有数', line1: '把 AI 编程工具的 Token、成本与额度', line2: '一滴一滴，先在本机算清楚。', foot: 'JIRAN · 59 SOURCES · LOCAL-FIRST · NO TELEMETRY' },
  en: { title: 'Jiran', motto: 'Every drop, counted.', line1: 'Token, cost and quota metering', line2: 'for AI coding tools, counted locally.', foot: '计然 · 59 SOURCES · LOCAL-FIRST · NO TELEMETRY' },
};
const W = 1200;
const H = 630;
for (const [lang, c] of Object.entries(cards)) {
  const zh = lang === 'zh';
  const serif = zh ? "'Songti SC', 'Noto Serif CJK SC', serif" : "'Instrument Serif', 'Times New Roman', serif";
  const sans = "'PingFang SC', 'Helvetica Neue', Arial, sans-serif";
  const motto = zh
    ? [...c.motto].map((ch, i) => `<text x="470" y="${190 + i * 38}" fill="${palette.inkDim}" font-family="${serif}" font-size="28" text-anchor="middle">${ch}</text>`).join('')
    : `<text x="72" y="372" fill="${palette.inkDim}" font-family="${serif}" font-style="italic" font-size="40">${c.motto}</text>`;
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${palette.paper}" stop-opacity="0.96"/>
      <stop offset="0.44" stop-color="${palette.paper}" stop-opacity="0.78"/>
      <stop offset="0.66" stop-color="${palette.paper}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  <g transform="translate(70 62) scale(1.6)">${mark(palette.ink, palette.cinnabar)}</g>
  <text x="66" y="${zh ? 318 : 300}" fill="${palette.ink}" font-family="${serif}" font-size="${zh ? 168 : 180}" font-weight="${zh ? 600 : 400}" letter-spacing="${zh ? 12 : -2}">${c.title}</text>
  ${motto}
  <text x="72" y="436" fill="${palette.ink}" font-family="${sans}" font-size="30">${c.line1}</text>
  <text x="72" y="478" fill="${palette.inkDim}" font-family="${sans}" font-size="30">${c.line2}</text>
  <rect x="72" y="536" width="28" height="2" fill="${palette.cinnabar}"/>
  <text x="114" y="543" fill="${palette.inkFaint}" font-family="Menlo, monospace" font-size="15" letter-spacing="3">${c.foot}</text>
</svg>`);
  await sharp(join(src, 'wide-base.png'))
    .resize(W, H, { fit: 'cover', position: 'right' })
    .composite([{ input: overlay }])
    .jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(join(out, `public/og/og-${lang}.jpg`));
  console.log(`og-${lang}.jpg`);
}

const icon = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="180" height="180"><rect width="32" height="32" fill="${palette.paper}"/><g transform="translate(1.6 1.6) scale(0.9)">${mark(palette.ink, palette.cinnabar, 2.2)}</g></svg>`);
await sharp(icon).png().toFile(join(out, 'public/apple-touch-icon.png'));
console.log('apple-touch-icon.png');
