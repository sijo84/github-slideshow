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
      // Reset runs once, before `tsx watch` starts; the server then migrates the empty schema at boot.
      command: 'npx tsx e2e/reset-db.ts && npm run dev -w @poker/server',
      url: 'http://localhost:3001/api/health',
      env: {
        DATABASE_URL: 'postgres://poker:poker@localhost:5432/poker_e2e',
        REGISTRATION: 'open',
        RATE_LIMIT_MAX: '100000',
        AUTH_RATE_LIMIT_MAX: '100000',
      },
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
