const { isTrackEquivalent } = require('./data-store');
const { createHttpError } = require('./http-error');
const { formatApiTrack } = require('./models');
const {
  searchDeezerArtists,
  listDeezerArtistTopTracks,
  searchItunesArtistTracksByName,
  searchItunesTracks,
  searchDeezerTracks
} = require('./public-metadata-service');
const { normaliseComparable } = require('./metadata-normalizer');

const GENERIC_ALBUM_NAMES = new Set(['', 'singles', 'youtube', 'soundcloud', 'spotify', 'deezer']);
const MAX_CONTEXT_TRACKS = 12;
const MAX_QUERY_COUNT = 4;
const GENRE_SEPARATOR_PATTERN = /\s*(?:,|\/|;|\||>|\u2022)\s*/;
const TITLE_TOKEN_SPLIT_PATTERN = /[^a-z0-9]+/i;
const MMR_RELEVANCE_WEIGHT = 0.74;

function getComparableDuration(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isGenericAlbumName(value) {
  return GENERIC_ALBUM_NAMES.has(normaliseComparable(value));
}

function getPrimaryArtist(track = {}) {
  if (Array.isArray(track.artists)) {
    const firstArtist = track.artists.find((artist) => String(artist || '').trim());
    if (firstArtist) {
      return String(firstArtist).trim();
    }
  }

  return String(track.artist || '').trim();
}

function getComparableTitle(track = {}) {
  return normaliseComparable(track.title);
}

function getComparableArtist(track = {}) {
  return normaliseComparable(getPrimaryArtist(track));
}

function getComparableAlbum(track = {}) {
  return normaliseComparable(track.album);
}

function tokenizeComparableText(value) {
  return Array.from(new Set(
    normaliseComparable(value)
      .split(TITLE_TOKEN_SPLIT_PATTERN)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  ));
}

function getTrackTitleTokens(track = {}) {
  return tokenizeComparableText(track.title);
}

function getTrackYear(track = {}) {
  const numericYear = Number.parseInt(track.releaseYear, 10);
  if (Number.isFinite(numericYear) && numericYear > 0) {
    return numericYear;
  }

  const yearMatch = String(track.releaseDate || '').match(/^(\d{4})/);
  return yearMatch ? Number.parseInt(yearMatch[1], 10) : 0;
}

function getProviderIdentityKeys(track = {}) {
  return Object.entries(track.providerIds || {})
    .filter(([key, value]) => key && value)
    .map(([key, value]) => `${key}:${normaliseComparable(value)}`);
}

function hasSharedProviderIdentity(leftTrack = {}, rightTrack = {}) {
  const rightKeys = new Set(getProviderIdentityKeys(rightTrack));
  if (!rightKeys.size) {
    return false;
  }

  return getProviderIdentityKeys(leftTrack).some((key) => rightKeys.has(key));
}

function extractGenreLabels(value) {
  const inputs = Array.isArray(value) ? value : [value];
  const labels = [];

  for (const input of inputs) {
    const parts = String(input || '')
      .split(GENRE_SEPARATOR_PATTERN)
      .map((part) => String(part || '').trim())
      .filter(Boolean);

    for (const part of parts) {
      if (!labels.includes(part)) {
        labels.push(part);
      }
    }
  }

  return labels;
}

function getTrackGenres(track = {}) {
  return extractGenreLabels(track.genre || track.genres || [])
    .map((genre) => normaliseComparable(genre))
    .filter(Boolean);
}

function buildGenreProfile(items = []) {
  const profile = new Map();

  for (const item of items) {
    for (const genre of getTrackGenres(item)) {
      profile.set(genre, (profile.get(genre) || 0) + 1);
    }
  }

  return profile;
}

function getGenreProfilePeak(profile = new Map()) {
  let peak = 0;

  for (const value of profile.values()) {
    if (value > peak) {
      peak = value;
    }
  }

  return peak;
}

function getDominantGenres(items = [], limit = 2) {
  return [...buildGenreProfile(items).entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([genre]) => genre);
}

function getGenreOverlapScore(leftTrack = {}, rightTrack = {}) {
  const leftGenres = getTrackGenres(leftTrack);
  const rightGenres = getTrackGenres(rightTrack);
  if (!leftGenres.length || !rightGenres.length) {
    return 0;
  }

  const leftSet = new Set(leftGenres);
  const rightSet = new Set(rightGenres);
  let sharedCount = 0;

  for (const genre of leftSet) {
    if (rightSet.has(genre)) {
      sharedCount += 1;
    }
  }

  return sharedCount / new Set([...leftSet, ...rightSet]).size;
}

function getGenreProfileScore(track = {}, profile = new Map()) {
  return getTrackGenres(track).reduce((score, genre) => score + (profile.get(genre) || 0), 0);
}

function getDurationSimilarity(leftTrack = {}, rightTrack = {}) {
  const leftDuration = getComparableDuration(leftTrack.duration);
  const rightDuration = getComparableDuration(rightTrack.duration);
  if (!leftDuration || !rightDuration) {
    return 0;
  }

  const delta = Math.abs(leftDuration - rightDuration);
  if (delta <= 8) {
    return 1;
  }
  if (delta <= 15) {
    return 0.7;
  }
  if (delta <= 30) {
    return 0.35;
  }

  return 0;
}

function getYearSimilarity(leftTrack = {}, rightTrack = {}) {
  const leftYear = getTrackYear(leftTrack);
  const rightYear = getTrackYear(rightTrack);
  if (!leftYear || !rightYear) {
    return 0;
  }

  const delta = Math.abs(leftYear - rightYear);
  if (delta === 0) {
    return 1;
  }
  if (delta <= 2) {
    return 0.7;
  }
  if (delta <= 5) {
    return 0.35;
  }

  return 0;
}

function getArtistMatchScore(leftTrack = {}, rightTrack = {}) {
  const leftArtist = getComparableArtist(leftTrack);
  const rightArtist = getComparableArtist(rightTrack);
  if (!leftArtist || !rightArtist) {
    return 0;
  }

  if (leftArtist === rightArtist) {
    return 1;
  }

  if (leftArtist.includes(rightArtist) || rightArtist.includes(leftArtist)) {
    return 0.55;
  }

  return 0;
}

function getAlbumMatchScore(leftTrack = {}, rightTrack = {}) {
  const leftAlbum = getComparableAlbum(leftTrack);
  const rightAlbum = getComparableAlbum(rightTrack);
  if (!leftAlbum || !rightAlbum || isGenericAlbumName(leftAlbum) || isGenericAlbumName(rightAlbum)) {
    return 0;
  }

  return leftAlbum === rightAlbum ? 1 : 0;
}

function getTitleOverlapScore(leftTrack = {}, rightTrack = {}) {
  const leftTokens = getTrackTitleTokens(leftTrack);
  const rightTokens = getTrackTitleTokens(rightTrack);
  if (!leftTokens.length || !rightTokens.length) {
    return 0;
  }

  const rightSet = new Set(rightTokens);
  let sharedCount = 0;

  for (const token of leftTokens) {
    if (rightSet.has(token)) {
      sharedCount += 1;
    }
  }

  return sharedCount / new Set([...leftTokens, ...rightTokens]).size;
}

function getProviderPreferenceScore(track = {}) {
  if (track.provider === 'library') {
    return 1;
  }
  if (track.provider === 'deezer') {
    return 0.6;
  }
  if (track.provider === 'itunes') {
    return 0.45;
  }

  return 0.2;
}

function countArtistOccurrences(tracks = [], artistName = '') {
  const normalizedArtist = normaliseComparable(artistName);
  if (!normalizedArtist) {
    return 0;
  }

  return tracks.reduce((count, track) => count + (getComparableArtist(track) === normalizedArtist ? 1 : 0), 0);
}

function countAlbumOccurrences(tracks = [], albumName = '') {
  const normalizedAlbum = normaliseComparable(albumName);
  if (!normalizedAlbum || isGenericAlbumName(normalizedAlbum)) {
    return 0;
  }

  return tracks.reduce((count, track) => count + (getComparableAlbum(track) === normalizedAlbum ? 1 : 0), 0);
}

function normaliseContextTrack(track = {}) {
  return {
    id: String(track.id || track.trackId || '').trim(),
    title: String(track.title || '').trim(),
    artist: getPrimaryArtist(track),
    album: String(track.album || '').trim(),
    genre: extractGenreLabels(track.genre || track.genres || []).join(', '),
    duration: getComparableDuration(track.duration),
    releaseYear: getTrackYear(track),
    releaseDate: String(track.releaseDate || '').trim(),
    providerIds: track.providerIds || {},
    sourceUrl: String(track.sourceUrl || '').trim(),
    externalUrl: String(track.externalUrl || '').trim()
  };
}

function normaliseContextTrackList(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((track) => normaliseContextTrack(track))
    .filter((track) => track.title || track.artist || Object.values(track.providerIds || {}).some(Boolean))
    .slice(0, MAX_CONTEXT_TRACKS);
}

function resolveRecommendationContext(payload = {}) {
  const recentTracks = normaliseContextTrackList(payload.recentTracks);
  const upcomingTracks = normaliseContextTrackList(payload.upcomingTracks);
  const excludedTracks = normaliseContextTrackList(payload.excludedTracks);

  return {
    recentTracks,
    upcomingTracks,
    excludedTracks,
    allTracks: [...recentTracks, ...upcomingTracks, ...excludedTracks]
  };
}

function buildRecommendationQueries(seed, context) {
  const title = String(seed?.title || '').trim();
  const artist = String(seed?.artist || '').trim();
  const album = String(seed?.album || '').trim();
  const genres = Array.from(new Set([
    ...extractGenreLabels(seed.genre || seed.genres || []),
    ...getDominantGenres([seed, ...context.recentTracks, ...context.upcomingTracks], 2)
  ]));

  return Array.from(
    new Set(
      [
        artist && album && !isGenericAlbumName(album) ? `${artist} ${album}` : '',
        ...genres.map((genre) => (artist ? `${artist} ${genre}` : genre)),
        artist,
        !artist && title ? title : ''
      ].filter(Boolean)
    )
  ).slice(0, MAX_QUERY_COUNT);
}

function dedupeRecommendationItems(items) {
  const deduped = [];

  for (const item of items) {
    const duplicateIndex = deduped.findIndex((existingItem) => isTrackEquivalent(existingItem, item));
    if (duplicateIndex < 0) {
      deduped.push(item);
      continue;
    }

    const existingHasArtwork = Boolean(deduped[duplicateIndex].artwork);
    const candidateHasArtwork = Boolean(item.artwork);
    if (!existingHasArtwork && candidateHasArtwork) {
      deduped[duplicateIndex] = item;
    }
  }

  return deduped;
}

function findBestArtistMatch(artistName, candidates = []) {
  const normalizedArtistName = normaliseComparable(artistName);
  if (!normalizedArtistName) {
    return null;
  }

  return (
    candidates.find((candidate) => normaliseComparable(candidate.name) === normalizedArtistName) ||
    candidates.find((candidate) => normaliseComparable(candidate.name).includes(normalizedArtistName)) ||
    candidates.find((candidate) => normalizedArtistName.includes(normaliseComparable(candidate.name))) ||
    null
  );
}

function isHomonymCandidate(candidate, seed) {
  const candidateTitle = getComparableTitle(candidate);
  const seedTitle = getComparableTitle(seed);
  if (!candidateTitle || !seedTitle || candidateTitle !== seedTitle) {
    return false;
  }

  return true;
}

function computeRecommendationRelevance(item, seed, {
  genreProfile = new Map(),
  genreProfilePeak = 0
} = {}) {
  if (!item || isHomonymCandidate(item, seed)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (isTrackEquivalent(item, seed) || hasSharedProviderIdentity(item, seed)) {
    return Number.NEGATIVE_INFINITY;
  }

  const artistScore = getArtistMatchScore(item, seed);
  const genreOverlapScore = getGenreOverlapScore(item, seed);
  const genreProfileScore = genreProfilePeak
    ? Math.min(1, getGenreProfileScore(item, genreProfile) / genreProfilePeak)
    : 0;
  const albumScore = getAlbumMatchScore(item, seed);
  const durationScore = getDurationSimilarity(item, seed);
  const yearScore = getYearSimilarity(item, seed);
  const providerScore = getProviderPreferenceScore(item);
  const titleOverlapScore = getTitleOverlapScore(item, seed);

  if (!artistScore && !genreOverlapScore && !genreProfileScore) {
    return Number.NEGATIVE_INFINITY;
  }

  if (!artistScore && titleOverlapScore >= 0.8 && !genreOverlapScore) {
    return Number.NEGATIVE_INFINITY;
  }

  let relevance = 0;
  relevance += artistScore * 0.46;
  relevance += genreOverlapScore * 0.26;
  relevance += genreProfileScore * 0.12;
  relevance += albumScore * 0.08;
  relevance += durationScore * 0.04;
  relevance += yearScore * 0.02;
  relevance += providerScore * 0.02;

  return relevance;
}

function computeRecommendationSimilarity(leftTrack, rightTrack) {
  return (
    (getArtistMatchScore(leftTrack, rightTrack) * 0.5) +
    (getAlbumMatchScore(leftTrack, rightTrack) * 0.14) +
    (getGenreOverlapScore(leftTrack, rightTrack) * 0.24) +
    (getYearSimilarity(leftTrack, rightTrack) * 0.04) +
    (getTitleOverlapScore(leftTrack, rightTrack) * 0.08)
  );
}

function resolveSeed(payload, store, baseUrl) {
  if (payload.trackId) {
    const track = store.getTrack(payload.trackId);
    if (!track) {
      throw createHttpError(404, 'Track not found.');
    }

    return {
      ...track,
      providerIds: track.providerIds || {},
      apiTrack: formatApiTrack(track, baseUrl)
    };
  }

  const title = String(payload.title || '').trim();
  const artist = String(payload.artist || '').trim();
  if (!title || !artist) {
    throw createHttpError(400, 'Recommendations require a trackId or title and artist.');
  }

  return {
    id: '',
    title,
    artist,
    album: String(payload.album || '').trim(),
    genre: extractGenreLabels(payload.genre || payload.genres || []).join(', '),
    duration: payload.duration || null,
    releaseYear: getTrackYear(payload),
    releaseDate: String(payload.releaseDate || '').trim(),
    providerIds: payload.providerIds || {},
    apiTrack: null
  };
}

async function getRecommendations(payload, store, baseUrl, { signal } = {}) {
  const seed = resolveSeed(payload, store, baseUrl);
  const context = resolveRecommendationContext(payload);
  const limit = Math.min(25, Math.max(1, Number.parseInt(payload.limit, 10) || 12));
  const queryLimit = Math.max(limit * 2, 16);
  const recommendationQueries = buildRecommendationQueries(seed, context);
  const sessionGenreProfile = buildGenreProfile([seed, ...context.recentTracks, ...context.upcomingTracks]);
  const genreProfilePeak = getGenreProfilePeak(sessionGenreProfile) || 1;

  const libraryCandidates = recommendationQueries
    .flatMap((query) =>
      store
        .listTracks({ query, page: 1, pageSize: Math.max(queryLimit, 20) })
        .items.map((track) => formatApiTrack(track, baseUrl))
    )
    .filter(Boolean);

  const deezerArtists = await searchDeezerArtists({
    query: seed.artist,
    page: 1,
    pageSize: 5,
    signal
  });
  const deezerArtist = findBestArtistMatch(seed.artist, deezerArtists.items);

  const [deezerTopTracks, itunesArtistTracks, itunesAlbumTracks, deezerQueryTracks, itunesQueryTracks] = await Promise.all([
    deezerArtist
      ? listDeezerArtistTopTracks(deezerArtist.id, {
          limit: Math.max(queryLimit, 15),
          signal
        }).then((result) => result.items)
      : Promise.resolve([]),
    searchItunesArtistTracksByName(seed.artist, { signal }),
    seed.album && !GENERIC_ALBUM_NAMES.has(normaliseComparable(seed.album))
      ? searchItunesTracks({
          query: `${seed.artist} ${seed.album}`,
          page: 1,
          pageSize: Math.max(queryLimit, 15),
          signal
        }).then((result) => result.items)
      : Promise.resolve([]),
    Promise.all(
      recommendationQueries.map((query) =>
        searchDeezerTracks({
          query,
          page: 1,
          pageSize: queryLimit,
          signal
        }).then((result) => result.items)
      )
    ).then((items) => items.flat()),
    Promise.all(
      recommendationQueries.map((query) =>
        searchItunesTracks({
          query,
          page: 1,
          pageSize: queryLimit,
          signal
        }).then((result) => result.items)
      )
    ).then((items) => items.flat())
  ]);

  const diversityContext = [...context.recentTracks, ...context.upcomingTracks];
  const candidatePool = dedupeRecommendationItems([
    ...libraryCandidates,
    ...deezerTopTracks,
    ...itunesArtistTracks,
    ...itunesAlbumTracks,
    ...deezerQueryTracks,
    ...itunesQueryTracks
  ])
    .filter((item) => !isTrackEquivalent(item, seed))
    .filter((item) => !context.allTracks.some((track) => isTrackEquivalent(item, track)))
    .map((item) => ({
      item,
      relevance: computeRecommendationRelevance(item, seed, {
        genreProfile: sessionGenreProfile,
        genreProfilePeak
      })
    }))
    .filter((entry) => Number.isFinite(entry.relevance) && entry.relevance >= 0.18);

  const selectedItems = [];
  const remainingCandidates = [...candidatePool];

  while (selectedItems.length < limit && remainingCandidates.length) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remainingCandidates.length; index += 1) {
      const entry = remainingCandidates[index];
      const comparisonSet = [seed, ...selectedItems, ...diversityContext];
      const maxSimilarity = comparisonSet.length
        ? Math.max(...comparisonSet.map((otherTrack) => computeRecommendationSimilarity(entry.item, otherTrack)))
        : 0;
      const candidateArtist = getPrimaryArtist(entry.item);
      const artistFatigue = countArtistOccurrences([seed, ...diversityContext], candidateArtist);
      const albumFatigue = countAlbumOccurrences(diversityContext, entry.item.album);
      const sameSeedArtistPenalty = getComparableArtist(entry.item) === getComparableArtist(seed) ? 0.16 : 0;
      const fatiguePenalty = Math.min(0.36, artistFatigue * 0.16)
        + Math.min(0.1, albumFatigue * 0.05)
        + sameSeedArtistPenalty;
      const score = (entry.relevance * MMR_RELEVANCE_WEIGHT)
        - (maxSimilarity * (1 - MMR_RELEVANCE_WEIGHT))
        - fatiguePenalty;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      break;
    }

    selectedItems.push(remainingCandidates.splice(bestIndex, 1)[0].item);
  }

  return {
    seed: seed.apiTrack || {
      id: seed.id || '',
      title: seed.title,
      artist: seed.artist,
      album: seed.album || 'Singles',
      genre: seed.genre || '',
      duration: seed.duration || null,
      provider: 'seed',
      artwork: '',
      providerIds: seed.providerIds || {},
      externalUrl: '',
      downloadTarget: '',
      normalizedTitle: normaliseComparable(seed.title),
      normalizedArtist: normaliseComparable(seed.artist),
      normalizedAlbum: normaliseComparable(seed.album || ''),
      normalizedDuration: seed.duration || null,
      releaseYear: seed.releaseYear || null,
      metadataSource: 'seed'
    },
    items: selectedItems,
    total: selectedItems.length
  };
}

module.exports = {
  getRecommendations
};
