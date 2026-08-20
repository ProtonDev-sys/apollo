from pathlib import Path

path = Path('scripts/apply-search-optimization.py')
source = path.read_text(encoding='utf-8')

old_fallback = '''search = replace_once(
    search,
    "      safePageSize,\\n      settings,\\n      signal\\n    });\\n",
    "      safePageSize: providerPageSize,\\n"
    "      settings,\\n"
    "      signal\\n"
    "    });\\n",
    'provider fallback page size'
)
'''
new_fallback = '''provider_fallback_pattern = "      safePageSize,\\n      settings,\\n      signal\\n    });\\n"
if search.count(provider_fallback_pattern) < 1:
    raise SystemExit('provider fallback page size: no match found')
search = search.replace(
    provider_fallback_pattern,
    "      safePageSize: providerPageSize,\\n"
    "      settings,\\n"
    "      signal\\n"
    "    });\\n",
    1
)
'''
if source.count(old_fallback) != 1:
    raise SystemExit(f'expected one provider fallback patch block, found {source.count(old_fallback)}')
source = source.replace(old_fallback, new_fallback, 1)

identity_removal = '''data_store = remove_between(
    data_store,
    "const GENERIC_ALBUM_NAMES = new Set(",
    "function normaliseStoredTrack(track = {}, existingTrack = null) {",
    'duplicated track identity helpers'
)
'''
settings_restore = identity_removal + '''data_store = replace_once(
    data_store,
    "function normaliseStoredTrack(track = {}, existingTrack = null) {",
    "const EXPLICITLY_CLEARABLE_STRING_SETTINGS = new Set([\\n"
    "  'ytDlpPath',\\n"
    "  'ffmpegPath',\\n"
    "  'spotifyClientId',\\n"
    "  'spotifyClientSecret'\\n"
    "]);\\n\\n"
    "function normaliseStoredTrack(track = {}, existingTrack = null) {",
    'clearable settings restoration'
)
'''
if source.count(identity_removal) != 1:
    raise SystemExit(f'expected one identity removal block, found {source.count(identity_removal)}')
source = source.replace(identity_removal, settings_restore, 1)

path.write_text(source, encoding='utf-8')
