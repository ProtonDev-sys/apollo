const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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

async function sendEventStreamRequest({ port, path }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream'
        }
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk.toString();
        });
        response.on('end', () => {
          const events = raw
            .trim()
            .split('\n\n')
            .filter(Boolean)
            .map((block) => {
              const lines = block.split('\n');
              const event = lines
                .find((line) => line.startsWith('event: '))
                ?.slice('event: '.length) || 'message';
              const data = lines
                .filter((line) => line.startsWith('data: '))
                .map((line) => line.slice('data: '.length))
                .join('\n');

              return {
                event,
                data: data ? JSON.parse(data) : null
              };
            });

          resolve({
            statusCode: response.statusCode,
            contentType: response.headers['content-type'],
            events
          });
        });
      }
    );

    request.on('error', reject);
    request.end();
  });
}

async function sendRequest({ port, method, path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    request.on('error', reject);
    request.end();
  });
}

async function createStreamingJsonRequest({ port, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
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
            request,
            response: {
              statusCode: response.statusCode,
              body: raw ? JSON.parse(raw) : null
            }
          });
        });
      }
    );

    request.on('error', reject);
    request.write(payload);
    request.end();

    resolve({ request });
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

test('music server can stream incremental search snapshots over SSE', async () => {
  const port = await getFreePort();
  const server = createMusicServer({
    getAuthStatus: () => ({ enabled: false }),
    searchCatalogStream: async function* () {
      yield {
        query: 'apollo',
        provider: ['soundcloud', 'youtube'],
        scope: 'remote',
        library: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 10,
          totalPages: 1
        },
        remote: {
          items: [
            {
              id: 'soundcloud:1',
              provider: 'soundcloud',
              title: 'First Result'
            }
          ],
          total: 1,
          page: 1,
          pageSize: 10,
          totalPages: 1,
          providerErrors: {},
          warning: '',
          progress: {
            complete: false,
            completedProviders: ['soundcloud'],
            pendingProviders: ['youtube'],
            lastProvider: 'soundcloud',
            lastStatus: 'fulfilled'
          }
        }
      };

      yield {
        query: 'apollo',
        provider: ['soundcloud', 'youtube'],
        scope: 'remote',
        library: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 10,
          totalPages: 1
        },
        remote: {
          items: [
            {
              id: 'soundcloud:1',
              provider: 'soundcloud',
              title: 'First Result'
            },
            {
              id: 'youtube:2',
              provider: 'youtube',
              title: 'Second Result'
            }
          ],
          total: 2,
          page: 1,
          pageSize: 10,
          totalPages: 1,
          providerErrors: {},
          warning: '',
          progress: {
            complete: true,
            completedProviders: ['soundcloud', 'youtube'],
            pendingProviders: [],
            lastProvider: 'youtube',
            lastStatus: 'fulfilled'
          }
        }
      };
    }
  });

  try {
    await server.start({
      host: '127.0.0.1',
      port
    });

    const response = await sendEventStreamRequest({
      port,
      path: '/api/search?query=apollo&scope=remote&provider=soundcloud,youtube&stream=1'
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.contentType || ''), /text\/event-stream/);
    assert.deepEqual(
      response.events.map((event) => event.event),
      ['snapshot', 'done']
    );
    assert.equal(response.events[0].data.remote.items.length, 1);
    assert.equal(response.events[0].data.remote.progress.complete, false);
    assert.equal(response.events[1].data.remote.items.length, 2);
    assert.equal(response.events[1].data.remote.progress.complete, true);
  } finally {
    await server.stop();
  }
});

test('music server rejects malformed byte ranges without crashing', async () => {
  const port = await getFreePort();
  const fixturePath = __filename;
  const server = createMusicServer({
    getAuthStatus: () => ({ enabled: false }),
    getTrack: () => ({
      id: 'fixture',
      filePath: fixturePath,
      fileName: 'music-server.test.js'
    })
  });

  try {
    await server.start({
      host: '127.0.0.1',
      port
    });

    const reversedRange = await sendRequest({
      port,
      method: 'GET',
      path: '/stream/fixture',
      headers: {
        Range: 'bytes=20-10'
      }
    });
    assert.equal(reversedRange.statusCode, 416);
    assert.equal(reversedRange.headers['content-range'], `bytes */${fs.statSync(fixturePath).size}`);

    const suffixRange = await sendRequest({
      port,
      method: 'GET',
      path: '/stream/fixture',
      headers: {
        Range: 'bytes=-16'
      }
    });
    assert.equal(suffixRange.statusCode, 206);
    assert.equal(Number(suffixRange.headers['content-length']), 16);
    assert.equal(suffixRange.body.length, 16);
  } finally {
    await server.stop();
  }
});

test('music server does not abort recommendation work after a normal request body finishes', async () => {
  const port = await getFreePort();
  let observedSignalAborted = null;
  const server = createMusicServer({
    getAuthStatus: () => ({ enabled: false }),
    getRecommendations: async (_payload, { signal } = {}) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      observedSignalAborted = signal?.aborted || false;
      return {
        items: [],
        total: 0,
        page: 1,
        pageSize: 5,
        totalPages: 1
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
      path: '/api/recommendations',
      body: {
        title: 'Apollo',
        artist: 'Tester'
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(observedSignalAborted, false);
  } finally {
    await server.stop();
  }
});

test('music server keeps shared recommendation work alive when the first client disconnects', async () => {
  const port = await getFreePort();
  let callCount = 0;
  const server = createMusicServer({
    getAuthStatus: () => ({ enabled: false }),
    getRecommendations: async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        items: [{ id: 'shared-result' }],
        total: 1,
        page: 1,
        pageSize: 5,
        totalPages: 1
      };
    }
  });

  try {
    await server.start({
      host: '127.0.0.1',
      port
    });

    const firstRequest = await createStreamingJsonRequest({
      port,
      path: '/api/recommendations',
      body: {
        title: 'Apollo',
        artist: 'Tester'
      }
    });
    firstRequest.request.destroy();

    const secondResponse = await sendJsonRequest({
      port,
      method: 'POST',
      path: '/api/recommendations',
      body: {
        title: 'Apollo',
        artist: 'Tester'
      }
    });

    assert.equal(secondResponse.statusCode, 200);
    assert.equal(secondResponse.body.items.length, 1);
    assert.equal(callCount, 1);
  } finally {
    await server.stop();
  }
});
