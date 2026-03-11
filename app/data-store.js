const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { createHttpError } = require('./http-error');
const { normaliseProviderIds } = require('./models');
const {
  createSharedSecretRecord,
  normaliseSessionTtlHours
} = require('./auth-service');
const { normalizeTrackMetadata, mergeTrackMetadata } = require('./metadata-normalizer');

function createDefaultSettings(musicRoot) {
  const serverRoot = path.join(musicRoot, 'Apollo');
  return {
    ytDlpPath: 'yt-dlp',
    ffmpegPath: 'ffmpeg',
    libraryDirectory: path.join(serverRoot, 'library'),
    incomingDirectory: path.join(serverRoot, 'incoming'),
    serverHost: '127.0.0.1',
    serverPort: '4848',
    autoStartBackgroundServer: false,
    apiAuthEnabled: false,
    apiSessionTtlHours: 168,
    apiSharedSecretHash: '',
    apiSharedSecretSalt: '',
    spotifyClientId: '',
    spotifyClientSecret: ''
  };
}

const GENERIC_ALBUM_NAMES = new Set(['', 'singles', 'youtube', 'soundcloud', 'spotify', 'deezer']);
const EXPLICITLY_CLEARABLE_STRING_SETTINGS = new Set([
  'ytDlpPath',
  'ffmpegPath',
  'spotifyClientId',
  'spotifyClientSecret'
]);

function normaliseComparableText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normaliseComparableUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function hasSameProviderIdentity(leftProviderIds = {}, rightProviderIds = {}) {
  const leftIds = normaliseProviderIds(leftProviderIds);
  const rightIds = normaliseProviderIds(rightProviderIds);

  if (leftIds.isrc && rightIds.isrc && leftIds.isrc === rightIds.isrc) {
    return true;
  }

  return ['spotify', 'youtube', 'soundcloud', 'itunes', 'deezer'].some((key) => {
    return leftIds[key] && rightIds[key] && leftIds[key] === rightIds[key];
  });
}

function hasCompatibleDuration(leftDuration, rightDuration) {
  if (!leftDuration || !rightDuration) {
    return true;
  }

  return Math.abs(Number(leftDuration) - Number(rightDuration)) <= 5;
}

function hasSameMetadataFingerprint(left, right) {
  const leftTitle = normaliseComparableText(left.title);
  const rightTitle = normaliseComparableText(right.title);
  const leftArtist = normaliseComparableText(left.artist);
  const rightArtist = normaliseComparableText(right.artist);

  if (!leftTitle || !rightTitle || !leftArtist || !rightArtist) {
    return false;
  }

  if (leftTitle !== rightTitle || leftArtist !== rightArtist) {
    return false;
  }

  if (!hasCompatibleDuration(left.duration, right.duration)) {
    return false;
  }

  const leftAlbum = normaliseComparableText(left.album);
  const rightAlbum = normaliseComparableText(right.album);
  if (
    leftAlbum &&
    rightAlbum &&
    !GENERIC_ALBUM_NAMES.has(leftAlbum) &&
    !GENERIC_ALBUM_NAMES.has(rightAlbum) &&
    leftAlbum !== rightAlbum
  ) {
    return false;
  }

  return true;
}

function isTrackEquivalent(left, right) {
  if (!left || !right) {
    return false;
  }

  if (hasSameProviderIdentity(left.providerIds, right.providerIds)) {
    return true;
  }

  const leftSourceUrl = normaliseComparableUrl(left.sourceUrl || left.externalUrl || left.downloadTarget);
  const rightSourceUrl = normaliseComparableUrl(right.sourceUrl || right.externalUrl || right.downloadTarget);
  if (leftSourceUrl && rightSourceUrl && leftSourceUrl === rightSourceUrl) {
    return true;
  }

  return hasSameMetadataFingerprint(left, right);
}

