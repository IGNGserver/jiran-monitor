import { expect, test, type Page } from '@playwright/test';

const PAGES = [
  { path: '/', lang: 'zh-CN', title: /计然/ },
  { path: '/en/', lang: 'en', title: /Jiran/ },
];

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
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
      await page.waitForTimeout(1200);
      expect(errors).toEqual([]);
    });

    test('页内锚点都有目标，所有图片都有 alt（含动态渲染的工作台图标）', async ({ page }) => {
      await page.goto(p.path);
      const missing = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
          .map((a) => a.getAttribute('href')!.slice(1))
          .filter((id) => id && !document.getElementById(id)),
      );
      expect(missing).toEqual([]);
      expect(await page.locator('img:not([alt])').count()).toBe(0);
    });

    test('首屏三维遥测核心启动（软件 WebGL2）', async ({ page }) => {
      await page.goto(p.path);
      await expect(page.locator('[data-hero]')).toHaveClass(/is-live/, { timeout: 15_000 });
      await expect(page.locator('[data-counter-n]')).not.toHaveText('0', { timeout: 10_000 });
    });

    test('交互式工作台：场景切换、ISO 周一窗口、币种与亮暗主题均真实联动', async ({ page }) => {
      await page.goto(p.path);
      const wb = page.locator('[data-workbench]');
      await expect(wb).toBeVisible();

      const dayHero = await wb.locator('.wb-hero-big').textContent();
      await wb.locator('[data-wb-period="week"]').click();
      await expect(wb.locator('[data-wb-meta]')).toContainText('ISO Mon');
      const weekHero = await wb.locator('.wb-hero-big').textContent();
      expect(weekHero).not.toBe(dayHero);

      // 切换币种与 Fluent 2 浅色主题
      await wb.locator('[data-wb-currency]').click();
      await expect(wb.locator('[data-wb-currency]')).toHaveText('CNY');
      await wb.locator('[data-wb-theme-toggle]').click();
      await expect(wb).toHaveAttribute('data-wb-theme', 'light');

      // 导览切换至模型工作台并展开 CSV 预览
      await page.locator('[data-wb-scenario="models"]').click();
      await expect(wb.locator('.wb-cmp-card')).toHaveCount(3);
      await wb.locator('[data-wb-csv-toggle]').click();
      await expect(wb.locator('.wb-csv-box')).toContainText('claude-opus-4-6');

      // 切换至工具子页查看 Qoder 独立 Credits 与无波浪号诚实披露
      await wb.locator('[data-wb-utab="tools"]').click();
      await wb.locator('[data-wb-tool="qoder"]').click();
      await expect(wb.locator('.wb-honest-note')).toBeVisible();
      await expect(wb.locator('.wb-main')).toContainText('120 Credits');
    });

    for (const width of [360, 768, 1024, 1440]) {
      test(`${width}px 视口无横向滚动溢出`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(p.path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  });
}

test('减少动态时不启动 WebGL，保留静帧海报', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForTimeout(2000);
  await expect(page.locator('[data-hero]')).not.toHaveClass(/is-live/);
  await expect(page.locator('.hero__poster img')).toBeVisible();
  await ctx.close();
});

test('静帧模式：同一场景确定性渲染出 PNG（design/tools/stills.mjs 依赖它）', async ({ page }) => {
  await page.goto('/?still=wide&t=41.3&w=480&h=252');
  await page.waitForFunction(() => (window as Window & { __heroStill?: string }).__heroStill?.startsWith('data:image/png'), null, {
    timeout: 30_000,
  });
});

test('来源矩阵：按能力筛选与实时搜索均生效', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-filter="s"]').click();
  await expect(page.locator('[data-src-wall]')).toHaveAttribute('data-filter', 's');
  expect(await page.locator('[data-src-wall] li[data-s]').count()).toBe(5);
  expect(await page.locator('[data-src-wall] li:visible').count()).toBe(5);

  await page.locator('[data-filter="all"]').click();
  await page.locator('[data-src-search]').fill('qoder');
  expect(await page.locator('[data-src-wall] li:visible').count()).toBe(1);
});

test('下载区：标签页支持键盘左右方向键切换', async ({ page }) => {
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
  await expect(page.locator('h1')).toContainText('不在遥测索引中');
});
