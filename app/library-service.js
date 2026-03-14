const fs = require('fs/promises');
const path = require('path');
const { createHttpError } = require('./http-error');
const { readAudioMetadata } = require('./file-metadata-service');
const { resolveDownloadMetadata } = require('./search-service');
const { mergeTrackMetadata, hasWeakTrackMetadata, normalizeTrackMetadata } = require('./metadata-normalizer');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.opus']);

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function sanitiseSegment(value, fallback) {
  const cleaned = (value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\.+$/g, '')
    .trim();
  return cleaned || fallback;
}

async function walkAudioFiles(rootPath) {
  const results = [];
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkAudioFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && isAudioFile(entryPath)) {
      results.push(entryPath);
    }
  }

  return results;
}

function inferTrackFromPath(libraryDirectory, filePath) {
  const relativeDirectory = path.dirname(path.relative(libraryDirectory, filePath));
  const parts = relativeDirectory.split(path.sep).filter(Boolean);
  const title = path.basename(filePath, path.extname(filePath));

  return normalizeTrackMetadata({
    title,
    artist: parts[0] || 'Unknown Artist',
    album: parts[1] || 'Singles',
    provider: 'library',
    metadataSource: 'path-fallback'
  });
}

async function ensureUniquePath(targetPath) {
  const directory = path.dirname(targetPath);
  const extension = path.extname(targetPath);
  const baseName = path.basename(targetPath, extension);

  let attempt = 0;
  let nextPath = targetPath;

  while (true) {
    try {
      await fs.access(nextPath);
      attempt += 1;
      nextPath = path.join(directory, `${baseName} (${attempt})${extension}`);
    } catch (error) {
      return nextPath;
    }
  }
}

async function removeEmptyParentDirectories(startDirectory, stopDirectory) {
  const resolvedStopDirectory = path.resolve(stopDirectory);
  let currentDirectory = path.resolve(startDirectory);
  const isWithinStopDirectory = (targetPath) => {
    const relativePath = path.relative(resolvedStopDirectory, targetPath);
    return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
  };

  while (isWithinStopDirectory(currentDirectory)) {
    const entries = await fs.readdir(currentDirectory);
    if (entries.length) {
      return;
    }

    await fs.rmdir(currentDirectory);
    currentDirectory = path.dirname(currentDirectory);
  }
}

function shouldRepairStoredTrack(track) {
  return (
    hasWeakTrackMetadata(track) &&
    Boolean(track.sourceUrl || track.externalUrl || track.downloadTarget || track.providerIds)
  );
}

async function moveFile(sourcePath, targetPath) {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw error;
    }

    // Cross-device moves need a copy/unlink fallback when staging and
    // library directories live on different volumes.
    await fs.copyFile(sourcePath, targetPath);
    await fs.unlink(sourcePath);
  }
}

class LibraryService {
  constructor(store) {
    this.store = store;
  }

