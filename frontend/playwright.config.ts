import { defineConfig } from '@playwright/test';

/**
 * PIMS 前端收口测试（Playwright）。
 *
 * - 默认跑 Mock 模式：webServer 自动起 `npm run dev`（VITE_USE_MOCK=true），无需后端、数据每次全新。
 * - 复用系统已安装的 Edge（channel: 'msedge'），不额外下载浏览器。
 * - 想跑真后端：PIMS_BASE=http://127.0.0.1:5173 PIMS_NO_WEBSERVER=1 npx playwright test
 */
const PORT = Number(process.env.PIMS_DEV_PORT || 5273);
const BASE = process.env.PIMS_BASE || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: BASE,
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'edge', use: { channel: 'msedge' } }],
  webServer: process.env.PIMS_NO_WEBSERVER
    ? undefined
    : {
        command: `npm run dev -- --port ${PORT} --strictPort`,
        url: BASE,
        reuseExistingServer: true,
        timeout: 120_000,
        env: { VITE_USE_MOCK: 'true' },
      },
});
