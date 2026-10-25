import { defineConfig, devices } from '@playwright/test';

/**
 * 端到端检查：对 `astro build` 的产物起 `astro preview`，在 Chromium 里跑。
 * 软件 WebGL（SwiftShader）保证在无 GPU 的 CI / 虚拟机上也能真正渲染首屏场景。
 */
export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4322',
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    // Astro 7 检测到 AI agent 环境（AI_AGENT / CLAUDECODE）时会把 preview 转入后台，
    // Playwright 就无法在测试结束后关掉它；清掉这两个变量，保持与 CI 一致的前台行为。
    command: 'env -u AI_AGENT -u CLAUDECODE pnpm exec astro preview --port 4322 --host 127.0.0.1',
    url: 'http://127.0.0.1:4322/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
