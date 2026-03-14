const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

test('LibraryService deleteTrack does not prune sibling directories outside the library root', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apollo-library-service-'));
  const libraryDirectory = path.join(baseDir, 'Apollo');
  const siblingDirectory = path.join(baseDir, 'ApolloOld', 'Artist', 'Album');
  const trackPath = path.join(siblingDirectory, 'Track.mp3');

  await fs.mkdir(siblingDirectory, { recursive: true });
  await fs.writeFile(trackPath, 'fixture', 'utf8');

  const deletions = [];
  const { LibraryService } = require('../app/library-service');
  const service = new LibraryService({
    getTrack(trackId) {
      if (trackId !== 'track-1') {
        return null;
      }

      return {
        id: 'track-1',
        filePath: trackPath
      };
    },
    async deleteTrack(trackId) {
      deletions.push(trackId);
      return {
        ok: true,
        id: trackId
      };
    }
  });

  try {
    await service.deleteTrack('track-1', libraryDirectory);

    await assert.rejects(() => fs.access(trackPath));
    await fs.access(path.join(baseDir, 'ApolloOld'));
    assert.deepEqual(deletions, ['track-1']);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('LibraryService importDownloadedFile falls back to copy/unlink on cross-device moves', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apollo-library-service-'));
  const sourcePath = path.join(baseDir, 'incoming', 'Track.mp3');
  const libraryDirectory = path.join(baseDir, 'library');
  const fileMetadataModulePath = require.resolve('../app/file-metadata-service');
  const libraryServiceModulePath = require.resolve('../app/library-service');
  const originalFileMetadataModule = require.cache[fileMetadataModulePath];
  const originalLibraryServiceModule = require.cache[libraryServiceModulePath];
  const fsPromises = require('fs/promises');
  const originalRename = fsPromises.rename;

  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, 'fixture', 'utf8');

  delete require.cache[fileMetadataModulePath];
  delete require.cache[libraryServiceModulePath];
  require.cache[fileMetadataModulePath] = {
    id: fileMetadataModulePath,
    filename: fileMetadataModulePath,
    loaded: true,
    exports: {
      readAudioMetadata: async () => ({})
    }
  };

  fsPromises.rename = async () => {
    const error = new Error('Cross-device link not permitted');
    error.code = 'EXDEV';
    throw error;
  };

  try {
    const { LibraryService } = require('../app/library-service');
    const upserts = [];
    const service = new LibraryService({
      getState: () => ({ tracks: [] }),
      upsertTrack: async (track) => {
        upserts.push(track);
        return track;
      }
    });

    const importedTrack = await service.importDownloadedFile(
      sourcePath,
      {
        title: 'Track',
        artist: 'Artist',
        album: 'Album'
      },
      libraryDirectory
    );

    const expectedPath = path.join(libraryDirectory, 'Artist', 'Album', 'Track.mp3');
    await fs.access(expectedPath);
    await assert.rejects(() => fs.access(sourcePath));
    assert.equal(importedTrack.filePath, expectedPath);
    assert.equal(upserts.length, 1);
  } finally {
    fsPromises.rename = originalRename;

    delete require.cache[fileMetadataModulePath];
    if (originalFileMetadataModule) {
      require.cache[fileMetadataModulePath] = originalFileMetadataModule;
    }

    delete require.cache[libraryServiceModulePath];
    if (originalLibraryServiceModule) {
      require.cache[libraryServiceModulePath] = originalLibraryServiceModule;
    }

    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
