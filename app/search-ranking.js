const {
  GENERIC_ALBUM_NAMES,
  createStrongTrackIdentityKeys,
  createTrackFingerprintKey,
  isTrackEquivalent,
  normaliseComparableText
} = require('./track-identity');

const NON_SONG_RESULT_PATTERN =
  /\b(analysis|behind the scenes|clip|documentary|fanmade|fan made|interview|karaoke|reaction|review|tutorial)\b/i;
const VERSION_RESULT_PATTERN =
  /\b(cover|instrumental|live|nightcore|remix|slowed|sped up)\b/i;
const AUDIO_RESULT_PATTERN = /\b(audio|official audio|topic)\b/i;
const PROVIDER_QUALITY = Object.freeze({
  spotify: 54,
  deezer: 48,
  itunes: 42,
  youtube: 26,
  soundcloud: 18,
  library: 60
});

function tokenizeSearchQuery(value) {
  const normalised = normaliseComparableText(value);
  return normalised ? normalised.split(' ').filter(Boolean) : [];
}

function createTrackSearchDocument(track = {}) {
  const title = normaliseComparableText(track.title);
  const artist = normaliseComparableText(track.artist);
  const artists = Array.isArray(track.artists)
    ? track.artists.map(normaliseComparableText).filter(Boolean).join(' ')
    : '';
  const album = normaliseComparableText(track.album);
  const albumArtist = normaliseComparableText(track.albumArtist);
  const genre = Array.isArray(track.genre)
    ? track.genre.map(normaliseComparableText).filter(Boolean).join(' ')
    : normaliseComparableText(track.genre);
  const fileName = normaliseComparableText(track.fileName || track.filePath);
  const titleArtist = [title, artist].filter(Boolean).join(' ');
  const artistTitle = [artist, title].filter(Boolean).join(' ');
  const searchableText = [title, artist, artists, album, albumArtist, genre, fileName]
    .filter(Boolean)
    .join(' ');

  return {
    track,
    title,
    artist,
    artists,
    album,
    albumArtist,
    genre,
    fileName,
    titleArtist,
    artistTitle,
    searchableText,
    titleWords: new Set(title.split(' ').filter(Boolean)),
    artistWords: new Set([artist, artists].filter(Boolean).join(' ').split(' ').filter(Boolean)),
    albumWords: new Set([album, albumArtist].filter(Boolean).join(' ').split(' ').filter(Boolean)),
    addedAtMs: Date.parse(track.addedAt || track.updatedAt || '') || 0
  };
}

function scoreTokenInDocument(document, token) {
  let bestScore = 0;

  if (document.titleWords.has(token)) {
    bestScore = Math.max(bestScore, 38);
  } else if (document.title.startsWith(token)) {
    bestScore = Math.max(bestScore, 31);
  } else if (document.title.includes(token)) {
    bestScore = Math.max(bestScore, 24);
  }

  if (document.artistWords.has(token)) {
    bestScore = Math.max(bestScore, 35);
  } else if (document.artist.startsWith(token) || document.artists.startsWith(token)) {
    bestScore = Math.max(bestScore, 29);
  } else if (document.artist.includes(token) || document.artists.includes(token)) {
    bestScore = Math.max(bestScore, 22);
  }

  if (document.albumWords.has(token)) {
    bestScore = Math.max(bestScore, 16);
  } else if (document.album.includes(token) || document.albumArtist.includes(token)) {
    bestScore = Math.max(bestScore, 11);
  }

  if (document.genre.includes(token)) {
    bestScore = Math.max(bestScore, 7);
  }

  if (document.fileName.includes(token)) {
    bestScore = Math.max(bestScore, 4);
  }

  return bestScore;
}

