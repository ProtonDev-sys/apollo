const { randomUUID } = require('crypto');
const { INSTALLABLE_DEPENDENCIES, resolveExecutablePath, runProcess } = require('./binaries');
const { createHttpError } = require('./http-error');
const { createEmptyProviderIds, formatApiTrack } = require('./models');

const SEARCH_PROVIDER_ORDER = ['spotify', 'youtube', 'soundcloud'];

function parseProviderSelection(input) {
  const rawProviders = String(input || 'all')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!rawProviders.length || rawProviders.includes('all')) {
    return ['spotify', 'youtube'];
  }

  const unknownProviders = rawProviders.filter((provider) => !SEARCH_PROVIDER_ORDER.includes(provider));
  if (unknownProviders.length) {
    throw createHttpError(400, `Unknown providers: ${unknownProviders.join(', ')}`);
  }

  return [...new Set(rawProviders)];
}

async function fetchSpotifyToken(settings) {
  const credentials = Buffer.from(
    `${settings.spotifyClientId}:${settings.spotifyClientSecret}`,
    'utf8'
  ).toString('base64');

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    throw new Error('Spotify authentication failed. Verify client ID and secret.');
  }

  const payload = await response.json();
  return payload.access_token;
}

function formatSpotifyTrack(item) {
  return {
    id: `spotify:${item.id}`,
    provider: 'spotify',
    title: item.name,
    artist: item.artists.map((artist) => artist.name).join(', '),
    album: item.album?.name || 'Spotify',
    duration: item.duration_ms ? Math.round(item.duration_ms / 1000) : null,
    artwork: item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || '',
    externalUrl: item.external_urls?.spotify || '',
    downloadTarget: `ytsearch1:${item.artists.map((artist) => artist.name).join(' ')} ${item.name} audio`,
    providerIds: createEmptyProviderIds({
      spotify: item.id,
      isrc: item.external_ids?.isrc || ''
    })
  };
}

