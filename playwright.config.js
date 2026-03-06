// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    extraHTTPHeaders: { "Content-Type": "application/json" },
  },
  projects: [
    {
      name: "api",
      testMatch: /api\/.+\.spec\.js$/,
    },
    {
      name: "ui",
      testMatch: /ui\/.+\.spec\.js$/,
      use: {
        baseURL: "http://localhost:8080",
        browserName: "chromium",
      },
    },
  ],
  webServer: [
    {
      command: "docker compose up -d",
      url: "http://localhost:3000/api/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
