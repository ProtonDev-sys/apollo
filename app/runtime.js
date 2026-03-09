const fs = require('fs/promises');
const path = require('path');
const { DataStore, createDefaultSettings } = require('./data-store');
const { getDependencyState } = require('./binaries');
const { LibraryService } = require('./library-service');
const {
  searchProviders,
  inspectDirectLink,
  searchCatalog,
  resolvePlayback,
  resolveClientDownload
} = require('./search-service');
const { DownloadService } = require('./download-service');
const { createMusicServer } = require('./music-server');

async function createRuntime({
  baseDir,
  musicRoot,
  settingsOverrides = {},
  onDownloadUpdate = () => {}
}) {
  const store = new DataStore({
    baseDir,
    defaultSettings: createDefaultSettings(musicRoot)
  });
  await store.init();

  if (Object.keys(settingsOverrides).length) {
    await store.updateSettings(settingsOverrides);
  }

  const libraryService = new LibraryService(store);
  const downloadService = new DownloadService({
    store,
    libraryService
  });

  let musicServer = null;

  musicServer = createMusicServer({
    getOverview: () => store.getOverview(),
    listTracks: (payload) => store.listTracks(payload),
    getTrack: (trackId) => store.getTrack(trackId),
    searchCatalog: (payload) =>
      searchCatalog(payload, store.getSettings(), store, musicServer.getInfo().baseUrl),
    resolvePlayback: (payload) =>
      resolvePlayback(payload, store.getSettings(), store, musicServer.getInfo().baseUrl),
    resolveClientDownload: (payload) =>
      resolveClientDownload(payload, store.getSettings(), store, musicServer.getInfo().baseUrl),
    inspectLink: (url) => inspectDirectLink(url, store.getSettings()),
    listPlaylists: () => store.listPlaylists(),
    createPlaylist: (payload) => store.createPlaylist(payload),
    addTrackToPlaylist: (playlistId, trackId) => store.addTrackToPlaylist(playlistId, trackId),
    removeTrackFromPlaylist: (playlistId, trackId) => store.removeTrackFromPlaylist(playlistId, trackId),
    listDownloads: () => downloadService.getDownloads(),
    queueDownload: (payload) => downloadService.queueDownload(payload),
    rescanLibrary: () => libraryService.syncLibrary(store.getSettings().libraryDirectory)
  });

  downloadService.on('updated', (download) => {
    onDownloadUpdate(download);
  });

  async function ensureDirectories() {
    const settings = store.getSettings();
    await fs.mkdir(settings.libraryDirectory, { recursive: true });
    await fs.mkdir(settings.incomingDirectory, { recursive: true });
  }

  async function start() {
    await ensureDirectories();
    await libraryService.syncLibrary(store.getSettings().libraryDirectory);

    const settings = store.getSettings();
    await musicServer.start({
      host: settings.serverHost,
      port: settings.serverPort
    });

    return getDashboard();
  }

  async function stop() {
    await musicServer.stop();
  }

  async function getDashboard() {
    const settings = store.getSettings();
    return {
      settings,
      dependencies: await getDependencyState(settings),
      server: musicServer.getInfo(),
      overview: store.getOverview(),
      downloads: downloadService.getDownloads(),
      playlists: store.listPlaylists()
    };
  }

  async function saveSettings(nextSettings) {
    const settings = await store.updateSettings(nextSettings);
    await ensureDirectories();
    await musicServer.start({
      host: settings.serverHost,
      port: settings.serverPort
    });

    return {
      settings,
      dependencies: await getDependencyState(settings),
      server: musicServer.getInfo()
    };
  }

  return {
    start,
    stop,
    getDashboard,
    saveSettings,
    getConfigPath: () => store.getConfigPath(),
    openLibraryPath: () => store.getSettings().libraryDirectory,
    search: (payload) => searchProviders(payload, store.getSettings()),
    inspectLink: (url) => inspectDirectLink(url, store.getSettings()),
    queueDownload: (payload) => downloadService.queueDownload(payload),
    listTracks: (payload) => store.listTracks(payload),
    rescanLibrary: () => libraryService.syncLibrary(store.getSettings().libraryDirectory),
    listPlaylists: () => ({ items: store.listPlaylists() }),
    createPlaylist: (payload) => store.createPlaylist(payload),
    addTrackToPlaylist: (payload) => store.addTrackToPlaylist(payload.playlistId, payload.trackId),
    removeTrackFromPlaylist: (payload) =>
      store.removeTrackFromPlaylist(payload.playlistId, payload.trackId),
    getServerInfo: () => musicServer.getInfo()
  };
}

module.exports = {
  createRuntime
};