function scoreTrackSearchDocument(document, query) {
  const normalisedQuery = normaliseComparableText(query);
  if (!normalisedQuery) {
    return 0;
  }

  const tokens = tokenizeSearchQuery(normalisedQuery);
  if (!tokens.length || !tokens.every((token) => document.searchableText.includes(token))) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;

  if (document.title === normalisedQuery) {
    score += 260;
  }
  if (document.artist === normalisedQuery || document.artists === normalisedQuery) {
    score += 225;
  }
  if (document.titleArtist === normalisedQuery || document.artistTitle === normalisedQuery) {
    score += 310;
  }
  if (document.title.startsWith(normalisedQuery)) {
    score += 120;
  } else if (document.title.includes(normalisedQuery)) {
    score += 88;
  }
  if (document.artist.startsWith(normalisedQuery) || document.artists.startsWith(normalisedQuery)) {
    score += 104;
  } else if (document.artist.includes(normalisedQuery) || document.artists.includes(normalisedQuery)) {
    score += 76;
  }
  if (document.album === normalisedQuery) {
    score += 54;
  } else if (document.album.startsWith(normalisedQuery)) {
    score += 36;
  } else if (document.album.includes(normalisedQuery)) {
    score += 24;
  }

  for (const token of tokens) {
    score += scoreTokenInDocument(document, token);
  }

  if (tokens.length > 1) {
    const titleTokenMatches = tokens.filter((token) => document.title.includes(token)).length;
    const artistTokenMatches = tokens.filter((token) =>
      document.artist.includes(token) || document.artists.includes(token)
    ).length;
    score += titleTokenMatches * 10;
    score += artistTokenMatches * 9;

    if (titleTokenMatches && artistTokenMatches) {
      score += 45;
    }
  }

  return score;
}

function rankTrackSearchDocuments(documents, query) {
  const normalisedQuery = normaliseComparableText(query);
  if (!normalisedQuery) {
    return [...documents]
      .sort((left, right) => right.addedAtMs - left.addedAtMs)
      .map((document) => document.track);
  }

  return documents
    .map((document) => ({
      document,
      score: scoreTrackSearchDocument(document, normalisedQuery)
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.document.addedAtMs !== left.document.addedAtMs) {
        return right.document.addedAtMs - left.document.addedAtMs;
      }
      return String(left.document.track.title || '').localeCompare(
        String(right.document.track.title || '')
      );
    })
    .map((entry) => entry.document.track);
}

function queryRequestsAlternateVersion(query) {
  return VERSION_RESULT_PATTERN.test(String(query || ''));
}

function scoreRawProviderEntry(entry, provider, query) {
  const document = createTrackSearchDocument({
    title: entry.track || entry.title || '',
    artist: entry.artist || entry.creator || entry.uploader || entry.channel || '',
    artists: entry.artists || [],
    album: entry.album || entry.playlist_title || '',
    genre: entry.genre || entry.genres || '',
    fileName: ''
  });
  let score = scoreTrackSearchDocument(document, query);
  if (!Number.isFinite(score)) {
    score = 0;
  }

  const title = String(entry.track || entry.title || '');
  const artist = String(entry.artist || entry.uploader || entry.channel || '');
  if (provider === 'youtube' && (AUDIO_RESULT_PATTERN.test(title) || AUDIO_RESULT_PATTERN.test(artist))) {
    score += 34;
  }
  if (NON_SONG_RESULT_PATTERN.test(title)) {
    score -= provider === 'youtube' ? 90 : 45;
  }
  if (!queryRequestsAlternateVersion(query) && VERSION_RESULT_PATTERN.test(title)) {
    score -= provider === 'youtube' ? 42 : 24;
  }

  const duration = Number(entry.duration);
  if (Number.isFinite(duration) && duration >= 75 && duration <= 720) {
    score += 12;
  } else if (Number.isFinite(duration) && (duration < 45 || duration > 1800)) {
    score -= 18;
  }

  return score;
}

