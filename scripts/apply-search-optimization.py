from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


def remove_between(source: str, start: str, end: str, label: str) -> str:
    if source.count(start) != 1 or source.count(end) != 1:
        raise SystemExit(
            f"{label}: expected one boundary each, "
            f"found start={source.count(start)} end={source.count(end)}"
        )
    start_index = source.index(start)
    end_index = source.index(end, start_index)
    return source[:start_index] + source[end_index:]


# DataStore: reuse track identity and maintain a precomputed search index.
data_store_path = Path('app/data-store.js')
data_store = data_store_path.read_text(encoding='utf-8')
data_store = replace_once(
    data_store,
    "const { normaliseProviderIds } = require('./models');\n",
    "const { normaliseProviderIds } = require('./models');\n"
    "const { isTrackEquivalent } = require('./track-identity');\n"
    "const { createTrackSearchDocument, rankTrackSearchDocuments } = require('./search-ranking');\n",
    'data-store imports'
)
data_store = remove_between(
    data_store,
    "const GENERIC_ALBUM_NAMES = new Set(",
    "function normaliseStoredTrack(track = {}, existingTrack = null) {",
    'duplicated track identity helpers'
)
data_store = replace_once(
    data_store,
    "    addedAt: existingTrack ? existingTrack.addedAt : new Date().toISOString(),\n"
    "    updatedAt: new Date().toISOString()\n",
    "    addedAt: track.addedAt || existingTrack?.addedAt || new Date().toISOString(),\n"
    "    updatedAt: track.updatedAt || new Date().toISOString()\n",
    'track timestamps'
)
data_store = replace_once(
    data_store,
    "    this.state = null;\n    this.writeQueue = Promise.resolve();\n",
    "    this.state = null;\n"
    "    this.writeQueue = Promise.resolve();\n"
    "    this.trackSearchDocuments = new Map();\n",
    'search index field'
)
data_store = replace_once(
    data_store,
    "    await this.loadSettings();\n",
    "    this.rebuildTrackSearchIndex();\n\n    await this.loadSettings();\n",
    'initial search index build'
)
data_store = replace_once(
    data_store,
    "  getOverview() {\n",
    "  rebuildTrackSearchIndex() {\n"
    "    this.trackSearchDocuments.clear();\n"
    "    for (const track of this.state?.tracks || []) {\n"
    "      this.indexTrack(track);\n"
    "    }\n"
    "  }\n\n"
    "  indexTrack(track) {\n"
    "    if (!track?.id) {\n"
    "      return;\n"
    "    }\n\n"
    "    this.trackSearchDocuments.set(track.id, createTrackSearchDocument(track));\n"
    "  }\n\n"
    "  removeTrackFromSearchIndex(trackId) {\n"
    "    this.trackSearchDocuments.delete(trackId);\n"
    "  }\n\n"
    "  getOverview() {\n",
    'search index methods'
)
list_tracks_start = "  listTracks({ query = '', page = 1, pageSize = 12 } = {}) {\n"
list_tracks_end = "  getTrack(trackId) {\n"
list_tracks_replacement = """  listTracks({ query = '', page = 1, pageSize = 12 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.min(10000, Math.max(1, Number.parseInt(pageSize, 10) || 12));
    const term = String(query || '').trim();
    const tracks = term
      ? rankTrackSearchDocuments([...this.trackSearchDocuments.values()], term)
      : [...this.state.tracks].sort((left, right) => {
          return new Date(right.addedAt || 0).getTime() - new Date(left.addedAt || 0).getTime();
        });

    const total = tracks.length;
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const currentPage = Math.min(safePage, totalPages);
    const start = (currentPage - 1) * safePageSize;

    return {
      items: tracks.slice(start, start + safePageSize),
      total,
      page: currentPage,
      pageSize: safePageSize,
      totalPages
    };
  }

"""
if data_store.count(list_tracks_start) != 1 or data_store.count(list_tracks_end) != 1:
    raise SystemExit('listTracks boundaries were not found exactly once')