  async hydrateTrackFromFile(libraryDirectory, filePath, settings, existingTrack) {
    const inferredTrack = inferTrackFromPath(libraryDirectory, filePath);
    const embeddedTrack = await readAudioMetadata(filePath, settings);
    let nextTrack = mergeTrackMetadata(inferredTrack, existingTrack || {});
    nextTrack = mergeTrackMetadata(nextTrack, embeddedTrack);

    nextTrack = {
      ...nextTrack,
      filePath,
      fileName: path.basename(filePath),
      provider: existingTrack?.provider || nextTrack.sourcePlatform || 'library',
      sourcePlatform: existingTrack?.sourcePlatform || nextTrack.sourcePlatform || 'library',
      sourceUrl: nextTrack.sourceUrl || existingTrack?.sourceUrl || '',
      externalUrl: nextTrack.externalUrl || existingTrack?.externalUrl || '',
      artwork: nextTrack.artwork || existingTrack?.artwork || '',
      providerIds: nextTrack.providerIds || existingTrack?.providerIds || {},
      isrc: nextTrack.isrc || existingTrack?.isrc || '',
      metadataSource: nextTrack.metadataSource || existingTrack?.metadataSource || 'library'
    };

    if (shouldRepairStoredTrack(nextTrack)) {
      try {
        const repaired = await resolveDownloadMetadata(
          {
            ...nextTrack,
            provider: nextTrack.sourcePlatform || nextTrack.provider || 'link',
            externalUrl: nextTrack.externalUrl || nextTrack.sourceUrl || '',
            sourceUrl: nextTrack.sourceUrl || ''
          },
          settings
        );
        nextTrack = {
          ...nextTrack,
          ...mergeTrackMetadata(nextTrack, repaired),
          providerIds: repaired.providerIds || nextTrack.providerIds || {},
          isrc: repaired.isrc || nextTrack.isrc || '',
          artwork: repaired.artwork || nextTrack.artwork || '',
          sourceUrl: nextTrack.sourceUrl || repaired.sourceUrl || repaired.externalUrl || '',
          sourcePlatform: nextTrack.sourcePlatform || repaired.sourcePlatform || repaired.provider || 'library',
          metadataSource: repaired.metadataSource || nextTrack.metadataSource || 'library'
        };
      } catch (error) {
        // Keep the best local metadata if repair fails.
      }
    }

    return {
      ...nextTrack,
      filePath,
      fileName: path.basename(filePath)
    };
  }

  async syncLibrary(libraryDirectory, settings = {}) {
    await fs.mkdir(libraryDirectory, { recursive: true });
    const files = await walkAudioFiles(libraryDirectory);
    const storedTracks = this.store.getState ? this.store.getState().tracks || [] : [];
    const existingTracks = new Map(
      storedTracks.map((track) => [
        String(track.filePath || '').toLowerCase(),
        track
      ])
    );
    const discoveredTracks = [];

    for (const filePath of files) {
      discoveredTracks.push(
        await this.hydrateTrackFromFile(
          libraryDirectory,
          filePath,
          settings,
          existingTracks.get(filePath.toLowerCase()) || null
        )
      );
    }

    await this.store.upsertTracks(discoveredTracks);
    await this.store.removeTracksMissingFromPaths(files);
    return this.store.listTracks({ page: 1, pageSize: 8 });
  }

  async importDownloadedFile(sourcePath, metadata, libraryDirectory, settings = {}) {
    const normalizedMetadata = normalizeTrackMetadata(metadata);
    const artist = sanitiseSegment(normalizedMetadata.artist, 'Unknown Artist');
    const album = sanitiseSegment(normalizedMetadata.album, 'Singles');
    const title = sanitiseSegment(normalizedMetadata.title, 'Unknown Title');
    const extension = path.extname(sourcePath) || '.mp3';
    const artistDirectory = path.join(libraryDirectory, artist, album);

    await fs.mkdir(artistDirectory, { recursive: true });
    const targetPath = await ensureUniquePath(path.join(artistDirectory, `${title}${extension}`));
    await moveFile(sourcePath, targetPath);

    const hydratedTrack = await this.hydrateTrackFromFile(libraryDirectory, targetPath, settings, {
      ...metadata,
      ...normalizedMetadata,
      provider: metadata.provider || normalizedMetadata.sourcePlatform || 'library',
      sourcePlatform: metadata.sourcePlatform || metadata.provider || normalizedMetadata.sourcePlatform || 'library'
    });

    return this.store.upsertTrack(hydratedTrack);
  }

  async deleteTrack(trackId, libraryDirectory) {
    const track = this.store.getTrack(trackId);
    if (!track) {
      throw createHttpError(404, 'Track not found.');
    }

    if (track.filePath) {
      await fs.rm(track.filePath, { force: true });
      await removeEmptyParentDirectories(path.dirname(track.filePath), libraryDirectory);
    }

    return this.store.deleteTrack(trackId);
  }
}

module.exports = {
  LibraryService
};
