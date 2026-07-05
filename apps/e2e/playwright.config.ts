import { defineConfig, devices } from "@playwright/test";

/**
 * Assumes the backend (:3001) and frontend (:3000) are already running and
 * seeded (the CI job and local runner start them). Uses the pre-installed
 * Chromium via PLAYWRIGHT_BROWSERS_PATH.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "off",
    // Locally, point at the pre-installed Chromium via E2E_CHROMIUM; in CI we run
    // `playwright install chromium`, so leave it unset there.
    ...(process.env.E2E_CHROMIUM
      ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM } }
      : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