start_index = data_store.index(list_tracks_start)
end_index = data_store.index(list_tracks_end, start_index)
data_store = data_store[:start_index] + list_tracks_replacement + data_store[end_index:]
data_store = replace_once(
    data_store,
    "    this.attachTrackToPlaylists(nextTrack);\n    return nextTrack;\n",
    "    this.indexTrack(nextTrack);\n"
    "    this.attachTrackToPlaylists(nextTrack);\n"
    "    return nextTrack;\n",
    'upsert search indexing'
)
data_store = replace_once(
    data_store,
    "    const [removedTrack] = this.state.tracks.splice(index, 1);\n"
    "    this.clearTrackFromPlaylistEntries(trackId);\n",
    "    const [removedTrack] = this.state.tracks.splice(index, 1);\n"
    "    this.removeTrackFromSearchIndex(trackId);\n"
    "    this.clearTrackFromPlaylistEntries(trackId);\n",
    'delete search indexing'
)
data_store = replace_once(
    data_store,
    "    this.state.tracks = this.state.tracks.filter((track) =>\n"
    "      pathSet.has((track.filePath || '').toLowerCase())\n"
    "    );\n\n"
    "    for (const trackId of removedTrackIds) {\n",
    "    this.state.tracks = this.state.tracks.filter((track) =>\n"
    "      pathSet.has((track.filePath || '').toLowerCase())\n"
    "    );\n"
    "    this.rebuildTrackSearchIndex();\n\n"
    "    for (const trackId of removedTrackIds) {\n",
    'missing-track search index rebuild'
)
data_store_path.write_text(data_store, encoding='utf-8')


# Search service: bounded provider fan-out plus global song relevance ranking.
search_path = Path('app/search-service.js')
search = search_path.read_text(encoding='utf-8')
search = replace_once(
    search,
    "const { isTrackEquivalent } = require('./data-store');\n",
    "const {\n"
    "  dedupeAndRankRemoteItems,\n"
    "  getProviderRequestPageSize,\n"
    "  isPreferredMusicResult,\n"
    "  scoreRawProviderEntry\n"
    "} = require('./search-ranking');\n",
    'search ranking imports'
)
for constant in [
    "const NON_SONG_VIDEO_PATTERN =\n  /\\b(lyrics?|official video|video clip|reaction|karaoke|cover|live|sped up|slowed|nightcore|fanmade|fan-made)\\b/i;\n",
    "const YOUTUBE_AUDIO_HINT_PATTERN = /\\b(official audio|audio|topic)\\b/i;\n",
    "const GENERIC_ALBUM_NAMES = new Set(['', 'singles', 'youtube', 'soundcloud', 'spotify', 'deezer']);\n"
]:
    if search.count(constant) != 1:
        raise SystemExit(f'search constant was not found exactly once: {constant[:40]}')
    search = search.replace(constant, '', 1)
