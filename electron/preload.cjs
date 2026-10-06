const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  openFile: (filters) => ipcRenderer.invoke('open-file', filters),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  initialFile: () => ipcRenderer.invoke('initial-file'),
});
