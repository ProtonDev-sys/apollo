const { randomUUID } = require('crypto');
const { INSTALLABLE_DEPENDENCIES, resolveExecutablePath, runProcess } = require('./binaries');
const { createHttpError, isAbortError } = require('./http-error');
const { isTrackEquivalent } = require('./data-store');
const { searchDeezerTracks, searchItunesTracks } = require('./public-metadata-service');
const { createEmptyProviderIds, formatApiTrack } = require('./models');
const {
  normalizeTrackMetadata,
  mergeTrackMetadata,
  hasWeakTrackMetadata,
  countMetadataFields,
  isGenericAlbumName
} = require('./metadata-normalizer');

const SEARCH_PROVIDER_ORDER = ['spotify', 'youtube', 'soundcloud', 'itunes', 'deezer'];
const NON_SONG_VIDEO_PATTERN =
  /\b(lyrics?|official video|video clip|reaction|karaoke|cover|live|sped up|slowed|nightcore|fanmade|fan-made)\b/i;
const YOUTUBE_AUDIO_HINT_PATTERN = /\b(official audio|audio|topic)\b/i;
const GENERIC_ALBUM_NAMES = new Set(['', 'singles', 'youtube', 'soundcloud', 'spotify', 'deezer']);
const FAST_MULTI_PROVIDER_TIMEOUT_MS = 900;
const SPOTIFY_TOKEN_EXPIRY_SKEW_MS = 30 * 1000;
const spotifyTokenCache = new Map();
const spotifyTokenInflight = new Map();

function createTimeoutError(message) {
  const error = new Error(message);
  error.code = 'ETIMEDOUT';
  return error;
}

function isTimeoutError(error) {
  return Boolean(error && error.code === 'ETIMEDOUT');
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(createTimeoutError(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function isSpotifyTrackUrl(value) {
  return /^https?:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+/i.test(String(value || '').trim());
}

function buildSpotifyDownloadTarget(artist, title) {
  return `ytsearch1:${[artist, title, 'audio'].filter(Boolean).join(' ')}`;
}

function buildProviderSearchQuery(provider, query) {
  const trimmedQuery = String(query || '').trim();
  if (
    provider === 'youtube' &&
    !/\b(audio|video|lyrics|karaoke|cover|live|remix|mix)\b/i.test(trimmedQuery)
  ) {
    return `${trimmedQuery} audio`;
  }

  return trimmedQuery;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseProviderSelection(input) {
  const rawProviders = String(input || 'all')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!rawProviders.length || rawProviders.includes('all')) {
    return [...SEARCH_PROVIDER_ORDER];
  }

  const unknownProviders = rawProviders.filter((provider) => !SEARCH_PROVIDER_ORDER.includes(provider));
  if (unknownProviders.length) {
    throw createHttpError(400, `Unknown providers: ${unknownProviders.join(', ')}`);
  }

  return [...new Set(rawProviders)];
}

function mergeProviderIds(...providerIdGroups) {
  return createEmptyProviderIds(
    Object.assign(
      {},
      ...providerIdGroups.map((providerIds) => createEmptyProviderIds(providerIds || {}))
    )
  );
}

function buildProviderIdentityUrl(input = {}) {
  const providerIds = createEmptyProviderIds(input.providerIds);
  const provider = String(input.provider || input.sourcePlatform || '').toLowerCase();

  if ((provider === 'spotify' || providerIds.spotify) && providerIds.spotify) {
    return `https://open.spotify.com/track/${providerIds.spotify}`;
  }

  if ((provider === 'youtube' || providerIds.youtube) && providerIds.youtube) {
    return `https://www.youtube.com/watch?v=${providerIds.youtube}`;
  }

  if ((provider === 'deezer' || providerIds.deezer) && providerIds.deezer) {
    return `https://www.deezer.com/track/${providerIds.deezer}`;
  }

  return '';
}

function getSpotifyTokenCacheKey(settings) {
  return `${settings.spotifyClientId || ''}:${settings.spotifyClientSecret || ''}`;
}

async function fetchSpotifyToken(settings) {
  const cacheKey = getSpotifyTokenCacheKey(settings);
  const cached = spotifyTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const inFlight = spotifyTokenInflight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
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
    const detail = await response.text();
    throw new Error(detail || 'Spotify authentication failed. Verify client ID and secret.');
  }

  const payload = await response.json();
  const expiresInMs = Math.max(
    5 * 1000,
    Number.parseInt(payload.expires_in, 10) * 1000 - SPOTIFY_TOKEN_EXPIRY_SKEW_MS
  );

  spotifyTokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: Date.now() + expiresInMs
  });
  return payload.access_token;
  })();

  spotifyTokenInflight.set(cacheKey, request);

  try {
    return await request;
  } finally {
    if (spotifyTokenInflight.get(cacheKey) === request) {
      spotifyTokenInflight.delete(cacheKey);
    }
  }
}