search = replace_once(
    search,
    "  return dedupeRemoteItems(results);\n",
    "  return dedupeAndRankRemoteItems(results, searchText);\n",
    'metadata candidate dedupe'
)
search = remove_between(
    search,
    "function scoreSearchEntry(entry, provider, query) {\n",
    "async function searchViaYtDlp(query, provider, page, pageSize, settings, signal) {\n",
    'inline ranking helpers'
)
search = replace_once(
    search,
    "      __score: scoreSearchEntry(entry, provider, query)\n",
    "      __score: scoreRawProviderEntry(entry, provider, query)\n",
    'yt-dlp ranking'
)
old_response = """function createRemoteSearchResponse(
  { items, warnings, providerErrors, providers, page, pageSize },
  progress = null
) {
  const dedupedItems = dedupeRemoteItems(items);
  const payload = {
    items: dedupedItems,
    total: dedupedItems.length,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(dedupedItems.length / pageSize)),
    provider: providers,
    providerErrors,
    warning: warnings.join(' ')
  };
"""
new_response = """function createRemoteSearchResponse(
  { items, warnings, providerErrors, providers, page, pageSize, query },
  progress = null
) {
  const rankedItems = dedupeAndRankRemoteItems(items, query, pageSize);
  const payload = {
    items: rankedItems,
    total: rankedItems.length,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(rankedItems.length / pageSize)),
    provider: providers,
    providerErrors,
    warning: warnings.join(' ')
  };
"""
search = replace_once(search, old_response, new_response, 'remote response ranking')
search = replace_once(
    search,
    "  const fastMultiProviderMode = providers.length > 1;\n  const results = await Promise.allSettled(\n",
    "  const fastMultiProviderMode = providers.length > 1;\n"
    "  const providerPageSize = getProviderRequestPageSize(safePageSize, providers.length, safePage);\n"
    "  const results = await Promise.allSettled(\n",
    'provider request budget'
)
search = replace_once(
    search,
    "        safePageSize,\n        settings,\n        signal\n      )\n",
    "        providerPageSize,\n        settings,\n        signal\n      )\n",
    'provider request page size'
)
search = replace_once(
    search,
    "      safePageSize,\n      settings,\n      signal\n    });\n",
    "      safePageSize: providerPageSize,\n"
    "      settings,\n"
    "      signal\n"
    "    });\n",
    'provider fallback page size'
)
search = replace_once(
    search,
    "    page: safePage,\n    pageSize: safePageSize\n  });\n}\n\nasync function* searchProvidersStream",
    "    page: safePage,\n"
    "    pageSize: safePageSize,\n"
    "    query: trimmedQuery\n"
    "  });\n"
    "}\n\nasync function* searchProvidersStream",
    'complete search response query'
)
search = replace_once(
    search,
    "  const fastMultiProviderMode = providers.length > 1;\n\n  if (!trimmedQuery) {\n",
    "  const fastMultiProviderMode = providers.length > 1;\n"
    "  const providerPageSize = getProviderRequestPageSize(safePageSize, providers.length, safePage);\n\n"
    "  if (!trimmedQuery) {\n",
    'stream provider request budget'
)
search = search.replace(
    "        pageSize: safePageSize\n      },\n",
    "        pageSize: safePageSize,\n        query: trimmedQuery\n      },\n"
)
search = replace_once(
    search,
    "    createProviderSearchRequest(providerName, trimmedQuery, safePage, safePageSize, settings, signal).then(\n",
    "    createProviderSearchRequest(providerName, trimmedQuery, safePage, providerPageSize, settings, signal).then(\n",
    'stream provider page size'
)
search = replace_once(
    search,
    "      safePageSize,\n      settings,\n      signal\n    });\n    items.push(...settled.items);\n",
    "      safePageSize: providerPageSize,\n"
    "      settings,\n"
    "      signal\n"
    "    });\n"
    "    items.push(...settled.items);\n",
    'stream fallback page size'
)
search = search.replace(
    "        pageSize: safePageSize\n      },\n      {\n",
    "        pageSize: safePageSize,\n        query: trimmedQuery\n      },\n      {\n"
)

required = [
    "dedupeAndRankRemoteItems",
    "providerPageSize = getProviderRequestPageSize",
    "__score: scoreRawProviderEntry",
    "query: trimmedQuery"
]
for fragment in required:
    if fragment not in search:
        raise SystemExit(f'missing search fragment: {fragment}')
for forbidden in [
    "function scoreSearchEntry(",
    "function scoreRemoteResult(",
    "function dedupeRemoteItems(",
    "NON_SONG_VIDEO_PATTERN",
    "YOUTUBE_AUDIO_HINT_PATTERN"
]:
    if forbidden in search:
        raise SystemExit(f'stale search fragment remains: {forbidden}')
search_path.write_text(search, encoding='utf-8')


# Music server: state the larger shared search cache explicitly.
server_path = Path('app/music-server.js')
server = server_path.read_text(encoding='utf-8')
server = replace_once(
    server,
    "  const searchCoordinator = new SearchCoordinator();\n",
    "  const searchCoordinator = new SearchCoordinator({\n"
    "    cacheTtlMs: 30000,\n"
    "    maxCacheEntries: 200\n"
    "  });\n",
    'search coordinator configuration'
)
server_path.write_text(server, encoding='utf-8')

print('Applied indexed library search and bounded remote ranking.')