function normaliseStoredTrack(track = {}, existingTrack = null) {
  const mergedMetadata = mergeTrackMetadata(existingTrack || {}, track || {});
  const providerIds = normaliseProviderIds(track.providerIds || existingTrack?.providerIds || {});
  const filePath = track.filePath || existingTrack?.filePath || '';

  return {
    id: track.id || existingTrack?.id || randomUUID(),
    title: mergedMetadata.title || 'Unknown Title',
    artist: mergedMetadata.artist || 'Unknown Artist',
    artists: Array.isArray(mergedMetadata.artists) ? mergedMetadata.artists : [mergedMetadata.artist || 'Unknown Artist'],
    album: mergedMetadata.album || 'Singles',
    albumArtist: mergedMetadata.albumArtist || mergedMetadata.artist || 'Unknown Artist',
    trackNumber: mergedMetadata.trackNumber || null,
    discNumber: mergedMetadata.discNumber || null,
    duration: mergedMetadata.duration || null,
    releaseDate: mergedMetadata.releaseDate || '',
    releaseYear: mergedMetadata.releaseYear || null,
    genre: mergedMetadata.genre || '',
    explicit:
      mergedMetadata.explicit === null || mergedMetadata.explicit === undefined
        ? null
        : Boolean(mergedMetadata.explicit),
    provider: track.provider || existingTrack?.provider || mergedMetadata.sourcePlatform || 'library',
    sourcePlatform:
      track.sourcePlatform || existingTrack?.sourcePlatform || mergedMetadata.sourcePlatform || track.provider || 'library',
    artwork:
      typeof track.artwork === 'string'
        ? track.artwork
        : existingTrack?.artwork || mergedMetadata.artwork || '',
    providerIds,
    isrc: track.isrc || providerIds.isrc || existingTrack?.isrc || '',
    sourceUrl: track.sourceUrl || existingTrack?.sourceUrl || mergedMetadata.sourceUrl || '',
    externalUrl: track.externalUrl || existingTrack?.externalUrl || mergedMetadata.externalUrl || '',
    metadataSource: track.metadataSource || existingTrack?.metadataSource || mergedMetadata.metadataSource || 'library',
    filePath,
    fileName: track.fileName || existingTrack?.fileName || (filePath ? path.basename(filePath) : ''),
    addedAt: existingTrack ? existingTrack.addedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createPlaylistEntry(entry = {}, order = 0) {
  const sourceTrack = entry.sourceTrack ? normaliseStoredTrack(entry.sourceTrack) : null;
  return {
    id: entry.id || randomUUID(),
    order,
    trackId: entry.trackId || '',
    sourceTrack,
    unavailable: Boolean(entry.unavailable),
    error: String(entry.error || '').trim(),
    addedAt: entry.addedAt || new Date().toISOString()
  };
}

function normalisePlaylistState(playlist = {}) {
  const trackIds = Array.isArray(playlist.trackIds) ? playlist.trackIds.filter(Boolean) : [];
  const explicitEntries = Array.isArray(playlist.entries)
    ? playlist.entries.map((entry, index) => createPlaylistEntry(entry, index))
    : [];
  const entries =
    explicitEntries.length ||
    !trackIds.length
      ? explicitEntries
      : trackIds.map((trackId, index) =>
          createPlaylistEntry(
            {
              trackId,
              addedAt: playlist.updatedAt || playlist.createdAt || new Date().toISOString()
            },
            index
          )
        );

  return {
    id: playlist.id || randomUUID(),
    name: String(playlist.name || playlist.title || '').trim() || 'Untitled Playlist',
    description: String(playlist.description || '').trim(),
    artworkUrl: playlist.artworkUrl || '',
    artworkPath: playlist.artworkPath || '',
    sourcePlatform: playlist.sourcePlatform || '',
    sourcePlaylistId: playlist.sourcePlaylistId || '',
    sourceUrl: playlist.sourceUrl || '',
    sourceSnapshotId: playlist.sourceSnapshotId || '',
    ownerName: playlist.ownerName || '',
    importedAt: playlist.importedAt || '',
    entries,
    createdAt: playlist.createdAt || new Date().toISOString(),
    updatedAt: playlist.updatedAt || new Date().toISOString()
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
    this.validateSettings(this.state.settings);
    await this.persist();
    await this.persistConfig();

    return this.getState();
  }

  validateSettings(settings) {
    if (
      settings.apiAuthEnabled &&
      !(settings.apiSharedSecretHash && settings.apiSharedSecretSalt)
    ) {
      throw createHttpError(400, 'Set an API shared secret before enabling API authentication.');
    }
  }

  async loadSettings() {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const config = JSON.parse(raw);
      const loadedSettings = this.normaliseLoadedSettings(config.settings || config);
      this.state.settings = {
        ...this.defaultSettings,
        ...this.state.settings,
        ...loadedSettings
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
    const tracks = Array.isArray(nextState.tracks)
      ? nextState.tracks.map((track) => normaliseStoredTrack(track))
      : [];

    return {
      settings: {
        ...this.defaultSettings,
        ...(nextState.settings || {})
      },
      tracks,
      playlists: Array.isArray(nextState.playlists)
        ? nextState.playlists.map((playlist) => normalisePlaylistState(playlist))
        : [],
      downloads: Array.isArray(nextState.downloads) ? nextState.downloads : []
    };
  }

  normaliseLoadedSettings(input = {}) {
    const nextSettings = {
      ...input
    };

    if (Object.prototype.hasOwnProperty.call(nextSettings, 'apiSharedSecret')) {
      const plaintextSecret = String(nextSettings.apiSharedSecret || '').trim();
      delete nextSettings.apiSharedSecret;

      if (plaintextSecret) {
        Object.assign(nextSettings, createSharedSecretRecord(plaintextSecret));
      }
    }

    if (Object.prototype.hasOwnProperty.call(nextSettings, 'apiSessionTtlHours')) {
      nextSettings.apiSessionTtlHours = normaliseSessionTtlHours(nextSettings.apiSessionTtlHours);
    }

    if (Object.prototype.hasOwnProperty.call(nextSettings, 'apiAuthEnabled')) {
      nextSettings.apiAuthEnabled = Boolean(nextSettings.apiAuthEnabled);
    }

    return nextSettings;
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  getSettings() {
    return { ...this.state.settings };
  }

  getPublicSettings() {
    return {
      ...this.state.settings,
      apiSharedSecret: '',
      apiSharedSecretConfigured: Boolean(
        this.state.settings.apiSharedSecretHash && this.state.settings.apiSharedSecretSalt
      ),
      apiSharedSecretHash: '',
      apiSharedSecretSalt: ''
    };
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

    const currentSettings = this.state.settings;
    const nextApiAuthEnabled = Object.prototype.hasOwnProperty.call(sanitised, 'apiAuthEnabled')
      ? Boolean(sanitised.apiAuthEnabled)
      : currentSettings.apiAuthEnabled;
    const nextApiSessionTtlHours = Object.prototype.hasOwnProperty.call(
      sanitised,
      'apiSessionTtlHours'
    )
      ? normaliseSessionTtlHours(sanitised.apiSessionTtlHours)
      : normaliseSessionTtlHours(currentSettings.apiSessionTtlHours);
    const nextSharedSecret = Object.prototype.hasOwnProperty.call(sanitised, 'apiSharedSecret')
      ? String(sanitised.apiSharedSecret || '').trim()
      : '';

    this.state.settings = {
      ...this.defaultSettings,
      ...this.state.settings,
      ...Object.fromEntries(
        Object.entries(sanitised).filter(([key, value]) => {
          if (['apiAuthEnabled', 'apiSessionTtlHours', 'apiSharedSecret'].includes(key)) {
            return false;
          }

          if (value !== '') {
            return true;
          }

          return EXPLICITLY_CLEARABLE_STRING_SETTINGS.has(key);
        })
      ),
      apiAuthEnabled: nextApiAuthEnabled,
      apiSessionTtlHours: nextApiSessionTtlHours
    };

    if (nextSharedSecret) {
      Object.assign(this.state.settings, createSharedSecretRecord(nextSharedSecret));
    }

    this.validateSettings(this.state.settings);

    await this.persist();
    await this.persistConfig();
    return this.getPublicSettings();
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
    const safePageSize = Math.min(10000, Math.max(1, Number.parseInt(pageSize, 10) || 12));
    const term = query.trim().toLowerCase();

    const filtered = this.state.tracks
      .filter((track) => {
        if (!term) {
          return true;
        }

        return [track.title, track.artist, track.album, track.genre, track.filePath]
          .concat(Array.isArray(track.artists) ? track.artists : [])
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term));
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

  findMatchingTrack(candidate) {
    return this.state.tracks.find((track) => isTrackEquivalent(track, candidate)) || null;
  }

  attachTrackToPlaylists(track) {
    for (const playlist of this.state.playlists) {
      let changed = false;
      playlist.entries = playlist.entries.map((entry, index) => {
        const nextEntry = createPlaylistEntry(entry, index);
        if (!nextEntry.trackId && nextEntry.sourceTrack && isTrackEquivalent(nextEntry.sourceTrack, track)) {
          nextEntry.trackId = track.id;
          changed = true;
        }
        nextEntry.order = index;
        return nextEntry;
      });

      if (changed) {
        playlist.updatedAt = new Date().toISOString();
      }
    }
  }

  linkPlaylistEntries(entries = []) {
    return entries.map((entry, index) => {
      const nextEntry = createPlaylistEntry(entry, index);
      if (!nextEntry.trackId && nextEntry.sourceTrack) {
        nextEntry.trackId = this.findMatchingTrack(nextEntry.sourceTrack)?.id || '';
      }
      nextEntry.order = index;
      return nextEntry;
    });
  }

  applyTrackUpsert(track) {
    const index = this.state.tracks.findIndex(
      (existing) => existing.id === track.id || (existing.filePath && existing.filePath === track.filePath)
    );
    const existingTrack = index >= 0 ? this.state.tracks[index] : null;
    const nextTrack = normaliseStoredTrack(track, existingTrack);

    if (index >= 0) {
      this.state.tracks[index] = nextTrack;
    } else {
      this.state.tracks.push(nextTrack);
    }

    this.attachTrackToPlaylists(nextTrack);
    return nextTrack;
  }

  async upsertTrack(track) {
    const nextTrack = this.applyTrackUpsert(track);
    await this.persist();
    return nextTrack;
  }

  async upsertTracks(tracks = []) {
    const upsertedTracks = [];
    for (const track of tracks) {
      upsertedTracks.push(this.applyTrackUpsert(track));
    }

    await this.persist();
    return upsertedTracks;
  }

  clearTrackFromPlaylistEntries(trackId) {
    for (const playlist of this.state.playlists) {
      const nextEntries = [];
      let changed = false;

      for (const entry of playlist.entries) {
        if (entry.trackId !== trackId) {
          nextEntries.push(entry);
          continue;
        }

        if (entry.sourceTrack) {
          nextEntries.push({
            ...entry,
            trackId: ''
          });
        }
        changed = true;
      }

      if (changed) {
        playlist.entries = nextEntries.map((entry, index) => createPlaylistEntry(entry, index));
        playlist.updatedAt = new Date().toISOString();
      }
    }
  }

  async deleteTrack(trackId) {
    const index = this.state.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) {
      throw createHttpError(404, 'Track not found.');
    }

    const [removedTrack] = this.state.tracks.splice(index, 1);
    this.clearTrackFromPlaylistEntries(trackId);
    await this.persist();

    return {
      ok: true,
      id: trackId,
      filePath: removedTrack.filePath || ''
    };
  }

  async removeTracksMissingFromPaths(existingPaths) {
    const pathSet = new Set(existingPaths.map((item) => item.toLowerCase()));
    const removedTrackIds = this.state.tracks
      .filter((track) => !pathSet.has((track.filePath || '').toLowerCase()))
      .map((track) => track.id);

    this.state.tracks = this.state.tracks.filter((track) =>
      pathSet.has((track.filePath || '').toLowerCase())
    );

    for (const trackId of removedTrackIds) {
      this.clearTrackFromPlaylistEntries(trackId);
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

  materializePlaylist(playlist) {
    if (!playlist) {
      return null;
    }

    const entries = playlist.entries.map((entry, index) => {
      const linkedTrack =
        (entry.trackId && this.getTrack(entry.trackId)) ||
        (entry.sourceTrack ? this.findMatchingTrack(entry.sourceTrack) : null);

      return {
        ...entry,
        order: index,
        trackId: linkedTrack?.id || entry.trackId || '',
        track: linkedTrack || entry.sourceTrack || null
      };
    });

    return {
      ...playlist,
      entries,
      tracks: entries.map((entry) => entry.track).filter(Boolean),
      trackIds: entries.map((entry) => entry.trackId).filter(Boolean)
    };
  }

  listPlaylists() {
    return this.state.playlists.map((playlist) => this.materializePlaylist(playlist)).filter(Boolean);
  }

  getPlaylist(playlistId) {
    return this.materializePlaylist(this.state.playlists.find((item) => item.id === playlistId) || null);
  }

  async createPlaylist({
    name,
    description = '',
    entries = [],
    artworkUrl = '',
    artworkPath = '',
    sourcePlatform = '',
    sourcePlaylistId = '',
    sourceUrl = '',
    sourceSnapshotId = '',
    ownerName = '',
    importedAt = ''
  }) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      throw createHttpError(400, 'Playlist name is required.');
    }

    const playlist = normalisePlaylistState({
      id: randomUUID(),
      name: trimmedName,
      description,
      artworkUrl,
      artworkPath,
      sourcePlatform,
      sourcePlaylistId,
      sourceUrl,
      sourceSnapshotId,
      ownerName,
      importedAt,
      entries,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    playlist.entries = this.linkPlaylistEntries(playlist.entries);

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

    if (Object.prototype.hasOwnProperty.call(updates, 'entries')) {
      playlist.entries = Array.isArray(updates.entries)
        ? this.linkPlaylistEntries(updates.entries)
        : playlist.entries;
    }

    for (const field of ['sourcePlatform', 'sourcePlaylistId', 'sourceUrl', 'sourceSnapshotId', 'ownerName', 'importedAt']) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        playlist[field] = String(updates[field] || '').trim();
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

    const track = this.getTrack(trackId);
    if (!track) {
      throw createHttpError(404, 'Track not found.');
    }

    if (!playlist.entries.some((entry) => entry.trackId === trackId)) {
      playlist.entries.push(
        createPlaylistEntry(
          {
            trackId,
            addedAt: new Date().toISOString()
          },
          playlist.entries.length
        )
      );
      playlist.updatedAt = new Date().toISOString();
      await this.persist();
    }

    return this.getPlaylist(playlistId);
  }

  async replacePlaylistEntries(playlistId, entries = []) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) {
      throw createHttpError(404, 'Playlist not found.');
    }

    playlist.entries = entries.map((entry, index) => createPlaylistEntry(entry, index));
    playlist.entries = this.linkPlaylistEntries(playlist.entries);
    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return this.getPlaylist(playlistId);
  }

  async removeTrackFromPlaylist(playlistId, trackId) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) {
      throw createHttpError(404, 'Playlist not found.');
    }

    playlist.entries = playlist.entries
      .filter((item) => item.trackId !== trackId)
      .map((entry, index) => createPlaylistEntry(entry, index));
    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return this.getPlaylist(playlistId);
  }
}

module.exports = {
  DataStore,
  createDefaultSettings,
  isTrackEquivalent
};
