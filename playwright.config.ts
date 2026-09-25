import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const acceptanceBrowser = process.env.PRELAUNCH_E2E_BROWSER;
const browserDevice = {
  chromium: "Desktop Chrome",
  firefox: "Desktop Firefox",
  webkit: "Desktop Safari",
} as const;
if (acceptanceBrowser && !(acceptanceBrowser in browserDevice)) {
  throw new Error(`Unsupported PRELAUNCH_E2E_BROWSER: ${acceptanceBrowser}`);
}
const selectedBrowser = (acceptanceBrowser || "chromium") as keyof typeof browserDevice;

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

/**
 * Playwright E2E configuration for CoTeach.
 *
 * - CI: single worker, 2 retries, github + html reporters
 * - Local: default workers, no retries, list reporter
 * - Web server is reused locally to avoid booting `next dev` per run.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // An explicit acceptance server must never be replaced by a dev server.
  webServer: process.env.OPENPBL_RESOURCE_E2E_BASE_URL ? undefined : {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: selectedBrowser,
      use: { ...devices[browserDevice[selectedBrowser]] },
    },
  ],
});
