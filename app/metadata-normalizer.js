const DECORATION_PATTERN =
  /\s*(\[(?:official|audio|video|lyrics?|karaoke|live|hq|hd|visualizer|topic|remaster(?:ed)?(?:\s+\d{4})?|explicit|clean|sped up|slowed)[^\]]*\]|\((?:official|audio|video|lyrics?|karaoke|live|hq|hd|visualizer|topic|remaster(?:ed)?(?:\s+\d{4})?|explicit|clean|sped up|slowed)[^)]*\))\s*/gi;
const FEATURE_PATTERN = /\s*(?:\(|\[)?(?:feat\.?|ft\.?|featuring)\s+[^)\]]+(?:\)|\])?\s*/gi;
const ARTIST_TITLE_SPLIT_PATTERN = /^\s*(.+?)\s*[-–—:|]\s*(.+?)\s*$/;
const GENERIC_CHANNEL_PATTERN = /\b(topic|official|records?|music|vevo|channel)\b/i;
const GENERIC_TITLE_VALUES = new Set(['', 'untitled', 'unknown title']);
const GENERIC_ARTIST_VALUES = new Set(['', 'unknown artist', 'various artists']);
const GENERIC_ALBUM_VALUES = new Set(['', 'singles', 'youtube', 'soundcloud', 'spotify', 'deezer']);

function normaliseWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTitleDecorations(title) {
  return normaliseWhitespace(String(title || '').replace(DECORATION_PATTERN, ' ').replace(FEATURE_PATTERN, ' '));
}

function stripArtistDecorations(artist) {
  return normaliseWhitespace(
    String(artist || '')
      .replace(/\s*-\s*topic$/i, '')
      .replace(/\s+official$/i, '')
      .replace(/\s+vevo$/i, '')
  );
}

function normaliseComparable(value) {
  return normaliseWhitespace(value).toLowerCase();
}

function isGenericArtistName(artist) {
  const cleaned = stripArtistDecorations(artist);
  if (!cleaned) {
    return true;
  }

  return GENERIC_CHANNEL_PATTERN.test(cleaned) && cleaned.split(/\s+/).length <= 3;
}

function isGenericTitle(value) {
  return GENERIC_TITLE_VALUES.has(normaliseComparable(value));
}

function isGenericArtist(value) {
  return GENERIC_ARTIST_VALUES.has(normaliseComparable(value)) || isGenericArtistName(value);
}

function isGenericAlbumName(value) {
  return GENERIC_ALBUM_VALUES.has(normaliseComparable(value));
}

function parseArtistTitle(title) {
  const match = String(title || '').match(ARTIST_TITLE_SPLIT_PATTERN);
  if (!match) {
    return null;
  }

  return {
    artist: stripArtistDecorations(match[1]),
    title: stripTitleDecorations(match[2])
  };
}

function normaliseDuration(duration) {
  const numericDuration = Number.parseFloat(duration);
  if (!Number.isFinite(numericDuration) || numericDuration <= 0) {
    return null;
  }

  return Math.round(numericDuration);
}

