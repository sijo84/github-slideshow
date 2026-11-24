import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'engine',
          root: './packages/engine',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'protocol',
          root: './packages/protocol',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          root: './apps/server',
          environment: 'node',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          env: { DATABASE_URL: 'postgres://poker:poker@localhost:5432/poker_test', NODE_ENV: 'test' },
          testTimeout: 30_000,
          fileParallelism: true,
        },
      },
      {
        extends: './apps/web/vite.config.ts',
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
