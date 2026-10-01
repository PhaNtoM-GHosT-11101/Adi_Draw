const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const isDev = !app.isPackaged
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5273'
const DIST = path.join(__dirname, '..', 'dist', 'index.html')
const REPO = 'PhaNtoM-GHosT-11101/Adi_Draw'

/** @type {BrowserWindow | null} */
let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#f5f6f9',
    title: 'Adi Draw',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) void win.loadURL(DEV_URL)
  else void win.loadFile(DIST)

  win.on('closed', () => {
    win = null
  })
  return win
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New board', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'save') },
        { label: 'Save as…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu', 'save-as') },
        { type: 'separator' },
        { label: 'Export PNG…', accelerator: 'CmdOrCtrl+E', click: () => send('menu', 'export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => send('menu', 'zoom-in') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => send('menu', 'zoom-out') },
        { label: 'Zoom to fit', accelerator: 'CmdOrCtrl+1', click: () => send('menu', 'zoom-fit') },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => send('menu', 'zoom-reset') },
        { type: 'separator' },
        { label: 'Toggle tool panel', accelerator: 'CmdOrCtrl+Shift+U', click: () => send('menu', 'panel') },
        { label: 'Keyboard shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('menu', 'help') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Adi Draw',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'Adi Draw',
              message: `Adi Draw ${app.getVersion()}`,
              detail: `Adi Draw — a whiteboard where every pen, colour and shortcut is yours to configure.

Everything stays on your device: boards are stored locally in this app.

https://github.com/${REPO}`,
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* --------------------------- file dialogs -------------------------- */

ipcMain.handle('ink:save', async (_e, contents, suggestedName) => {
  if (!win) return null
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save board',
    defaultPath: path.join(app.getPath('documents'), suggestedName || 'board.wbd'),
    filters: [{ name: 'Adi Draw board', extensions: ['wbd'] }],
  })
  if (canceled || !filePath) return null
  await fs.promises.writeFile(filePath, contents, 'utf8')
  return filePath
})

ipcMain.handle('ink:open', async () => {
  if (!win) return null
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open board',
    properties: ['openFile'],
    filters: [{ name: 'Adi Draw board', extensions: ['wbd', 'json'] }],
  })
  if (canceled || !filePaths[0]) return null
  return { path: filePaths[0], name: path.basename(filePaths[0]), contents: await fs.promises.readFile(filePaths[0], 'utf8') }
})

ipcMain.handle('ink:export', async (_e, { suggestedName, dataUrl }) => {
  if (!win) return null
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export image',
    defaultPath: path.join(app.getPath('pictures'), suggestedName),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  })
  if (canceled || !filePath) return null
  const base64 = String(dataUrl).split(',')[1] ?? ''
  await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'))
  return filePath
})

/* ------------------------------ lifecycle --------------------------- */

app.whenReady().then(() => {
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
