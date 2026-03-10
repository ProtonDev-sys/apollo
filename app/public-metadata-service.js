const { createAbortError, createHttpError } = require('./http-error');
const { createEmptyProviderIds } = require('./models');
const { normalizeTrackMetadata, normaliseComparable } = require('./metadata-normalizer');

const MUSICBRAINZ_BASE_URL = 'https://musicbrainz.org/ws/2';
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const DEEZER_API_BASE_URL = 'https://api.deezer.com';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MUSICBRAINZ_MIN_INTERVAL_MS = 1100;
const MUSICBRAINZ_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Apollo/0.1.0 (https://github.com/ProtonDev-sys/apollo)'
};

const responseCache = new Map();
const inFlightRequests = new Map();
let musicBrainzQueue = Promise.resolve();
let nextMusicBrainzRequestAt = 0;

function clonePayload(value) {
  return JSON.parse(JSON.stringify(value));
}

function raceWithSignal(promise, signal) {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(signal.reason || createAbortError('Request was closed by the client.', 499));
  }

  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      reject(signal.reason || createAbortError('Request was closed by the client.', 499));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      }
    );
  });
}

function getCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(cacheKey);
    return null;
  }

  return clonePayload(cached.payload);
}

function setCachedResponse(cacheKey, payload, ttlMs = DEFAULT_CACHE_TTL_MS) {
  responseCache.set(cacheKey, {
    payload: clonePayload(payload),
    expiresAt: Date.now() + ttlMs
  });

  if (responseCache.size > 500) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) {
      responseCache.delete(oldestKey);
    }
  }
}

function scheduleMusicBrainzRequest(task) {
  const runner = async () => {
    const waitTime = Math.max(0, nextMusicBrainzRequestAt - Date.now());
    if (waitTime) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    nextMusicBrainzRequestAt = Date.now() + MUSICBRAINZ_MIN_INTERVAL_MS;
    return task();
  };

  const nextRequest = musicBrainzQueue.then(runner, runner);
  musicBrainzQueue = nextRequest.catch(() => {});
  return nextRequest;
}

async function fetchJson(url, { headers = {}, signal, throttle = '' } = {}) {
  const runFetch = async () => {
    const response = await fetch(url, {
      headers,
      signal
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw createHttpError(404, 'Resource not found.');
      }

      const detail = await response.text();
      throw new Error(detail || `Request failed with status ${response.status}.`);
    }

    return response.json();
  };

  if (throttle === 'musicbrainz') {
    return scheduleMusicBrainzRequest(runFetch);
  }

  return runFetch();
}

async function fetchCachedJson(
  cacheKey,
  url,
  { headers = {}, signal, throttle = '', ttlMs = DEFAULT_CACHE_TTL_MS } = {}
) {
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    return cached;
  }

  let sharedRequest = inFlightRequests.get(cacheKey);
  if (!sharedRequest) {
    sharedRequest = fetchJson(url, { headers, throttle })
      .then((payload) => {
        setCachedResponse(cacheKey, payload, ttlMs);
        return clonePayload(payload);
      })
      .finally(() => {
        if (inFlightRequests.get(cacheKey) === sharedRequest) {
          inFlightRequests.delete(cacheKey);
        }
      });
    inFlightRequests.set(cacheKey, sharedRequest);
  }

  return raceWithSignal(sharedRequest.then((payload) => clonePayload(payload)), signal);
}

function normaliseArtistPayload(artist) {
  return {
    id: artist.id,
    name: artist.name || 'Unknown Artist',
    sortName: artist['sort-name'] || artist.name || '',
    type: artist.type || '',
    country: artist.country || '',
    area: artist.area?.name || '',
    disambiguation: artist.disambiguation || '',
    lifeSpan: {
      begin: artist['life-span']?.begin || '',
      end: artist['life-span']?.end || '',
      ended: Boolean(artist['life-span']?.ended)
    },
    tags: (artist.tags || [])
      .map((tag) => tag.name)
      .filter(Boolean)
      .slice(0, 10),
    source: 'musicbrainz'
  };
}

