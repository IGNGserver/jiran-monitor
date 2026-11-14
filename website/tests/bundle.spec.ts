import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 首屏预算：Astro 7 + three 0.186
// 三维遥测核心（scene.<hash>.js）是动态 import 的独立 chunk，仅在支持 WebGL2 且未开启
// 「减少动态」时于页面 load 后空闲时间按需加载，不阻塞首屏。
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

test('计算遥测 3D 场景仍是独立的按需 chunk，体积在预算内', () => {
  const chunks = readdirSync(join(DIST, '_astro')).filter((name) => /^scene\..*\.js$/.test(name));
  expect(chunks).toHaveLength(1);
  const { raw, gzip } = page(join('_astro', chunks[0]));
  expect(raw.byteLength).toBeLessThan(900 * 1024);
  expect(gzip.byteLength).toBeLessThan(200 * 1024);

  const hero = readdirSync(join(DIST, '_astro')).filter((name) => /^Hero\.astro.*\.js$/.test(name));
  expect(hero).toHaveLength(1);
  const heroBytes = statSync(join(DIST, '_astro', hero[0])).size;
  expect(heroBytes).toBeLessThan(32 * 1024);
});
