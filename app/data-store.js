const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { createHttpError } = require('./http-error');
const { normaliseProviderIds } = require('./models');

function createDefaultSettings(musicRoot) {
  const serverRoot = path.join(musicRoot, 'Apollo');
  return {
    ytDlpPath: 'yt-dlp',
    ffmpegPath: 'ffmpeg',
    libraryDirectory: path.join(serverRoot, 'library'),
    incomingDirectory: path.join(serverRoot, 'incoming'),
    serverHost: '127.0.0.1',
    serverPort: '4848',
    spotifyClientId: '',
    spotifyClientSecret: ''
  };
}

class DataStore {
  constructor({ baseDir, defaultSettings }) {
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, 'library-state.json');
    this.configPath = path.join(baseDir, 'config.json');
    this.defaultSettings = defaultSettings;
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = this.normaliseState(parsed);
    } catch (error) {
      this.state = this.normaliseState({});
    }

    await this.loadSettings();
    await this.mergeLegacySettings();
    await this.persist();
    await this.persistConfig();

    return this.getState();
  }

  async loadSettings() {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const config = JSON.parse(raw);
      this.state.settings = {
        ...this.defaultSettings,
        ...this.state.settings,
        ...(config.settings || config)
      };
    } catch (error) {
      return;
    }
  }

  async mergeLegacySettings() {
    const legacyPath = path.join(this.baseDir, 'settings.json');

    try {
      const raw = await fs.readFile(legacyPath, 'utf8');
      const legacy = JSON.parse(raw);
      const current = this.state.settings;

      this.state.settings = {
        ...current,
        ytDlpPath: legacy.ytDlpPath || current.ytDlpPath,
        ffmpegPath: legacy.ffmpegPath || current.ffmpegPath,
        spotifyClientId: legacy.spotifyClientId || current.spotifyClientId,
        spotifyClientSecret: legacy.spotifyClientSecret || current.spotifyClientSecret
      };
    } catch (error) {
      return;
    }
  }

  normaliseState(nextState) {
    return {
      settings: {
        ...this.defaultSettings,
        ...(nextState.settings || {})
      },
      tracks: Array.isArray(nextState.tracks)
        ? nextState.tracks.map((track) => ({
            ...track,
            artwork: track.artwork || '',
            providerIds: normaliseProviderIds(track.providerIds)
          }))
        : [],
      playlists: Array.isArray(nextState.playlists)
        ? nextState.playlists.map((playlist) => ({
            ...playlist,
            description: playlist.description || '',
            artworkUrl: playlist.artworkUrl || '',
            artworkPath: playlist.artworkPath || '',
            trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds : []
          }))
        : [],
      downloads: Array.isArray(nextState.downloads) ? nextState.downloads : []
    };
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  getSettings() {
    return { ...this.state.settings };
  }

  getConfigPath() {
    return this.configPath;
  }

  async updateSettings(nextSettings) {
    const sanitised = Object.fromEntries(
      Object.entries(nextSettings).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() : value
      ])
    );

    this.state.settings = {
      ...this.defaultSettings,
      ...this.state.settings,
      ...Object.fromEntries(
        Object.entries(sanitised).filter(([, value]) => value !== '')
      )
    };

    await this.persist();
    await this.persistConfig();
    return this.getSettings();
  }

  async persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(() => fs.writeFile(this.filePath, snapshot, 'utf8'));
    return this.writeQueue;
  }

  async persistConfig() {
    const snapshot = JSON.stringify(
      {
        settings: this.state.settings
      },
      null,
      2
    );
    this.writeQueue = this.writeQueue.then(() => fs.writeFile(this.configPath, snapshot, 'utf8'));
    return this.writeQueue;
  }

  getOverview() {
    const completedDownloads = this.state.downloads.filter(
      (item) => item.status === 'completed'
    ).length;

    return {
      trackCount: this.state.tracks.length,
      playlistCount: this.state.playlists.length,
      downloadCount: this.state.downloads.length,
      completedDownloads
    };
  }

  listTracks({ query = '', page = 1, pageSize = 12 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.min(50, Math.max(1, Number.parseInt(pageSize, 10) || 12));
    const term = query.trim().toLowerCase();

    const filtered = this.state.tracks
      .filter((track) => {
        if (!term) {
          return true;
        }

        return [track.title, track.artist, track.album, track.filePath]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(term));
      })
      .sort((left, right) => {
        return new Date(right.addedAt || 0).getTime() - new Date(left.addedAt || 0).getTime();
      });

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const currentPage = Math.min(safePage, totalPages);
    const start = (currentPage - 1) * safePageSize;

    return {
      items: filtered.slice(start, start + safePageSize),
      total,
      page: currentPage,
      pageSize: safePageSize,
      totalPages
    };
  }

  getTrack(trackId) {
    return this.state.tracks.find((track) => track.id === trackId) || null;
  }

  async upsertTrack(track) {
    const index = this.state.tracks.findIndex(
      (existing) => existing.id === track.id || existing.filePath === track.filePath
    );
    const existingTrack = index >= 0 ? this.state.tracks[index] : null;
    const hasProviderIds =
      track.providerIds && Object.values(track.providerIds).some((value) => String(value || '').trim());
    const nextTrack = {
      id: track.id || (existingTrack ? existingTrack.id : randomUUID()),
      title: track.title || 'Unknown Title',
      artist: track.artist || 'Unknown Artist',
      album: track.album || 'Singles',
      duration: track.duration || null,
      provider: track.provider || 'library',
      artwork: typeof track.artwork === 'string' ? track.artwork : existingTrack?.artwork || '',
      providerIds: hasProviderIds
        ? normaliseProviderIds(track.providerIds)
        : normaliseProviderIds(existingTrack?.providerIds),
      sourceUrl: track.sourceUrl || '',
      filePath: track.filePath,
      fileName: path.basename(track.filePath),
      addedAt: existingTrack ? existingTrack.addedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (index >= 0) {
      this.state.tracks[index] = {
        ...this.state.tracks[index],
        ...nextTrack
      };
    } else {
      this.state.tracks.push(nextTrack);
    }

    await this.persist();
    return nextTrack;
  }

  async removeTracksMissingFromPaths(existingPaths) {
    const pathSet = new Set(existingPaths.map((item) => item.toLowerCase()));
    this.state.tracks = this.state.tracks.filter((track) =>
      pathSet.has((track.filePath || '').toLowerCase())
    );

    for (const playlist of this.state.playlists) {
      playlist.trackIds = playlist.trackIds.filter((trackId) =>
        this.state.tracks.some((track) => track.id === trackId)
      );
      playlist.updatedAt = new Date().toISOString();
    }

    await this.persist();
  }

  listDownloads() {
    return [...this.state.downloads].sort((left, right) => {
      return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
    });
  }

  getDownload(downloadId) {
    return this.state.downloads.find((download) => download.id === downloadId) || null;
  }

  async upsertDownload(download) {
    const index = this.state.downloads.findIndex((item) => item.id === download.id);
    if (index >= 0) {
      this.state.downloads[index] = {
        ...this.state.downloads[index],
        ...download
      };
    } else {
      this.state.downloads.push(download);
    }

    await this.persist();
    return download;
  }

  listPlaylists() {
    return this.state.playlists.map((playlist) => this.getPlaylist(playlist.id)).filter(Boolean);
  }

  getPlaylist(playlistId) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) {
      return null;
    }

    return {
      ...playlist,
      tracks: playlist.trackIds
        .map((trackId) => this.getTrack(trackId))
        .filter(Boolean)
    };
  }

  async createPlaylist({ name, description = '' }) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      throw createHttpError(400, 'Playlist name is required.');
    }

    const playlist = {
      id: randomUUID(),
      name: trimmedName,
      description: description.trim(),
      artworkUrl: '',
      artworkPath: '',
      trackIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.state.playlists.push(playlist);
    await this.persist();
    return this.getPlaylist(playlist.id);
  }

  async updatePlaylist(playlistId, updates) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) {
      throw createHttpError(404, 'Playlist not found.');
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'name')) {
      const trimmedName = String(updates.name || '').trim();
      if (!trimmedName) {
        throw createHttpError(400, 'Playlist name cannot be empty.');
      }
      playlist.name = trimmedName;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'description')) {
      playlist.description = String(updates.description || '').trim();
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'artworkUrl')) {
      const trimmedArtworkUrl = String(updates.artworkUrl || '').trim();
      playlist.artworkUrl = trimmedArtworkUrl;
      playlist.artworkPath = trimmedArtworkUrl ? '' : '';
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'artworkPath')) {
      playlist.artworkPath = String(updates.artworkPath || '').trim();
      if (playlist.artworkPath) {
        playlist.artworkUrl = '';
      }
    }

    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return this.getPlaylist(playlistId);
  }

  async deletePlaylist(playlistId) {
    const index = this.state.playlists.findIndex((item) => item.id === playlistId);
    if (index < 0) {
      throw createHttpError(404, 'Playlist not found.');
    }

    this.state.playlists.splice(index, 1);
    await this.persist();

    return {
      ok: true,
      id: playlistId
    };
  }

  async addTrackToPlaylist(playlistId, trackId) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) {
      throw createHttpError(404, 'Playlist not found.');
    }

    if (!this.getTrack(trackId)) {
      throw createHttpError(404, 'Track not found.');
    }

    if (!playlist.trackIds.includes(trackId)) {
      playlist.trackIds.push(trackId);
      playlist.updatedAt = new Date().toISOString();
      await this.persist();
    }

    return this.getPlaylist(playlistId);
  }

  async removeTrackFromPlaylist(playlistId, trackId) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) {
      throw createHttpError(404, 'Playlist not found.');
    }

    playlist.trackIds = playlist.trackIds.filter((item) => item !== trackId);
    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return this.getPlaylist(playlistId);
  }
}

module.exports = {
  DataStore,
  createDefaultSettings
};