async function searchSpotify(query, page, pageSize, settings) {
  if (!settings.spotifyClientId || !settings.spotifyClientSecret) {
    return {
      items: [],
      total: 0,
      page,
      pageSize,
      totalPages: 1
    };
  }

  const token = await fetchSpotifyToken(settings);
  const offset = (page - 1) * pageSize;
  const response = await fetch(
    `https://api.spotify.com/v1/search?type=track&limit=${pageSize}&offset=${offset}&q=${encodeURIComponent(query)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    throw new Error('Spotify search failed.');
  }

  const payload = await response.json();
  const total = payload.tracks?.total || 0;
  return {
    items: (payload.tracks?.items || []).map(formatSpotifyTrack),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

function formatYtDlpEntry(entry, provider) {
  const resolvedUrl =
    entry.webpage_url ||
    (provider === 'youtube' && entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : '') ||
    (provider === 'soundcloud' && entry.url?.startsWith('http') ? entry.url : '');

  return {
    id: `${provider}:${entry.id || randomUUID()}`,
    provider,
    title: entry.title || 'Untitled',
    artist: entry.uploader || entry.channel || 'Unknown Artist',
    album: provider === 'youtube' ? 'YouTube' : 'SoundCloud',
    duration: entry.duration || null,
    artwork: entry.thumbnails?.[0]?.url || '',
    externalUrl: resolvedUrl,
    downloadTarget: resolvedUrl,
    providerIds: createEmptyProviderIds({
      [provider]: entry.id || ''
    })
  };
}

async function searchViaYtDlp(query, provider, page, pageSize, settings) {
  const ytDlpPath = await resolveExecutablePath(
    settings.ytDlpPath,
    INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
  );
  const prefix = provider === 'soundcloud' ? 'scsearch' : 'ytsearch';
  const limit = Math.min(30, page * pageSize);
  const { stdout } = await runProcess(ytDlpPath, [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    `${prefix}${limit}:${query}`
  ]);
  const payload = JSON.parse(stdout);
  const items = (payload.entries || []).map((entry) => formatYtDlpEntry(entry, provider));
  const start = (page - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize))
  };
}

async function searchProviders({ query, provider = 'all', page = 1, pageSize = 8 }, settings) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      items: [],
      total: 0,
      page: 1,
      pageSize,
      totalPages: 1,
      provider: parseProviderSelection(provider),
      warning: ''
    };
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(20, Math.max(1, Number.parseInt(pageSize, 10) || 8));
  const providers = parseProviderSelection(provider);
  const results = await Promise.allSettled(
    providers.map((selectedProvider) => {
      if (selectedProvider === 'spotify') {
        return searchSpotify(trimmedQuery, safePage, safePageSize, settings);
      }

      return searchViaYtDlp(trimmedQuery, selectedProvider, safePage, safePageSize, settings);
    })
  );

  const items = [];
  const warnings = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      items.push(...result.value.items);
      continue;
    }

    warnings.push(result.reason.message);
  }

  return {
    items,
    total: items.length,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(items.length / safePageSize)),
    provider: providers,
    warning: warnings.join(' ')
  };
}

async function inspectDirectLink(url, settings) {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error('Enter a direct media link.');
  }

  const ytDlpPath = await resolveExecutablePath(
    settings.ytDlpPath,
    INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
  );
  const { stdout } = await runProcess(ytDlpPath, [
    '--dump-single-json',
    '--no-warnings',
    trimmedUrl
  ]);
  const payload = JSON.parse(stdout);

  return {
    id: `link:${payload.id || randomUUID()}`,
    provider: payload.extractor_key?.toLowerCase() || 'link',
    title: payload.title || 'Untitled',
    artist: payload.uploader || payload.channel || payload.artist || 'Unknown Artist',
    album: payload.album || 'Singles',
    duration: payload.duration || null,
    artwork: payload.thumbnail || payload.thumbnails?.[0]?.url || '',
    externalUrl: payload.webpage_url || trimmedUrl,
    downloadTarget: trimmedUrl,
    providerIds: createEmptyProviderIds({
      youtube: payload.extractor_key?.toLowerCase() === 'youtube' ? payload.id || '' : '',
      soundcloud: payload.extractor_key?.toLowerCase() === 'soundcloud' ? payload.id || '' : '',
      isrc: payload.track_id || payload.isrc || ''
    })
  };
}

async function searchCatalog(payload, settings, store, baseUrl) {
  const query = payload.query || '';
  const page = Math.max(1, Number.parseInt(payload.page, 10) || 1);
  const pageSize = Math.min(20, Math.max(1, Number.parseInt(payload.pageSize, 10) || 8));
  const scope = payload.scope || 'all';
  const providers = parseProviderSelection(payload.provider || 'all');

  const library =
    scope === 'remote'
      ? {
          items: [],
          total: 0,
          page,
          pageSize,
          totalPages: 1
        }
      : (() => {
          const result = store.listTracks({ query, page, pageSize });
          return {
            ...result,
            items: result.items.map((track) => formatApiTrack(track, baseUrl))
          };
        })();

  const remote =
    scope === 'library'
      ? {
          items: [],
          total: 0,
          page,
          pageSize,
          totalPages: 1,
          warning: ''
        }
      : await searchProviders({ query, provider: providers, page, pageSize }, settings);

  return {
    query,
    provider: providers,
    scope,
    library,
    remote
  };
}

async function resolveRemoteMedia(input, settings) {
  const target = input.downloadTarget || input.externalUrl || input.url;
  if (!target) {
    throw new Error('No remote source was provided.');
  }

  const ytDlpPath = await resolveExecutablePath(
    settings.ytDlpPath,
    INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
  );
  const { stdout } = await runProcess(ytDlpPath, [
    '--get-url',
    '--format',
    'bestaudio/best',
    target
  ]);
  const directUrl = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!directUrl) {
    throw new Error('Unable to resolve a playable media URL.');
  }

  return {
    directUrl,
    fileName: `${input.artist || 'Unknown Artist'} - ${input.title || 'Untitled'}.mp3`
  };
}

async function resolvePlayback(input, settings, store, baseUrl) {
  if (input.trackId) {
    const track = store.getTrack(input.trackId);
    if (!track) {
      throw new Error('Track not found.');
    }

    return {
      type: 'library',
      streamUrl: `${baseUrl}/stream/${track.id}`,
      downloadUrl: `${baseUrl}/stream/${track.id}?download=1`,
      title: track.title,
      artist: track.artist,
      album: track.album
    };
  }

  const resolved = await resolveRemoteMedia(input, settings);
  return {
    type: 'remote',
    streamUrl: resolved.directUrl,
    downloadUrl: resolved.directUrl,
    title: input.title || 'Untitled',
    artist: input.artist || 'Unknown Artist',
    album: input.album || 'Singles',
    fileName: resolved.fileName
  };
}

async function resolveClientDownload(input, settings, store, baseUrl) {
  if (input.trackId) {
    const track = store.getTrack(input.trackId);
    if (!track) {
      throw new Error('Track not found.');
    }

    return {
      type: 'library',
      downloadUrl: `${baseUrl}/stream/${track.id}?download=1`,
      fileName: track.fileName,
      title: track.title,
      artist: track.artist
    };
  }

  const resolved = await resolveRemoteMedia(input, settings);
  return {
    type: 'remote',
    downloadUrl: resolved.directUrl,
    fileName: resolved.fileName,
    title: input.title || 'Untitled',
    artist: input.artist || 'Unknown Artist'
  };
}

module.exports = {
  parseProviderSelection,
  searchProviders,
  inspectDirectLink,
  searchCatalog,
  resolvePlayback,
  resolveClientDownload
};
