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

async function sendJsonRequest({ port, method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk.toString();
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            body: raw ? JSON.parse(raw) : null
          });
        });
      }
    );

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

test('music server exposes POST /api/resolve-shared-track', async () => {
  const port = await getFreePort();
  const calls = [];
  const server = createMusicServer({
    getAuthStatus: () => ({ enabled: false }),
    resolveSharedTrack: async (payload) => {
      calls.push(payload);
      return {
        id: payload.id,
        title: 'Resolved Song',
        provider: 'deezer'
      };
    }
  });

  try {
    await server.start({
      host: '127.0.0.1',
      port
    });

    const response = await sendJsonRequest({
      port,
      method: 'POST',
      path: '/api/resolve-shared-track',
      body: {
        id: 'deezer:3709069532'
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{ id: 'deezer:3709069532' }]);
    assert.equal(response.body.id, 'deezer:3709069532');
    assert.equal(response.body.title, 'Resolved Song');
  } finally {
    await server.stop();
  }
});
