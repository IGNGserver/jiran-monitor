import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 首屏预算：Astro 7 + three 0.186 + gltfpack meshopt GLB
// 四组 Token 主题三维模型及其渲染器（runtime.<hash>.js + models/{hero,mix,quota,hub}.glb）
// 均为动态 import 的独立按需资产，仅在支持 WebGL 且未开启「减少动态」时于 load 后空闲加载。
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

function page(name: string) {
  const raw = readFileSync(join(DIST, name));
  return { raw, gzip: gzipSync(raw) };
}

test('首屏 HTML 保持在预算内且不静态引用 3D 渲染引擎', () => {
  for (const name of ['index.html', 'en/index.html']) {
    const { gzip } = page(name);
    expect(gzip.byteLength, `${name} gzip`).toBeLessThan(64 * 1024);
  }
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  expect(html).not.toMatch(/_astro\/runtime\.[A-Za-z0-9_-]+\.js/);
  expect(html).toContain('<style');
});

test('Token 三维模型渲染引擎、引导入口与四组压缩 GLB 均在预算内', () => {
  const chunks = readdirSync(join(DIST, '_astro')).filter((name) => /^runtime\..*\.js$/.test(name));
  expect(chunks).toHaveLength(1);
  const { raw, gzip } = page(join('_astro', chunks[0]));
  expect(raw.byteLength).toBeLessThan(900 * 1024);
  expect(gzip.byteLength).toBeLessThan(200 * 1024);

  const boot = readdirSync(join(DIST, '_astro')).filter((name) => /^ModelStage\.astro.*\.js$/.test(name));
  expect(boot).toHaveLength(1);
  const bootBytes = statSync(join(DIST, '_astro', boot[0])).size;
  expect(bootBytes).toBeLessThan(32 * 1024);

  let totalRaw = 0;
  let totalGzip = 0;
  for (const id of ['hero', 'mix', 'quota', 'hub']) {
    const glb = page(`models/${id}.glb`);
    expect(glb.raw.byteLength, `${id}.glb raw`).toBeLessThan(180 * 1024);
    totalRaw += glb.raw.byteLength;
    totalGzip += glb.gzip.byteLength;
  }
  expect(totalRaw).toBeLessThan(600 * 1024);
  expect(totalGzip).toBeLessThan(240 * 1024);
});