function isPreferredMusicResult(entry, provider, query) {
  if (provider !== 'youtube') {
    return true;
  }

  if (queryRequestsAlternateVersion(query)) {
    return true;
  }

  const title = String(entry.track || entry.title || '');
  const duration = Number(entry.duration);
  if (Number.isFinite(duration) && duration > 0 && duration < 60) {
    return false;
  }

  return !NON_SONG_RESULT_PATTERN.test(title) && !VERSION_RESULT_PATTERN.test(title);
}

function scoreRemoteTrack(item, query) {
  const document = createTrackSearchDocument(item);
  let score = scoreTrackSearchDocument(document, query);
  if (!Number.isFinite(score)) {
    score = -30;
  }

  const provider = String(item.provider || item.sourcePlatform || '').toLowerCase();
  score += PROVIDER_QUALITY[provider] || 0;

  if (item.requestedProvider) {
    score -= 24;
  }

  const metadataSource = String(item.metadataSource || '').toLowerCase();
  if (metadataSource === 'spotify' || metadataSource === 'spotify-page') {
    score += 28;
  } else if (metadataSource === 'deezer') {
    score += 22;
  } else if (metadataSource === 'itunes') {
    score += 18;
  }

  if (item.artwork) {
    score += 7;
  }
  if (Number(item.duration) > 0) {
    score += 5;
  }
  if (!GENERIC_ALBUM_NAMES.has(normaliseComparableText(item.album))) {
    score += 4;
  }
  if (item.isrc || item.providerIds?.isrc) {
    score += 8;
  }

  const title = String(item.title || '');
  if (NON_SONG_RESULT_PATTERN.test(title)) {
    score -= 75;
  }
  if (!queryRequestsAlternateVersion(query) && VERSION_RESULT_PATTERN.test(title)) {
    score -= 32;
  }

  return score;
}

function mergeRemoteIdentity(preferred, alternate) {
  return {
    ...preferred,
    providerIds: {
      ...(alternate?.providerIds || {}),
      ...(preferred?.providerIds || {})
    },
    isrc: preferred?.isrc || alternate?.isrc || preferred?.providerIds?.isrc || alternate?.providerIds?.isrc || '',
    artwork: preferred?.artwork || alternate?.artwork || '',
    duration: preferred?.duration || alternate?.duration || null,
    releaseDate: preferred?.releaseDate || alternate?.releaseDate || '',
    releaseYear: preferred?.releaseYear || alternate?.releaseYear || null
  };
}

function createRankedRemoteEntry(item, score) {
  const fingerprintKey = createTrackFingerprintKey(item);
  return {
    item,
    score,
    strongKeys: new Set(createStrongTrackIdentityKeys(item)),
    fingerprintKeys: new Set(fingerprintKey ? [fingerprintKey] : [])
  };
}

function rebuildRemoteIdentityIndexes(rankedItems, strongIdentityIndexes, fingerprintIndexes) {
  strongIdentityIndexes.clear();
  fingerprintIndexes.clear();

  rankedItems.forEach((entry, index) => {
    if (!entry) {
      return;
    }

    for (const key of entry.strongKeys) {
      strongIdentityIndexes.set(key, index);
    }

    for (const fingerprintKey of entry.fingerprintKeys) {
      const indexes = fingerprintIndexes.get(fingerprintKey) || [];
      indexes.push(index);
      fingerprintIndexes.set(fingerprintKey, indexes);
    }
  });
}

function mergeRemoteIdentityClusters(rankedItems, matchingIndexes, item, itemScore) {
  const survivorIndex = Math.min(...matchingIndexes);
  const candidates = [
    ...matchingIndexes
      .map((index) => rankedItems[index])
      .filter(Boolean),
    createRankedRemoteEntry(item, itemScore)
  ].sort((left, right) => right.score - left.score);

  let mergedItem = candidates[0].item;
  const strongKeys = new Set();
  const fingerprintKeys = new Set();
  for (const candidate of candidates) {
    for (const key of candidate.strongKeys) {
      strongKeys.add(key);
    }
    for (const key of candidate.fingerprintKeys) {
      fingerprintKeys.add(key);
    }
  }
  for (const alternate of candidates.slice(1)) {
    mergedItem = mergeRemoteIdentity(mergedItem, alternate.item);
  }

  for (const index of matchingIndexes) {
    rankedItems[index] = null;
  }
  rankedItems[survivorIndex] = {
    item: mergedItem,
    score: candidates[0].score,
    strongKeys,
    fingerprintKeys
  };
}

