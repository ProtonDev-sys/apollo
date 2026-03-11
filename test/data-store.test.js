const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { DataStore, createDefaultSettings } = require('../app/data-store');

test('DataStore allows clearing optional provider credentials and binary paths', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apollo-data-store-'));
  const defaultSettings = createDefaultSettings(path.join(baseDir, 'music-root'));
  const store = new DataStore({
    baseDir,
    defaultSettings
  });

  try {
    await store.init();
    await store.updateSettings({
      ytDlpPath: 'C:/tools/yt-dlp.exe',
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      spotifyClientId: 'client-id',
      spotifyClientSecret: 'client-secret',
      serverHost: '127.0.0.1'
    });

    const updated = await store.updateSettings({
      ytDlpPath: '',
      ffmpegPath: '',
      spotifyClientId: '',
      spotifyClientSecret: '',
      serverHost: ''
    });

    assert.equal(updated.ytDlpPath, '');
    assert.equal(updated.ffmpegPath, '');
    assert.equal(updated.spotifyClientId, '');
    assert.equal(updated.spotifyClientSecret, '');
    assert.equal(updated.serverHost, '127.0.0.1');

    const persistedConfig = JSON.parse(
      await fs.readFile(path.join(baseDir, 'config.json'), 'utf8')
    );
    assert.equal(persistedConfig.settings.ytDlpPath, '');
    assert.equal(persistedConfig.settings.spotifyClientId, '');
    assert.equal(persistedConfig.settings.serverHost, '127.0.0.1');
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('DataStore links imported playlist entries to matching tracks and preserves remote metadata when tracks are removed', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apollo-data-store-'));
  const defaultSettings = createDefaultSettings(path.join(baseDir, 'music-root'));
  const store = new DataStore({
    baseDir,
    defaultSettings
  });

  try {
    await store.init();
    const track = await store.upsertTrack({
      id: 'track-1',
      title: 'One More Time',
      artist: 'Daft Punk',
      album: 'Discovery',
      albumArtist: 'Daft Punk',
      trackNumber: 1,
      discNumber: 1,
      releaseDate: '2001-11-30',
      genre: 'House',
      explicit: false,
      provider: 'youtube',
      sourcePlatform: 'youtube',
      providerIds: {
        youtube: 'yt-123',
        isrc: 'FRZ110000001'
      },
      sourceUrl: 'https://www.youtube.com/watch?v=yt-123',
      filePath: path.join(baseDir, 'library', 'Daft Punk', 'Discovery', 'One More Time.mp3')
    });

    const playlist = await store.createPlaylist({
      name: 'Imported',
      sourcePlatform: 'spotify',
      sourcePlaylistId: 'playlist-1',
      sourceUrl: 'https://open.spotify.com/playlist/playlist-1',
      entries: [
        {
          sourceTrack: {
            id: 'spotify:track-1',
            provider: 'spotify',
            sourcePlatform: 'spotify',
            title: 'One More Time',
            artist: 'Daft Punk',
            album: 'Discovery',
            albumArtist: 'Daft Punk',
            trackNumber: 1,
            discNumber: 1,
            releaseDate: '2001-11-30',
            providerIds: {
              spotify: 'track-1',
              isrc: 'FRZ110000001'
            },
            externalUrl: 'https://open.spotify.com/track/track-1'
          }
        }
      ]
    });

    assert.equal(playlist.entries.length, 1);
    assert.equal(playlist.entries[0].trackId, track.id);
    assert.equal(playlist.entries[0].track.title, 'One More Time');

    await store.deleteTrack(track.id);
    const updatedPlaylist = store.getPlaylist(playlist.id);
    assert.equal(updatedPlaylist.entries.length, 1);
    assert.equal(updatedPlaylist.entries[0].trackId, '');
    assert.equal(updatedPlaylist.entries[0].track.title, 'One More Time');
    assert.equal(updatedPlaylist.entries[0].track.provider, 'spotify');
    assert.equal(updatedPlaylist.entries[0].track.isrc, 'FRZ110000001');
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
