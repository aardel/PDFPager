const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  savePDFs: (folderPath, files) => ipcRenderer.invoke('save-pdfs', { folderPath, files })
});
