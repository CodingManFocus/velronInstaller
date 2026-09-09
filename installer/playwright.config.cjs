const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/ui', fullyParallel: true, timeout: 20000,
  use: { baseURL: 'http://127.0.0.1:43791', viewport: { width: 1100, height: 760 }, screenshot: 'only-on-failure',
    launchOptions: process.env.VELRON_TEST_CHROMIUM ? { executablePath: process.env.VELRON_TEST_CHROMIUM } : {} },
  webServer: { command: 'node tests/ui/serve.cjs', url: 'http://127.0.0.1:43791', reuseExistingServer: false },
});
