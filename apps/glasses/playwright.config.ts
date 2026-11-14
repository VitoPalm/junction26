import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 600, height: 600 },
    launchOptions: { executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] },
  },
  webServer: {
    command: 'npm run dev -- --strictPort',
    url: 'http://127.0.0.1:5174/glasses/',
    reuseExistingServer: !process.env.CI,
  },
});
