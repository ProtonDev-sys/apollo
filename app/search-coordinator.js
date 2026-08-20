const { createAbortError } = require('./http-error');
const { normaliseComparableText } = require('./track-identity');

function cloneSearchResult(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function normaliseProviderSelection(value) {
  const providers = Array.isArray(value) ? value : String(value || 'all').split(',');
  const normalised = [...new Set(
    providers
      .map((provider) => String(provider || '').trim().toLowerCase())
      .filter(Boolean)
  )];

  if (!normalised.length || normalised.includes('all')) {
    return ['all'];
  }

  return normalised.sort();
}

class SearchCoordinator {
  constructor({ cacheTtlMs = 30000, maxCacheEntries = 200 } = {}) {
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
    this.maxCacheEntries = Math.max(1, Number(maxCacheEntries) || 1);
    this.activeSearches = new Map();
    this.cache = new Map();
  }

  resolveClientKey({ request, requestUrl, accessToken = '' }) {
    const explicitClientId =
      String(request.headers['x-client-id'] || '').trim() ||
      String(requestUrl.searchParams.get('clientId') || '').trim();

    if (explicitClientId) {
      return `client:${explicitClientId}`;
    }

    if (accessToken) {
      return `token:${accessToken}`;
    }

    return `ip:${request.socket.remoteAddress || 'anonymous'}`;
  }

  createCacheKey(payload = {}) {
    return JSON.stringify({
      query: normaliseComparableText(payload.query),
      provider: normaliseProviderSelection(payload.provider),
      scope: String(payload.scope || 'all').trim().toLowerCase(),
      page: Math.max(1, Number.parseInt(payload.page, 10) || 1),
      pageSize: Math.max(1, Number.parseInt(payload.pageSize, 10) || 20)
    });
  }

  getCached(cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(cacheKey);
      return null;
    }

    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, cached);
    return cloneSearchResult(cached.payload);
  }

  setCached(cacheKey, payload) {
    this.pruneExpiredCache();
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, {
      payload: cloneSearchResult(payload),
      expiresAt: Date.now() + this.cacheTtlMs
    });

    while (this.cache.size > this.maxCacheEntries) {
      const leastRecentlyUsedKey = this.cache.keys().next().value;
      if (!leastRecentlyUsedKey) {
        break;
      }

      this.cache.delete(leastRecentlyUsedKey);
    }
  }

  pruneExpiredCache() {
    const now = Date.now();
    for (const [cacheKey, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(cacheKey);
      }
    }
  }

  beginSearch({ clientKey, cacheKey, requestSignal = null }) {
    const previousSearch = this.activeSearches.get(clientKey);
    if (previousSearch) {
      previousSearch.controller.abort(
        createAbortError('Search superseded by a newer request from the same client.')
      );
    }

    const cached = this.getCached(cacheKey);
    if (cached) {
      return {
        cached,
        entry: null,
        signal: requestSignal
      };
    }

    const controller = new AbortController();
    const signal = requestSignal
      ? AbortSignal.any([controller.signal, requestSignal])
      : controller.signal;
    const entry = {
      clientKey,
      cacheKey,
      controller
    };

    this.activeSearches.set(clientKey, entry);
    return {
      cached: null,
      entry,
      signal
    };
  }

  finishSearch(entry, payload) {
    if (!entry) {
      return cloneSearchResult(payload);
    }

    if (this.activeSearches.get(entry.clientKey) !== entry) {
      throw createAbortError('Search superseded by a newer request from the same client.');
    }

    this.setCached(entry.cacheKey, payload);
    return cloneSearchResult(payload);
  }

  releaseSearch(entry) {
    if (!entry) {
      return;
    }

    if (this.activeSearches.get(entry.clientKey) === entry) {
      this.activeSearches.delete(entry.clientKey);
    }
  }

  async runSearch({ clientKey, cacheKey, requestSignal = null, execute }) {
    const { cached, entry, signal } = this.beginSearch({
      clientKey,
      cacheKey,
      requestSignal
    });
    if (cached) {
      return cached;
    }

    try {
      const result = await execute({ signal });
      return this.finishSearch(entry, result);
    } finally {
      this.releaseSearch(entry);
    }
  }
}

module.exports = {
  SearchCoordinator,
  cloneSearchResult,
  normaliseProviderSelection
};
