// Keep Electron's launch diagnostics when a CI desktop cannot start.
if (process.env.CI) process.env.DEBUG = [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const executablePath = process.env.VELRON_SMOKE_EXECUTABLE;
  const desktop = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.resolve(__dirname, '..')] }), timeout: 30000 });
  try {
    const page = await desktop.firstWindow();
    await page.locator('.component-grid').waitFor();
    const info = await page.evaluate(() => window.velronInstaller.getDefaults());
    assert.equal(info.platform, process.platform);
    assert.equal(info.options.components, 'both');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const rejected = await page.evaluate(async () => {
      const { options } = await window.velronInstaller.getDefaults();
      try { await window.velronInstaller.install({ ...options, arbitraryCommand: 'not permitted' }); return false; }
      catch { return true; }
    });
    assert.equal(rejected, true);
    await fs.mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, `../test-results/native-${process.platform}.png`) });
    console.log(`Native ${process.platform} window, preload bridge, and validation passed.`);
  } finally { await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
