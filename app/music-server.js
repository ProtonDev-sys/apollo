const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const MIME_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
  });
  response.end(JSON.stringify(payload));
}

function notFound(response) {
  sendJson(response, 404, { error: 'Not found.' });
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body.'));
      }
    });
    request.on('error', reject);
  });
}

function streamTrack(request, response, track, requestUrl) {
  if (!track || !track.filePath || !fs.existsSync(track.filePath)) {
    notFound(response);
    return;
  }

  const stat = fs.statSync(track.filePath);
  const extension = path.extname(track.filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  const range = request.headers.range;

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', contentType);
  if (requestUrl.searchParams.get('download') === '1') {
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(track.fileName || path.basename(track.filePath))}"`
    );
  }

  if (!range) {
    response.writeHead(200, {
      'Content-Length': stat.size
    });
    fs.createReadStream(track.filePath).pipe(response);
    return;
  }

  const [startText, endText] = range.replace(/bytes=/, '').split('-');
  const start = Number.parseInt(startText, 10) || 0;
  const end = endText ? Number.parseInt(endText, 10) : stat.size - 1;

  if (start >= stat.size || end >= stat.size) {
    response.writeHead(416, {
      'Content-Range': `bytes */${stat.size}`
    });
    response.end();
    return;
  }

  response.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1
  });
  fs.createReadStream(track.filePath, { start, end }).pipe(response);
}

function createMusicServer(services) {
  let server = null;
  let serverInfo = {
    running: false,
    host: '',
    port: '',
    baseUrl: ''
  };

  async function handleRequest(request, response) {
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }

    const requestUrl = new URL(request.url, 'http://localhost');
    const pathname = requestUrl.pathname;

    try {
      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, {
          status: 'ok',
          server: serverInfo,
          overview: services.getOverview()
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/tracks') {
        sendJson(response, 200, services.listTracks({
          query: requestUrl.searchParams.get('q') || '',
          page: requestUrl.searchParams.get('page') || '1',
          pageSize: requestUrl.searchParams.get('pageSize') || '20'
        }));
        return;
      }

      if (request.method === 'GET' && pathname === '/api/search') {
        sendJson(response, 200, await services.searchCatalog({
          query: requestUrl.searchParams.get('query') || requestUrl.searchParams.get('q') || '',
          provider: requestUrl.searchParams.get('provider') || 'all',
          scope: requestUrl.searchParams.get('scope') || 'all',
          page: requestUrl.searchParams.get('page') || '1',
          pageSize: requestUrl.searchParams.get('pageSize') || '20'
        }));
        return;
      }

      if (request.method === 'POST' && pathname === '/api/playback') {
        const body = await readBody(request);
        sendJson(response, 200, await services.resolvePlayback(body));
        return;
      }

      if (request.method === 'GET' && pathname === '/api/playlists') {
        sendJson(response, 200, { items: services.listPlaylists() });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/playlists') {
        const body = await readBody(request);
        sendJson(response, 201, await services.createPlaylist(body));
        return;
      }

      const addTrackMatch = pathname.match(/^\/api\/playlists\/([^/]+)\/tracks$/);
      if (request.method === 'POST' && addTrackMatch) {
        const body = await readBody(request);
        sendJson(response, 200, await services.addTrackToPlaylist(addTrackMatch[1], body.trackId));
        return;
      }

      const removeTrackMatch = pathname.match(/^\/api\/playlists\/([^/]+)\/tracks\/([^/]+)$/);
      if (request.method === 'DELETE' && removeTrackMatch) {
        sendJson(response, 200, await services.removeTrackFromPlaylist(removeTrackMatch[1], removeTrackMatch[2]));
        return;
      }

      if (request.method === 'GET' && pathname === '/api/downloads') {
        sendJson(response, 200, { items: services.listDownloads() });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/downloads/server') {
        const body = await readBody(request);
        sendJson(response, 202, await services.queueDownload(body));
        return;
      }

      if (request.method === 'POST' && pathname === '/api/downloads/client') {
        const body = await readBody(request);
        sendJson(response, 200, await services.resolveClientDownload(body));
        return;
      }

      if (request.method === 'POST' && pathname === '/api/inspect-link') {
        const body = await readBody(request);
        sendJson(response, 200, await services.inspectLink(body.url || ''));
        return;
      }

      if (request.method === 'POST' && pathname === '/api/library/rescan') {
        sendJson(response, 200, await services.rescanLibrary());
        return;
      }

      const streamMatch = pathname.match(/^\/stream\/([^/]+)$/);
      if (request.method === 'GET' && streamMatch) {
        streamTrack(request, response, services.getTrack(streamMatch[1]), requestUrl);
        return;
      }

      notFound(response);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  }

  async function start({ host, port }) {
    await stop();

    await new Promise((resolve, reject) => {
      server = http.createServer((request, response) => {
        void handleRequest(request, response);
      });

      server.on('error', reject);
      server.listen(Number.parseInt(port, 10), host, () => {
        resolve();
      });
    });

    serverInfo = {
      running: true,
      host,
      port: String(port),
      baseUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
    };

    return serverInfo;
  }

  async function stop() {
    if (!server) {
      serverInfo = {
        running: false,
        host: '',
        port: '',
        baseUrl: ''
      };
      return;
    }

    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    server = null;
    serverInfo = {
      running: false,
      host: '',
      port: '',
      baseUrl: ''
    };
  }

  return {
    start,
    stop,
    getInfo: () => ({ ...serverInfo })
  };
}

module.exports = {
  createMusicServer
};
