import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev -w @poker/server',
      url: 'http://localhost:3001/api/health',
      env: { DATABASE_URL: 'postgres://poker:poker@localhost:5432/poker_e2e' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -w @poker/web',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
