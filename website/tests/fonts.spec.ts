import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

// 中文展示字体是按站点用字生成的子集（design/tools/cjk-fonts.py）。文案新增了字而子集没重新生成时，
// 新字会退回系统宋体——这里在构建产物上把关，与生成脚本用同一套取字规则。
const DIST = 'dist';
const REGEN = '先 pnpm build，再 pnpm fonts（需要 fonttools，见 design/tools/requirements.txt），然后重新 build';

const manifest = JSON.parse(readFileSync('src/assets/fonts/noto-serif-sc.chars.json', 'utf8')) as {
  source: string;
  a: string;
  b: string;
  absent: string;
};
const files = readdirSync(DIST, { recursive: true, encoding: 'utf8' });
const html = files.filter((f) => f.endsWith('.html'));
const js = files.filter((f) => f.startsWith('_astro' + sep) && f.endsWith('.js'));
const charsOf = (list: string[]) => {
  const out = new Set<string>();
  for (const f of list) for (const c of readFileSync(join(DIST, f), 'utf8')) if (c.codePointAt(0)! >= 0x20) out.add(c);
  return out;
};
const missing = (seen: Set<string>, ...have: string[]) => {
  const ok = new Set(have.join(''));
  return [...seen].filter((c) => !ok.has(c)).join('');
};

test('子集与锁定的 @fontsource/noto-serif-sc 版本一致', () => {
  const { version } = JSON.parse(readFileSync('node_modules/@fontsource/noto-serif-sc/package.json', 'utf8'));
  expect(manifest.source, REGEN).toBe(`@fontsource/noto-serif-sc@${version}`);
});

test('英文页与脚本里的字都在 a 档子集里', () => {
  const en = html.filter((f) => f.startsWith('en' + sep));
  expect(en.length).toBeGreaterThan(0);
  expect(missing(charsOf([...en, ...js]), manifest.a, manifest.absent), REGEN).toBe('');
});

test('所有页面的字都在子集里', () => {
  expect(missing(charsOf(html), manifest.a, manifest.b, manifest.absent), REGEN).toBe('');
});
