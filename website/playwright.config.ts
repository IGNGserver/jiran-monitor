import { defineConfig, devices } from '@playwright/test';

/**
 * 端到端检查：对 `astro build` 的产物起 `astro preview`，在 Chromium 里跑。
 * 软件 WebGL（SwiftShader）保证在无 GPU 的 CI / 虚拟机上也能真正渲染三维计量舞台。
 */
export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4322',
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    // `--ignore-lock` 让 Astro 7 在任何 AI Agent 或本地环境下均以前台一次性进程启动，结束后由 Playwright 干净回收。
    command: 'pnpm exec astro preview --port 4322 --host 127.0.0.1 --ignore-lock',
    url: 'http://127.0.0.1:4322/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
