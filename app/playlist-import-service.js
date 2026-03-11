const { INSTALLABLE_DEPENDENCIES, resolveExecutablePath, runProcess } = require('./binaries');
const { createHttpError } = require('./http-error');
const { fetchCachedJson, formatDeezerTrack } = require('./public-metadata-service');
const {
  fetchSpotifyToken,
  formatSpotifyTrack,
  extractResolvedMetadata
} = require('./search-service');

const SPOTIFY_PLAYLIST_URL_PATTERN = /^https?:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)(?:\?.*)?$/i;
const DEEZER_PLAYLIST_URL_PATTERN = /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)(?:\?.*)?$/i;
const YOUTUBE_PLAYLIST_URL_PATTERN = /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i;
const SOUNDCLOUD_PLAYLIST_URL_PATTERN = /^https?:\/\/(?:www\.)?soundcloud\.com\//i;

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectPlaylistProvider(url) {
  const trimmedUrl = String(url || '').trim();
  if (SPOTIFY_PLAYLIST_URL_PATTERN.test(trimmedUrl)) {
    return 'spotify';
  }
  if (DEEZER_PLAYLIST_URL_PATTERN.test(trimmedUrl)) {
    return 'deezer';
  }
  if (YOUTUBE_PLAYLIST_URL_PATTERN.test(trimmedUrl)) {
    return 'youtube';
  }
  if (SOUNDCLOUD_PLAYLIST_URL_PATTERN.test(trimmedUrl)) {
    return 'soundcloud';
  }

  return '';
}

async function fetchSpotifyJson(url, token, signal) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    signal
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Spotify playlist request failed with status ${response.status}.`);
  }

  return response.json();
}

async function importSpotifyPlaylist(url, settings, signal) {
  const playlistId = String(url).match(SPOTIFY_PLAYLIST_URL_PATTERN)?.[1] || '';
  if (!playlistId) {
    throw createHttpError(400, 'Unsupported Spotify playlist URL.');
  }
  if (!settings.spotifyClientId || !settings.spotifyClientSecret) {
    throw createHttpError(400, 'Spotify playlist import requires Spotify API credentials.');
  }

  const token = await fetchSpotifyToken(settings);
  const playlist = await fetchSpotifyJson(`https://api.spotify.com/v1/playlists/${playlistId}`, token, signal);
  const items = [];
  let nextUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

  while (nextUrl) {
    const payload = await fetchSpotifyJson(nextUrl, token, signal);
    items.push(...(payload.items || []));
    nextUrl = payload.next || '';
  }

  return {
    name: playlist.name || 'Untitled Playlist',
    description: stripHtml(playlist.description || ''),
    artworkUrl: playlist.images?.[0]?.url || '',
    sourcePlatform: 'spotify',
    sourcePlaylistId: playlistId,
    sourceUrl: playlist.external_urls?.spotify || url,
    sourceSnapshotId: playlist.snapshot_id || '',
    ownerName: playlist.owner?.display_name || '',
    importedAt: new Date().toISOString(),
    entries: items.map((item, index) => {
      if (!item.track || item.is_local) {
        return {
          order: index,
          trackId: '',
          sourceTrack: null,
          unavailable: true,
          error: item.is_local ? 'Local Spotify playlist items are not importable.' : 'Track metadata unavailable.'
        };
      }

      return {
        order: index,
        trackId: '',
        sourceTrack: formatSpotifyTrack(item.track),
        unavailable: false,
        error: ''
      };
    })
  };
}

async function fetchDeezerPlaylistPage(url, signal) {
  return fetchCachedJson(`deezer:playlist-page:${url}`, url, {
    signal,
    ttlMs: 5 * 60 * 1000
  });
}

async function importDeezerPlaylist(url, signal) {
  const playlistId = String(url).match(DEEZER_PLAYLIST_URL_PATTERN)?.[1] || '';
  if (!playlistId) {
    throw createHttpError(400, 'Unsupported Deezer playlist URL.');
  }

  const playlist = await fetchDeezerPlaylistPage(`https://api.deezer.com/playlist/${playlistId}`, signal);
  const items = [...(playlist.tracks?.data || [])];
  let nextUrl = playlist.tracks?.next || '';

  while (nextUrl) {
    const payload = await fetchDeezerPlaylistPage(nextUrl, signal);
    items.push(...(payload.data || []));
    nextUrl = payload.next || '';
  }

  return {
    name: playlist.title || 'Untitled Playlist',
    description: stripHtml(playlist.description || ''),
    artworkUrl:
      playlist.picture_xl ||
      playlist.picture_big ||
      playlist.picture_medium ||
      playlist.picture_small ||
      playlist.picture ||
      '',
    sourcePlatform: 'deezer',
    sourcePlaylistId: String(playlist.id || playlistId),
    sourceUrl: playlist.link || url,
    sourceSnapshotId: String(playlist.checksum || ''),
    ownerName: playlist.creator?.name || '',
    importedAt: new Date().toISOString(),
    entries: items.map((track, index) => ({
      order: index,
      trackId: '',
      sourceTrack: formatDeezerTrack(track),
      unavailable: false,
      error: ''
    }))
  };
}

async function importYtDlpPlaylist(url, settings, signal) {
  const ytDlpPath = await resolveExecutablePath(
    settings.ytDlpPath,
    INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
  );
  const { stdout } = await runProcess(ytDlpPath, [
    '--dump-single-json',
    '--no-warnings',
    url
  ], { signal });
  const payload = JSON.parse(stdout);
  const provider = String(payload.extractor_key || payload.extractor || '').toLowerCase().includes('soundcloud')
    ? 'soundcloud'
    : 'youtube';

  return {
    name: payload.title || payload.playlist_title || 'Untitled Playlist',
    description: stripHtml(payload.description || ''),
    artworkUrl:
      payload.thumbnails?.[payload.thumbnails.length - 1]?.url ||
      payload.thumbnail ||
      '',
    sourcePlatform: provider,
    sourcePlaylistId: String(payload.id || ''),
    sourceUrl: payload.webpage_url || url,
    sourceSnapshotId: '',
    ownerName: payload.channel || payload.uploader || '',
    importedAt: new Date().toISOString(),
    entries: (payload.entries || []).map((entry, index) => {
      try {
        return {
          order: index,
          trackId: '',
          sourceTrack: extractResolvedMetadata(entry, provider),
          unavailable: false,
          error: ''
        };
      } catch (error) {
        return {
          order: index,
          trackId: '',
          sourceTrack: null,
          unavailable: true,
          error: error.message
        };
      }
    })
  };
}

async function importPlaylistFromUrl(url, settings, { signal } = {}) {
  const trimmedUrl = String(url || '').trim();
  if (!trimmedUrl) {
    throw createHttpError(400, 'Playlist URL is required.');
  }

  const provider = detectPlaylistProvider(trimmedUrl);
  if (!provider) {
    throw createHttpError(400, 'Unsupported playlist URL.');
  }

  if (provider === 'spotify') {
    return importSpotifyPlaylist(trimmedUrl, settings, signal);
  }

  if (provider === 'deezer') {
    return importDeezerPlaylist(trimmedUrl, signal);
  }

  return importYtDlpPlaylist(trimmedUrl, settings, signal);
}

module.exports = {
  importPlaylistFromUrl,
  detectPlaylistProvider
};
