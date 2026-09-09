const { test, expect } = require('@playwright/test');
const { getDefaults } = require('../../app/installOptions.cjs');

test('missing preload bridge shows the actual failure and can copy without IPC', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('preload-bridge');
  const log = page.locator('.startup-log');
  await expect(log).toHaveValue(/PRELOAD_BRIDGE_UNAVAILABLE/);
  await page.locator('.startup-error button').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('PRELOAD_BRIDGE_UNAVAILABLE');
});

test('rejected defaults and unavailable clipboard leave selectable original error details', async ({ page }) => {
  await page.addInitScript(() => {
    window.velronInstaller = {
      getDefaults: async () => { throw new Error('IPC_SENDER_REJECTED: expected file URL <script>unsafe</script>'); },
      reportStartupFailure: async () => { throw new Error('IPC still unavailable'); },
      copyStartupDiagnostics: async () => { throw new Error('Clipboard unavailable'); },
    };
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('load-defaults');
  await expect(page.locator('.startup-log')).toHaveValue(/IPC_SENDER_REJECTED/);
  await page.locator('.startup-error button').click();
  expect(await page.locator('.startup-log').evaluate(el => el.selectionEnd - el.selectionStart)).toBeGreaterThan(0);
  await expect(page.locator('.startup-error script')).toHaveCount(0);
});

test('first render failure is reported with version, stage and saved main-process log', async ({ page }) => {
  await page.addInitScript(options => {
    window.velronInstaller = {
      getDefaults: async () => ({ options, platform: 'win32', arch: 'x64', version: '2.0.0', locale: 'ko' }),
      onProgress: () => {},
      reportStartupFailure: async input => {
        window.startupReport = input;
        return input.detail + '\nLog file: C:\\Users\\Tester\\startup.log';
      },
    };
  }, getDefaults('win32', 'C:\\Users\\Tester', {}));
  await page.route('**/translations.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.installerTranslations = {};' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('render-wizard');
  await expect(page.locator('.startup-log')).toHaveValue(/startup.log/);
  expect(await page.evaluate(() => window.startupReport.detail)).toContain('Version: 2.0.0');
});

test('stalled initialization times out and a late response cannot overwrite the error', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    window.velronInstaller = { getDefaults: () => new Promise(resolve => { window.resolveDefaults = resolve; }) };
  });
  await page.goto('/');
  await page.clock.fastForward(16000);
  await expect(page.locator('.startup-log')).toHaveValue(/STARTUP_TIMEOUT/);
  await page.evaluate(() => window.resolveDefaults({ options: {}, locale: 'ko' }));
  await expect(page.locator('.startup-log')).toHaveValue(/STARTUP_TIMEOUT/);
});
