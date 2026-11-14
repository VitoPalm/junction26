import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests',
  workers: 1,
  use: { viewport: { width: 600, height: 600 }, launchOptions: { executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] } },
  webServer: [{ command: 'npm run dev -- --host 127.0.0.1 --port 4181 --strictPort', url: 'http://127.0.0.1:4181', reuseExistingServer: true }, { command: 'npm --prefix ../../experiments/openrouter-ikea/app run dev -- --host 127.0.0.1 --port 4180 --strictPort', url: 'http://127.0.0.1:4180', reuseExistingServer: true }],
});
