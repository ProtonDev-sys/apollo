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

function scoreRecommendation(item, seed) {
  let score = 0;

  if (item.provider === 'deezer') {
    score += 40;
  } else if (item.provider === 'itunes') {
    score += 30;
  } else if (item.provider === 'library') {
    score += 60;
  }

  if (normaliseComparable(item.artist) === normaliseComparable(seed.artist)) {
    score += 25;
  }

  if (
    seed.album &&
    !GENERIC_ALBUM_NAMES.has(normaliseComparable(seed.album)) &&
    normaliseComparable(item.album) === normaliseComparable(seed.album)
  ) {
    score += 10;
  }

  if (item.artwork) {
    score += 5;
  }

  if (item.duration) {
    score += 3;
  }

  return score;
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
    duration: payload.duration || null,
    providerIds: payload.providerIds || {},
    apiTrack: null
  };
}

async function getRecommendations(payload, store, baseUrl, { signal } = {}) {
  const seed = resolveSeed(payload, store, baseUrl);
  const limit = Math.min(25, Math.max(1, Number.parseInt(payload.limit, 10) || 12));
  const libraryCandidates = store
    .listTracks({ query: seed.artist, page: 1, pageSize: 50 })
    .items.map((track) => formatApiTrack(track, baseUrl))
    .filter(
      (track) =>
        track &&
        normaliseComparable(track.artist).includes(normaliseComparable(seed.artist)) &&
        !isTrackEquivalent(track, seed)
    );

  const deezerArtists = await searchDeezerArtists({
    query: seed.artist,
    page: 1,
    pageSize: 5,
    signal
  });
  const deezerArtist = findBestArtistMatch(seed.artist, deezerArtists.items);

  const [deezerTopTracks, itunesArtistTracks, itunesAlbumTracks] = await Promise.all([
    deezerArtist
      ? listDeezerArtistTopTracks(deezerArtist.id, {
          limit: Math.max(limit * 2, 15),
          signal
        }).then((result) => result.items)
      : Promise.resolve([]),
    searchItunesArtistTracksByName(seed.artist, { signal }),
    seed.album && !GENERIC_ALBUM_NAMES.has(normaliseComparable(seed.album))
      ? searchItunesTracks({
          query: `${seed.artist} ${seed.album}`,
          page: 1,
          pageSize: Math.max(limit * 2, 15),
          signal
        }).then((result) => result.items)
      : Promise.resolve([])
  ]);

  const fallbackTracks =
    deezerTopTracks.length || itunesArtistTracks.length
      ? []
      : (
          await Promise.all([
            searchDeezerTracks({
              query: seed.artist,
              page: 1,
              pageSize: Math.max(limit, 10),
              signal
            }).then((result) => result.items),
            searchItunesTracks({
              query: seed.artist,
              page: 1,
              pageSize: Math.max(limit, 10),
              signal
            }).then((result) => result.items)
          ])
        ).flat();

  const items = dedupeRecommendationItems([
    ...libraryCandidates,
    ...deezerTopTracks,
    ...itunesArtistTracks,
    ...itunesAlbumTracks,
    ...fallbackTracks
  ])
    .filter((item) => !isTrackEquivalent(item, seed))
    .sort((left, right) => scoreRecommendation(right, seed) - scoreRecommendation(left, seed))
    .slice(0, limit);

  return {
    seed: seed.apiTrack || {
      id: seed.id || '',
      title: seed.title,
      artist: seed.artist,
      album: seed.album || 'Singles',
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
      metadataSource: 'seed'
    },
    items,
    total: items.length
  };
}

module.exports = {
  getRecommendations
};
