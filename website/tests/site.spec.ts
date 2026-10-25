import { expect, test, type Page } from '@playwright/test';

const PAGES = [
  { path: '/', lang: 'zh-CN', title: /计然/ },
  { path: '/en/', lang: 'en', title: /Jiran/ },
];

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // 第三方请求（GitHub API）在离线 CI 里可能失败，页面会退回构建时的版本信息，不算错误
    if (m.type() === 'error' && !/api\.github\.com|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

for (const p of PAGES) {
  test.describe(p.path, () => {
    test('加载无脚本错误，语言与标题正确', async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto(p.path);
      await expect(page).toHaveTitle(p.title);
      await expect(page.locator('html')).toHaveAttribute('lang', p.lang);
      await expect(page.locator('h1')).toHaveCount(1);
      await page.waitForTimeout(1500);
      expect(errors).toEqual([]);
    });

    test('页内锚点都有目标，图片都有 alt', async ({ page }) => {
      await page.goto(p.path);
      const missing = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
          .map((a) => a.getAttribute('href')!.slice(1))
          .filter((id) => id && !document.getElementById(id)),
      );
      expect(missing).toEqual([]);
      expect(await page.locator('img:not([alt])').count()).toBe(0);
    });

    test('首屏实时场景启动（软件 WebGL）', async ({ page }) => {
      await page.goto(p.path);
      await expect(page.locator('[data-hero]')).toHaveClass(/is-live/, { timeout: 15_000 });
      await expect(page.locator('[data-counter-n]')).not.toHaveText('~0', { timeout: 10_000 });
    });

    for (const width of [360, 768, 1440]) {
      test(`${width}px 无横向滚动`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(p.path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  });
}

test('减少动态时不启动 WebGL，保留静帧', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForTimeout(2500);
  await expect(page.locator('[data-hero]')).not.toHaveClass(/is-live/);
  await expect(page.locator('.hero__poster img')).toBeVisible();
  await ctx.close();
});

test('静帧模式：同一场景渲染出 PNG（design/tools/stills.mjs 依赖它）', async ({ page }) => {
  await page.goto('/?still=wide&t=41.3&w=480&h=252');
  await page.waitForFunction(() => (window as Window & { __heroStill?: string }).__heroStill?.startsWith('data:image/png'), null, {
    timeout: 30_000,
  });
});

test('来源筛选：会话明细只剩 5 个高亮', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-filter="s"]').click();
  await expect(page.locator('[data-src-wall]')).toHaveAttribute('data-filter', 's');
  expect(await page.locator('[data-src-wall] li[data-s]').count()).toBe(5);
});

test('下载区：标签页可用键盘切换', async ({ page }) => {
  await page.goto('/en/');
  const first = page.locator('[data-platform]').first();
  await first.focus();
  await page.keyboard.press('ArrowRight');
  const selected = page.locator('[data-platform][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(page.locator('[data-panel]:not([hidden])')).toHaveCount(1);
});

test('404 页面', async ({ page }) => {
  const res = await page.goto('/this-does-not-exist/');
  expect(res?.status()).toBe(404);
  await expect(page.locator('h1')).toContainText('没有被计入');
});
