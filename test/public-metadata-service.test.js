const test = require('node:test');
const assert = require('node:assert/strict');

test('searchItunesTracks reports totalPages from the API total, not the current page', async () => {
  const originalFetch = global.fetch;
  const modulePath = require.resolve('../app/public-metadata-service');
  delete require.cache[modulePath];

  global.fetch = async (url) => {
    assert.match(String(url), /itunes\.apple\.com\/search/);
    return {
      ok: true,
      async json() {
        return {
          resultCount: 8,
          results: [
            {
              trackId: 2001,
              trackName: 'Apollo Track',
              artistName: 'Apollo Artist',
              collectionName: 'Apollo Album',
              trackTimeMillis: 180000,
              trackViewUrl: 'https://music.apple.com/us/album/apollo-track/id2001',
              artworkUrl100: 'https://example.com/apollo-track.jpg'
            }
          ]
        };
      }
    };
  };

  try {
    const { searchItunesTracks } = require('../app/public-metadata-service');
    const result = await searchItunesTracks({
      query: 'apollo',
      page: 2,
      pageSize: 3
    });

    assert.equal(result.total, 8);
    assert.equal(result.page, 2);
    assert.equal(result.pageSize, 3);
    assert.equal(result.totalPages, 3);
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
  }
});
