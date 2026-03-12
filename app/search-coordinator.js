const { createAbortError } = require('./http-error');

function cloneSearchResult(value) {
  return JSON.parse(JSON.stringify(value));
}

class SearchCoordinator {
  constructor({ cacheTtlMs = 15000, maxCacheEntries = 100 } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.maxCacheEntries = maxCacheEntries;
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

  createCacheKey(payload) {
    return JSON.stringify({
      query: String(payload.query || '').trim(),
      provider: Array.isArray(payload.provider) ? payload.provider : String(payload.provider || 'all'),
      scope: String(payload.scope || 'all'),
      page: String(payload.page || '1'),
      pageSize: String(payload.pageSize || '20')
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

    return cloneSearchResult(cached.payload);
  }

  setCached(cacheKey, payload) {
    this.pruneExpiredCache();
    this.cache.set(cacheKey, {
      payload: cloneSearchResult(payload),
      expiresAt: Date.now() + this.cacheTtlMs
    });

    while (this.cache.size > this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) {
        break;
      }

      this.cache.delete(oldestKey);
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
    const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
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
  SearchCoordinator
};
