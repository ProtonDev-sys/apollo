const path = require('path');
const { resolveExecutablePath, INSTALLABLE_DEPENDENCIES, runProcess } = require('./binaries');
const { normalizeTrackMetadata } = require('./metadata-normalizer');

function buildSiblingExecutablePath(binaryPath, executableName) {
  if (!binaryPath) {
    return executableName;
  }

  const extension =
    process.platform === 'win32' && !executableName.endsWith('.exe')
      ? `${executableName}.exe`
      : executableName;
  return path.join(path.dirname(binaryPath), extension);
}

async function resolveFfprobePath(settings = {}) {
  const ffmpegPath = await resolveExecutablePath(
    settings.ffmpegPath,
    INSTALLABLE_DEPENDENCIES.ffmpeg.binaryName
  );

  try {
    await runProcess(buildSiblingExecutablePath(ffmpegPath, 'ffprobe'), ['-version']);
    return buildSiblingExecutablePath(ffmpegPath, 'ffprobe');
  } catch (error) {
    return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  }
}

function normaliseTagLookup(tags = {}) {
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [String(key || '').toLowerCase(), value])
  );
}

async function readAudioMetadata(filePath, settings) {
  try {
    const ffprobePath = await resolveFfprobePath(settings);
    const { stdout } = await runProcess(ffprobePath, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);
    const payload = JSON.parse(stdout);
    const formatTags = normaliseTagLookup(payload.format?.tags || {});
    const audioStream = (payload.streams || []).find((stream) => stream.codec_type === 'audio') || {};
    const streamTags = normaliseTagLookup(audioStream.tags || {});
    const combinedTags = {
      ...formatTags,
      ...streamTags
    };

    return normalizeTrackMetadata({
      provider: 'library',
      title: combinedTags.title || '',
      artist: combinedTags.artist || '',
      artists: combinedTags.artist ? String(combinedTags.artist).split(/\s*,\s*/) : [],
      album: combinedTags.album || '',
      albumArtist:
        combinedTags.album_artist ||
        combinedTags.albumartist ||
        combinedTags['album artist'] ||
        '',
      trackNumber: combinedTags.track || combinedTags.tracknumber || '',
      discNumber: combinedTags.disc || combinedTags.discnumber || '',
      duration: payload.format?.duration || audioStream.duration || null,
      releaseDate: combinedTags.date || combinedTags.year || combinedTags.originaldate || '',
      releaseYear: combinedTags.year || '',
      genre: combinedTags.genre || '',
      explicit: combinedTags.explicit || '',
      isrc: combinedTags.isrc || '',
      metadataSource: 'embedded-tags'
    });
  } catch (error) {
    return normalizeTrackMetadata({
      provider: 'library',
      metadataSource: 'path-fallback'
    });
  }
}

async function writeAudioMetadata(sourcePath, metadata, ffmpegPath) {
  const normalized = normalizeTrackMetadata(metadata);
  const args = ['-y', '-i', sourcePath, '-map', '0', '-codec', 'copy'];
  const metadataPairs = [
    ['title', normalized.title],
    ['artist', normalized.artist],
    ['album', normalized.album],
    ['album_artist', normalized.albumArtist],
    ['track', normalized.trackNumber ? String(normalized.trackNumber) : ''],
    ['disc', normalized.discNumber ? String(normalized.discNumber) : ''],
    ['date', normalized.releaseDate || (normalized.releaseYear ? String(normalized.releaseYear) : '')],
    ['genre', normalized.genre],
    ['isrc', normalized.isrc]
  ];

  for (const [key, value] of metadataPairs) {
    if (!String(value || '').trim()) {
      continue;
    }

    args.push('-metadata', `${key}=${value}`);
  }

  if (args.length === 6) {
    return;
  }

  const tempPath = path.join(
    path.dirname(sourcePath),
    `${path.basename(sourcePath, path.extname(sourcePath))}.tagged${path.extname(sourcePath)}`
  );

  await runProcess(ffmpegPath, [...args, tempPath]);
  await require('fs/promises').rm(sourcePath, { force: true });
  await require('fs/promises').rename(tempPath, sourcePath);
}

module.exports = {
  readAudioMetadata,
  writeAudioMetadata,
  resolveFfprobePath
};
