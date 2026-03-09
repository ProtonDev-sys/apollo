const path = require('path');

const PROVIDER_ID_KEYS = ['spotify', 'youtube', 'soundcloud', 'isrc'];

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

function formatApiTrack(track, baseUrl) {
  if (!track) {
    return null;
  }

  const resolvedBaseUrl = (baseUrl || '').replace(/\/$/, '');
  const streamUrl = resolvedBaseUrl ? `${resolvedBaseUrl}/stream/${track.id}` : '';

  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    provider: 'library',
    artwork: track.artwork || '',
    providerIds: normaliseProviderIds(track.providerIds),
    externalUrl: streamUrl,
    downloadTarget: streamUrl ? `${streamUrl}?download=1` : '',
    trackId: track.id,
    fileName: track.fileName || (track.filePath ? path.basename(track.filePath) : '')
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

function formatApiPlaylist(playlist, baseUrl) {
  if (!playlist) {
    return null;
  }

  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description || '',
    artworkUrl: resolvePlaylistArtworkUrl(playlist, baseUrl),
    trackIds: Array.isArray(playlist.trackIds) ? [...playlist.trackIds] : [],
    tracks: Array.isArray(playlist.tracks)
      ? playlist.tracks.map((track) => formatApiTrack(track, baseUrl)).filter(Boolean)
      : [],
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
  resolvePlaylistArtworkUrl
};
