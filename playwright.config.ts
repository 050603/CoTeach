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
const acceptanceExecutable = process.env.PRELAUNCH_E2E_EXECUTABLE_PATH;
if (acceptanceExecutable && selectedBrowser !== "chromium") {
  throw new Error("A branded Chrome/Edge executable requires PRELAUNCH_E2E_BROWSER=chromium");
}

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
  // Playwright clears outputDir before a run. Keep unrelated audit evidence
  // outside that cleanup boundary.
  outputDir: "./test-results/playwright",
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
    baseURL: process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000",
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
      name: process.env.PRELAUNCH_E2E_BROWSER_LABEL || selectedBrowser,
      use: {
        ...devices[browserDevice[selectedBrowser]],
        // Device presets include a frozen Chromium UA. A real branded binary
        // must keep its own Chrome/Edge identity and version during acceptance.
        ...(acceptanceExecutable ? { userAgent: undefined, launchOptions: { executablePath: acceptanceExecutable } } : {}),
      },
    },
  ],
});
