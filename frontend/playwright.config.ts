import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.YIHE_TEST_PORT ?? 3307);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /live-(agent|completion|notes)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "local-integration",
      testMatch: /live-(agent|completion|notes)\.spec\.ts/,
      dependencies: ["chromium"],
      workers: 1,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command:
      process.env.YIHE_TEST_STATIC === "1"
        ? `python3 -m http.server ${port} --bind 127.0.0.1 --directory out`
        : `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: origin,
    reuseExistingServer: false,
    env: { YIHE_TEST: "1", NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:8009" },
    timeout: 60000,
  },
});
