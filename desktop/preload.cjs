const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('msgtDesktop', Object.freeze({
  platform: process.platform,
  chooseDisc: () => ipcRenderer.invoke('desktop:disc-pick'),
  rememberedDisc: () => ipcRenderer.invoke('desktop:disc-current'),
  readDiscSlice: (start, end) => ipcRenderer.invoke('desktop:disc-read', start, end),
  forgetDisc: () => ipcRenderer.invoke('desktop:disc-forget'),
  chooseGhostFolder: () => ipcRenderer.invoke('desktop:ghost-read-folder-pick'),
  listGhosts: () => ipcRenderer.invoke('desktop:ghost-list'),
  chooseSaveFolder: () => ipcRenderer.invoke('desktop:ghost-save-folder-pick'),
  rememberedSaveFolder: () => ipcRenderer.invoke('desktop:ghost-save-folder-current'),
  saveGhost: (name, data) => ipcRenderer.invoke('desktop:ghost-save', name, data)
}));
