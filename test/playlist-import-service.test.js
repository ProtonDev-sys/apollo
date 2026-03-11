const test = require('node:test');
const assert = require('node:assert/strict');

test('Spotify playlist import returns playlist metadata and ordered enriched track entries', async () => {
  const originalFetch = global.fetch;
  const modulePath = require.resolve('../app/playlist-import-service');
  const searchModulePath = require.resolve('../app/search-service');
  delete require.cache[modulePath];
  delete require.cache[searchModulePath];

  global.fetch = async (url) => {
    if (String(url).includes('accounts.spotify.com/api/token')) {
      return {
        ok: true,
        async json() {
          return {
            access_token: 'playlist-token',
            expires_in: 3600
          };
        }
      };
    }

    if (String(url) === 'https://api.spotify.com/v1/playlists/playlist123') {
      return {
        ok: true,
        async json() {
          return {
            id: 'playlist123',
            name: 'Imported Playlist',
            description: 'A <b>great</b> playlist',
            snapshot_id: 'snapshot-1',
            external_urls: {
              spotify: 'https://open.spotify.com/playlist/playlist123'
            },
            owner: {
              display_name: 'Apollo Tester'
            },
            images: [{ url: 'https://example.com/playlist-cover.jpg' }]
          };
        }
      };
    }

    if (String(url) === 'https://api.spotify.com/v1/playlists/playlist123/tracks?limit=100') {
      return {
        ok: true,
        async json() {
          return {
            items: [
              {
                is_local: false,
                track: {
                  id: 'track-1',
                  name: 'Track Name',
                  artists: [{ name: 'Artist Name' }],
                  album: {
                    name: 'Album Name',
                    release_date: '2023-02-03',
                    artists: [{ name: 'Artist Name' }],
                    images: [{ url: 'https://example.com/album-cover.jpg' }]
                  },
                  track_number: 4,
                  disc_number: 1,
                  duration_ms: 180000,
                  explicit: true,
                  external_urls: {
                    spotify: 'https://open.spotify.com/track/track-1'
                  },
                  external_ids: {
                    isrc: 'ISRC12345678'
                  }
                }
              }
            ],
            next: null
          };
        }
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const { importPlaylistFromUrl } = require('../app/playlist-import-service');
    const playlist = await importPlaylistFromUrl(
      'https://open.spotify.com/playlist/playlist123',
      {
        spotifyClientId: 'client-id',
        spotifyClientSecret: 'client-secret'
      }
    );

    assert.equal(playlist.name, 'Imported Playlist');
    assert.equal(playlist.description, 'A great playlist');
    assert.equal(playlist.sourcePlatform, 'spotify');
    assert.equal(playlist.sourcePlaylistId, 'playlist123');
    assert.equal(playlist.ownerName, 'Apollo Tester');
    assert.equal(playlist.entries.length, 1);
    assert.equal(playlist.entries[0].order, 0);
    assert.equal(playlist.entries[0].sourceTrack.title, 'Track Name');
    assert.equal(playlist.entries[0].sourceTrack.album, 'Album Name');
    assert.equal(playlist.entries[0].sourceTrack.trackNumber, 4);
    assert.equal(playlist.entries[0].sourceTrack.releaseDate, '2023-02-03');
    assert.equal(playlist.entries[0].sourceTrack.explicit, true);
    assert.equal(playlist.entries[0].sourceTrack.isrc, 'ISRC12345678');
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
    delete require.cache[searchModulePath];
  }
});