function buildYouTubeSearchTarget(artist, title) {
  return `ytsearch1:${[artist, title, 'audio'].filter(Boolean).join(' ')}`;
}

function formatItunesTrack(track) {
  const normalized = normalizeTrackMetadata({
    provider: 'itunes',
    title: track.trackName || track.collectionName || 'Untitled',
    artist: track.artistName || 'Unknown Artist',
    album: track.collectionName || 'iTunes',
    duration: track.trackTimeMillis ? Math.round(track.trackTimeMillis / 1000) : null,
    metadataSource: 'itunes'
  });

  return {
    id: `itunes:${track.trackId || track.collectionId || track.artistId || normalized.normalizedTitle}`,
    provider: 'itunes',
    title: normalized.title,
    artist: normalized.artist,
    album: normalized.album,
    duration: normalized.duration,
    artwork: track.artworkUrl100 || track.artworkUrl60 || '',
    externalUrl: track.trackViewUrl || track.collectionViewUrl || '',
    downloadTarget: buildYouTubeSearchTarget(normalized.artist, normalized.title),
    providerIds: createEmptyProviderIds({
      itunes: track.trackId || track.collectionId || ''
    }),
    normalizedTitle: normalized.normalizedTitle,
    normalizedArtist: normalized.normalizedArtist,
    normalizedAlbum: normalized.normalizedAlbum,
    normalizedDuration: normalized.normalizedDuration,
    metadataSource: normalized.metadataSource
  };
}

function formatDeezerTrack(track) {
  const normalized = normalizeTrackMetadata({
    provider: 'deezer',
    title: track.title || track.title_short || 'Untitled',
    artist: track.artist?.name || 'Unknown Artist',
    album: track.album?.title || 'Deezer',
    duration: track.duration || null,
    metadataSource: 'deezer'
  });

  return {
    id: `deezer:${track.id || normalized.normalizedTitle}`,
    provider: 'deezer',
    title: normalized.title,
    artist: normalized.artist,
    album: normalized.album,
    duration: normalized.duration,
    artwork:
      track.album?.cover_medium ||
      track.album?.cover ||
      track.artist?.picture_medium ||
      track.artist?.picture ||
      '',
    externalUrl: track.link || '',
    downloadTarget: buildYouTubeSearchTarget(normalized.artist, normalized.title),
    providerIds: createEmptyProviderIds({
      isrc: track.isrc || '',
      deezer: track.id || ''
    }),
    normalizedTitle: normalized.normalizedTitle,
    normalizedArtist: normalized.normalizedArtist,
    normalizedAlbum: normalized.normalizedAlbum,
    normalizedDuration: normalized.normalizedDuration,
    metadataSource: normalized.metadataSource
  };
}

async function searchItunesArtistTracksByName(artistName, { signal } = {}) {
  const trimmedArtistName = String(artistName || '').trim();
  if (!trimmedArtistName) {
    return [];
  }

  const url =
    `${ITUNES_SEARCH_URL}?media=music&entity=song&attribute=artistTerm&term=${encodeURIComponent(trimmedArtistName)}` +
    '&limit=200';
  const payload = await fetchCachedJson(`itunes:artist-tracks:${trimmedArtistName}`, url, {
    signal,
    ttlMs: 15 * 60 * 1000
  });
  const normalizedArtistName = normaliseComparable(trimmedArtistName);

  return dedupeArtistTracks(
    (payload.results || [])
      .map(formatItunesTrack)
      .filter((track) => {
        const normalizedArtist = normaliseComparable(track.artist);
        return (
          normalizedArtist === normalizedArtistName ||
          normalizedArtist.includes(normalizedArtistName) ||
          normalizedArtistName.includes(normalizedArtist)
        );
      })
  );
}

function dedupeArtistTracks(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const dedupeKey = [
      normaliseComparable(item.title),
      normaliseComparable(item.artist),
      item.duration || ''
    ].join('::');

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    deduped.push(item);
  }

  return deduped;
}

