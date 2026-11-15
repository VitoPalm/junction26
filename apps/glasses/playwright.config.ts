import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 600, height: 600 },
    // NATIVE_WEBMCP=1: Chrome's own document.modelContext instead of the dev stub (webmcp-native.spec.ts).
    launchOptions: { executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable', args: ['--no-sandbox', ...(process.env.NATIVE_WEBMCP ? ['--enable-features=WebMCP'] : [])] },
  },
  webServer: {
    command: 'npm run dev -- --strictPort',
    url: 'http://127.0.0.1:5174/glasses/',
    reuseExistingServer: !process.env.CI,
  },
});
