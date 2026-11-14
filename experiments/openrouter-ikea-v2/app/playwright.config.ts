import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests', workers: 1,
  use: { launchOptions: { executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] } },
});
