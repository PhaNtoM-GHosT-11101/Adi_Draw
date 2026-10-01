const { contextBridge, ipcRenderer } = require('electron')

/**
 * Small bridge so the renderer can use native save/open dialogs when running
 * inside Electron. In a plain browser these resolve to `null` and the app
 * falls back to the download / file-input flow.
 */
contextBridge.exposeInMainWorld('inkDesktop', {
  isDesktop: true,
  platform: process.platform,
  save: (contents, suggestedName) => ipcRenderer.invoke('ink:save', contents, suggestedName),
  open: () => ipcRenderer.invoke('ink:open'),
  exportPng: (suggestedName, dataUrl) => ipcRenderer.invoke('ink:export', { suggestedName, dataUrl }),
  onMenu: (handler) => {
    const listener = (_e, action) => handler(action)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  },
})
