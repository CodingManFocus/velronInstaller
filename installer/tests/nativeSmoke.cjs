// Keep Electron's launch diagnostics when a CI desktop cannot start.
if (process.env.CI) process.env.DEBUG = [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

(async () => {
  const executablePath = process.env.VELRON_SMOKE_EXECUTABLE;
  let fixture;
  let desktop;
  try {
    let appPath = path.resolve(__dirname, '..');
    if (!executablePath) {
      fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'velron-page-smoke-'));
      appPath = path.join(fixture, 'TESTER~1', 'Velron Installer');
      await fs.mkdir(appPath, { recursive: true });
      for (const item of ['app', 'ui', 'package.json']) {
        await fs.cp(path.resolve(__dirname, '..', item), path.join(appPath, item), { recursive: true });
      }
    }
    // Exercise the IPC guard under a tilde + space path, as in Windows 8.3 TEMP paths.
    desktop = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [appPath] }), timeout: 30000 });
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
    const diagnostics = await page.evaluate(async () => {
      const report = await window.velronInstaller.reportStartupFailure({ stage: 'native-smoke', detail: 'Synthetic startup diagnostic' });
      await window.velronInstaller.copyStartupDiagnostics(report);
      return report;
    });
    assert.match(diagnostics, /Synthetic startup diagnostic/);
    assert.match(diagnostics, /Log file:/);
    const logFile = /^Log file: (.+)$/m.exec(diagnostics)[1];
    assert.equal(await fs.readFile(logFile, 'utf8'), diagnostics);
    await fs.mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, `../test-results/native-${process.platform}.png`) });
    console.log(`Native ${process.platform} window, preload bridge, and validation passed.`);
  } finally {
    try { if (desktop) await desktop.close(); }
    finally { if (fixture) await fs.rm(fixture, { recursive: true, force: true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
