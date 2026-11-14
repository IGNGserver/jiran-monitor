import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

test('构建产物自托管无衬线与等宽可变字体，且不打包旧版衬线字体', () => {
  const assets = readdirSync(join(DIST, '_astro'));
  expect(assets.some((f) => f.startsWith('instrument-sans-latin-wght-normal.') && f.endsWith('.woff2'))).toBe(true);
  expect(assets.some((f) => f.startsWith('jetbrains-mono-latin-wght-normal.') && f.endsWith('.woff2'))).toBe(true);
  expect(assets.some((f) => f.includes('noto-serif') || f.includes('instrument-serif'))).toBe(false);
});

test('中英文首页均预加载核心可变字体且不引用任何第三方字体域名', () => {
  for (const pagePath of ['index.html', 'en/index.html']) {
    const html = readFileSync(join(DIST, pagePath), 'utf8');
    expect(html).toMatch(/<link rel="preload" href="\/_astro\/instrument-sans-latin-wght-normal\.[^"]+\.woff2"/);
    expect(html).toMatch(/<link rel="preload" href="\/_astro\/jetbrains-mono-latin-wght-normal\.[^"]+\.woff2"/);
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  }
});
