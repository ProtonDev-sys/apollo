from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


def replace_block(source: str, start: str, end: str, replacement: str, label: str) -> str:
    start_count = source.count(start)
    end_count = source.count(end)
    if start_count != 1 or end_count != 1:
        raise SystemExit(
            f"{label}: expected one boundary each, "
            f"found start={start_count}, end={end_count}"
        )
    start_index = source.index(start)
    end_index = source.index(end, start_index)
    return source[:start_index] + replacement + source[end_index:]


ranking_path = Path('app/search-ranking.js')
ranking = ranking_path.read_text(encoding='utf-8')
ranking_replacement = r'''function createRankedRemoteEntry(item, score) {
  const fingerprintKey = createTrackFingerprintKey(item);
  return {
    item,
    score,
    strongKeys: new Set(createStrongTrackIdentityKeys(item)),
    fingerprintKeys: new Set(fingerprintKey ? [fingerprintKey] : [])
  };
}

function rebuildRemoteIdentityIndexes(rankedItems, strongIdentityIndexes, fingerprintIndexes) {
  strongIdentityIndexes.clear();
  fingerprintIndexes.clear();

  rankedItems.forEach((entry, index) => {
    if (!entry) {
      return;
    }

    for (const key of entry.strongKeys) {
      strongIdentityIndexes.set(key, index);
    }

    for (const fingerprintKey of entry.fingerprintKeys) {
      const indexes = fingerprintIndexes.get(fingerprintKey) || [];
      indexes.push(index);
      fingerprintIndexes.set(fingerprintKey, indexes);
    }
  });
}

function mergeRemoteIdentityClusters(rankedItems, matchingIndexes, item, itemScore) {
  const survivorIndex = Math.min(...matchingIndexes);
  const candidates = [
    ...matchingIndexes
      .map((index) => rankedItems[index])
      .filter(Boolean),
    createRankedRemoteEntry(item, itemScore)
  ].sort((left, right) => right.score - left.score);

  let mergedItem = candidates[0].item;
  const strongKeys = new Set();
  const fingerprintKeys = new Set();
  for (const candidate of candidates) {
    for (const key of candidate.strongKeys) {
      strongKeys.add(key);
    }
    for (const key of candidate.fingerprintKeys) {
      fingerprintKeys.add(key);
    }
  }
  for (const alternate of candidates.slice(1)) {
    mergedItem = mergeRemoteIdentity(mergedItem, alternate.item);
  }

  for (const index of matchingIndexes) {
    rankedItems[index] = null;
  }
  rankedItems[survivorIndex] = {
    item: mergedItem,
    score: candidates[0].score,
    strongKeys,
    fingerprintKeys
  };
}

function dedupeAndRankRemoteItems(items, query, limit = Number.POSITIVE_INFINITY) {
  const rankedItems = [];
  const strongIdentityIndexes = new Map();
  const fingerprintIndexes = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item) {
      continue;
    }

    const itemScore = scoreRemoteTrack(item, query);
    const strongKeys = createStrongTrackIdentityKeys(item);
    const fingerprintKey = createTrackFingerprintKey(item);
    const matchingIndexes = new Set();

    for (const key of strongKeys) {
      const index = strongIdentityIndexes.get(key);
      if (Number.isInteger(index) && rankedItems[index]) {
        matchingIndexes.add(index);
      }
    }

    if (fingerprintKey) {
      for (const candidateIndex of fingerprintIndexes.get(fingerprintKey) || []) {
        const candidate = rankedItems[candidateIndex];
        if (candidate && isTrackEquivalent(candidate.item, item)) {
          matchingIndexes.add(candidateIndex);
        }
      }
    }

    if (!matchingIndexes.size) {
      rankedItems.push(createRankedRemoteEntry(item, itemScore));
    } else {
      mergeRemoteIdentityClusters(rankedItems, [...matchingIndexes], item, itemScore);
    }

    rebuildRemoteIdentityIndexes(rankedItems, strongIdentityIndexes, fingerprintIndexes);
  }

  const sorted = rankedItems
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(left.item.title || '').localeCompare(String(right.item.title || ''));
    });
  const numericLimit = Number(limit);
  const limited = Number.isFinite(numericLimit)
    ? sorted.slice(0, Math.max(0, numericLimit))
    : sorted;

  return limited.map((entry) => entry.item);
}

function paginateRankedRemoteItems(items, query, page = 1, pageSize = 8) {
  const safePageSize = Math.min(20, Math.max(1, Number.parseInt(pageSize, 10) || 8));
  const requestedPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const rankedItems = dedupeAndRankRemoteItems(items, query);
  const total = rankedItems.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const start = (currentPage - 1) * safePageSize;

  return {
    items: rankedItems.slice(start, start + safePageSize),
    total,
    page: currentPage,
    pageSize: safePageSize,
    totalPages
  };
}

function getProviderRequestPageSize(pageSize, providerCount, page = 1) {
  const safePageSize = Math.min(20, Math.max(1, Number.parseInt(pageSize, 10) || 8));
  const safeProviderCount = Math.max(1, Number.parseInt(providerCount, 10) || 1);
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);

  if (safeProviderCount === 1 || safePage > 1) {
    return safePageSize;
  }

  return Math.min(10, Math.max(4, Math.ceil(safePageSize / safeProviderCount) + 2));
}

'''
ranking = replace_block(
    ranking,
    'function dedupeAndRankRemoteItems(items, query, limit = Number.POSITIVE_INFINITY) {',
    'function getProviderRequestPageSize(pageSize, providerCount, page = 1) {',
    ranking_replacement,
    'remote identity clustering'
)
ranking = replace_once(
    ranking,
    '  dedupeAndRankRemoteItems,\n  getProviderRequestPageSize\n};\n',
    '  dedupeAndRankRemoteItems,\n  paginateRankedRemoteItems,\n  getProviderRequestPageSize\n};\n',
    'ranking exports'
)
ranking_path.write_text(ranking, encoding='utf-8')


