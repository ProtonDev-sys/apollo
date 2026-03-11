const test = require('node:test');
const assert = require('node:assert/strict');

test('Spotify access tokens are cached across search requests', async () => {
  const originalFetch = global.fetch;
  const modulePath = require.resolve('../app/search-service');
  delete require.cache[modulePath];

  let tokenRequests = 0;
  let searchRequests = 0;

  global.fetch = async (url, options = {}) => {
    if (String(url).includes('accounts.spotify.com/api/token')) {
      tokenRequests += 1;
      return {
        ok: true,
        async json() {
          return {
            access_token: 'cached-token',
            expires_in: 3600
          };
        }
      };
    }

    if (String(url).includes('api.spotify.com/v1/search')) {
      searchRequests += 1;
      assert.equal(options.headers.Authorization, 'Bearer cached-token');
      return {
        ok: true,
        async json() {
          return {
            tracks: {
              total: 1,
              items: [
                {
                  id: `track-${searchRequests}`,
                  name: 'Track',
                  artists: [{ name: 'Artist' }],
                  album: {
                    name: 'Album',
                    images: [{ url: 'https://example.com/cover.jpg' }]
                  },
                  duration_ms: 180000,
                  external_urls: {
                    spotify: 'https://open.spotify.com/track/123'
                  },
                  external_ids: {
                    isrc: 'ISRC123'
                  }
                }
              ]
            }
          };
        }
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const { searchProviders } = require('../app/search-service');
    const settings = {
      ytDlpPath: 'yt-dlp',
      ffmpegPath: 'ffmpeg',
      spotifyClientId: 'client-id',
      spotifyClientSecret: 'client-secret'
    };

    await searchProviders({ query: 'first', provider: 'spotify' }, settings);
    await searchProviders({ query: 'second', provider: 'spotify' }, settings);

    assert.equal(tokenRequests, 1);
    assert.equal(searchRequests, 2);
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
  }
});