async function searchArtists({ query, page = 1, pageSize = 10, signal } = {}) {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) {
    return {
      items: [],
      total: 0,
      page: 1,
      pageSize,
      totalPages: 1
    };
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(25, Math.max(1, Number.parseInt(pageSize, 10) || 10));
  const offset = (safePage - 1) * safePageSize;
  const url =
    `${MUSICBRAINZ_BASE_URL}/artist?fmt=json&query=${encodeURIComponent(trimmedQuery)}` +
    `&limit=${safePageSize}&offset=${offset}`;
  const payload = await fetchCachedJson(`mb:artist-search:${safePage}:${safePageSize}:${trimmedQuery}`, url, {
    headers: MUSICBRAINZ_HEADERS,
    signal,
    throttle: 'musicbrainz'
  });
  const total = payload.count || 0;

  return {
    items: (payload.artists || []).map(normaliseArtistPayload),
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(total / safePageSize))
  };
}

async function getArtistProfile(artistId, { signal } = {}) {
  const trimmedArtistId = String(artistId || '').trim();
  if (!trimmedArtistId) {
    throw createHttpError(400, 'Artist ID is required.');
  }

  const url = `${MUSICBRAINZ_BASE_URL}/artist/${encodeURIComponent(trimmedArtistId)}?fmt=json&inc=genres+aliases+url-rels`;
  const artist = await fetchCachedJson(`mb:artist:${trimmedArtistId}`, url, {
    headers: MUSICBRAINZ_HEADERS,
    signal,
    throttle: 'musicbrainz',
    ttlMs: 15 * 60 * 1000
  });
  const profile = normaliseArtistPayload(artist);

  return {
    ...profile,
    aliases: (artist.aliases || []).map((alias) => alias.name).filter(Boolean).slice(0, 20),
    genres: (artist.genres || [])
      .map((genre) => genre.name)
      .filter(Boolean)
      .slice(0, 10),
    links: (artist.relations || [])
      .map((relation) => ({
        type: relation.type || '',
        url: relation.url?.resource || ''
      }))
      .filter((relation) => relation.url)
      .slice(0, 20)
  };
}

async function listArtistReleases(artistId, { page = 1, pageSize = 20, signal } = {}) {
  const trimmedArtistId = String(artistId || '').trim();
  if (!trimmedArtistId) {
    throw createHttpError(400, 'Artist ID is required.');
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(50, Math.max(1, Number.parseInt(pageSize, 10) || 20));
  const offset = (safePage - 1) * safePageSize;
  const url =
    `${MUSICBRAINZ_BASE_URL}/release-group?fmt=json&artist=${encodeURIComponent(trimmedArtistId)}` +
    `&limit=${safePageSize}&offset=${offset}`;
  const payload = await fetchCachedJson(
    `mb:artist-releases:${trimmedArtistId}:${safePage}:${safePageSize}`,
    url,
    {
      headers: MUSICBRAINZ_HEADERS,
      signal,
      throttle: 'musicbrainz',
      ttlMs: 15 * 60 * 1000
    }
  );
  const total = payload['release-group-count'] || 0;

  return {
    items: (payload['release-groups'] || []).map((releaseGroup) => ({
      id: releaseGroup.id,
      title: releaseGroup.title || 'Untitled Release',
      primaryType: releaseGroup['primary-type'] || '',
      secondaryTypes: releaseGroup['secondary-types'] || [],
      firstReleaseDate: releaseGroup['first-release-date'] || '',
      artistId: trimmedArtistId,
      source: 'musicbrainz'
    })),
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(total / safePageSize))
  };
}

