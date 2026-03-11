const path = require('path');
const { normalizeTrackMetadata } = require('./metadata-normalizer');

const PROVIDER_ID_KEYS = ['spotify', 'youtube', 'soundcloud', 'itunes', 'deezer', 'isrc'];

function createEmptyProviderIds(overrides = {}) {
  const providerIds = {};

  for (const key of PROVIDER_ID_KEYS) {
    const value = overrides[key];
    providerIds[key] = typeof value === 'string' ? value.trim() : value ? String(value) : '';
  }

  return providerIds;
}

function normaliseProviderIds(input = {}) {
  return createEmptyProviderIds(input);
}

function formatTrackIdentifiers(track) {
  const providerIds = normaliseProviderIds(track.providerIds);
  return {
    ...providerIds,
    isrc: track.isrc || providerIds.isrc || ''
  };
}

function formatApiTrack(track, baseUrl) {
  if (!track) {
    return null;
  }

  const normalized = normalizeTrackMetadata({
    provider: track.sourcePlatform || track.provider || (track.filePath ? 'library' : 'link'),
    title: track.title,
    artist: track.artist,
    artists: track.artists,
    album: track.album,
    albumArtist: track.albumArtist,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    duration: track.duration,
    releaseDate: track.releaseDate,
    releaseYear: track.releaseYear,
    genre: track.genre,
    explicit: track.explicit,
    artwork: track.artwork,
    sourceUrl: track.sourceUrl,
    externalUrl: track.externalUrl,
    isrc: track.isrc,
    metadataSource: track.metadataSource || track.provider || 'library'
  });

  const resolvedBaseUrl = (baseUrl || '').replace(/\/$/, '');
  const isLibraryTrack = Boolean(track.filePath);
  const streamUrl = isLibraryTrack && resolvedBaseUrl ? `${resolvedBaseUrl}/stream/${track.id}` : '';
  const providerIds = formatTrackIdentifiers(track);

  return {
    id: track.id,
    title: normalized.title,
    artist: normalized.artist,
    artists: normalized.artists,
    album: normalized.album,
    albumArtist: normalized.albumArtist,
    trackNumber: normalized.trackNumber,
    discNumber: normalized.discNumber,
    duration: normalized.duration,
    releaseDate: normalized.releaseDate,
    releaseYear: normalized.releaseYear,
    genre: normalized.genre,
    explicit: normalized.explicit,
    provider: isLibraryTrack ? 'library' : normalized.sourcePlatform,
    sourcePlatform: normalized.sourcePlatform,
    artwork: normalized.artwork || '',
    externalUrl:
      (isLibraryTrack ? streamUrl : normalized.externalUrl || normalized.sourceUrl) || '',
    downloadTarget:
      (isLibraryTrack
        ? (streamUrl ? `${streamUrl}?download=1` : '')
        : track.downloadTarget || normalized.externalUrl || normalized.sourceUrl) || '',
    sourceUrl: normalized.sourceUrl || normalized.externalUrl || '',
    trackId: isLibraryTrack ? track.id : track.trackId || '',
    fileName: track.fileName || (track.filePath ? path.basename(track.filePath) : ''),
    providerIds,
    isrc: providerIds.isrc,
    normalizedTitle: normalized.normalizedTitle,
    normalizedArtist: normalized.normalizedArtist,
    normalizedAlbum: normalized.normalizedAlbum,
    normalizedDuration: normalized.normalizedDuration,
    metadataSource: normalized.metadataSource
  };
}

function resolvePlaylistArtworkUrl(playlist, baseUrl) {
  if (!playlist) {
    return '';
  }

  if (playlist.artworkPath && baseUrl) {
    const fileName = encodeURIComponent(path.basename(playlist.artworkPath));
    return `${baseUrl.replace(/\/$/, '')}/media/playlists/${fileName}`;
  }

  return playlist.artworkUrl || '';
}

function formatApiPlaylistEntry(entry, baseUrl) {
  if (!entry) {
    return null;
  }

  return {
    id: entry.id,
    order: Number.isFinite(entry.order) ? entry.order : 0,
    trackId: entry.trackId || '',
    unavailable: Boolean(entry.unavailable),
    error: entry.error || '',
    addedAt: entry.addedAt || '',
    track: formatApiTrack(entry.track || entry.sourceTrack, baseUrl)
  };
}

function formatApiPlaylist(playlist, baseUrl) {
  if (!playlist) {
    return null;
  }

  const entries = Array.isArray(playlist.entries)
    ? playlist.entries.map((entry) => formatApiPlaylistEntry(entry, baseUrl)).filter(Boolean)
    : [];
  const tracks = entries
    .map((entry) => entry.track)
    .filter(Boolean);

  return {
    id: playlist.id,
    name: playlist.name,
    title: playlist.name,
    description: playlist.description || '',
    artworkUrl: resolvePlaylistArtworkUrl(playlist, baseUrl),
    sourcePlatform: playlist.sourcePlatform || '',
    sourcePlaylistId: playlist.sourcePlaylistId || '',
    sourceUrl: playlist.sourceUrl || '',
    sourceSnapshotId: playlist.sourceSnapshotId || '',
    ownerName: playlist.ownerName || '',
    importedAt: playlist.importedAt || '',
    trackIds: entries.map((entry) => entry.trackId).filter(Boolean),
    entries,
    tracks,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt
  };
}

module.exports = {
  PROVIDER_ID_KEYS,
  createEmptyProviderIds,
  normaliseProviderIds,
  formatApiTrack,
  formatApiPlaylist,
  formatApiPlaylistEntry,
  resolvePlaylistArtworkUrl
};
