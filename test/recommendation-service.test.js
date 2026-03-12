const test = require('node:test');
const assert = require('node:assert/strict');

function createRemoteTrack({
  id,
  provider = 'deezer',
  title,
  artist,
  album,
  genre = '',
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

test('getRecommendations uses session context to diversify away from repeated artists', async () => {
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
      searchDeezerArtists: async () => ({
        items: [{ id: 'seed-artist', name: 'Seed Artist' }]
      }),
      listDeezerArtistTopTracks: async () => ({
        items: [
          createRemoteTrack({
            id: 'seed-hit-1',
            title: 'Seed Artist Hit 1',
            artist: 'Seed Artist',
            album: 'Seed Album',
            genre: 'Indie Pop',
            duration: 201,
            artwork: 'https://example.com/artwork/seed-hit-1.jpg',
            providerIds: { deezer: 'seed-hit-1' }
          }),
          createRemoteTrack({
            id: 'seed-hit-2',
            title: 'Seed Artist Hit 2',
            artist: 'Seed Artist',
            album: 'Seed Album',
            genre: 'Indie Pop',
            duration: 203,
            artwork: 'https://example.com/artwork/seed-hit-2.jpg',
            providerIds: { deezer: 'seed-hit-2' }
          })
        ]
      }),
      searchItunesArtistTracksByName: async () => [
        createRemoteTrack({
          id: 'seed-itunes-1',
          provider: 'itunes',
          title: 'Seed Artist iTunes 1',
          artist: 'Seed Artist',
          album: 'Seed Album',
          genre: 'Indie Pop',
          duration: 204,
          providerIds: { itunes: 'seed-itunes-1' }
        })
      ],
      searchItunesTracks: async () => ({
        items: [
          createRemoteTrack({
            id: 'artist-b-discovery',
            provider: 'itunes',
            title: 'Discovery Lane',
            artist: 'Artist B',
            album: 'Elsewhere',
            genre: 'Indie Pop',
            duration: 199,
            providerIds: { itunes: 'artist-b-discovery' }
          }),
          createRemoteTrack({
            id: 'artist-c-discovery',
            provider: 'itunes',
            title: 'Night Drive',
            artist: 'Artist C',
            album: 'Elsewhere',
            genre: 'Indie Pop',
            duration: 202,
            providerIds: { itunes: 'artist-c-discovery' }
          })
        ]
      }),
      searchDeezerTracks: async () => ({
        items: [
          createRemoteTrack({
            id: 'artist-d-excluded',
            title: 'Pulse',
            artist: 'Artist D',
            album: 'Momentum',
            genre: 'Indie Pop',
            duration: 200,
            providerIds: { deezer: 'artist-d-excluded' }
          }),
          createRemoteTrack({
            id: 'artist-e-discovery',
            title: 'Moonwake',
            artist: 'Artist E',
            album: 'Orbit',
            genre: 'Indie Pop',
            duration: 205,
            providerIds: { deezer: 'artist-e-discovery' }
          })
        ]
      })
    }
  };

  try {
    const { getRecommendations } = require('../app/recommendation-service');
    const store = {
      getTrack: () => null,
      listTracks: ({ query }) => ({
        items: String(query).includes('Seed')
          ? [
              {
                id: 'library-seed-artist',
                filePath: 'C:/Apollo/library/seed-artist.mp3',
                title: 'Seed Artist Library Cut',
                artist: 'Seed Artist',
                album: 'Seed Album',
                genre: 'Indie Pop',
                duration: 198,
                providerIds: {}
              },
              {
                id: 'library-artist-b',
                filePath: 'C:/Apollo/library/artist-b.mp3',
                title: 'Skyline',
                artist: 'Artist B',
                album: 'Elsewhere',
                genre: 'Indie Pop',
                duration: 200,
                providerIds: {}
              }
            ]
          : []
      })
    };

    const result = await getRecommendations(
      {
        title: 'Seed Song',
        artist: 'Seed Artist',
        album: 'Seed Album',
        genre: 'Indie Pop',
        duration: 200,
        limit: 4,
        recentTracks: [
          { title: 'Recent Seed Song', artist: 'Seed Artist', album: 'Seed Album', genre: 'Indie Pop', duration: 197 }
        ],
        upcomingTracks: [
          { title: 'Queued Seed Song', artist: 'Seed Artist', album: 'Seed Album', genre: 'Indie Pop', duration: 203 }
        ],
        excludedTracks: [
          { title: 'Pulse', artist: 'Artist D', album: 'Momentum', genre: 'Indie Pop', duration: 200, providerIds: { deezer: 'artist-d-excluded' } }
        ]
      },
      store,
      'http://127.0.0.1:4848'
    );

    assert.equal(result.items.length, 4);
    assert.notEqual(result.items[0].artist, 'Seed Artist');
    assert.ok(new Set(result.items.slice(0, 3).map((item) => item.artist)).size >= 2);
    assert.ok(!result.items.some((item) => item.providerIds?.deezer === 'artist-d-excluded'));
  } finally {
    delete require.cache[recommendationModulePath];
    delete require.cache[metadataModulePath];
    if (originalMetadataModule) {
      require.cache[metadataModulePath] = originalMetadataModule;
    }
  }
});
