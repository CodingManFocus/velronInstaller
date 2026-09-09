const { test, expect } = require('@playwright/test');
const { getDefaults } = require('../../app/installOptions.cjs');

async function setup(page, { platform = 'linux', locale = 'ko', existing = false, outcome = 'success' } = {}) {
  const options = getDefaults(platform, platform === 'win32' ? 'C:\\Users\\Focus' : '/home/focus', {});
  await page.addInitScript(({ options, platform, locale, existing, outcome }) => {
    let progress;
    window.velronInstaller = {
      getDefaults: async () => ({ options, platform, locale, arch: 'x64', version: '2.0.0' }),
      chooseDirectory: async () => options.velronHome + '/selected',
      inspectConfig: async () => ({ exists: existing, valid: true, httpPort: 5151, vcpPort: 5153, serverHost: '127.0.0.1' }),
      onProgress: callback => { progress = callback; },
      install: async value => {
        window.submittedOptions = value;
        progress({ type: 'stage', stage: 'configure' });
        progress({ type: 'log', line: 'Verified release. Configuration saved.' });
        await new Promise(resolve => setTimeout(resolve, 80));
        return { status: outcome, warnings: outcome === 'success' ? ['! Codex CLI was not found.'] : [] };
      },
      cancel: async () => {}, openServer: async () => { window.openedServer = true; },
      showConfig: async () => { window.openedConfig = true; }, copyLogs: async () => {}, close: async () => {},
    };
  }, { options, platform, locale, existing, outcome });
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
}

test('complete Korean wizard preserves every setting and shows actionable completion', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('heading', { name: '어떻게 사용하고 싶으세요?' })).toBeVisible();
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.getByLabel('데이터와 설정', { exact: true }).fill('/home/focus/Velron data');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.locator('[name=httpPort]').fill('5151');
  await page.locator('[name=vcpPort]').fill('5153');
  await page.locator('[name=autostart]').uncheck();
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.locator('[name=connection][value=remote]').check();
  await page.locator('[name=vcpUrl]').fill('wss://server.example.com:4141/vcp/v1');
  await page.locator('[name=vcpToken]').fill('a'.repeat(43));
  await page.locator('[name=integration]').selectOption('both');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page.locator('body')).not.toContainText('a'.repeat(43));
  await page.getByRole('button', { name: 'Velron 설치', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Velron이 준비됐어요' })).toBeVisible();
  expect(await page.evaluate(() => window.submittedOptions)).toMatchObject({ velronHome: '/home/focus/Velron data', httpPort: 5151, vcpPort: 5153, autostart: false, connection: 'remote', integration: 'both' });
  await expect(page.getByText('Codex CLI was not found.', { exact: true })).toBeVisible();
  await expect(page.locator('details')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Velron 열기', exact: true }).click();
  expect(await page.evaluate(() => window.openedServer)).toBe(true);
});

test('client-only wizard skips server settings, validates remote fields, and retains values across languages', async ({ page }) => {
  await setup(page, { platform: 'win32' });
  await page.locator('[name=components][value=client]').check();
  await expect(page.getByRole('navigation')).not.toContainText('서버 설정');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.locator('[name=connection][value=remote]').check();
  await page.locator('[name=vcpUrl]').fill('http://server/vcp/v1');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('wss://');
  await page.locator('[name=vcpUrl]').fill('wss://server/vcp/v1');
  await page.locator('[name=vcpToken]').fill('b'.repeat(43));
  await page.locator('#language').selectOption('en');
  await expect(page.locator('[name=vcpToken]')).toHaveValue('b'.repeat(43));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready when you are' })).toBeVisible();
});

test('existing configuration is retained and a failed installation can be retried', async ({ page }) => {
  await setup(page, { existing: true, outcome: 'failed', locale: 'en', platform: 'darwin' });
  await page.locator('[name=components][value=server]').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('[name=httpPort]')).toBeDisabled();
  await expect(page.locator('[name=httpPort]')).toHaveValue('5151');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Install Velron', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Installation couldn’t finish' })).toBeVisible();
  await page.getByRole('button', { name: 'Review settings and try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready when you are' })).toBeVisible();
});

test('minimum window layout remains usable and uses the bundled Velron assets', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 650 });
  await setup(page);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '다음', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/velron-installer-components.png' });
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page.getByRole('button', { name: '다음', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/velron-installer-server.png' });
});
