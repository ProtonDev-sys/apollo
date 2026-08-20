const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTrackSearchDocument,
  dedupeAndRankRemoteItems,
  getProviderRequestPageSize,
  isPreferredMusicResult,
  paginateRankedRemoteItems,
  rankTrackSearchDocuments,
  scoreTrackSearchDocument,
  tokenizeSearchQuery
} = require('../app/search-ranking');
const { normaliseComparableUrl } = require('../app/track-identity');

function track(overrides = {}) {
  return {
    id: overrides.id || overrides.title,
    title: 'Untitled',
    artist: 'Unknown Artist',
    album: '',
    provider: 'library',
    providerIds: {},
    addedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('song queries normalize accents, punctuation, and short artist names', () => {
  assert.deepEqual(tokenizeSearchQuery('  Beyoncé — Halo  '), ['beyonce', 'halo']);
  assert.deepEqual(tokenizeSearchQuery('U2 One'), ['u2', 'one']);

  const document = createTrackSearchDocument(track({
    title: 'Halo',
    artist: 'Beyoncé'
  }));
  assert.ok(Number.isFinite(scoreTrackSearchDocument(document, 'beyonce halo')));
});

test('library ranking prefers exact title and artist combinations over incidental matches', () => {
  const documents = [
    createTrackSearchDocument(track({
      id: 'incidental',
      title: 'A Song About One More Time',
      artist: 'Other Artist',
      album: 'Daft Punk Tribute',
      addedAt: '2026-01-03T00:00:00.000Z'
    })),
    createTrackSearchDocument(track({
      id: 'correct',
      title: 'One More Time',
      artist: 'Daft Punk',
      album: 'Discovery',
      addedAt: '2001-01-01T00:00:00.000Z'
    })),
    createTrackSearchDocument(track({
      id: 'album-only',
      title: 'Aerodynamic',
      artist: 'Daft Punk',
      album: 'One More Time',
      addedAt: '2026-01-04T00:00:00.000Z'
    }))
  ];

  const ranked = rankTrackSearchDocuments(documents, 'daft punk one more time');
  assert.equal(ranked[0].id, 'correct');
});

test('library ranking uses token AND semantics independent of token order', () => {
  const documents = [
    createTrackSearchDocument(track({ id: 'correct', title: 'Get Lucky', artist: 'Daft Punk' })),
    createTrackSearchDocument(track({ id: 'missing-artist', title: 'Get Lucky', artist: 'Cover Band' })),
    createTrackSearchDocument(track({ id: 'missing-title', title: 'Around the World', artist: 'Daft Punk' }))
  ];

  const ranked = rankTrackSearchDocuments(documents, 'lucky punk daft');
  assert.deepEqual(ranked.map((item) => item.id), ['correct']);
});

test('remote result ranking deduplicates identities and preserves useful provider ids', () => {
  const ranked = dedupeAndRankRemoteItems([
    track({
      id: 'youtube-1',
      provider: 'youtube',
      title: 'One More Time (Official Audio)',
      artist: 'Daft Punk',
      album: 'YouTube',
      duration: 320,
      providerIds: { youtube: 'yt-1', isrc: 'FRZ110000001' },
      artwork: ''
    }),
    track({
      id: 'spotify-1',
      provider: 'spotify',
      title: 'One More Time',
      artist: 'Daft Punk',
      album: 'Discovery',
      duration: 320,
      providerIds: { spotify: 'sp-1', isrc: 'FRZ110000001' },
      isrc: 'FRZ110000001',
      artwork: 'https://example.test/cover.jpg',
      metadataSource: 'spotify'
    }),
    track({
      id: 'reaction',
      provider: 'youtube',
      title: 'Producer Reacts to One More Time',
      artist: 'Music Channel',
      duration: 800,
      providerIds: { youtube: 'reaction-1' }
    })
  ], 'daft punk one more time', 10);

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].provider, 'spotify');
  assert.equal(ranked[0].providerIds.spotify, 'sp-1');
  assert.equal(ranked[0].providerIds.youtube, 'yt-1');
  assert.equal(ranked[1].id, 'reaction');
});

