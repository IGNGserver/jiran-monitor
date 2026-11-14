#!/usr/bin/env node
/**
 * 从构建产物 dist/ 启动本地临时静态服务，通过无头 Chromium + SwiftShader WebGL2
 * 采集四组 Token 模型的确定性高清静帧母版（PNG）：
 *   hero.png, hero-portrait.png, hero-og.png, mix.png, quota.png, hub.png
 *
 * 用法（在本地构建区 $BUILD_SCRATCH_ROOT 内执行，先确保已完成首次 astro build）：
 *   node design/tools/stills.mjs <out-masters-dir>
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const distDir = join(root, 'dist');
const outDir = resolve(process.argv[2] || join(root, '.tmp-masters'));

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`[stills] dist/index.html not found in ${distDir}; run astro build first.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
};

const server = createServer((req, res) => {
  const urlPath = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = join(distDir, rel);
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
  res.end(readFileSync(filePath));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
const baseUrl = `http://127.0.0.1:${addr.port}`;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const keys = ['hero', 'hero-portrait', 'hero-og', 'mix', 'quota', 'hub'];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  for (const key of keys) {
    await page.goto(`${baseUrl}/?still=${key}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__MODEL_STILL__), null, { timeout: 30_000 });
    const dataUrl = await page.evaluate(() => window.__MODEL_STILL__);
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    const target = join(outDir, `${key}.png`);
    writeFileSync(target, buf);
    console.log(`[stills] ${key}.png -> ${(buf.byteLength / 1024).toFixed(1)} KB`);
  }
} finally {
  await browser.close();
  server.close();
}
