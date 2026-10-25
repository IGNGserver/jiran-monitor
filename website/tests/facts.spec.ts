import { expect, test } from '@playwright/test';
import { COUNTS, TOOLS } from '../src/data/product';
import { findStableRelease, pickStable } from '../src/data/release';
import { CONTENT } from '../src/i18n/content';

// 站点上的数字必须与支持矩阵自洽（产品 README「Supported tools」表）
test('支持矩阵计数与 README 一致', () => {
  expect(TOOLS).toHaveLength(COUNTS.rows);
  expect(TOOLS.filter((t) => t.u)).toHaveLength(COUNTS.usage);
  expect(TOOLS.filter((t) => t.l)).toHaveLength(COUNTS.limits);
  expect(TOOLS.filter((t) => t.s)).toHaveLength(COUNTS.sessions);
  expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
});

test('首屏统计数字来自同一份计数', () => {
  for (const lang of ['zh', 'en'] as const) {
    const n = CONTENT[lang].hero.stats.map((s) => s.n);
    expect(n).toEqual([String(COUNTS.rows), String(COUNTS.usage), String(COUNTS.limits), '0']);
  }
});

test('正式版不在第一页时仍能找到', async () => {
  const release = (tag: string, prerelease: boolean, assets: { name: string; size: number }[] = []) => ({
    tag_name: tag,
    published_at: '2026-01-01T00:00:00Z',
    draft: false,
    prerelease,
    assets,
  });
  const pages: Record<string, unknown[]> = {
    '1': Array.from({ length: 30 }, (_, i) => release(`v9.9.${i}`, true)),
    '2': [release('v1.2.1', false)],
  };
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const page = new URL(url).searchParams.get('page') ?? '1';
    return { ok: true, json: async () => pages[page] ?? [] } as Response;
  }) as typeof fetch;

  const info = await findStableRelease('owner/repo', {}, fakeFetch);
  expect(info?.tag).toBe('v1.2.1');
  expect(calls).toHaveLength(2);
});

test('发布链接只由仓库常量和安全段构造', () => {
  const info = pickStable([
    {
      tag_name: 'v1.2.1',
      published_at: '2026-01-01T00:00:00Z',
      draft: false,
      prerelease: false,
      assets: [{ name: 'Jiran-1.2.1.deb', size: 1 }],
    },
  ]);
  expect(info?.url).toBe('https://github.com/IGNGserver/jiran-monitor/releases/tag/v1.2.1');
  expect(info?.assets.deb?.url).toBe(
    'https://github.com/IGNGserver/jiran-monitor/releases/download/v1.2.1/Jiran-1.2.1.deb',
  );
  expect(
    pickStable([
      {
        tag_name: 'bad/tag',
        published_at: '2026-01-01T00:00:00Z',
        draft: false,
        prerelease: false,
        assets: [],
      },
    ]),
  ).toBeNull();
});

test('中英文案结构一致', () => {
  const shape = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;
  expect(shape(CONTENT.en)).toEqual(shape(CONTENT.zh));
});
