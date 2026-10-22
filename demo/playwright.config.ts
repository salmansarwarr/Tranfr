import { defineConfig } from "@playwright/test";

const PORT = 5181;

export default defineConfig({
  testDir: "./e2e",
  // Testnet transactions take tens of seconds each, and the claim phase waits for real epochs.
  timeout: 30 * 60_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
