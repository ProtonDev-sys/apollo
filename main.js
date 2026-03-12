const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const { createRuntime } = require('./app/runtime');
const { APP_NAME, ensureAppDataDirectory } = require('./app/paths');
const { StartupService } = require('./app/startup-service');
const { UpdateService } = require('./app/update-service');

let mainWindow = null;
let tray = null;
let runtime = null;
let updateService = null;
let keepRunningInBackground = false;
let isQuitRequested = false;
let currentSettings = null;
let currentUpdateState = null;

const isBackgroundLaunch = process.argv.includes('--background');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName(APP_NAME);

function createAppIcon(size = 32) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect width="64" height="64" fill="#070707" />
      <rect x="6" y="6" width="52" height="52" fill="none" stroke="#dc55dc" stroke-width="3" />
      <circle cx="42.5" cy="20.5" r="9.5" fill="none" stroke="#f5efe7" stroke-width="4" opacity="0.62" />
      <circle cx="42.5" cy="20.5" r="3" fill="#f5efe7" />
      <path d="M19 47c4.8-9.2 12.5-14.9 24.2-17.7" fill="none" stroke="#f5efe7" stroke-width="4" stroke-linecap="round" />
      <path d="M31 49c.9-6 3.1-11.3 6.8-15.8" fill="none" stroke="#dc55dc" stroke-width="4" stroke-linecap="round" />
    </svg>
  `;

  return nativeImage
    .createFromDataURL(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)
    .resize({ width: size, height: size });
}

function emitDownloadUpdate(download) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('downloads:update', download);
  }
}

function emitUpdateState() {
  currentUpdateState = updateService?.getState() || null;
  if (mainWindow && !mainWindow.isDestroyed() && currentUpdateState) {
    mainWindow.webContents.send('app:update-state', currentUpdateState);
  }

  updateTrayMenu();
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    icon: createAppIcon(256),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('close', (event) => {
    if (keepRunningInBackground && !isQuitRequested) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    emitUpdateState();
  });
}

async function applyBackgroundPreference(enabled) {
  if (!runtime) {
    return;
  }

  const payload = await runtime.saveSettings({
    autoStartBackgroundServer: enabled
  });
  currentSettings = payload.settings;
  keepRunningInBackground = Boolean(payload.settings.autoStartBackgroundServer);
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:update-state', updateService?.getState() || {});
  }
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const updateState = currentUpdateState || updateService?.getState() || {};
  const template = [
    {
      label: 'Open Apollo',
      click: () => createWindow()
    },
    {
      label: keepRunningInBackground ? 'Hide window to background' : 'Background mode disabled',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Start with system',
      type: 'checkbox',
      checked: Boolean(currentSettings?.autoStartBackgroundServer),
      click: (menuItem) => {
        void applyBackgroundPreference(menuItem.checked).catch((error) => {
          dialog.showErrorBox('Apollo startup preference failed', error.message);
        });
      }
    },
    {
      label: 'Check for updates',
      enabled: Boolean(updateState.supported && updateState.configured && !updateState.checking),
      click: () => {
        void updateService?.checkForUpdates().catch((error) => {
          dialog.showErrorBox('Apollo update check failed', error.message);
        });
      }
    },
    {
      label: updateState.downloaded ? 'Install update and restart' : 'No update ready',
      enabled: Boolean(updateState.downloaded),
      click: () => {
        updateService?.quitAndInstall();
      }
    },
    { type: 'separator' },
    {
      label: 'Open library folder',
      click: () => {
        if (runtime) {
          void shell.openPath(runtime.openLibraryPath());
        }
      }
    },
    {
      label: 'Quit Apollo',
      click: () => {
        isQuitRequested = true;
        app.quit();
      }
    }
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(
    updateState.downloaded
      ? 'Apollo - update ready to install'
      : keepRunningInBackground
        ? 'Apollo - running in background'
        : 'Apollo'
  );
}

function createTray() {
  if (tray) {
    return;
  }

  tray = new Tray(createAppIcon(process.platform === 'win32' ? 16 : 24));
  tray.on('click', () => createWindow());
  updateTrayMenu();
}

app.whenReady().then(async () => {
  try {
    const baseDir = await ensureAppDataDirectory();
    const startupService = new StartupService({
      appRoot: __dirname,
      electronApp: app
    });

    runtime = await createRuntime({
      baseDir,
      startupService,
      musicRoot: app.getPath('music'),
      onDownloadUpdate: (download) => emitDownloadUpdate(download)
    });
    const dashboard = await runtime.start();
    currentSettings = dashboard.settings;
    keepRunningInBackground = Boolean(dashboard.settings.autoStartBackgroundServer);

    updateService = new UpdateService({
      electronApp: app
    });
    updateService.on('changed', () => emitUpdateState());
    updateService.initialize();
    currentUpdateState = updateService.getState();

    createTray();

    if (!isBackgroundLaunch || !keepRunningInBackground) {
      createWindow();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else if (mainWindow) {
        mainWindow.show();
      }
    });
  } catch (error) {
    dialog.showErrorBox('Apollo failed to start', error.stack || error.message);
    app.quit();
  }
});

app.on('second-instance', () => {
  createWindow();
});

app.on('before-quit', async () => {
  isQuitRequested = true;
  updateService?.dispose();
  tray?.destroy();
  await runtime?.stop();
});

app.on('window-all-closed', () => {
  if (keepRunningInBackground) {
    return;
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:get-dashboard', async () => runtime.getDashboard());
ipcMain.handle('app:get-update-state', async () => updateService?.getState() || {});
ipcMain.handle('app:check-for-updates', async () => updateService?.checkForUpdates() || {});
ipcMain.handle('app:install-update', async () => updateService?.quitAndInstall() || false);

ipcMain.handle('settings:save', async (_event, nextSettings) => {
  const payload = await runtime.saveSettings(nextSettings);
  currentSettings = payload.settings;
  keepRunningInBackground = Boolean(payload.settings.autoStartBackgroundServer);
  updateTrayMenu();
  return payload;
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
