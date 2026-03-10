const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { createAbortError, createHttpError, isAbortError } = require('./http-error');
const { SearchCoordinator } = require('./search-coordinator');

const MIME_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
}

function isResponseClosed(response) {
  return response.destroyed || response.writableEnded;
}

function sendJson(response, statusCode, payload) {
  if (isResponseClosed(response)) {
    return;
  }

  setCorsHeaders(response);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json'
  });
  response.end(JSON.stringify(payload));
}

function sendNoContent(response) {
  if (isResponseClosed(response)) {
    return;
  }

  setCorsHeaders(response);
  response.writeHead(204);
  response.end();
}

function notFound(response) {
  sendJson(response, 404, { error: 'Not found.' });
}

async function readBufferBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      resolve(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
    });
    request.on('error', reject);
  });
}

async function readBody(request) {
  const body = await readBufferBody(request);
  if (!body.length) {
    return {};
  }

  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw createHttpError(400, 'Invalid JSON body.');
  }
}

async function readMultipartArtwork(request) {
  const contentType = request.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw createHttpError(400, 'Missing multipart boundary.');
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const buffer = await readBufferBody(request);
  const raw = buffer.toString('latin1');
  const sections = raw.split(`--${boundary}`).slice(1, -1);

  for (const section of sections) {
    const trimmedSection = section.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const headerEnd = trimmedSection.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      continue;
    }

    const headerText = trimmedSection.slice(0, headerEnd);
    const bodyText = trimmedSection.slice(headerEnd + 4);
    const headerLines = headerText.split('\r\n');
    const headers = Object.fromEntries(
      headerLines.map((line) => {
        const separatorIndex = line.indexOf(':');
        return [
          line.slice(0, separatorIndex).trim().toLowerCase(),
          line.slice(separatorIndex + 1).trim()
        ];
      })
    );

    const disposition = headers['content-disposition'] || '';
    const nameMatch = disposition.match(/name="?([^";]+)"?/i);
    const fileNameMatch = disposition.match(/filename="?([^";]*)"?/i);

    if (!nameMatch || nameMatch[1] !== 'artwork' || !fileNameMatch || !fileNameMatch[1]) {
      continue;
    }

    return {
      fieldName: nameMatch[1],
      fileName: path.basename(fileNameMatch[1]),
      contentType: headers['content-type'] || 'application/octet-stream',
      buffer: Buffer.from(bodyText, 'latin1')
    };
  }

  throw createHttpError(400, 'No artwork file was provided.');
}

function serveStaticFile(response, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    notFound(response);
    return;
  }

  const stat = fs.statSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';

  setCorsHeaders(response);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size
  });
  fs.createReadStream(filePath).pipe(response);
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

  setCorsHeaders(response);
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

function extractAccessToken(request, requestUrl) {
  const authorization = request.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }

  return requestUrl.searchParams.get('access_token') || '';
}

function isPublicRoute(request, pathname) {
  return (
    (request.method === 'GET' && pathname === '/api/auth/status') ||
    (request.method === 'POST' && pathname === '/api/auth/session')
  );
}

