const { normaliseProviderIds } = require('./models');

const GENERIC_ALBUM_NAMES = new Set([
  '',
  'singles',
  'youtube',
  'soundcloud',
  'spotify',
  'deezer'
]);

function normaliseComparableText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseComparableUrl(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return '';
  }

  try {
    const url = new URL(rawValue);
    url.hash = '';
    for (const trackingParameter of [
      'fbclid',
      'gclid',
      'si',
      'utm_campaign',
      'utm_content',
      'utm_medium',
      'utm_source',
      'utm_term'
    ]) {
      url.searchParams.delete(trackingParameter);
    }

    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/g, '') || '/';
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return rawValue.replace(/\/+$/g, '');
  }
}

function normaliseTrackProviderIds(trackOrProviderIds = {}) {
  if (trackOrProviderIds && typeof trackOrProviderIds === 'object' && trackOrProviderIds.providerIds) {
    return normaliseProviderIds({
      ...trackOrProviderIds.providerIds,
      isrc: trackOrProviderIds.isrc || trackOrProviderIds.providerIds.isrc || ''
    });
  }

  return normaliseProviderIds(trackOrProviderIds || {});
}

function hasSameProviderIdentity(leftTrackOrIds = {}, rightTrackOrIds = {}) {
  const leftIds = normaliseTrackProviderIds(leftTrackOrIds);
  const rightIds = normaliseTrackProviderIds(rightTrackOrIds);

  if (leftIds.isrc && rightIds.isrc && leftIds.isrc.toLowerCase() === rightIds.isrc.toLowerCase()) {
    return true;
  }

  return ['spotify', 'youtube', 'soundcloud', 'itunes', 'deezer'].some((key) => {
    return Boolean(
      leftIds[key]
      && rightIds[key]
      && String(leftIds[key]).toLowerCase() === String(rightIds[key]).toLowerCase()
    );
  });
}

function hasCompatibleDuration(leftDuration, rightDuration, toleranceSeconds = 5) {
  const left = Number(leftDuration);
  const right = Number(rightDuration);
  if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) {
    return true;
  }

  return Math.abs(left - right) <= toleranceSeconds;
}

function hasSameMetadataFingerprint(left = {}, right = {}) {
  const leftTitle = normaliseComparableText(left.title);
  const rightTitle = normaliseComparableText(right.title);
  const leftArtist = normaliseComparableText(left.artist);
  const rightArtist = normaliseComparableText(right.artist);

  if (!leftTitle || !rightTitle || !leftArtist || !rightArtist) {
    return false;
  }

  if (leftTitle !== rightTitle || leftArtist !== rightArtist) {
    return false;
  }

  if (!hasCompatibleDuration(left.duration, right.duration)) {
    return false;
  }

  const leftAlbum = normaliseComparableText(left.album);
  const rightAlbum = normaliseComparableText(right.album);
  if (
    leftAlbum
    && rightAlbum
    && !GENERIC_ALBUM_NAMES.has(leftAlbum)
    && !GENERIC_ALBUM_NAMES.has(rightAlbum)
    && leftAlbum !== rightAlbum
  ) {
    return false;
  }

  return true;
}

function getTrackSourceUrl(track = {}) {
  return normaliseComparableUrl(track.sourceUrl || track.externalUrl || track.downloadTarget);
}

function isTrackEquivalent(left, right) {
  if (!left || !right) {
    return false;
  }

  if (hasSameProviderIdentity(left, right)) {
    return true;
  }

  const leftSourceUrl = getTrackSourceUrl(left);
  const rightSourceUrl = getTrackSourceUrl(right);
  if (leftSourceUrl && rightSourceUrl && leftSourceUrl === rightSourceUrl) {
    return true;
  }

  return hasSameMetadataFingerprint(left, right);
}

function createStrongTrackIdentityKeys(track = {}) {
  const providerIds = normaliseTrackProviderIds(track);
  const keys = [];

  for (const provider of ['isrc', 'spotify', 'youtube', 'soundcloud', 'itunes', 'deezer']) {
    const value = String(providerIds[provider] || '').trim().toLowerCase();
    if (value) {
      keys.push(`${provider}:${value}`);
    }
  }

  const sourceUrl = getTrackSourceUrl(track);
  if (sourceUrl) {
    keys.push(`url:${sourceUrl}`);
  }

  return keys;
}

function createTrackFingerprintKey(track = {}) {
  const title = normaliseComparableText(track.title);
  const artist = normaliseComparableText(track.artist);
  return title && artist ? `${title}\u0000${artist}` : '';
}

module.exports = {
  GENERIC_ALBUM_NAMES,
  normaliseComparableText,
  normaliseComparableUrl,
  normaliseTrackProviderIds,
  hasSameProviderIdentity,
  hasCompatibleDuration,
  hasSameMetadataFingerprint,
  getTrackSourceUrl,
  isTrackEquivalent,
  createStrongTrackIdentityKeys,
  createTrackFingerprintKey
};
