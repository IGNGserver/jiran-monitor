#!/usr/bin/env node
/**
 * 用站点自己的首屏场景（src/scripts/hero/scene.ts）渲染静帧母版，所以静帧与实时画面同源。
 * 场景是 f(种子, 时间) 的纯函数：同一个 t 每次渲染出的画面完全一致。
 *
 * 用法：node design/tools/stills.mjs <站点地址> <母版输出目录>
 *   例：pnpm dev（或 pnpm build && pnpm preview）后
 *       node design/tools/stills.mjs http://127.0.0.1:4321/ ~/.build/计然-site/masters
 * 之后用 design/tools/media.mjs 把母版转成站点图片。需要 Playwright 的 Chromium。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
if (!base || !out) {
  console.error('usage: node design/tools/stills.mjs <site-url> <masters-dir>');
  process.exit(1);
}

/** [文件名, 机位, 宽, 高, 场景时刻（秒）] */
const SHOTS = [
  ['wide-base.png', 'wide', 2400, 1260, 41.3],
  ['tall-base.png', 'tall', 1200, 1800, 41.3],
  ['macro-base.png', 'macro', 1600, 1600, 47.9],
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
for (const [file, view, w, h, t] of SHOTS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.error(`[${file}]`, e.message));
  const url = new URL(base);
  url.search = new URLSearchParams({ still: view, t: String(t), w: String(w), h: String(h) }).toString();
  await page.goto(url.href);
  await page.waitForFunction(() => window.__heroStill, null, { timeout: 180_000 });
  const data = await page.evaluate(() => window.__heroStill);
  await writeFile(join(out, file), Buffer.from(data.split(',')[1], 'base64'));
  console.log(file, w, 'x', h);
  await page.close();
}
await browser.close();