function createMusicServer(services) {
  let server = null;
  const searchCoordinator = new SearchCoordinator();
  let serverInfo = {
    running: false,
    host: '',
    port: '',
    baseUrl: ''
  };

  async function handleRequest(request, response) {
    if (request.method === 'OPTIONS') {
      sendNoContent(response);
      return;
    }

    const requestUrl = new URL(request.url, 'http://localhost');
    const pathname = requestUrl.pathname;
    const accessToken = extractAccessToken(request, requestUrl);

    try {
      if (request.method === 'GET' && pathname === '/api/auth/status') {
        sendJson(response, 200, services.getAuthStatus());
        return;
      }

      if (request.method === 'POST' && pathname === '/api/auth/session') {
        const body = await readBody(request);
        sendJson(response, 201, services.createAuthSession(body));
        return;
      }

      if (!isPublicRoute(request, pathname)) {
        const authStatus = services.getAuthStatus();
        if (authStatus.enabled) {
          const session = services.authenticateRequest({ token: accessToken });
          if (!session) {
            sendJson(response, 401, { error: 'Authentication required.' });
            return;
          }
        }
      }

      const playlistArtworkMatch = pathname.match(/^\/media\/playlists\/([^/]+)$/);
      if (request.method === 'GET' && playlistArtworkMatch) {
        serveStaticFile(response, services.getPlaylistArtworkPath(decodeURIComponent(playlistArtworkMatch[1])));
        return;
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, {
          status: 'ok',
          server: serverInfo,
          overview: services.getOverview()
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/tracks') {
        sendJson(
          response,
          200,
          services.listTracks({
            query: requestUrl.searchParams.get('q') || '',
            page: requestUrl.searchParams.get('page') || '1',
            pageSize: requestUrl.searchParams.get('pageSize') || '20'
          })
        );
        return;
      }

      const trackRoute = pathname.match(/^\/api\/tracks\/([^/]+)$/);
      if (request.method === 'DELETE' && trackRoute) {
        sendJson(response, 200, await services.deleteTrack(trackRoute[1]));
        return;
      }

      if (request.method === 'GET' && pathname === '/api/search') {
        const payload = {
          query: requestUrl.searchParams.get('query') || requestUrl.searchParams.get('q') || '',
          provider: requestUrl.searchParams.get('provider') || 'all',
          scope: requestUrl.searchParams.get('scope') || 'all',
          page: requestUrl.searchParams.get('page') || '1',
          pageSize: requestUrl.searchParams.get('pageSize') || '20'
        };
        const clientKey = searchCoordinator.resolveClientKey({
          request,
          requestUrl,
          accessToken
        });
        const requestController = new AbortController();
        const cancelSearch = () => {
          if (!requestController.signal.aborted) {
            requestController.abort(createAbortError('Search request was closed by the client.', 499));
          }
        };

        request.once('aborted', cancelSearch);
        request.once('close', cancelSearch);

        try {
          const result = await searchCoordinator.runSearch({
            clientKey,
            cacheKey: searchCoordinator.createCacheKey(payload),
            requestSignal: requestController.signal,
            execute: ({ signal }) => services.searchCatalog(payload, { signal })
          });

          sendJson(response, 200, result);
        } finally {
          request.off('aborted', cancelSearch);
          request.off('close', cancelSearch);
        }

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

      const playlistArtworkRoute = pathname.match(/^\/api\/playlists\/([^/]+)\/artwork$/);
      if (request.method === 'POST' && playlistArtworkRoute) {
        const artwork = await readMultipartArtwork(request);
        sendJson(response, 200, await services.uploadPlaylistArtwork(playlistArtworkRoute[1], artwork));
        return;
      }

      if (request.method === 'DELETE' && playlistArtworkRoute) {
        sendJson(response, 200, await services.deletePlaylistArtwork(playlistArtworkRoute[1]));
        return;
      }

      const playlistTracksRoute = pathname.match(/^\/api\/playlists\/([^/]+)\/tracks$/);
      if (request.method === 'POST' && playlistTracksRoute) {
        const body = await readBody(request);
        sendJson(response, 200, await services.addTrackToPlaylist(playlistTracksRoute[1], body.trackId));
        return;
      }

      const playlistTrackRoute = pathname.match(/^\/api\/playlists\/([^/]+)\/tracks\/([^/]+)$/);
      if (request.method === 'DELETE' && playlistTrackRoute) {
        sendJson(response, 200, await services.removeTrackFromPlaylist(playlistTrackRoute[1], playlistTrackRoute[2]));
        return;
      }

      const playlistRoute = pathname.match(/^\/api\/playlists\/([^/]+)$/);
      if (request.method === 'GET' && playlistRoute) {
        const playlist = services.getPlaylist(playlistRoute[1]);
        if (!playlist) {
          notFound(response);
          return;
        }

        sendJson(response, 200, playlist);
        return;
      }

      if (request.method === 'PATCH' && playlistRoute) {
        const body = await readBody(request);
        sendJson(response, 200, await services.updatePlaylist(playlistRoute[1], body));
        return;
      }

      if (request.method === 'DELETE' && playlistRoute) {
        sendJson(response, 200, await services.deletePlaylist(playlistRoute[1]));
        return;
      }

      if (request.method === 'GET' && pathname === '/api/downloads') {
        sendJson(response, 200, { items: services.listDownloads() });
        return;
      }

      const downloadRoute = pathname.match(/^\/api\/downloads\/([^/]+)$/);
      if (request.method === 'GET' && downloadRoute) {
        const download = services.getDownload(downloadRoute[1]);
        if (!download) {
          notFound(response);
          return;
        }

        sendJson(response, 200, download);
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

      if (request.method === 'DELETE' && pathname === '/api/auth/session') {
        const token = extractAccessToken(request, requestUrl);
        sendJson(response, 200, services.revokeAuthSession({ token }));
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
      if (isAbortError(error) && isResponseClosed(response)) {
        return;
      }

      if (isResponseClosed(response)) {
        return;
      }

      sendJson(response, error.statusCode || 500, { error: error.message });
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
