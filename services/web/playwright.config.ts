import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 20_000,
  use: {
    baseURL: 'http://127.0.0.1:18410',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 18410 --strictPort',
    url: 'http://127.0.0.1:18410',
    reuseExistingServer: false,
  },
})
