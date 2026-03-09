const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const { createRuntime } = require('./app/runtime');
const { APP_NAME, ensureAppDataDirectory } = require('./app/paths');

let mainWindow = null;
let runtime = null;

app.setName(APP_NAME);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

function emitDownloadUpdate(download) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('downloads:update', download);
  }
}

app.whenReady().then(async () => {
  const baseDir = await ensureAppDataDirectory();
  runtime = await createRuntime({
    baseDir,
    musicRoot: app.getPath('music'),
    onDownloadUpdate: (download) => emitDownloadUpdate(download)
  });
  await runtime.start();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', async () => {
  await runtime?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:get-dashboard', async () => runtime.getDashboard());

ipcMain.handle('settings:save', async (_event, nextSettings) => {
  return runtime.saveSettings(nextSettings);
});

ipcMain.handle('settings:pick-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('downloads:open-folder', async () => {
  return shell.openPath(runtime.openLibraryPath());
});

ipcMain.handle('search:run', async (_event, payload) => runtime.search(payload));
ipcMain.handle('search:inspect-link', async (_event, url) => runtime.inspectLink(url));
ipcMain.handle('downloads:start', async (_event, item) => runtime.queueDownload(item));
ipcMain.handle('library:list', async (_event, payload) => runtime.listTracks(payload));
ipcMain.handle('library:rescan', async () => runtime.rescanLibrary());
ipcMain.handle('playlists:list', async () => runtime.listPlaylists());
ipcMain.handle('playlists:create', async (_event, payload) => runtime.createPlaylist(payload));
ipcMain.handle('playlists:add-track', async (_event, payload) => runtime.addTrackToPlaylist(payload));
ipcMain.handle('playlists:remove-track', async (_event, payload) =>
  runtime.removeTrackFromPlaylist(payload)
);
