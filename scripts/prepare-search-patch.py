from pathlib import Path

path = Path('scripts/apply-search-optimization.py')
source = path.read_text(encoding='utf-8')
old = '''search = replace_once(
    search,
    "      safePageSize,\\n      settings,\\n      signal\\n    });\\n",
    "      safePageSize: providerPageSize,\\n"
    "      settings,\\n"
    "      signal\\n"
    "    });\\n",
    'provider fallback page size'
)
'''
new = '''provider_fallback_pattern = "      safePageSize,\\n      settings,\\n      signal\\n    });\\n"
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
if source.count(old) != 1:
    raise SystemExit(f'expected one provider fallback patch block, found {source.count(old)}')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
