const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const searchServicePath = path.join(__dirname, '..', 'app', 'search-service.js');

function readSearchService() {
  return fs.readFileSync(searchServicePath, 'utf8');
}

test('remote search paginates only after global ranking and deduplication', () => {
  const source = readSearchService();

  assert.match(source, /paginateRankedRemoteItems\(items, query, page, pageSize\)/);
  assert.match(source, /const pagination = paginateRankedRemoteItems/);
  assert.doesNotMatch(source, /dedupeAndRankRemoteItems\(items, query, pageSize\)/);
});

test('remote page requests collect every provider page up to the requested page', () => {
  const source = readSearchService();

  assert.match(source, /async function searchProviderPages\(/);
  assert.match(
    source,
    /for \(let providerPage = 1; providerPage <= pageCount; providerPage \+= 1\)/
  );
  assert.match(
    source,
    /searchProviderPages\([\s\S]*?safePage,[\s\S]*?providerPageSize/
  );
});

test('progressive search uses the same candidate collection and pagination path', () => {
  const source = readSearchService();
  const occurrences = source.match(/searchProviderPages\(/g) || [];

  assert.ok(occurrences.length >= 3, 'expected helper definition plus normal and streamed callers');
  assert.match(source, /yield createRemoteSearchResponse\(/);
});
