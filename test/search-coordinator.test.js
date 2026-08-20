const test = require('node:test');
const assert = require('node:assert/strict');

const { SearchCoordinator } = require('../app/search-coordinator');

test('search cache keys canonicalize query, providers, and pagination', () => {
  const coordinator = new SearchCoordinator();

  const first = coordinator.createCacheKey({
    query: '  Beyoncé   Halo ',
    provider: 'youtube,spotify',
    scope: 'REMOTE',
    page: '01',
    pageSize: '08'
  });
  const second = coordinator.createCacheKey({
    query: 'beyonce halo',
    provider: ['spotify', 'youtube'],
    scope: 'remote',
    page: 1,
    pageSize: 8
  });

  assert.equal(first, second);
});

test('search cache behaves as LRU when capacity is exceeded', () => {
  const coordinator = new SearchCoordinator({
    cacheTtlMs: 60000,
    maxCacheEntries: 2
  });

  coordinator.setCached('one', { value: 1 });
  coordinator.setCached('two', { value: 2 });
  assert.deepEqual(coordinator.getCached('one'), { value: 1 });
  coordinator.setCached('three', { value: 3 });

  assert.equal(coordinator.getCached('two'), null);
  assert.deepEqual(coordinator.getCached('one'), { value: 1 });
  assert.deepEqual(coordinator.getCached('three'), { value: 3 });
});

test('new searches supersede older searches from the same client', async () => {
  const coordinator = new SearchCoordinator();
  let firstSignal;
  let releaseFirst;
  const firstPromise = coordinator.runSearch({
    clientKey: 'client:test',
    cacheKey: 'first',
    execute: ({ signal }) => {
      firstSignal = signal;
      return new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
  });

  await new Promise(setImmediate);
  const secondResult = await coordinator.runSearch({
    clientKey: 'client:test',
    cacheKey: 'second',
    execute: async () => ({ query: 'second' })
  });

  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(secondResult, { query: 'second' });

  releaseFirst({ query: 'first' });
  await assert.rejects(firstPromise, /superseded/i);
});

test('cached search results are cloned before returning to callers', async () => {
  const coordinator = new SearchCoordinator();
  const first = await coordinator.runSearch({
    clientKey: 'client:one',
    cacheKey: 'shared',
    execute: async () => ({ items: [{ id: 'one' }] })
  });
  first.items[0].id = 'changed';

  const second = await coordinator.runSearch({
    clientKey: 'client:two',
    cacheKey: 'shared',
    execute: async () => {
      throw new Error('cache miss');
    }
  });

  assert.deepEqual(second, { items: [{ id: 'one' }] });
});