async function listArtistTracks(artistId, { page = 1, pageSize = 25, signal } = {}) {
  const trimmedArtistId = String(artistId || '').trim();
  if (!trimmedArtistId) {
    throw createHttpError(400, 'Artist ID is required.');
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(50, Math.max(1, Number.parseInt(pageSize, 10) || 25));
  const profile = await getArtistProfile(trimmedArtistId, { signal });
  const itunesItems = await searchItunesArtistTracksByName(profile.name, { signal });

  if (itunesItems.length) {
    const start = (safePage - 1) * safePageSize;
    return {
      items: itunesItems.slice(start, start + safePageSize),
      total: itunesItems.length,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(itunesItems.length / safePageSize))
    };
  }

  const fetchLimit = Math.min(100, safePageSize * 3);
  const offset = (safePage - 1) * safePageSize;
  const url =
    `${MUSICBRAINZ_BASE_URL}/recording?fmt=json&artist=${encodeURIComponent(trimmedArtistId)}` +
    `&inc=artist-credits+isrcs&limit=${fetchLimit}&offset=${offset}`;
  const payload = await fetchCachedJson(
    `mb:artist-tracks:${trimmedArtistId}:${safePage}:${safePageSize}`,
    url,
    {
      headers: MUSICBRAINZ_HEADERS,
      signal,
      throttle: 'musicbrainz',
      ttlMs: 15 * 60 * 1000
    }
  );

  const items = dedupeArtistTracks(
    (payload.recordings || []).map((recording) => {
      const normalized = normalizeTrackMetadata({
        provider: 'musicbrainz',
        title: recording.title || 'Untitled',
        artist: recording['artist-credit']?.map((credit) => credit.name).join(', ') || 'Unknown Artist',
        album: 'Singles',
        duration: recording.length ? Math.round(recording.length / 1000) : null,
        metadataSource: 'musicbrainz'
      });

      return {
        id: `musicbrainz:${recording.id}`,
        provider: 'musicbrainz',
        title: normalized.title,
        artist: normalized.artist,
        album: normalized.album,
        duration: normalized.duration,
        artwork: '',
        externalUrl: `https://musicbrainz.org/recording/${recording.id}`,
        downloadTarget: buildYouTubeSearchTarget(normalized.artist, normalized.title),
        providerIds: createEmptyProviderIds({
          isrc: recording.isrcs?.[0] || ''
        }),
        normalizedTitle: normalized.normalizedTitle,
        normalizedArtist: normalized.normalizedArtist,
        normalizedAlbum: normalized.normalizedAlbum,
        normalizedDuration: normalized.normalizedDuration,
        metadataSource: normalized.metadataSource,
        sourceRecordingId: recording.id
      };
    })
  );

  return {
    items,
    total: payload['recording-count'] || items.length,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil((payload['recording-count'] || items.length) / safePageSize))
  };
}

async function searchItunesTracks({ query, page = 1, pageSize = 10, signal } = {}) {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) {
    return {
      items: [],
      total: 0,
      page: 1,
      pageSize,
      totalPages: 1
    };
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(25, Math.max(1, Number.parseInt(pageSize, 10) || 10));
  const offset = (safePage - 1) * safePageSize;
  const url =
    `${ITUNES_SEARCH_URL}?media=music&entity=song&term=${encodeURIComponent(trimmedQuery)}` +
    `&limit=${safePageSize}&offset=${offset}`;
  const payload = await fetchCachedJson(`itunes:search:${safePage}:${safePageSize}:${trimmedQuery}`, url, {
    signal,
    ttlMs: 5 * 60 * 1000
  });
  const total = payload.resultCount || 0;

  return {
    items: (payload.results || []).map(formatItunesTrack),
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, total < safePageSize ? 1 : safePage + 1)
  };
}

async function searchDeezerTracks({ query, page = 1, pageSize = 10, signal } = {}) {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) {
    return {
      items: [],
      total: 0,
      page: 1,
      pageSize,
      totalPages: 1
    };
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(25, Math.max(1, Number.parseInt(pageSize, 10) || 10));
  const index = (safePage - 1) * safePageSize;
  const url =
    `${DEEZER_API_BASE_URL}/search?q=${encodeURIComponent(trimmedQuery)}` +
    `&limit=${safePageSize}&index=${index}`;
  const payload = await fetchCachedJson(`deezer:search:${safePage}:${safePageSize}:${trimmedQuery}`, url, {
    signal,
    ttlMs: 5 * 60 * 1000
  });
  const total = Number(payload.total) || 0;

  return {
    items: (payload.data || []).map(formatDeezerTrack),
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(total / safePageSize))
  };
}

module.exports = {
  searchArtists,
  getArtistProfile,
  listArtistReleases,
  listArtistTracks,
  searchItunesTracks,
  searchDeezerTracks
};