service_path = Path('app/search-service.js')
service = service_path.read_text(encoding='utf-8')
service = replace_once(
    service,
    "  dedupeAndRankRemoteItems,\n  getProviderRequestPageSize,\n",
    "  dedupeAndRankRemoteItems,\n  paginateRankedRemoteItems,\n  getProviderRequestPageSize,\n",
    'pagination import'
)
service_replacement = r'''function createRemoteSearchResponse(
  { items, warnings, providerErrors, providers, page, pageSize, query },
  progress = null
) {
  const pagination = paginateRankedRemoteItems(items, query, page, pageSize);
  const payload = {
    ...pagination,
    provider: providers,
    providerErrors,
    warning: warnings.join(' ')
  };

  if (progress) {
    payload.progress = {
      complete: Boolean(progress.complete),
      completedProviders: [...progress.completedProviders],
      pendingProviders: [...progress.pendingProviders],
      lastProvider: progress.lastProvider || '',
      lastStatus: progress.lastStatus || ''
    };
  }

  return payload;
}

function createProviderSearchRequest(selectedProvider, query, page, pageSize, settings, signal) {
  if (selectedProvider === 'spotify') {
    return searchSpotify(query, page, pageSize, settings, signal);
  }

  if (selectedProvider === 'itunes') {
    return searchItunesTracks({
      query,
      page,
      pageSize,
      signal
    });
  }

  if (selectedProvider === 'deezer') {
    return searchDeezerTracks({
      query,
      page,
      pageSize,
      signal
    });
  }

  return searchViaYtDlp(query, selectedProvider, page, pageSize, settings, signal);
}

async function searchProviderPages(
  selectedProvider,
  query,
  requestedPage,
  pageSize,
  settings,
  signal
) {
  const items = [];
  const pageCount = Math.max(1, Number.parseInt(requestedPage, 10) || 1);

  for (let providerPage = 1; providerPage <= pageCount; providerPage += 1) {
    const result = await createProviderSearchRequest(
      selectedProvider,
      query,
      providerPage,
      pageSize,
      settings,
      signal
    );
    const pageItems = Array.isArray(result.items) ? result.items : [];
    items.push(...pageItems);

    if (pageItems.length < pageSize) {
      break;
    }
  }

  return {
    items,
    total: items.length,
    page: 1,
    pageSize,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize))
  };
}

async function searchSpotifyFallbackPages(query, requestedPage, pageSize, settings, signal) {
  const items = [];
  const pageCount = Math.max(1, Number.parseInt(requestedPage, 10) || 1);

  for (let providerPage = 1; providerPage <= pageCount; providerPage += 1) {
    const result = await searchSpotifyFallback(
      query,
      providerPage,
      pageSize,
      settings,
      signal
    );
    const pageItems = Array.isArray(result.items) ? result.items : [];
    items.push(...pageItems);

    if (pageItems.length < pageSize) {
      break;
    }
  }

  return {
    items,
    total: items.length,
    page: 1,
    pageSize,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize))
  };
}

async function settleProviderSearchResult(
  providerName,
  result,
  { fastMultiProviderMode, trimmedQuery, requestedPage, providerPageSize, settings, signal }
) {
  if (result.status === 'fulfilled') {
    return {
      items: result.value.items,
      warnings: [],
      providerErrors: {}
    };
  }

  if (isAbortError(result.reason)) {
    throw result.reason;
  }

  const providerErrors = {
    [providerName]: result.reason.message
  };

  if (providerName === 'spotify' && !fastMultiProviderMode) {
    try {
      const fallback = await searchSpotifyFallbackPages(
        trimmedQuery,
        requestedPage,
        providerPageSize,
        settings,
        signal
      );
      return {
        items: fallback.items,
        warnings: [`spotify: ${result.reason.message} Falling back to YouTube audio results.`],
        providerErrors
      };
    } catch (fallbackError) {
      if (isAbortError(fallbackError)) {
        throw fallbackError;
      }

      providerErrors.spotifyFallback = fallbackError.message;
      return {
        items: [],
        warnings: [`spotify: ${result.reason.message}`, `spotify fallback: ${fallbackError.message}`],
        providerErrors
      };
    }
  }

  return {
    items: [],
    warnings: [`${providerName}: ${result.reason.message}`],
    providerErrors
  };
}

async function searchProviders(
  { query, provider = 'all', page = 1, pageSize = 8 },
  settings,
  { signal } = {}
) {
  const trimmedQuery = String(query || '').trim();
  const safePageSize = Math.min(20, Math.max(1, Number.parseInt(pageSize, 10) || 8));
  if (!trimmedQuery) {
    return {
      items: [],
      total: 0,
      page: 1,
      pageSize: safePageSize,
      totalPages: 1,
      provider: parseProviderSelection(provider),
      warning: ''
    };
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const providers = parseProviderSelection(provider);
  const fastMultiProviderMode = providers.length > 1;
  const providerPageSize = getProviderRequestPageSize(safePageSize, providers.length, safePage);
  const results = await Promise.allSettled(
    providers.map((selectedProvider) =>
      searchProviderPages(
        selectedProvider,
        trimmedQuery,
        safePage,
        providerPageSize,
        settings,
        signal
      )
    )
  );

  const items = [];
  const warnings = [];
  const providerErrors = {};

  for (const [index, result] of results.entries()) {
    const providerName = providers[index];
    const settled = await settleProviderSearchResult(providerName, result, {
      fastMultiProviderMode,
      trimmedQuery,
      requestedPage: safePage,
      providerPageSize,
      settings,
      signal
    });
    items.push(...settled.items);
    warnings.push(...settled.warnings);
    Object.assign(providerErrors, settled.providerErrors);
  }

  return createRemoteSearchResponse({
    items,
    warnings,
    providerErrors,
    providers,
    page: safePage,
    pageSize: safePageSize,
    query: trimmedQuery
  });
}

async function* searchProvidersStream(
  { query, provider = 'all', page = 1, pageSize = 8 },
  settings,
  { signal } = {}
) {
  const trimmedQuery = String(query || '').trim();
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(20, Math.max(1, Number.parseInt(pageSize, 10) || 8));
  const providers = parseProviderSelection(provider);
  const fastMultiProviderMode = providers.length > 1;
  const providerPageSize = getProviderRequestPageSize(safePageSize, providers.length, safePage);

  if (!trimmedQuery) {
    yield createRemoteSearchResponse(
      {
        items: [],
        warnings: [],
        providerErrors: {},
        providers,
        page: 1,
        pageSize: safePageSize,
        query: trimmedQuery
      },
      {
        complete: true,
        completedProviders: providers,
        pendingProviders: [],
        lastProvider: '',
        lastStatus: 'fulfilled'
      }
    );
    return;
  }

  const items = [];
  const warnings = [];
  const providerErrors = {};
  const completedProviders = [];
  const pendingProviders = [...providers];
  const pendingSearches = providers.map((providerName) =>
    searchProviderPages(
      providerName,
      trimmedQuery,
      safePage,
      providerPageSize,
      settings,
      signal
    ).then(
      (value) => ({
        providerName,
        result: {
          status: 'fulfilled',
          value
        }
      }),
      (reason) => ({
        providerName,
        result: {
          status: 'rejected',
          reason
        }
      })
    )
  );

  while (pendingSearches.length) {
    const nextSettled = await Promise.race(
      pendingSearches.map((pendingSearch, index) =>
        pendingSearch.then((payload) => ({
          index,
          payload
        }))
      )
    );
    pendingSearches.splice(nextSettled.index, 1);

    const { providerName, result } = nextSettled.payload;
    const settled = await settleProviderSearchResult(providerName, result, {
      fastMultiProviderMode,
      trimmedQuery,
      requestedPage: safePage,
      providerPageSize,
      settings,
      signal
    });
    items.push(...settled.items);
    warnings.push(...settled.warnings);
    Object.assign(providerErrors, settled.providerErrors);

    completedProviders.push(providerName);
    const remainingProviders = pendingProviders.filter((pendingProvider) => pendingProvider !== providerName);
    pendingProviders.length = 0;
    pendingProviders.push(...remainingProviders);

    yield createRemoteSearchResponse(
      {
        items,
        warnings,
        providerErrors,
        providers,
        page: safePage,
        pageSize: safePageSize,
        query: trimmedQuery
      },
      {
        complete: pendingProviders.length === 0,
        completedProviders,
        pendingProviders,
        lastProvider: providerName,
        lastStatus: result.status
      }
    );
  }
}

'''
service = replace_block(
    service,
    'function createRemoteSearchResponse(',
    'async function inspectDirectLink(url, settings, { signal } = {}) {',
    service_replacement,
    'globally paginated provider search'
)
service_path.write_text(service, encoding='utf-8')

print('Applied reviewed identity clustering and global remote pagination fixes.')