async function fetchSpotifyTrackPageMetadata(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Spotify page request failed with status ${response.status}.`);
  }

  const html = await response.text();
  const titleText = decodeHtmlEntities(html.match(/<title>([^<]+)<\/title>/i)?.[1] || '');
  const ogDescription = decodeHtmlEntities(
    html.match(/<meta property="og:description" content="([^"]+)"/i)?.[1] || ''
  );
  const ogImage =
    html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ||
    html.match(/<meta name="twitter:image" content="([^"]+)"/i)?.[1] ||
    '';
  const trackId = String(url).match(/track\/([a-zA-Z0-9]+)/i)?.[1] || '';
  const titleMatch = titleText.match(/^(.*?)\s*-\s*song and lyrics by\s*(.*?)\s*\|\s*Spotify$/i);
  const descriptionParts = ogDescription
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean);
  const title = titleMatch?.[1] || titleText.replace(/\s*\|\s*Spotify$/i, '').trim() || 'Untitled';
  const artist = titleMatch?.[2] || descriptionParts[0] || 'Unknown Artist';
  const normalized = normalizeTrackMetadata({
    provider: 'spotify',
    title,
    artist,
    artists: artist ? [artist] : [],
    album: descriptionParts[1] || 'Spotify',
    albumArtist: artist,
    duration: null,
    metadataSource: 'spotify-page'
  });

  return {
    id: `spotify:${trackId || randomUUID()}`,
    provider: 'spotify',
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
    artwork: ogImage,
    externalUrl: url,
    sourceUrl: url,
    downloadTarget: buildSpotifyDownloadTarget(normalized.artist, normalized.title),
    providerIds: createEmptyProviderIds({
      spotify: trackId
    }),
    isrc: '',
    normalizedTitle: normalized.normalizedTitle,
    normalizedArtist: normalized.normalizedArtist,
    normalizedAlbum: normalized.normalizedAlbum,
    normalizedDuration: normalized.normalizedDuration,
    metadataSource: normalized.metadataSource
  };
}

function formatSpotifyTrack(item) {
  const normalized = normalizeTrackMetadata({
    provider: 'spotify',
    title: item.name,
    artist: item.artists.map((artist) => artist.name).join(', '),
    artists: item.artists.map((artist) => artist.name),
    album: item.album?.name || 'Spotify',
    albumArtist:
      item.album?.artists?.map((artist) => artist.name).filter(Boolean).join(', ') ||
      item.artists.map((artist) => artist.name).join(', '),
    trackNumber: item.track_number || null,
    discNumber: item.disc_number || null,
    duration: item.duration_ms ? Math.round(item.duration_ms / 1000) : null,
    releaseDate: item.album?.release_date || '',
    explicit: item.explicit,
    isrc: item.external_ids?.isrc || '',
    metadataSource: 'spotify'
  });

  return {
    id: `spotify:${item.id}`,
    provider: 'spotify',
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
    artwork: item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || '',
    externalUrl: item.external_urls?.spotify || '',
    sourceUrl: item.external_urls?.spotify || '',
    downloadTarget: buildSpotifyDownloadTarget(normalized.artist, normalized.title),
    providerIds: createEmptyProviderIds({
      spotify: item.id,
      isrc: item.external_ids?.isrc || ''
    }),
    isrc: normalized.isrc,
    normalizedTitle: normalized.normalizedTitle,
    normalizedArtist: normalized.normalizedArtist,
    normalizedAlbum: normalized.normalizedAlbum,
    normalizedDuration: normalized.normalizedDuration,
    metadataSource: normalized.metadataSource
  };
}

async function searchSpotify(query, page, pageSize, settings, signal) {
  if (isSpotifyTrackUrl(query)) {
    const item = await fetchSpotifyTrackPageMetadata(query.trim(), signal);
    return {
      items: [item],
      total: 1,
      page: 1,
      pageSize: 1,
      totalPages: 1
    };
  }

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
      },
      signal
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || 'Spotify search failed.');
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

function hasCompatibleDuration(leftDuration, rightDuration) {
  if (!leftDuration || !rightDuration) {
    return true;
  }

  return Math.abs(Number(leftDuration) - Number(rightDuration)) <= 5;
}

function scoreMetadataCandidate(seed, candidate) {
  const left = normalizeTrackMetadata(seed);
  const right = normalizeTrackMetadata(candidate);
  let score = countMetadataFields(right);

  if (left.isrc && right.isrc && left.isrc === right.isrc) {
    score += 80;
  }

  if (left.normalizedTitle && right.normalizedTitle && left.normalizedTitle === right.normalizedTitle) {
    score += 25;
  } else if (
    left.normalizedTitle &&
    right.normalizedTitle &&
    (left.normalizedTitle.includes(right.normalizedTitle) || right.normalizedTitle.includes(left.normalizedTitle))
  ) {
    score += 10;
  } else {
    score -= 20;
  }

  if (left.normalizedArtist && right.normalizedArtist && left.normalizedArtist === right.normalizedArtist) {
    score += 25;
  } else if (
    left.normalizedArtist &&
    right.normalizedArtist &&
    (left.normalizedArtist.includes(right.normalizedArtist) || right.normalizedArtist.includes(left.normalizedArtist))
  ) {
    score += 10;
  } else {
    score -= 20;
  }

  if (hasCompatibleDuration(left.duration, right.duration)) {
    score += 10;
  } else {
    score -= 15;
  }

  if (
    left.normalizedAlbum &&
    right.normalizedAlbum &&
    !isGenericAlbumName(left.album) &&
    !isGenericAlbumName(right.album) &&
    left.normalizedAlbum === right.normalizedAlbum
  ) {
    score += 6;
  }

  if (right.artwork) {
    score += 2;
  }

  if (right.releaseDate || right.releaseYear) {
    score += 2;
  }

  return score;
}

function shouldEnrichTrackMetadata(track) {
  const normalized = normalizeTrackMetadata(track);
  return (
    hasWeakTrackMetadata(normalized) ||
    ['youtube', 'soundcloud', 'link'].includes(normalized.sourcePlatform) ||
    ['spotify-page'].includes(normalized.metadataSource)
  );
}

async function searchMetadataCandidates(seed, settings, signal) {
  const normalizedSeed = normalizeTrackMetadata(seed);
  const searchText = [normalizedSeed.artist, normalizedSeed.title].filter(Boolean).join(' ').trim();
  const results = [];
  const candidateRequests = [
    searchItunesTracks({
      query: searchText,
      page: 1,
      pageSize: 5,
      signal
    }),
    searchDeezerTracks({
      query: searchText,
      page: 1,
      pageSize: 5,
      signal
    })
  ];

  if (settings.spotifyClientId && settings.spotifyClientSecret) {
    candidateRequests.push(
      searchSpotify(normalizedSeed.isrc ? `isrc:${normalizedSeed.isrc}` : searchText, 1, 5, settings, signal)
        .catch(() => searchSpotify(searchText, 1, 5, settings, signal))
    );
  }

  const settled = await Promise.allSettled(candidateRequests);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(...result.value.items);
    }
  }

  return dedupeRemoteItems(results);
}

async function enrichTrackMetadata(seed, settings, { signal, force = false } = {}) {
  const base = normalizeTrackMetadata(seed);
  if (!force && !shouldEnrichTrackMetadata(base)) {
    return {
      ...seed,
      ...base,
      providerIds: mergeProviderIds(seed.providerIds),
      isrc: base.isrc
    };
  }

  const searchText = [base.artist, base.title].filter(Boolean).join(' ').trim();
  if (!searchText) {
    return {
      ...seed,
      ...base,
      providerIds: mergeProviderIds(seed.providerIds),
      isrc: base.isrc
    };
  }

  const candidates = await searchMetadataCandidates(base, settings, signal);
  let bestCandidate = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreMetadataCandidate(base, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate || bestScore < 30) {
    return {
      ...seed,
      ...base,
      providerIds: mergeProviderIds(seed.providerIds),
      isrc: base.isrc
    };
  }

  const merged = mergeTrackMetadata(bestCandidate, {
    ...base,
    sourcePlatform: base.sourcePlatform || bestCandidate.sourcePlatform,
    sourceUrl: seed.sourceUrl || base.sourceUrl || seed.externalUrl || bestCandidate.externalUrl || '',
    externalUrl: seed.externalUrl || base.externalUrl || buildProviderIdentityUrl(seed) || '',
    metadataSource: `${base.metadataSource || 'unknown'}+${bestCandidate.metadataSource || bestCandidate.provider || 'enriched'}`
  });
  const providerIds = mergeProviderIds(bestCandidate.providerIds, seed.providerIds);

  return {
    ...seed,
    ...merged,
    providerIds,
    isrc: merged.isrc || providerIds.isrc || ''
  };
}

function buildResolvedTrackMetadata(entry, provider) {
  const resolvedUrl = resolveEntryUrl(entry, provider);
  const normalized = normalizeTrackMetadata({
    provider,
    title: entry.track || entry.title || 'Untitled',
    artist: entry.artist || entry.creator || entry.uploader || entry.channel || entry.album_artist || 'Unknown Artist',
    artists:
      entry.artists ||
      entry.creators?.map((creator) => creator.name).filter(Boolean) ||
      [],
    album:
      entry.album ||
      entry.playlist_title ||
      (provider === 'youtube' ? 'YouTube' : provider === 'soundcloud' ? 'SoundCloud' : 'Singles'),
    albumArtist: entry.album_artist || entry.artist || '',
    trackNumber: entry.track_number || entry.track_number || entry.tracknumber || null,
    discNumber: entry.disc_number || entry.discnumber || null,
    duration: entry.duration || null,
    releaseDate: entry.release_date || entry.upload_date || entry.release_year || entry.year || '',
    genre: entry.genre || entry.genres || '',
    explicit: Number(entry.age_limit) > 15 ? true : null,
    isrc: entry.track_id || entry.isrc || entry.external_ids?.isrc || '',
    metadataSource: provider
  });

  return {
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
    artwork: resolveEntryArtwork(entry),
    externalUrl: resolvedUrl,
    sourceUrl: resolvedUrl,
    downloadTarget: resolvedUrl,
    providerIds: resolveEntryProviderIds(entry, provider),
    isrc: normalized.isrc,
    normalizedTitle: normalized.normalizedTitle,
    normalizedArtist: normalized.normalizedArtist,
    normalizedAlbum: normalized.normalizedAlbum,
    normalizedDuration: normalized.normalizedDuration,
    metadataSource: normalized.metadataSource
  };
}

function formatYtDlpEntry(entry, provider) {
  return {
    id: `${provider}:${entry.id || randomUUID()}`,
    provider,
    ...buildResolvedTrackMetadata(entry, provider)
  };
}

function resolveEntryUrl(entry, fallbackProvider = 'link') {
  const provider = String(fallbackProvider || '').toLowerCase();
  return (
    entry.webpage_url ||
    entry.original_url ||
    (provider === 'youtube' && entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : '') ||
    (provider === 'soundcloud' && entry.url?.startsWith('http') ? entry.url : '') ||
    (typeof entry.url === 'string' && entry.url.startsWith('http') ? entry.url : '')
  );
}

function resolveEntryArtwork(entry) {
  return (
    entry.thumbnail ||
    entry.thumbnails?.[entry.thumbnails.length - 1]?.url ||
    entry.thumbnails?.[0]?.url ||
    ''
  );
}

function resolveProviderName(entry, fallbackProvider = 'link') {
  const extractor = String(entry.extractor_key || entry.extractor || fallbackProvider).toLowerCase();
  if (extractor.includes('youtube')) {
    return 'youtube';
  }

  if (extractor.includes('soundcloud')) {
    return 'soundcloud';
  }

  if (extractor.includes('deezer')) {
    return 'deezer';
  }

  if (extractor.includes('itunes') || extractor.includes('apple')) {
    return 'itunes';
  }

  if (extractor.includes('spotify')) {
    return 'spotify';
  }

  return String(fallbackProvider || 'link').toLowerCase();
}

function resolveEntryProviderIds(entry, fallbackProvider = 'link') {
  const provider = resolveProviderName(entry, fallbackProvider);
  return createEmptyProviderIds({
    [provider]: entry.id || '',
    isrc: entry.track_id || entry.isrc || entry.external_ids?.isrc || ''
  });
}

function extractResolvedMetadata(entry, fallbackProvider = 'link') {
  const provider = resolveProviderName(entry, fallbackProvider);
  return {
    provider,
    ...buildResolvedTrackMetadata(entry, provider)
  };
}

function scoreSearchEntry(entry, provider, query) {
  const title = String(entry.track || entry.title || '').toLowerCase();
  const artist = String(entry.artist || entry.uploader || entry.channel || '').toLowerCase();
  const queryTerms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 3);

  let score = 0;

  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 4;
    }
    if (artist.includes(term)) {
      score += 3;
    }
  }

  if (provider === 'youtube') {
    if (YOUTUBE_AUDIO_HINT_PATTERN.test(title) || YOUTUBE_AUDIO_HINT_PATTERN.test(artist)) {
      score += 30;
    }

    if (NON_SONG_VIDEO_PATTERN.test(title)) {
      score -= 40;
    }
  }

  if (provider === 'soundcloud' && NON_SONG_VIDEO_PATTERN.test(title)) {
    score -= 20;
  }

  if (entry.duration && entry.duration >= 90 && entry.duration <= 600) {
    score += 10;
  }

  return score;
}

function isPreferredMusicResult(entry, provider, query) {
  if (provider !== 'youtube') {
    return true;
  }

  const queryText = String(query || '').toLowerCase();
  if (/\b(video|lyrics|karaoke|cover|live|remix)\b/.test(queryText)) {
    return true;
  }

  const title = String(entry.track || entry.title || '').toLowerCase();
  if (entry.duration && entry.duration < 90) {
    return false;
  }

  return !NON_SONG_VIDEO_PATTERN.test(title);
}

function scoreRemoteResult(item) {
  let score = 0;

  if (item.provider === 'spotify') {
    score += 50;
  } else if (item.provider === 'deezer') {
    score += 40;
  } else if (item.provider === 'itunes') {
    score += 35;
  } else if (item.provider === 'youtube') {
    score += 20;
  } else if (item.provider === 'soundcloud') {
    score += 10;
  }

  if (item.requestedProvider) {
    score -= 20;
  }

  if (item.metadataSource === 'spotify' || item.metadataSource === 'spotify-page') {
    score += 25;
  } else if (item.metadataSource === 'deezer') {
    score += 18;
  } else if (item.metadataSource === 'itunes') {
    score += 15;
  }

  if (item.artwork) {
    score += 5;
  }

  if (item.duration) {
    score += 3;
  }

  if (!GENERIC_ALBUM_NAMES.has(String(item.album || '').trim().toLowerCase())) {
    score += 2;
  }

  return score;
}

function dedupeRemoteItems(items) {
  const dedupedItems = [];

  for (const item of items) {
    const duplicateIndex = dedupedItems.findIndex((existingItem) => isTrackEquivalent(existingItem, item));
    if (duplicateIndex < 0) {
      dedupedItems.push(item);
      continue;
    }

    if (scoreRemoteResult(item) > scoreRemoteResult(dedupedItems[duplicateIndex])) {
      dedupedItems[duplicateIndex] = item;
    }
  }

  return dedupedItems;
}

async function searchViaYtDlp(query, provider, page, pageSize, settings, signal) {
  const ytDlpPath = await resolveExecutablePath(
    settings.ytDlpPath,
    INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
  );
  const prefix = provider === 'soundcloud' ? 'scsearch' : 'ytsearch';
  const limit = Math.min(30, page * pageSize);
  const searchQuery = buildProviderSearchQuery(provider, query);
  const { stdout } = await runProcess(ytDlpPath, [
    '--dump-single-json',
    '--no-warnings',
    `${prefix}${limit}:${searchQuery}`
  ], { signal });
  const payload = JSON.parse(stdout);
  const rankedEntries = (payload.entries || [])
    .map((entry) => ({
      ...entry,
      __score: scoreSearchEntry(entry, provider, query)
    }))
    .sort((left, right) => right.__score - left.__score);
  const preferredEntries = rankedEntries.filter((entry) =>
    isPreferredMusicResult(entry, provider, query)
  );
  const chosenEntries =
    preferredEntries.length >= Math.min(pageSize, 3) ? preferredEntries : rankedEntries;
  const items = chosenEntries.map((entry) => formatYtDlpEntry(entry, provider));
  const start = (page - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize))
  };
}

async function searchSpotifyFallback(query, page, pageSize, settings, signal) {
  const fallback = await searchViaYtDlp(query, 'youtube', page, pageSize, settings, signal);
  return {
    ...fallback,
    items: fallback.items.map((item) => ({
      ...item,
      requestedProvider: 'spotify',
      metadataSource: `${item.metadataSource || 'youtube'}-spotify-fallback`
    }))
  };
}

async function searchProviders(
  { query, provider = 'all', page = 1, pageSize = 8 },
  settings,
  { signal } = {}
) {
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
  const fastMultiProviderMode = providers.length > 1;
  const results = await Promise.allSettled(
    providers.map((selectedProvider) => {
      let request;
      if (selectedProvider === 'spotify') {
        request = searchSpotify(trimmedQuery, safePage, safePageSize, settings, signal);
      } else if (selectedProvider === 'itunes') {
        request = searchItunesTracks({
          query: trimmedQuery,
          page: safePage,
          pageSize: safePageSize,
          signal
        });
      } else if (selectedProvider === 'deezer') {
        request = searchDeezerTracks({
          query: trimmedQuery,
          page: safePage,
          pageSize: safePageSize,
          signal
        });
      } else {
        request = searchViaYtDlp(trimmedQuery, selectedProvider, safePage, safePageSize, settings, signal);
      }

      if (fastMultiProviderMode && ['spotify', 'youtube', 'soundcloud'].includes(selectedProvider)) {
        return withTimeout(
          request,
          FAST_MULTI_PROVIDER_TIMEOUT_MS,
          `${selectedProvider} search timed out after ${FAST_MULTI_PROVIDER_TIMEOUT_MS}ms.`
        );
      }

      return request;
    })
  );

  const items = [];
  const warnings = [];
  const providerErrors = {};

  for (const [index, result] of results.entries()) {
    const providerName = providers[index];
    if (result.status === 'fulfilled') {
      items.push(...result.value.items);
      continue;
    }

    if (isAbortError(result.reason)) {
      throw result.reason;
    }

    providerErrors[providerName] = result.reason.message;

    if (providerName === 'spotify' && !fastMultiProviderMode && !isTimeoutError(result.reason)) {
      try {
        const fallback = await searchSpotifyFallback(
          trimmedQuery,
          safePage,
          safePageSize,
          settings,
          signal
        );
        items.push(...fallback.items);
        warnings.push(`spotify: ${result.reason.message} Falling back to YouTube audio results.`);
        continue;
      } catch (fallbackError) {
        if (isAbortError(fallbackError)) {
          throw fallbackError;
        }

        warnings.push(`spotify: ${result.reason.message}`);
        warnings.push(`spotify fallback: ${fallbackError.message}`);
        providerErrors.spotifyFallback = fallbackError.message;
        continue;
      }
    }

    warnings.push(`${providerName}: ${result.reason.message}`);
  }

  const dedupedItems = dedupeRemoteItems(items);

  return {
    items: dedupedItems,
    total: dedupedItems.length,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(dedupedItems.length / safePageSize)),
    provider: providers,
    providerErrors,
    warning: warnings.join(' ')
  };
}

async function inspectDirectLink(url, settings, { signal } = {}) {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error('Enter a direct media link.');
  }

  if (isSpotifyTrackUrl(trimmedUrl)) {
    return fetchSpotifyTrackPageMetadata(trimmedUrl, signal);
  }

  const ytDlpPath = await resolveExecutablePath(
    settings.ytDlpPath,
    INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
  );
  const { stdout } = await runProcess(ytDlpPath, [
    '--dump-single-json',
    '--no-warnings',
    trimmedUrl
  ], { signal });
  const payload = JSON.parse(stdout);
  const metadata = extractResolvedMetadata(payload, payload.extractor_key?.toLowerCase() || 'link');

  return {
    id: `link:${payload.id || randomUUID()}`,
    ...metadata,
    externalUrl: metadata.externalUrl || trimmedUrl,
    sourceUrl: metadata.sourceUrl || metadata.externalUrl || trimmedUrl,
    downloadTarget: trimmedUrl,
    providerIds: mergeProviderIds(metadata.providerIds),
    isrc: metadata.isrc || metadata.providerIds?.isrc || ''
  };
}

async function searchCatalog(payload, settings, store, baseUrl, { signal } = {}) {
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
      : await searchProviders({ query, provider: providers, page, pageSize }, settings, { signal });

  return {
    query,
    provider: providers,
    scope,
    library,
    remote
  };
}

async function resolveRemoteMedia(input, settings, { signal } = {}) {
  const spotifySearchTarget =
    input.provider === 'spotify' &&
    isSpotifyTrackUrl(input.downloadTarget || input.externalUrl || input.url)
      ? buildSpotifyDownloadTarget(input.artist, input.title)
      : '';
  const target = spotifySearchTarget || input.downloadTarget || input.externalUrl || input.url;
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
  ], { signal });
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

async function resolveDownloadMetadata(input, settings) {
  const target =
    input.downloadTarget ||
    input.externalUrl ||
    input.sourceUrl ||
    input.url ||
    buildProviderIdentityUrl(input);
  if (!target) {
    return {
      ...input,
      ...normalizeTrackMetadata(input),
      providerIds: createEmptyProviderIds(input.providerIds),
      isrc: input.isrc || input.providerIds?.isrc || ''
    };
  }

  let resolvedItem = null;

  if (input.provider === 'spotify' && isSpotifyTrackUrl(target)) {
    const spotifyMetadata = await fetchSpotifyTrackPageMetadata(target);
    resolvedItem = {
      ...spotifyMetadata,
      ...input,
      title: input.title || spotifyMetadata.title,
      artist: input.artist || spotifyMetadata.artist,
      artists: input.artists || spotifyMetadata.artists,
      album: input.album || spotifyMetadata.album,
      albumArtist: input.albumArtist || spotifyMetadata.albumArtist,
      trackNumber: input.trackNumber || spotifyMetadata.trackNumber,
      discNumber: input.discNumber || spotifyMetadata.discNumber,
      duration: input.duration || spotifyMetadata.duration,
      releaseDate: input.releaseDate || spotifyMetadata.releaseDate,
      releaseYear: input.releaseYear || spotifyMetadata.releaseYear,
      genre: input.genre || spotifyMetadata.genre,
      explicit:
        input.explicit === null || input.explicit === undefined
          ? spotifyMetadata.explicit
          : input.explicit,
      artwork: input.artwork || spotifyMetadata.artwork,
      externalUrl: target,
      sourceUrl: input.sourceUrl || target,
      downloadTarget: input.downloadTarget || spotifyMetadata.downloadTarget,
      providerIds: mergeProviderIds({
        ...spotifyMetadata.providerIds,
        ...input.providerIds
      }),
      isrc: input.isrc || spotifyMetadata.isrc || spotifyMetadata.providerIds?.isrc || ''
    };
  } else if (input.provider === 'spotify') {
    resolvedItem = {
      ...input,
      ...normalizeTrackMetadata(input),
      providerIds: createEmptyProviderIds(input.providerIds),
      sourceUrl: input.sourceUrl || input.externalUrl || target,
      externalUrl: input.externalUrl || buildProviderIdentityUrl(input) || '',
      isrc: input.isrc || input.providerIds?.isrc || ''
    };
  } else {
    const ytDlpPath = await resolveExecutablePath(
      settings.ytDlpPath,
      INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
    );
    const { stdout } = await runProcess(ytDlpPath, [
      '--dump-single-json',
      '--no-warnings',
      target
    ]);
    const payload = JSON.parse(stdout);
    const resolved = extractResolvedMetadata(payload, input.provider || 'link');

    resolvedItem = {
      ...resolved,
      ...input,
      provider: resolved.provider || input.provider || 'link',
      sourcePlatform: resolved.provider || input.provider || input.sourcePlatform || 'link',
      title: resolved.title || input.title || 'Untitled',
      artist: resolved.artist || input.artist || 'Unknown Artist',
      artists: input.artists || resolved.artists,
      album: resolved.album || input.album || 'Singles',
      albumArtist: resolved.albumArtist || input.albumArtist || resolved.artist || '',
      trackNumber: resolved.trackNumber || input.trackNumber || null,
      discNumber: resolved.discNumber || input.discNumber || null,
      duration: resolved.duration || input.duration || null,
      releaseDate: resolved.releaseDate || input.releaseDate || '',
      releaseYear: resolved.releaseYear || input.releaseYear || null,
      genre: resolved.genre || input.genre || '',
      explicit:
        input.explicit === null || input.explicit === undefined
          ? resolved.explicit
          : input.explicit,
      artwork: resolved.artwork || input.artwork || '',
      externalUrl: resolved.externalUrl || input.externalUrl || target,
      sourceUrl: input.sourceUrl || resolved.sourceUrl || resolved.externalUrl || target,
      downloadTarget: input.downloadTarget || resolved.downloadTarget || target,
      providerIds: mergeProviderIds(resolved.providerIds, input.providerIds),
      isrc: input.isrc || resolved.isrc || resolved.providerIds?.isrc || ''
    };
  }

  const enriched = await enrichTrackMetadata(resolvedItem, settings, {
    force: shouldEnrichTrackMetadata(resolvedItem)
  });

  return {
    ...resolvedItem,
    ...enriched,
    provider: resolvedItem.provider || input.provider || enriched.sourcePlatform || 'link',
    sourcePlatform:
      resolvedItem.sourcePlatform || input.sourcePlatform || input.provider || enriched.sourcePlatform || 'link',
    externalUrl:
      resolvedItem.externalUrl ||
      enriched.externalUrl ||
      input.externalUrl ||
      buildProviderIdentityUrl(resolvedItem) ||
      '',
    sourceUrl:
      resolvedItem.sourceUrl ||
      enriched.sourceUrl ||
      input.sourceUrl ||
      input.externalUrl ||
      target,
    downloadTarget: resolvedItem.downloadTarget || input.downloadTarget || target,
    providerIds: mergeProviderIds(resolvedItem.providerIds, enriched.providerIds, input.providerIds),
    isrc:
      enriched.isrc ||
      resolvedItem.isrc ||
      resolvedItem.providerIds?.isrc ||
      input.isrc ||
      ''
  };
}

async function resolvePlayback(input, settings, store, baseUrl, { signal } = {}) {
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

  const resolved = await resolveRemoteMedia(input, settings, { signal });
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

async function resolveClientDownload(input, settings, store, baseUrl, { signal } = {}) {
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

  const resolved = await resolveRemoteMedia(input, settings, { signal });
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
  resolveDownloadMetadata,
  resolvePlayback,
  resolveClientDownload,
  fetchSpotifyToken,
  fetchSpotifyTrackPageMetadata,
  formatSpotifyTrack,
  extractResolvedMetadata,
  enrichTrackMetadata,
  buildProviderIdentityUrl
};
