const test = require('node:test');
const assert = require('node:assert/strict');

test('resolveSharedTrack resolves provider-backed IDs and local library IDs', async () => {
  const originalFetch = global.fetch;
  const modulePath = require.resolve('../app/shared-track-service');
  const publicMetadataModulePath = require.resolve('../app/public-metadata-service');
  delete require.cache[modulePath];
  delete require.cache[publicMetadataModulePath];

  global.fetch = async (url) => {
    if (String(url) === 'https://api.deezer.com/track/3709069532') {
      return {
        ok: true,
        async json() {
          return {
            id: 3709069532,
            title: 'Veridis Quo',
            artist: {
              name: 'Daft Punk'
            },
            album: {
              title: 'Discovery',
              cover: 'https://example.com/discovery.jpg'
            },
            duration: 345,
            link: 'https://www.deezer.com/track/3709069532',
            isrc: 'GBDUW0100002'
          };
        }
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const { resolveSharedTrack } = require('../app/shared-track-service');
    const store = {
      getTrack(trackId) {
        if (trackId === 'local-1') {
          return {
            id: 'local-1',
            title: 'One More Time',
            artist: 'Daft Punk',
            artists: ['Daft Punk'],
            album: 'Discovery',
            albumArtist: 'Daft Punk',
            duration: 320,
            provider: 'youtube',
            sourcePlatform: 'youtube',
            providerIds: {
              youtube: 'abc123',
              deezer: '',
              spotify: '',
              soundcloud: '',
              itunes: '',
              isrc: ''
            },
            filePath: 'C:\\Music\\Apollo\\library\\Daft Punk\\Discovery\\One More Time.mp3',
            fileName: 'One More Time.mp3'
          };
        }

        return null;
      }
    };

    const deezerTrack = await resolveSharedTrack(
      { id: 'deezer:3709069532' },
      {},
      store,
      'http://127.0.0.1:4848'
    );
    assert.equal(deezerTrack.id, 'deezer:3709069532');
    assert.equal(deezerTrack.provider, 'deezer');
    assert.equal(deezerTrack.title, 'Veridis Quo');
    assert.equal(deezerTrack.artist, 'Daft Punk');
    assert.equal(deezerTrack.isrc, 'GBDUW0100002');
    assert.equal(deezerTrack.playable, true);

    const localTrack = await resolveSharedTrack(
      { id: 'library:local-1' },
      {},
      store,
      'http://127.0.0.1:4848'
    );
    assert.equal(localTrack.provider, 'library');
    assert.equal(localTrack.trackId, 'local-1');
    assert.equal(localTrack.playable, true);
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
    delete require.cache[publicMetadataModulePath];
  }
});

test('resolveSharedTrack rejects soundcloud bare IDs', async () => {
  const { resolveSharedTrack } = require('../app/shared-track-service');

  await assert.rejects(
    () => resolveSharedTrack({ id: 'soundcloud:12345' }, {}, { getTrack: () => null }, ''),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /SoundCloud shared IDs/);
      return true;
    }
  );
});
