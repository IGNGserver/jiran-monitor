import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// dist/_headers 由 public/_headers 与 src/integrations/early-hints.mjs 共同生成，部署后 Cloudflare Pages 照此下发响应头
const headers = readFileSync('dist/_headers', 'utf8');

/** _headers 里某条路径规则下的所有头（到下一条规则或空行为止） */
function rule(path: string) {
  const lines = headers.split('\n');
  const start = lines.indexOf(path);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    out.push(line.trim());
  }
  return out;
}

test('带哈希的构建产物永久缓存', () => {
  expect(rule('/_astro/*')).toContain('Cache-Control: public, max-age=31536000, immutable');
});

test('所有页面都下发不改变行为的安全头', () => {
  const glob = rule('/*');
  for (const header of [
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'X-Frame-Options: DENY',
    'Cross-Origin-Opener-Policy: same-origin',
  ]) {
    expect(glob).toContain(header);
  }
  expect(glob.some((line) => line.startsWith('Permissions-Policy:') && line.includes('camera=()'))).toBe(true);
});

for (const [path, file] of [['/', 'dist/index.html'], ['/en/', 'dist/en/index.html']]) {
  test(`${path} 的预加载都有对应的 Link 头（103 Early Hints）`, () => {
    const hrefs = [...readFileSync(file, 'utf8').matchAll(/<link rel="preload" href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    const links = rule(path);
    for (const href of hrefs) expect(links).toContain(`Link: <${href}>; rel=preload; as=font; type="font/woff2"; crossorigin`);
  });
}