function dedupeAndRankRemoteItems(items, query, limit = Number.POSITIVE_INFINITY) {
  const rankedItems = [];
  const strongIdentityIndexes = new Map();
  const fingerprintIndexes = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item) {
      continue;
    }

    const itemScore = scoreRemoteTrack(item, query);
    const strongKeys = createStrongTrackIdentityKeys(item);
    const fingerprintKey = createTrackFingerprintKey(item);
    const matchingIndexes = new Set();

    for (const key of strongKeys) {
      const index = strongIdentityIndexes.get(key);
      if (Number.isInteger(index) && rankedItems[index]) {
        matchingIndexes.add(index);
      }
    }

    if (fingerprintKey) {
      for (const candidateIndex of fingerprintIndexes.get(fingerprintKey) || []) {
        const candidate = rankedItems[candidateIndex];
        if (candidate && isTrackEquivalent(candidate.item, item)) {
          matchingIndexes.add(candidateIndex);
        }
      }
    }

    if (!matchingIndexes.size) {
      rankedItems.push(createRankedRemoteEntry(item, itemScore));
    } else {
      mergeRemoteIdentityClusters(rankedItems, [...matchingIndexes], item, itemScore);
    }

    rebuildRemoteIdentityIndexes(rankedItems, strongIdentityIndexes, fingerprintIndexes);
  }

  const sorted = rankedItems
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(left.item.title || '').localeCompare(String(right.item.title || ''));
    });
  const numericLimit = Number(limit);
  const limited = Number.isFinite(numericLimit)
    ? sorted.slice(0, Math.max(0, numericLimit))
    : sorted;

  return limited.map((entry) => entry.item);
}

function paginateRankedRemoteItems(items, query, page = 1, pageSize = 8) {
  const safePageSize = Math.min(20, Math.max(1, Number.parseInt(pageSize, 10) || 8));
  const requestedPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const rankedItems = dedupeAndRankRemoteItems(items, query);
  const total = rankedItems.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const start = (currentPage - 1) * safePageSize;

  return {
    items: rankedItems.slice(start, start + safePageSize),
    total,
    page: currentPage,
    pageSize: safePageSize,
    totalPages
  };
}

function getProviderRequestPageSize(pageSize, providerCount, page = 1) {
  const safePageSize = Math.min(20, Math.max(1, Number.parseInt(pageSize, 10) || 8));
  const safeProviderCount = Math.max(1, Number.parseInt(providerCount, 10) || 1);
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);

  if (safeProviderCount === 1 || safePage > 1) {
    return safePageSize;
  }

  return Math.min(10, Math.max(4, Math.ceil(safePageSize / safeProviderCount) + 2));
}

function getProviderRequestPageSize(pageSize, providerCount, page = 1) {
  const safePageSize = Math.min(20, Math.max(1, Number.parseInt(pageSize, 10) || 8));
  const safeProviderCount = Math.max(1, Number.parseInt(providerCount, 10) || 1);
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);

  if (safeProviderCount === 1 || safePage > 1) {
    return safePageSize;
  }

  return Math.min(10, Math.max(4, Math.ceil(safePageSize / safeProviderCount) + 2));
}

module.exports = {
  tokenizeSearchQuery,
  createTrackSearchDocument,
  scoreTrackSearchDocument,
  rankTrackSearchDocuments,
  scoreRawProviderEntry,
  isPreferredMusicResult,
  scoreRemoteTrack,
  dedupeAndRankRemoteItems,
  paginateRankedRemoteItems,
  getProviderRequestPageSize
};
