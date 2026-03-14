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

test('Multi-provider search does not drop slower providers with an internal timeout', async () => {
  const originalFetch = global.fetch;
  const modulePath = require.resolve('../app/search-service');
  const binariesModulePath = require.resolve('../app/binaries');
  const originalBinariesModule = require.cache[binariesModulePath];
  delete require.cache[modulePath];
  delete require.cache[binariesModulePath];

  require.cache[binariesModulePath] = {
    id: binariesModulePath,
    filename: binariesModulePath,
    loaded: true,
    exports: {
      INSTALLABLE_DEPENDENCIES: {
        ytDlp: {
          binaryName: 'yt-dlp'
        }
      },
      resolveExecutablePath: async () => 'yt-dlp',
      runProcess: async () => {
        await new Promise((resolve) => setTimeout(resolve, 950));
        return {
          stdout: JSON.stringify({
            entries: [
              {
                id: 'soundcloud-track-1',
                title: 'Slow SoundCloud Result',
                uploader: 'Apollo Artist',
                duration: 215,
                webpage_url: 'https://soundcloud.com/apollo/slow-result',
                extractor_key: 'Soundcloud'
              }
            ]
          }),
          stderr: ''
        };
      }
    }
  };

  global.fetch = async (url, options = {}) => {
    if (String(url).includes('accounts.spotify.com/api/token')) {
      return {
        ok: true,
        async json() {
          return {
            access_token: 'slow-provider-token',
            expires_in: 3600
          };
        }
      };
    }

    if (String(url).includes('api.spotify.com/v1/search')) {
      assert.equal(options.headers.Authorization, 'Bearer slow-provider-token');
      return {
        ok: true,
        async json() {
          return {
            tracks: {
              total: 1,
              items: [
                {
                  id: 'spotify-track-1',
                  name: 'Fast Spotify Result',
                  artists: [{ name: 'Apollo Artist' }],
                  album: {
                    name: 'Apollo Album',
                    images: [{ url: 'https://example.com/spotify-cover.jpg' }]
                  },
                  duration_ms: 210000,
                  external_urls: {
                    spotify: 'https://open.spotify.com/track/spotify-track-1'
                  },
                  external_ids: {
                    isrc: 'ISRC12345678'
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

    const result = await searchProviders(
      { query: 'apollo song', provider: 'spotify,soundcloud', pageSize: 5 },
      settings
    );

    assert.equal(result.warning, '');
    assert.equal(result.items.length, 2);
    assert.ok(result.items.some((item) => item.provider === 'spotify'));
    assert.ok(result.items.some((item) => item.provider === 'soundcloud'));
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
    delete require.cache[binariesModulePath];
    if (originalBinariesModule) {
      require.cache[binariesModulePath] = originalBinariesModule;
    }
  }
});

test('Multi-provider search starts provider requests in parallel', async () => {
  const originalFetch = global.fetch;
  const modulePath = require.resolve('../app/search-service');
  const binariesModulePath = require.resolve('../app/binaries');
  const originalBinariesModule = require.cache[binariesModulePath];
  delete require.cache[modulePath];
  delete require.cache[binariesModulePath];

  let activeRequests = 0;
  let maxActiveRequests = 0;
  let releaseProviders;
  const providersReleased = new Promise((resolve) => {
    releaseProviders = resolve;
  });

  require.cache[binariesModulePath] = {
    id: binariesModulePath,
    filename: binariesModulePath,
    loaded: true,
    exports: {
      INSTALLABLE_DEPENDENCIES: {
        ytDlp: {
          binaryName: 'yt-dlp'
        }
      },
      resolveExecutablePath: async () => 'yt-dlp',
      runProcess: async () => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await providersReleased;
        activeRequests -= 1;
        return {
          stdout: JSON.stringify({
            entries: [
              {
                id: 'soundcloud-parallel-track',
                title: 'Parallel SoundCloud Result',
                uploader: 'Apollo Artist',
                duration: 215,
                webpage_url: 'https://soundcloud.com/apollo/parallel-result',
                extractor_key: 'Soundcloud'
              }
            ]
          }),
          stderr: ''
        };
      }
    }
  };

  global.fetch = async (url, options = {}) => {
    if (String(url).includes('accounts.spotify.com/api/token')) {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await providersReleased;
      activeRequests -= 1;
      return {
        ok: true,
        async json() {
          return {
            access_token: 'parallel-token',
            expires_in: 3600
          };
        }
      };
    }

    if (String(url).includes('api.spotify.com/v1/search')) {
      assert.equal(options.headers.Authorization, 'Bearer parallel-token');
      return {
        ok: true,
        async json() {
          return {
            tracks: {
              total: 1,
              items: [
                {
                  id: 'spotify-parallel-track',
                  name: 'Parallel Spotify Result',
                  artists: [{ name: 'Apollo Artist' }],
                  album: {
                    name: 'Apollo Album',
                    images: [{ url: 'https://example.com/parallel-cover.jpg' }]
                  },
                  duration_ms: 210000,
                  external_urls: {
                    spotify: 'https://open.spotify.com/track/spotify-parallel-track'
                  },
                  external_ids: {
                    isrc: 'ISRC87654321'
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

    const searchRequest = searchProviders(
      { query: 'apollo parallel', provider: 'spotify,soundcloud', pageSize: 5 },
      settings
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(maxActiveRequests, 2);

    releaseProviders();

    const result = await searchRequest;
    assert.ok(result.items.some((item) => item.provider === 'spotify'));
    assert.ok(result.items.some((item) => item.provider === 'soundcloud'));
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
    delete require.cache[binariesModulePath];
    if (originalBinariesModule) {
      require.cache[binariesModulePath] = originalBinariesModule;
    }
  }
});

test('searchProviders tolerates missing query input and returns an empty result', async () => {
  const { searchProviders } = require('../app/search-service');

  const result = await searchProviders(
    { provider: 'spotify', pageSize: '5' },
    {
      ytDlpPath: 'yt-dlp',
      ffmpegPath: 'ffmpeg'
    }
  );

  assert.deepEqual(result, {
    items: [],
    total: 0,
    page: 1,
    pageSize: 5,
    totalPages: 1,
    provider: ['spotify'],
    warning: ''
  });
});

test('inspectDirectLink rejects missing input with a user-facing validation error', async () => {
  const { inspectDirectLink } = require('../app/search-service');

  await assert.rejects(
    () =>
      inspectDirectLink(undefined, {
        ytDlpPath: 'yt-dlp',
        ffmpegPath: 'ffmpeg'
      }),
    (error) => {
      assert.equal(error.message, 'Enter a direct media link.');
      return true;
    }
  );
});
