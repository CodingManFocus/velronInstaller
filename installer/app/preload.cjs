const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('velronInstaller', {
  getDefaults: () => ipcRenderer.invoke('installer:defaults'),
  reportStartupFailure: value => ipcRenderer.invoke('installer:startup-failure', value),
  copyStartupDiagnostics: value => ipcRenderer.invoke('installer:copy-startup-diagnostics', value),
  chooseDirectory: value => ipcRenderer.invoke('installer:directory', value),
  inspectConfig: value => ipcRenderer.invoke('installer:inspect', value),
  install: options => ipcRenderer.invoke('installer:install', options),
  cancel: () => ipcRenderer.invoke('installer:cancel'),
  openServer: () => ipcRenderer.invoke('installer:open-server'),
  showConfig: () => ipcRenderer.invoke('installer:show-config'),
  copyLogs: () => ipcRenderer.invoke('installer:copy-logs'),
  close: () => ipcRenderer.invoke('installer:close'),
  onProgress: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('installer:progress', listener);
    return () => ipcRenderer.removeListener('installer:progress', listener);
  },
});
