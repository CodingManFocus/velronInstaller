const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getDefaults, validateOptions } = require('./installOptions.cjs');
const { createInstallRunner } = require('./installRunner.cjs');
const { validateFilesystemOptions } = require('./installPaths.cjs');
const { isServerSettings } = require('./serverSettings.cjs');
const { openInstalledServer } = require('./managementBootstrap.cjs');

let window;
let runner;
let installedOptions;
let closePending = false;
const pagePath = path.join(__dirname, '..', 'ui', 'index.html');
const pageUrl = pathToFileURL(pagePath).href;
const engineDir = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(__dirname, '..', '..');

async function inspectConfig(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096 || /[\x00-\x1f]/.test(directory)) {
    throw new Error('Choose an absolute installation path.');
  }
  const configPath = path.join(directory, 'config.json');
  try {
    const stat = await fs.stat(configPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return { exists: true, valid: false };
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!isServerSettings(config)) {
      return { exists: true, valid: false };
    }
    // Return only the network settings needed by the wizard; no tokens or private state.
    return { exists: true, valid: true, httpPort: config.port, vcpPort: config.localVcpPort, serverHost: config.host.trim() };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, valid: true };
    return { exists: true, valid: false };
  }
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
      throw new Error('Untrusted installer request.');
    }
    return callback(...args);
  });
}

async function confirmCancellation() {
  if (!runner.running) return true;
  const korean = app.getLocale().startsWith('ko');
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', title: 'Velron Installer',
    message: korean ? '진행 중인 설치를 중단할까요?' : 'Stop the installation?',
    detail: korean ? '이미 설치된 파일과 설정은 남습니다. 나중에 다시 실행할 수 있어요.' : 'Files and settings already installed will remain. You can run the installer again.',
    buttons: korean ? ['계속 설치', '설치 중단'] : ['Keep installing', 'Stop installation'],
    defaultId: 0, cancelId: 0, noLink: true,
  });
  if (response !== 1) return false;
  runner.cancel();
  return true;
}

function createWindow() {
  window = new BrowserWindow({ width: 1100, height: 800, minWidth: 900, minHeight: 680,
    title: 'Velron Installer', backgroundColor: '#f7f7f8', show: false, autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => {
    if (!runner.running) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    confirmCancellation().finally(() => { closePending = false; });
  });
  window.once('ready-to-show', () => window.show());
  window.loadFile(pagePath);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    runner = createInstallRunner({ engineDir, onEvent: event => {
      if (window && !window.isDestroyed()) window.webContents.send('installer:progress', event);
    } });
    handle('installer:defaults', () => ({ options: getDefaults(), platform: process.platform,
      arch: process.arch, locale: app.getLocale(), version: app.getVersion() }));
    handle('installer:inspect', inspectConfig);
    handle('installer:directory', async directory => {
      if (runner.running) throw new Error('Installation is running.');
      if (typeof directory !== 'string' || directory.length > 4096) throw new Error('Invalid directory.');
      const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        defaultPath: directory || undefined, properties: ['openDirectory', 'createDirectory'],
      });
      return canceled ? null : filePaths[0];
    });
    handle('installer:install', async input => {
      if (runner.running) throw new Error('An installation is already running.');
      installedOptions = null;
      const options = validateOptions(input, process.platform, { cwd: engineDir });
      await validateFilesystemOptions(options, { cwd: engineDir });
      if (options.components !== 'client' && options.keepConfig) {
        const config = await inspectConfig(options.velronHome);
        if (config.exists && !config.valid) throw new Error('The existing Server configuration cannot be read. Choose new Server settings or repair config.json.');
        if (config.exists) {
          options.httpPort = config.httpPort;
          options.vcpPort = config.vcpPort;
          options.serverHost = config.serverHost;
        }
      }
      const result = await runner.run(options);
      if (result.status === 'success') installedOptions = { ...options, vcpToken: '' };
      return result;
    });
    handle('installer:cancel', confirmCancellation);
    handle('installer:copy-logs', () => clipboard.writeText(runner.logs));
    handle('installer:show-config', () => {
      if (!installedOptions || installedOptions.components === 'server') return;
      shell.showItemInFolder(path.join(installedOptions.velronHome, 'stdio-mcp.json'));
    });
    handle('installer:open-server', async () => {
      if (!installedOptions || installedOptions.components === 'client' || !installedOptions.startNow) return;
      await openInstalledServer(installedOptions, { openExternal: url => shell.openExternal(url),
        tokenOptions: { cwd: engineDir } });
    });
    handle('installer:close', () => { if (!runner.running) window.close(); });
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => {
    dialog.showErrorBox('Velron Installer', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
