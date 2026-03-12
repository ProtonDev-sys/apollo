const test = require('node:test');
const assert = require('node:assert/strict');

function createRemoteTrack({
  id,
  provider = 'deezer',
  title,
  artist,
  album,
  genre,
  duration,
  artwork = '',
  providerIds = {}
}) {
  return {
    id,
    provider,
    title,
    artist,
    album,
    genre,
    duration,
    artwork,
    providerIds,
    externalUrl: `https://example.com/${provider}/${id}`,
    downloadTarget: `https://example.com/${provider}/${id}`
  };
}

test('getRecommendations prioritises tracks that match the queue genre profile', async () => {
  const recommendationModulePath = require.resolve('../app/recommendation-service');
  const metadataModulePath = require.resolve('../app/public-metadata-service');
  const originalMetadataModule = require.cache[metadataModulePath];
  delete require.cache[recommendationModulePath];
  delete require.cache[metadataModulePath];

  require.cache[metadataModulePath] = {
    id: metadataModulePath,
    filename: metadataModulePath,
    loaded: true,
    exports: {
      searchDeezerArtists: async () => ({ items: [] }),
      listDeezerArtistTopTracks: async () => ({ items: [] }),
      searchItunesArtistTracksByName: async () => [],
      searchItunesTracks: async () => ({ items: [] }),
      searchDeezerTracks: async () => ({
        items: [
          createRemoteTrack({
            id: 'metal-detour',
            title: 'Steel Avenue',
            artist: 'Artist Metal',
            album: 'Detours',
            genre: 'Heavy Metal',
            duration: 201,
            providerIds: { deezer: 'metal-detour' }
          }),
          createRemoteTrack({
            id: 'house-lock',
            title: 'Club Circuit',
            artist: 'Artist House',
            album: 'After Hours',
            genre: 'French House',
            duration: 202,
            providerIds: { deezer: 'house-lock' }
          })
        ]
      })
    }
  };

  try {
    const { getRecommendations } = require('../app/recommendation-service');
    const result = await getRecommendations(
      {
        title: 'Seed Song',
        artist: 'Seed Artist',
        album: 'Seed Album',
        genre: 'French House, Electronic',
        duration: 200,
        limit: 2,
        recentTracks: [
          { title: 'Recent Club Cut', artist: 'Artist Queue A', genre: 'House', duration: 198 }
        ],
        upcomingTracks: [
          { title: 'Queued Night Drive', artist: 'Artist Queue B', genre: 'Electronic', duration: 204 }
        ]
      },
      {
        getTrack: () => null,
        listTracks: () => ({ items: [] })
      },
      'http://127.0.0.1:4848'
    );

    assert.ok(result.items.length >= 1);
    assert.equal(result.items[0].artist, 'Artist House');
    assert.equal(result.items[0].genre, 'French House');
    assert.ok(!result.items.some((item) => item.artist === 'Artist Metal'));
  } finally {
    delete require.cache[recommendationModulePath];
    delete require.cache[metadataModulePath];
    if (originalMetadataModule) {
      require.cache[metadataModulePath] = originalMetadataModule;
    }
  }
});

test('getRecommendations rejects same-title homonyms from different artists', async () => {
  const recommendationModulePath = require.resolve('../app/recommendation-service');
  const metadataModulePath = require.resolve('../app/public-metadata-service');
  const originalMetadataModule = require.cache[metadataModulePath];
  delete require.cache[recommendationModulePath];
  delete require.cache[metadataModulePath];

  require.cache[metadataModulePath] = {
    id: metadataModulePath,
    filename: metadataModulePath,
    loaded: true,
    exports: {
      searchDeezerArtists: async () => ({ items: [] }),
      listDeezerArtistTopTracks: async () => ({ items: [] }),
      searchItunesArtistTracksByName: async () => [],
      searchItunesTracks: async () => ({
        items: [
          createRemoteTrack({
            id: 'wrong-homonym',
            provider: 'itunes',
            title: 'Pardon Me',
            artist: 'Different Artist',
            album: 'Wrong Turn',
            genre: 'Blues',
            duration: 220,
            providerIds: { itunes: 'wrong-homonym' }
          }),
          createRemoteTrack({
            id: 'correct-lane',
            provider: 'itunes',
            title: 'Midnight Receiver',
            artist: '49 Winchester',
            album: 'Fortune Favors the Bold',
            genre: 'Country Rock',
            duration: 241,
            providerIds: { itunes: 'correct-lane' }
          })
        ]
      }),
      searchDeezerTracks: async () => ({
        items: [
          createRemoteTrack({
            id: 'country-alt',
            title: 'Backroad Bloom',
            artist: 'The Red Clay Strays',
            album: 'Made by These Moments',
            genre: 'Country Rock',
            duration: 236,
            providerIds: { deezer: 'country-alt' }
          })
        ]
      })
    }
  };

  try {
    const { getRecommendations } = require('../app/recommendation-service');
    const result = await getRecommendations(
      {
        title: 'Pardon Me',
        artist: '49 Winchester',
        album: 'Leavin This Holler',
        genre: 'Country Rock, Americana',
        duration: 244,
        limit: 3,
        recentTracks: [
          { title: 'Anchor Song', artist: '49 Winchester', genre: 'Country Rock', duration: 230 }
        ]
      },
      {
        getTrack: () => null,
        listTracks: () => ({ items: [] })
      },
      'http://127.0.0.1:4848'
    );

    assert.ok(result.items.length >= 1);
    assert.ok(!result.items.some((item) => item.title === 'Pardon Me' && item.artist !== '49 Winchester'));
    assert.ok(result.items.some((item) => item.artist === '49 Winchester' || item.artist === 'The Red Clay Strays'));
  } finally {
    delete require.cache[recommendationModulePath];
    delete require.cache[metadataModulePath];
    if (originalMetadataModule) {
      require.cache[metadataModulePath] = originalMetadataModule;
    }
  }
});
