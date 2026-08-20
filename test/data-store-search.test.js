const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { DataStore, createDefaultSettings } = require('../app/data-store');

async function createStore() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apollo-search-store-'));
  const store = new DataStore({
    baseDir,
    defaultSettings: createDefaultSettings(path.join(baseDir, 'music-root'))
  });
  await store.init();
  return { baseDir, store };
}

test('library search ranks title and artist matches above incidental metadata matches', async () => {
  const { baseDir, store } = await createStore();

  try {
    await store.upsertTracks([
      {
        id: 'incidental',
        title: 'Tribute Mix',
        artist: 'Other Artist',
        album: 'Daft Punk One More Time Collection',
        filePath: path.join(baseDir, 'incidental.mp3'),
        addedAt: '2026-01-03T00:00:00.000Z'
      },
      {
        id: 'correct',
        title: 'One More Time',
        artist: 'Daft Punk',
        album: 'Discovery',
        filePath: path.join(baseDir, 'correct.mp3'),
        addedAt: '2001-01-01T00:00:00.000Z'
      },
      {
        id: 'artist-only',
        title: 'Aerodynamic',
        artist: 'Daft Punk',
        album: 'Discovery',
        filePath: path.join(baseDir, 'artist-only.mp3'),
        addedAt: '2026-01-04T00:00:00.000Z'
      }
    ]);

    const result = store.listTracks({
      query: 'daft punk one more time',
      pageSize: 20
    });

    assert.equal(result.items[0].id, 'correct');
    assert.equal(result.total, 2);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('library search is accent-insensitive and supports short tokens', async () => {
  const { baseDir, store } = await createStore();

  try {
    await store.upsertTracks([
      {
        id: 'beyonce',
        title: 'Halo',
        artist: 'Beyoncé',
        filePath: path.join(baseDir, 'halo.mp3')
      },
      {
        id: 'u2',
        title: 'One',
        artist: 'U2',
        filePath: path.join(baseDir, 'one.mp3')
      }
    ]);

    assert.deepEqual(
      store.listTracks({ query: 'beyonce halo' }).items.map((item) => item.id),
      ['beyonce']
    );
    assert.deepEqual(
      store.listTracks({ query: 'u2 one' }).items.map((item) => item.id),
      ['u2']
    );
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('library search index updates on upsert and delete', async () => {
  const { baseDir, store } = await createStore();

  try {
    await store.upsertTrack({
      id: 'track',
      title: 'Old Name',
      artist: 'Artist',
      filePath: path.join(baseDir, 'track.mp3')
    });
    assert.equal(store.listTracks({ query: 'old name' }).total, 1);

    await store.upsertTrack({
      id: 'track',
      title: 'New Name',
      artist: 'Artist',
      filePath: path.join(baseDir, 'track.mp3')
    });
    assert.equal(store.listTracks({ query: 'old name' }).total, 0);
    assert.equal(store.listTracks({ query: 'new name' }).total, 1);

    await store.deleteTrack('track');
    assert.equal(store.listTracks({ query: 'new name' }).total, 0);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('empty library queries retain newest-added ordering', async () => {
  const { baseDir, store } = await createStore();

  try {
    await store.upsertTracks([
      {
        id: 'older',
        title: 'Older',
        artist: 'Artist',
        filePath: path.join(baseDir, 'older.mp3'),
        addedAt: '2024-01-01T00:00:00.000Z'
      },
      {
        id: 'newer',
        title: 'Newer',
        artist: 'Artist',
        filePath: path.join(baseDir, 'newer.mp3'),
        addedAt: '2025-01-01T00:00:00.000Z'
      }
    ]);

    assert.deepEqual(
      store.listTracks({ pageSize: 20 }).items.map((item) => item.id),
      ['newer', 'older']
    );
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