test('bridge identities merge every previously separate matching cluster', () => {
  const ranked = dedupeAndRankRemoteItems([
    track({
      id: 'spotify-only',
      provider: 'spotify',
      title: 'Bridge Song',
      artist: 'Artist',
      album: 'Album A',
      providerIds: { spotify: 'sp-bridge' },
      metadataSource: 'spotify'
    }),
    track({
      id: 'youtube-only',
      provider: 'youtube',
      title: 'Bridge Song',
      artist: 'Artist',
      album: 'Album B',
      providerIds: { youtube: 'yt-bridge' }
    }),
    track({
      id: 'bridge',
      provider: 'deezer',
      title: 'Bridge Song',
      artist: 'Artist',
      album: 'Album A',
      providerIds: {
        spotify: 'sp-bridge',
        youtube: 'yt-bridge',
        deezer: 'dz-bridge'
      }
    })
  ], 'bridge song artist');

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].providerIds.spotify, 'sp-bridge');
  assert.equal(ranked[0].providerIds.youtube, 'yt-bridge');
  assert.equal(ranked[0].providerIds.deezer, 'dz-bridge');
});

test('remote pagination is applied after global ranking and deduplication', () => {
  const pagination = paginateRankedRemoteItems([
    track({ id: 'one', title: 'Song One', artist: 'Artist', provider: 'spotify', providerIds: { spotify: '1' } }),
    track({ id: 'two', title: 'Song Two', artist: 'Artist', provider: 'spotify', providerIds: { spotify: '2' } }),
    track({ id: 'three', title: 'Song Three', artist: 'Artist', provider: 'spotify', providerIds: { spotify: '3' } }),
    track({ id: 'four', title: 'Song Four', artist: 'Artist', provider: 'spotify', providerIds: { spotify: '4' } }),
    track({ id: 'five', title: 'Song Five', artist: 'Artist', provider: 'spotify', providerIds: { spotify: '5' } })
  ], 'song artist', 2, 2);

  assert.equal(pagination.page, 2);
  assert.equal(pagination.pageSize, 2);
  assert.equal(pagination.total, 5);
  assert.equal(pagination.totalPages, 3);
  assert.equal(pagination.items.length, 2);
  assert.deepEqual(
    new Set(pagination.items.map((item) => item.id)),
    new Set(['four', 'one'])
  );
});

test('URL identities preserve case-sensitive paths and query values', () => {
  const upper = normaliseComparableUrl('https://EXAMPLE.test/media/AbC?token=XyZ&utm_source=test');
  const lower = normaliseComparableUrl('https://example.test/media/aBc?token=xyz');

  assert.equal(upper, 'https://example.test/media/AbC?token=XyZ');
  assert.equal(lower, 'https://example.test/media/aBc?token=xyz');
  assert.notEqual(upper, lower);
});

test('YouTube song filtering rejects commentary and alternate versions unless requested', () => {
  assert.equal(isPreferredMusicResult({ title: 'Song Reaction', duration: 300 }, 'youtube', 'song'), false);
  assert.equal(isPreferredMusicResult({ title: 'Song Live', duration: 300 }, 'youtube', 'song'), false);
  assert.equal(isPreferredMusicResult({ title: 'Song Live', duration: 300 }, 'youtube', 'song live'), true);
  assert.equal(isPreferredMusicResult({ title: 'Song Official Audio', duration: 210 }, 'youtube', 'song'), true);
});

test('multi-provider search uses a bounded per-provider request budget', () => {
  assert.equal(getProviderRequestPageSize(20, 1, 1), 20);
  assert.equal(getProviderRequestPageSize(20, 5, 1), 6);
  assert.equal(getProviderRequestPageSize(8, 5, 1), 4);
  assert.equal(getProviderRequestPageSize(20, 5, 2), 20);
});
