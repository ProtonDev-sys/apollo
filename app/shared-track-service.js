const { createHttpError } = require('./http-error');
const { createEmptyProviderIds, formatApiTrack } = require('./models');
const { inspectDirectLink, resolveDownloadMetadata } = require('./search-service');
const { lookupDeezerTrackById, lookupItunesTrackById } = require('./public-metadata-service');

function parseSharedTrackId(sharedId) {
  const trimmedId = String(sharedId || '').trim();
  const separatorIndex = trimmedId.indexOf(':');
  if (!trimmedId || separatorIndex <= 0 || separatorIndex === trimmedId.length - 1) {
    throw createHttpError(400, 'Shared track id must use the format <namespace>:<value>.');
  }

  return {
    namespace: trimmedId.slice(0, separatorIndex).toLowerCase(),
    value: trimmedId.slice(separatorIndex + 1),
    raw: trimmedId
  };
}

function formatResolvedTrack(track, baseUrl) {
  const formatted = formatApiTrack(track, baseUrl);
  return {
    ...formatted,
    playable: Boolean(
      formatted.trackId ||
      formatted.downloadTarget ||
      formatted.externalUrl ||
      formatted.sourceUrl
    )
  };
}

async function resolveSharedTrack(payload, settings, store, baseUrl, { signal } = {}) {
  const { namespace, value, raw } = parseSharedTrackId(payload.id || payload.sharedId);

  if (namespace === 'library') {
    const track = store.getTrack(value);
    if (!track) {
      throw createHttpError(
        404,
        'Library track IDs are local to one Apollo server. Share a public provider-backed ID instead.'
      );
    }

    return formatResolvedTrack(track, baseUrl);
  }

  if (namespace === 'soundcloud') {
    throw createHttpError(
      400,
      'SoundCloud shared IDs are not globally resolvable from a bare ID. Share a canonical SoundCloud URL instead.'
    );
  }

  if (namespace === 'spotify') {
    const url = `https://open.spotify.com/track/${value}`;
    const track = await resolveDownloadMetadata(
      {
        id: raw,
        provider: 'spotify',
        sourcePlatform: 'spotify',
        providerIds: createEmptyProviderIds({ spotify: value }),
        sourceUrl: url,
        externalUrl: url,
        downloadTarget: url
      },
      settings
    );

    return formatResolvedTrack(
      {
        id: raw,
        ...track,
        provider: 'spotify',
        sourcePlatform: 'spotify'
      },
      baseUrl
    );
  }

  if (namespace === 'deezer') {
    return formatResolvedTrack(await lookupDeezerTrackById(value, { signal }), baseUrl);
  }

  if (namespace === 'itunes') {
    return formatResolvedTrack(await lookupItunesTrackById(value, { signal }), baseUrl);
  }

  if (namespace === 'youtube') {
    return formatResolvedTrack(
      await inspectDirectLink(`https://www.youtube.com/watch?v=${value}`, settings, { signal }),
      baseUrl
    );
  }

  throw createHttpError(400, `Unsupported shared track namespace: ${namespace}.`);
}

module.exports = {
  parseSharedTrackId,
  resolveSharedTrack
};
