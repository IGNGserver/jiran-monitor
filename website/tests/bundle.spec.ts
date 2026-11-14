import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 首屏预算：Astro 7 + three 0.186 + gltfpack meshopt GLB
// 三维遥测机芯（scene.<hash>.js + models/meter.glb）是动态 import 的独立按需资产，
// 仅在支持 WebGL 且未开启「减少动态」时于页面 load 后空闲时间按需加载，不阻塞首屏。
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

function page(name: string) {
  const raw = readFileSync(join(DIST, name));
  return { raw, gzip: gzipSync(raw) };
}

test('首屏 HTML 保持在预算内且不静态引用 3D 场景', () => {
  for (const name of ['index.html', 'en/index.html']) {
    const { gzip } = page(name);
    expect(gzip.byteLength, `${name} gzip`).toBeLessThan(64 * 1024);
  }
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  expect(html).not.toMatch(/_astro\/scene\.[A-Za-z0-9_-]+\.js/);
  expect(html).toContain('<style');
});

test('JR-01 3D 场景、导演入口与压缩 GLB 模型均在预算内', () => {
  const chunks = readdirSync(join(DIST, '_astro')).filter((name) => /^scene\..*\.js$/.test(name));
  expect(chunks).toHaveLength(1);
  const { raw, gzip } = page(join('_astro', chunks[0]));
  expect(raw.byteLength).toBeLessThan(900 * 1024);
  expect(gzip.byteLength).toBeLessThan(200 * 1024);

  const stage = readdirSync(join(DIST, '_astro')).filter((name) => /^Stage\.astro.*\.js$/.test(name));
  expect(stage).toHaveLength(1);
  const stageBytes = statSync(join(DIST, '_astro', stage[0])).size;
  expect(stageBytes).toBeLessThan(32 * 1024);

  const glb = page('models/meter.glb');
  expect(glb.raw.byteLength).toBeLessThan(700 * 1024);
  expect(glb.gzip.byteLength).toBeLessThan(260 * 1024);
});
