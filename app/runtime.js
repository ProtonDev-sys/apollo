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
const {
  searchArtists,
  getArtistProfile,
  listArtistReleases,
  listArtistTracks
} = require('./public-metadata-service');
const { createHttpError } = require('./http-error');
const { formatApiTrack, formatApiPlaylist, resolvePlaylistArtworkUrl } = require('./models');
const { DownloadService } = require('./download-service');
const { createMusicServer } = require('./music-server');
const { AuthService } = require('./auth-service');

const PLAYLIST_ARTWORK_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function getExtensionForMimeType(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    default:
      return '';
  }
}

async function createRuntime({
  baseDir,
  musicRoot,
  settingsOverrides = {},
  startupService = null,
  onDownloadUpdate = () => {}
}) {
  const store = new DataStore({
    baseDir,
    defaultSettings: createDefaultSettings(musicRoot)
  });
  await store.init();
  await startupService?.sync(store.getSettings());

  if (Object.keys(settingsOverrides).length) {
    await store.updateSettings(settingsOverrides);
    await startupService?.sync(store.getSettings());
  }

  const libraryService = new LibraryService(store);
  const downloadService = new DownloadService({
    store,
    libraryService
  });
  const authService = new AuthService({ store });
  const mediaDirectory = path.join(baseDir, 'media');
  const playlistArtworkDirectory = path.join(mediaDirectory, 'playlists');

  let musicServer = null;

  function getBaseUrl() {
    return musicServer ? musicServer.getInfo().baseUrl : '';
  }

  function formatTrackList(result) {
    return {
      ...result,
      items: result.items.map((track) => formatApiTrack(track, getBaseUrl())).filter(Boolean)
    };
  }

  function formatPlaylist(playlist) {
    return formatApiPlaylist(playlist, getBaseUrl());
  }

  async function removeFileIfPresent(targetPath) {
    if (!targetPath) {
      return;
    }

    await fs.rm(targetPath, { force: true });
  }

  async function updatePlaylist(playlistId, payload) {
    const existing = store.getPlaylist(playlistId);
    if (!existing) {
      throw createHttpError(404, 'Playlist not found.');
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'artworkUrl')) {
      await removeFileIfPresent(existing.artworkPath);
    }

    return formatPlaylist(await store.updatePlaylist(playlistId, payload));
  }

  async function deletePlaylist(playlistId) {
    const existing = store.getPlaylist(playlistId);
    if (!existing) {
      throw createHttpError(404, 'Playlist not found.');
    }

    await removeFileIfPresent(existing.artworkPath);
    return store.deletePlaylist(playlistId);
  }

  async function savePlaylistArtwork(playlistId, artwork) {
    const playlist = store.getPlaylist(playlistId);
    if (!playlist) {
      throw createHttpError(404, 'Playlist not found.');
    }

    const extension =
      getExtensionForMimeType(artwork.contentType) ||
      path.extname(artwork.fileName || '').toLowerCase();

    if (!PLAYLIST_ARTWORK_EXTENSIONS.has(extension)) {
      throw createHttpError(400, 'Unsupported artwork type. Use jpg, png, or webp.');
    }

    await fs.mkdir(playlistArtworkDirectory, { recursive: true });
    const nextArtworkPath = path.join(playlistArtworkDirectory, `${playlistId}${extension}`);

    if (playlist.artworkPath && playlist.artworkPath !== nextArtworkPath) {
      await removeFileIfPresent(playlist.artworkPath);
    }

    await fs.writeFile(nextArtworkPath, artwork.buffer);
    const updated = await store.updatePlaylist(playlistId, {
      artworkPath: nextArtworkPath,
      artworkUrl: ''
    });

    return {
      id: updated.id,
      artworkUrl: resolvePlaylistArtworkUrl(updated, getBaseUrl())
    };
  }

  async function deletePlaylistArtwork(playlistId) {
    const playlist = store.getPlaylist(playlistId);
    if (!playlist) {
      throw createHttpError(404, 'Playlist not found.');
    }

    await removeFileIfPresent(playlist.artworkPath);
    await store.updatePlaylist(playlistId, {
      artworkPath: '',
      artworkUrl: ''
    });

    return {
      ok: true,
      id: playlistId,
      artworkUrl: ''
    };
  }

  musicServer = createMusicServer({
    getOverview: () => store.getOverview(),
    listTracks: (payload) => formatTrackList(store.listTracks(payload)),
    getTrack: (trackId) => store.getTrack(trackId),
    deleteTrack: async (trackId) =>
      libraryService.deleteTrack(trackId, store.getSettings().libraryDirectory),
    searchCatalog: (payload, options = {}) =>
      searchCatalog(payload, store.getSettings(), store, musicServer.getInfo().baseUrl, options),
    resolvePlayback: (payload, options = {}) =>
      resolvePlayback(payload, store.getSettings(), store, musicServer.getInfo().baseUrl, options),
    resolveClientDownload: (payload, options = {}) =>
      resolveClientDownload(
        payload,
        store.getSettings(),
        store,
        musicServer.getInfo().baseUrl,
        options
      ),
    inspectLink: (url, options = {}) => inspectDirectLink(url, store.getSettings(), options),
    listPlaylists: () => store.listPlaylists().map((playlist) => formatPlaylist(playlist)),
    getPlaylist: (playlistId) => formatPlaylist(store.getPlaylist(playlistId)),
    createPlaylist: async (payload) => formatPlaylist(await store.createPlaylist(payload)),
    updatePlaylist,
    deletePlaylist,
    addTrackToPlaylist: async (playlistId, trackId) =>
      formatPlaylist(await store.addTrackToPlaylist(playlistId, trackId)),
    removeTrackFromPlaylist: async (playlistId, trackId) =>
      formatPlaylist(await store.removeTrackFromPlaylist(playlistId, trackId)),
    uploadPlaylistArtwork: savePlaylistArtwork,
    deletePlaylistArtwork,
    getPlaylistArtworkPath: (fileName) => path.join(playlistArtworkDirectory, path.basename(fileName)),
    getAuthStatus: () => authService.getPublicStatus(),
    createAuthSession: (payload) => authService.createSession(payload),
    revokeAuthSession: ({ token }) => authService.revokeSession(token),
    authenticateRequest: ({ token }) => authService.validateSessionToken(token),
    listDownloads: () => downloadService.getDownloads(),
    getDownload: (downloadId) => store.getDownload(downloadId),
    queueDownload: (payload) => downloadService.queueDownload(payload),
    rescanLibrary: async () => formatTrackList(await libraryService.syncLibrary(store.getSettings().libraryDirectory)),
    searchArtists: (payload, options = {}) => searchArtists({ ...payload, ...options }),
    getArtist: (artistId, options = {}) => getArtistProfile(artistId, options),
    listArtistReleases: (artistId, payload, options = {}) =>
      listArtistReleases(artistId, { ...payload, ...options }),
    listArtistTracks: (artistId, payload, options = {}) =>
      listArtistTracks(artistId, { ...payload, ...options })
  });

  downloadService.on('updated', (download) => {
    onDownloadUpdate(download);
  });

  async function ensureDirectories() {
    const settings = store.getSettings();
    await fs.mkdir(settings.libraryDirectory, { recursive: true });
    await fs.mkdir(settings.incomingDirectory, { recursive: true });
    await fs.mkdir(playlistArtworkDirectory, { recursive: true });
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
      settings: store.getPublicSettings(),
      dependencies: await getDependencyState(settings),
      server: musicServer.getInfo(),
      auth: authService.getPublicStatus(),
      overview: store.getOverview(),
      downloads: downloadService.getDownloads(),
      playlists: store.listPlaylists()
    };
  }

  async function saveSettings(nextSettings) {
    const settings = await store.updateSettings(nextSettings);
    await startupService?.sync(store.getSettings());
    authService.clearSessions();
    await ensureDirectories();
    await musicServer.start({
      host: store.getSettings().serverHost,
      port: store.getSettings().serverPort
    });

    return {
      settings,
      dependencies: await getDependencyState(store.getSettings()),
      server: musicServer.getInfo(),
      auth: authService.getPublicStatus()
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
    inspectLink: (url, options = {}) => inspectDirectLink(url, store.getSettings(), options),
    queueDownload: (payload) => downloadService.queueDownload(payload),
    listTracks: (payload) => formatTrackList(store.listTracks(payload)),
    deleteTrack: (trackId) => libraryService.deleteTrack(trackId, store.getSettings().libraryDirectory),
    rescanLibrary: async () => formatTrackList(await libraryService.syncLibrary(store.getSettings().libraryDirectory)),
    listPlaylists: () => ({ items: store.listPlaylists().map((playlist) => formatPlaylist(playlist)) }),
    getPlaylist: (playlistId) => formatPlaylist(store.getPlaylist(playlistId)),
    createPlaylist: async (payload) => formatPlaylist(await store.createPlaylist(payload)),
    updatePlaylist,
    deletePlaylist,
    addTrackToPlaylist: async (payload) =>
      formatPlaylist(await store.addTrackToPlaylist(payload.playlistId, payload.trackId)),
    removeTrackFromPlaylist: async (payload) =>
      formatPlaylist(await store.removeTrackFromPlaylist(payload.playlistId, payload.trackId)),
    uploadPlaylistArtwork: ({ playlistId, artwork }) => savePlaylistArtwork(playlistId, artwork),
    deletePlaylistArtwork,
    getPlaylistArtworkPath: (fileName) => path.join(playlistArtworkDirectory, path.basename(fileName)),
    getDownload: (downloadId) => store.getDownload(downloadId),
    getServerInfo: () => musicServer.getInfo(),
    searchArtists: (payload, options = {}) => searchArtists({ ...payload, ...options }),
    getArtist: (artistId, options = {}) => getArtistProfile(artistId, options),
    listArtistReleases: (artistId, payload, options = {}) =>
      listArtistReleases(artistId, { ...payload, ...options }),
    listArtistTracks: (artistId, payload, options = {}) =>
      listArtistTracks(artistId, { ...payload, ...options })
  };
}

module.exports = {
  createRuntime
};
