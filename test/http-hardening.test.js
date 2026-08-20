const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { createMusicServer } = require('../app/music-server');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function sendJsonRequest({ port, body, includeContentLength = true }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json'
    };
    if (includeContentLength) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/recommendations',
        method: 'POST',
        headers
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk.toString();
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: raw ? JSON.parse(raw) : null
          });
        });
      }
    );

    request.on('error', reject);
    request.end(payload);
  });
}

function createServices(onRecommendation) {
  return {
    getAuthStatus: () => ({ enabled: false }),
    getRecommendations: onRecommendation
  };
}

test('music server rejects declared JSON bodies above 1 MiB and remains usable', async () => {
  const port = await getFreePort();
  let callCount = 0;
  const server = createMusicServer(
    createServices(async () => {
      callCount += 1;
      return {
        items: [],
        total: 0,
        page: 1,
        pageSize: 5,
        totalPages: 1
      };
    })
  );

  try {
    await server.start({ host: '127.0.0.1', port });

    const oversizedResponse = await sendJsonRequest({
      port,
      body: {
        title: 'x'.repeat(1024 * 1024)
      }
    });

    assert.equal(oversizedResponse.statusCode, 413);
    assert.match(oversizedResponse.body.error, /1 MiB limit/);
    assert.equal(callCount, 0);

    const normalResponse = await sendJsonRequest({
      port,
      body: {
        title: 'Apollo',
        artist: 'Tester'
      }
    });

    assert.equal(normalResponse.statusCode, 200);
    assert.equal(callCount, 1);
    assert.equal(normalResponse.headers['cache-control'], 'no-store');
    assert.match(String(normalResponse.headers['content-type'] || ''), /charset=utf-8/);
    assert.equal(normalResponse.headers['x-content-type-options'], 'nosniff');
    assert.equal(normalResponse.headers['referrer-policy'], 'no-referrer');
  } finally {
    await server.stop();
  }
});

test('music server rejects streamed JSON bodies above 1 MiB', async () => {
  const port = await getFreePort();
  let callCount = 0;
  const server = createMusicServer(
    createServices(async () => {
      callCount += 1;
      return {
        items: [],
        total: 0,
        page: 1,
        pageSize: 5,
        totalPages: 1
      };
    })
  );

  try {
    await server.start({ host: '127.0.0.1', port });

    const response = await sendJsonRequest({
      port,
      includeContentLength: false,
      body: {
        title: 'x'.repeat(1024 * 1024)
      }
    });

    assert.equal(response.statusCode, 413);
    assert.match(response.body.error, /1 MiB limit/);
    assert.equal(callCount, 0);
  } finally {
    await server.stop();
  }
});
