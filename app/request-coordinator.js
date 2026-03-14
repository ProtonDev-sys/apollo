const { createAbortError } = require('./http-error');

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function raceWithSignal(promise, signal) {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(signal.reason || createAbortError('Request was closed by the client.', 499));
  }

  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      reject(signal.reason || createAbortError('Request was closed by the client.', 499));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      }
    );
  });
}

class RequestCoordinator {
  constructor({ cacheTtlMs = 0, maxCacheEntries = 100 } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.maxCacheEntries = maxCacheEntries;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  getCached(cacheKey) {
    if (!this.cacheTtlMs) {
      return null;
    }

    const cached = this.cache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(cacheKey);
      return null;
    }

    return cloneValue(cached.payload);
  }

  setCached(cacheKey, payload) {
    if (!this.cacheTtlMs) {
      return;
    }

    this.pruneExpired();
    this.cache.set(cacheKey, {
      payload: cloneValue(payload),
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

  pruneExpired() {
    const now = Date.now();
    for (const [cacheKey, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(cacheKey);
      }
    }
  }

  async run({ cacheKey, requestSignal = null, execute }) {
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    let sharedPromise = this.inFlight.get(cacheKey);
    if (!sharedPromise) {
      // Shared work must not inherit a single caller's abort signal, otherwise
      // one disconnect can fail every peer waiting on the same cache key.
      sharedPromise = Promise.resolve()
        .then(() => execute())
        .then((result) => {
          this.setCached(cacheKey, result);
          return cloneValue(result);
        })
        .finally(() => {
          if (this.inFlight.get(cacheKey) === sharedPromise) {
            this.inFlight.delete(cacheKey);
          }
        });
      this.inFlight.set(cacheKey, sharedPromise);
    }

    return raceWithSignal(sharedPromise.then((value) => cloneValue(value)), requestSignal);
  }
}

module.exports = {
  RequestCoordinator
};
