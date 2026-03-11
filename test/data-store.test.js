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
