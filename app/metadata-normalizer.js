const DECORATION_PATTERN =
  /\s*(\[(?:official|audio|video|lyrics?|karaoke|live|hq|hd|visualizer|topic|remaster(?:ed)?(?:\s+\d{4})?|explicit|clean|sped up|slowed)[^\]]*\]|\((?:official|audio|video|lyrics?|karaoke|live|hq|hd|visualizer|topic|remaster(?:ed)?(?:\s+\d{4})?|explicit|clean|sped up|slowed)[^)]*\))\s*/gi;
const FEATURE_PATTERN = /\s*(?:\(|\[)?(?:feat\.?|ft\.?|featuring)\s+[^)\]]+(?:\)|\])?\s*/gi;
const ARTIST_TITLE_SPLIT_PATTERN = /^\s*(.+?)\s*[-–—:|]\s*(.+?)\s*$/;
const GENERIC_CHANNEL_PATTERN = /\b(topic|official|records?|music|vevo|channel)\b/i;

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
  const value = Number.parseInt(duration, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}

function normaliseTrackMetadata(input = {}) {
  const provider = String(input.provider || '').toLowerCase();
  const rawTitle = normaliseWhitespace(input.title);
  const rawArtist = stripArtistDecorations(input.artist);
  const parsed = parseArtistTitle(rawTitle);

  let title = stripTitleDecorations(rawTitle);
  let artist = rawArtist;

  if (parsed) {
    const parsedArtist = parsed.artist;
    const parsedTitle = parsed.title;
    const parsedArtistComparable = normaliseComparable(parsedArtist);
    const currentArtistComparable = normaliseComparable(rawArtist);

    if (!artist || isGenericArtistName(artist) || currentArtistComparable === parsedArtistComparable) {
      artist = parsedArtist;
      title = parsedTitle;
    } else if (
      ['youtube', 'soundcloud'].includes(provider) &&
      normaliseComparable(rawTitle).startsWith(parsedArtistComparable)
    ) {
      title = parsedTitle;
    }
  }

  const normalizedTitle = normaliseComparable(title);
  const normalizedArtist = normaliseComparable(artist);
  const normalizedAlbum = normaliseComparable(input.album || '');
  const normalizedDuration = normaliseDuration(input.duration);

  return {
    title: title || rawTitle || 'Untitled',
    artist: artist || rawArtist || 'Unknown Artist',
    album: normaliseWhitespace(input.album) || 'Singles',
    duration: normalizedDuration,
    normalizedTitle,
    normalizedArtist,
    normalizedAlbum,
    normalizedDuration,
    metadataSource: input.metadataSource || provider || 'unknown'
  };
}

module.exports = {
  normalizeTrackMetadata: normaliseTrackMetadata,
  normaliseComparable,
  normaliseDuration,
  parseArtistTitle,
  stripArtistDecorations,
  stripTitleDecorations
};
