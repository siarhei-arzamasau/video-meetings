import { defineConfig, devices } from '@playwright/test';

/**
 * The browser e2e suite: a real Chromium against the real API and a real database.
 *
 * Both servers are the suite's own, on ports nothing else uses (3100/3101), and
 * `reuseExistingServer` is off so a stray dev server cannot stand in for them. The API runs
 * with the worker on and a fast poll — "the Processing chip disappears" needs the real
 * pipeline — and with its uploads in a temp directory. One worker and no retries: the specs
 * share one database, and a flaky test here is a bug, not a retry.
 *
 * Not in `turbo.json` and not in CI, for the same reason the API's `test:e2e` is not: it
 * needs Postgres. Run it explicitly with `pnpm --filter=@repo/web test:e2e`. The API suite
 * truncates `users` per test, so the two must never run at the same time.
 */
/**
 * How long to wait for each server to answer. Two minutes is plenty on a machine that is not
 * doing anything else, and nothing like enough on one that is: the web server here is
 * `next dev`, which compiles the app on first request. Tunable rather than raised, so a slow
 * or loaded machine is a `E2E_SERVER_TIMEOUT_MS=300000` away from a usable run instead of a
 * config edit nobody wants in a commit.
 */
const serverTimeout = Number(process.env['E2E_SERVER_TIMEOUT_MS'] ?? 120_000);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'off',
    // `E2E_SLOW_MO_MS=500 pnpm --filter=@repo/web test:e2e -- --headed` is how to watch the
    // suite drive the page at human speed; unset, it runs as fast as it can.
    launchOptions: { slowMo: Number(process.env['E2E_SLOW_MO_MS'] ?? 0) },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter=@repo/api start:e2e-web',
      url: 'http://localhost:3101/api/health',
      reuseExistingServer: false,
      timeout: serverTimeout,
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:3100',
      reuseExistingServer: false,
      timeout: serverTimeout,
      env: {
        WEB_PORT: '3100',
        NEXT_PUBLIC_API_URL: 'http://localhost:3101/api',
      },
    },
  ],
});
