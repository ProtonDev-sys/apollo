const fs = require('fs/promises');
const path = require('path');

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

  return {
    title,
    artist: parts[0] || 'Unknown Artist',
    album: parts[1] || 'Singles'
  };
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

class LibraryService {
  constructor(store) {
    this.store = store;
  }

  async syncLibrary(libraryDirectory) {
    await fs.mkdir(libraryDirectory, { recursive: true });
    const files = await walkAudioFiles(libraryDirectory);

    for (const filePath of files) {
      const inferred = inferTrackFromPath(libraryDirectory, filePath);
      await this.store.upsertTrack({
        ...inferred,
        filePath,
        provider: 'library'
      });
    }

    await this.store.removeTracksMissingFromPaths(files);
    return this.store.listTracks({ page: 1, pageSize: 8 });
  }

  async importDownloadedFile(sourcePath, metadata, libraryDirectory) {
    const artist = sanitiseSegment(metadata.artist, 'Unknown Artist');
    const album = sanitiseSegment(metadata.album, 'Singles');
    const title = sanitiseSegment(metadata.title, 'Unknown Title');
    const extension = path.extname(sourcePath) || '.mp3';
    const artistDirectory = path.join(libraryDirectory, artist, album);

    await fs.mkdir(artistDirectory, { recursive: true });
    const targetPath = await ensureUniquePath(path.join(artistDirectory, `${title}${extension}`));
    await fs.rename(sourcePath, targetPath);

    return this.store.upsertTrack({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      duration: metadata.duration,
      provider: metadata.provider,
      sourceUrl: metadata.sourceUrl,
      filePath: targetPath
    });
  }
}

module.exports = {
  LibraryService
};
