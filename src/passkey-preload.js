const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('auraPasskey', {
  info: () => ipcRenderer.invoke('vault:passkey-info'),
  getOptions: (mode) => ipcRenderer.invoke('vault:passkey-options', mode),
  complete: (mode, credential) => ipcRenderer.invoke('vault:passkey-complete', mode, credential),
  setupPin: (pin) => ipcRenderer.invoke('vault:pin-setup', pin),
  verifyPin: (pin) => ipcRenderer.invoke('vault:pin-verify', pin),
  cancel: () => ipcRenderer.invoke('vault:passkey-cancel')
});