function normaliseNumberTag(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }

  const match = String(value).match(/(\d{1,3})/);
  if (!match) {
    return null;
  }

  const numericValue = Number.parseInt(match[1], 10);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function normaliseReleaseDate(value) {
  const trimmed = normaliseWhitespace(value);
  if (!trimmed) {
    return '';
  }

  const fullDate = trimmed.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (fullDate) {
    return `${fullDate[1]}-${fullDate[2]}-${fullDate[3]}`;
  }

  const monthDate = trimmed.match(/^(\d{4})[-/](\d{2})$/);
  if (monthDate) {
    return `${monthDate[1]}-${monthDate[2]}`;
  }

  const yearOnly = trimmed.match(/^(\d{4})$/);
  if (yearOnly) {
    return yearOnly[1];
  }

  const isoLike = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (isoLike) {
    return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}`;
  }

  return '';
}

function extractReleaseYear(releaseDate, fallbackYear) {
  const releaseYear = String(releaseDate || '').match(/^(\d{4})/)?.[1] || '';
  if (releaseYear) {
    return Number.parseInt(releaseYear, 10);
  }

  const numericYear = Number.parseInt(fallbackYear, 10);
  if (!Number.isFinite(numericYear) || numericYear <= 0) {
    return null;
  }

  return numericYear;
}

function normaliseGenre(value) {
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => normaliseWhitespace(item))
      .filter(Boolean)
      .join(', ');
    return joined || '';
  }

  return normaliseWhitespace(value);
}

function normaliseExplicit(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const comparable = normaliseComparable(value);
  if (!comparable) {
    return null;
  }

  if (['true', 'yes', '1', 'explicit'].includes(comparable)) {
    return true;
  }

  if (['false', 'no', '0', 'clean'].includes(comparable)) {
    return false;
  }

  return null;
}

function normaliseArtistList(value, fallbackArtist = '') {
  if (Array.isArray(value)) {
    const artists = value
      .map((artist) => stripArtistDecorations(artist))
      .filter(Boolean);
    return artists.length ? artists : (fallbackArtist ? [fallbackArtist] : []);
  }

  const trimmed = stripArtistDecorations(value);
  if (!trimmed) {
    return fallbackArtist ? [fallbackArtist] : [];
  }

  const list = trimmed
    .split(/\s*,\s*/)
    .map((artist) => stripArtistDecorations(artist))
    .filter(Boolean);
  return list.length ? list : [trimmed];
}

function cleanupCanonicalTrack(input = {}) {
  const provider = String(input.provider || input.sourcePlatform || '').toLowerCase();
  const rawTitle = normaliseWhitespace(input.title);
  const rawArtist = stripArtistDecorations(input.artist);
  const parsed = parseArtistTitle(rawTitle);

  let title = stripTitleDecorations(rawTitle);
  let artist = rawArtist;

  if (parsed) {
    const parsedArtistComparable = normaliseComparable(parsed.artist);
    const currentArtistComparable = normaliseComparable(rawArtist);

    if (!artist || isGenericArtistName(artist) || currentArtistComparable === parsedArtistComparable) {
      artist = parsed.artist;
      title = parsed.title;
    } else if (
      ['youtube', 'soundcloud'].includes(provider) &&
      normaliseComparable(rawTitle).startsWith(parsedArtistComparable)
    ) {
      title = parsed.title;
    }
  }

  const artists = normaliseArtistList(input.artists, artist || rawArtist || '');
  const resolvedArtist = artist || artists[0] || rawArtist || 'Unknown Artist';
  const albumArtist = stripArtistDecorations(input.albumArtist) || artists[0] || resolvedArtist;
  const releaseDate = normaliseReleaseDate(input.releaseDate || input.releaseYear || input.year);

  return {
    title: title || rawTitle || 'Untitled',
    artist: resolvedArtist || 'Unknown Artist',
    artists: artists.length ? artists : [resolvedArtist || 'Unknown Artist'],
    album: normaliseWhitespace(input.album) || 'Singles',
    albumArtist: albumArtist || resolvedArtist || 'Unknown Artist',
    trackNumber: normaliseNumberTag(input.trackNumber),
    discNumber: normaliseNumberTag(input.discNumber),
    duration: normaliseDuration(input.duration),
    releaseDate,
    releaseYear: extractReleaseYear(releaseDate, input.releaseYear || input.year),
    genre: normaliseGenre(input.genre),
    explicit: normaliseExplicit(input.explicit),
    artwork: normaliseWhitespace(input.artwork || input.artworkUrl),
    sourcePlatform: provider || 'unknown',
    sourceUrl: normaliseWhitespace(input.sourceUrl || ''),
    externalUrl: normaliseWhitespace(input.externalUrl || ''),
    isrc: normaliseWhitespace(input.isrc || input.providerIds?.isrc || ''),
    normalizedTitle: normaliseComparable(title || rawTitle || 'Untitled'),
    normalizedArtist: normaliseComparable(resolvedArtist || 'Unknown Artist'),
    normalizedAlbum: normaliseComparable(input.album || ''),
    normalizedDuration: normaliseDuration(input.duration),
    metadataSource: input.metadataSource || provider || 'unknown'
  };
}

function normalizeTrackMetadata(input = {}) {
  return cleanupCanonicalTrack(input);
}

function preferTextField(field, currentValue, candidateValue) {
  const current = normaliseWhitespace(currentValue);
  const candidate = normaliseWhitespace(candidateValue);
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  if (field === 'album') {
    if (isGenericAlbumName(current) && !isGenericAlbumName(candidate)) {
      return candidate;
    }
    if (!isGenericAlbumName(current) && isGenericAlbumName(candidate)) {
      return current;
    }
  }

  if (field === 'title') {
    if (isGenericTitle(current) && !isGenericTitle(candidate)) {
      return candidate;
    }
  }

  if (field === 'artist' || field === 'albumArtist') {
    if (isGenericArtist(current) && !isGenericArtist(candidate)) {
      return candidate;
    }
  }

  if (normaliseComparable(current) === normaliseComparable(candidate)) {
    return candidate.length >= current.length ? candidate : current;
  }

  return current;
}

function mergeArtistLists(currentArtists = [], candidateArtists = [], fallbackArtist = '') {
  const merged = [...currentArtists];

  for (const candidate of candidateArtists) {
    if (!merged.some((artist) => normaliseComparable(artist) === normaliseComparable(candidate))) {
      merged.push(candidate);
    }
  }

  if (!merged.length && fallbackArtist) {
    merged.push(fallbackArtist);
  }

  return merged;
}

function mergeTrackMetadata(base = {}, candidate = {}) {
  const left = normalizeTrackMetadata(base);
  const right = normalizeTrackMetadata(candidate);
  const title = preferTextField('title', left.title, right.title);
  const artist = preferTextField('artist', left.artist, right.artist);
  const album = preferTextField('album', left.album, right.album);
  const albumArtist = preferTextField('albumArtist', left.albumArtist, right.albumArtist || right.artist);
  const artists = mergeArtistLists(left.artists, right.artists, artist);
  const releaseDate =
    left.releaseDate ||
    right.releaseDate ||
    '';

  return {
    ...base,
    ...candidate,
    title,
    artist,
    artists,
    album,
    albumArtist,
    trackNumber: left.trackNumber || right.trackNumber || null,
    discNumber: left.discNumber || right.discNumber || null,
    duration: left.duration || right.duration || null,
    releaseDate,
    releaseYear: left.releaseYear || right.releaseYear || extractReleaseYear(releaseDate, null),
    genre: left.genre || right.genre || '',
    explicit:
      left.explicit === null || left.explicit === undefined
        ? right.explicit
        : left.explicit,
    artwork: left.artwork || right.artwork || '',
    sourcePlatform: left.sourcePlatform || right.sourcePlatform || 'unknown',
    sourceUrl: left.sourceUrl || right.sourceUrl || '',
    externalUrl: left.externalUrl || right.externalUrl || '',
    isrc: left.isrc || right.isrc || '',
    normalizedTitle: normaliseComparable(title),
    normalizedArtist: normaliseComparable(artist),
    normalizedAlbum: normaliseComparable(album),
    normalizedDuration: left.normalizedDuration || right.normalizedDuration || null,
    metadataSource: left.metadataSource || right.metadataSource || 'unknown'
  };
}

function countMetadataFields(track = {}) {
  const normalized = normalizeTrackMetadata(track);
  let score = 0;

  if (normalized.title && !isGenericTitle(normalized.title)) {
    score += 2;
  }
  if (normalized.artist && !isGenericArtist(normalized.artist)) {
    score += 2;
  }
  if (normalized.album && !isGenericAlbumName(normalized.album)) {
    score += 1;
  }
  if (normalized.artwork) {
    score += 1;
  }
  if (normalized.duration) {
    score += 1;
  }
  if (normalized.releaseDate || normalized.releaseYear) {
    score += 1;
  }
  if (normalized.genre) {
    score += 1;
  }
  if (normalized.explicit !== null) {
    score += 1;
  }
  if (normalized.isrc) {
    score += 2;
  }
  if (normalized.trackNumber) {
    score += 1;
  }
  if (normalized.discNumber) {
    score += 1;
  }

  return score;
}

function hasWeakTrackMetadata(track = {}) {
  const normalized = normalizeTrackMetadata(track);
  return (
    isGenericTitle(normalized.title) ||
    isGenericArtist(normalized.artist) ||
    isGenericAlbumName(normalized.album) ||
    countMetadataFields(normalized) < 6
  );
}

module.exports = {
  normalizeTrackMetadata,
  mergeTrackMetadata,
  hasWeakTrackMetadata,
  countMetadataFields,
  normaliseComparable,
  normaliseDuration,
  parseArtistTitle,
  stripArtistDecorations,
  stripTitleDecorations,
  isGenericAlbumName,
  isGenericArtist,
  isGenericTitle
};
