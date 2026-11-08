import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 首屏预算：实测基线（2026-11，Astro 7 + three 0.186）
//   index.html          150,482 B raw / 30,276 B gzip（CSS 内联，省掉阻塞请求）
//   scene.<hash>.js     571,866 B raw / 143,712 B gzip（three + 刻漏场景）
// 场景是动态 import 的独立 chunk，只在支持 WebGL 且未开启「减少动态」时、load 之后的空闲
// 时间才下载，所以它不参与首屏；这些上限只用来发现「被打回首屏」或「悄悄翻倍」的回归。
// 仓库可能位于含非 ASCII 字符的路径下，fileURLToPath 才会解码。
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
  // 场景 chunk 只能经动态 import 到达；一旦出现在 HTML 里就是首屏回归。
  expect(html).not.toMatch(/_astro\/scene\.[A-Za-z0-9_-]+\.js/);
  expect(html).toContain('<style');
});

test('刻漏场景仍是独立的按需 chunk，体积没有翻倍', () => {
  const chunks = readdirSync(join(DIST, '_astro')).filter((name) => /^scene\..*\.js$/.test(name));
  expect(chunks).toHaveLength(1);
  const { raw, gzip } = page(join('_astro', chunks[0]));
  expect(raw.byteLength).toBeLessThan(900 * 1024);
  expect(gzip.byteLength).toBeLessThan(200 * 1024);
  // three 不允许同时出现在首屏脚本里。
  const hero = readdirSync(join(DIST, '_astro')).filter((name) => /^Hero\.astro.*\.js$/.test(name));
  expect(hero).toHaveLength(1);
  const heroBytes = statSync(join(DIST, '_astro', hero[0])).size;
  expect(heroBytes).toBeLessThan(32 * 1024);
});
