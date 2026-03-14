const fs = require('fs');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream');
const { URL } = require('url');
const { createAbortError, createHttpError, isAbortError } = require('./http-error');
const { RequestCoordinator } = require('./request-coordinator');
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

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

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

function startEventStream(response) {
  if (isResponseClosed(response)) {
    return;
  }

  setCorsHeaders(response);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.flushHeaders?.();
}

function sendEventStreamMessage(response, eventName, payload) {
  if (isResponseClosed(response)) {
    return;
  }

  if (eventName) {
    response.write(`event: ${eventName}\n`);
  }

  const serializedPayload = JSON.stringify(payload);
  for (const line of serializedPayload.split(/\r?\n/)) {
    response.write(`data: ${line}\n`);
  }

  response.write('\n');
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

function createRequestAbortController(request, message = 'Request was closed by the client.') {
  const controller = new AbortController();
  const abortRequest = () => {
    if (!controller.signal.aborted) {
      controller.abort(createAbortError(message, 499));
    }
  };

  // `IncomingMessage.close` fires after a request completes in modern Node,
  // so use the underlying socket close instead to detect real disconnects.
  const clientSocket = request.socket;
  request.once('aborted', abortRequest);
  clientSocket?.once('close', abortRequest);

  return {
    signal: controller.signal,
    detach() {
      request.off('aborted', abortRequest);
      clientSocket?.off('close', abortRequest);
    }
  };
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

function pipeFileStream(request, response, filePath, headers = {}) {
  const fileStream = fs.createReadStream(filePath, headers.range || {});
  const destroyStream = () => {
    fileStream.destroy();
  };

  request.once('close', destroyStream);
  response.once('close', destroyStream);
  fileStream.once('error', () => {
    if (!isResponseClosed(response)) {
      response.destroy();
    }
  });

  pipeline(fileStream, response, () => {
    request.off('close', destroyStream);
    response.off('close', destroyStream);
  });
}

function serveStaticFile(request, response, filePath) {
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
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=60'
  });
  pipeFileStream(request, response, filePath);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function streamRemotePlayback(request, response, sourceUrl, abortSignal) {
  if (!isHttpUrl(sourceUrl)) {
    throw createHttpError(400, 'Remote playback proxy requires an http or https URL.');
  }

  const upstreamHeaders = {};
  if (request.headers.range) {
    upstreamHeaders.range = request.headers.range;
  }
  if (request.headers['user-agent']) {
    upstreamHeaders['user-agent'] = request.headers['user-agent'];
  }
  if (request.headers.accept) {
    upstreamHeaders.accept = request.headers.accept;
  }

  const upstreamResponse = await fetch(sourceUrl, {
    headers: upstreamHeaders,
    redirect: 'follow',
    signal: abortSignal
  });
  if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
    throw createHttpError(upstreamResponse.status || 502, `Remote playback proxy failed with status ${upstreamResponse.status || 502}.`);
  }
  if (!upstreamResponse.body) {
    throw createHttpError(502, 'Remote playback proxy did not receive an audio stream.');
  }

  setCorsHeaders(response);
  response.statusCode = upstreamResponse.status;
  const forwardHeaders = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'etag',
    'last-modified'
  ];
  for (const headerName of forwardHeaders) {
    const headerValue = upstreamResponse.headers.get(headerName);
    if (headerValue) {
      response.setHeader(headerName, headerValue);
    }
  }
  response.flushHeaders?.();

  const upstreamStream = Readable.fromWeb(upstreamResponse.body);
  const destroyStream = () => {
    upstreamStream.destroy();
  };

  request.once('close', destroyStream);
  response.once('close', destroyStream);

  pipeline(upstreamStream, response, () => {
    request.off('close', destroyStream);
    response.off('close', destroyStream);
  });
}

function parseByteRange(rangeHeader, fileSize) {
  const match = String(rangeHeader || '').match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) {
    return null;
  }

  const [, startText, endText] = match;
  if (!startText && !endText) {
    return null;
  }

  let start = 0;
  let end = fileSize - 1;

  if (startText && endText) {
    start = Number.parseInt(startText, 10);
    end = Number.parseInt(endText, 10);
  } else if (startText) {
    start = Number.parseInt(startText, 10);
  } else {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    start = Math.max(0, fileSize - suffixLength);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null;
  }

  return {
    start,
    end: Math.min(end, fileSize - 1)
  };
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
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    pipeFileStream(request, response, track.filePath);
    return;
  }

  const parsedRange = parseByteRange(range, stat.size);

  if (!parsedRange || parsedRange.start >= stat.size) {
    response.writeHead(416, {
      'Content-Range': `bytes */${stat.size}`
    });
    response.end();
    return;
  }

  const { start, end } = parsedRange;

  response.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-store'
  });
  pipeFileStream(request, response, track.filePath, {
    range: { start, end }
  });
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
  const requestCoordinator = new RequestCoordinator({
    cacheTtlMs: 10000,
    maxCacheEntries: 200
  });
  const rescanCoordinator = new RequestCoordinator();
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
        serveStaticFile(
          request,
          response,
          services.getPlaylistArtworkPath(decodeURIComponent(playlistArtworkMatch[1]))
        );
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

      if (request.method === 'GET' && pathname === '/api/artists') {
        const payload = {
          query: requestUrl.searchParams.get('query') || requestUrl.searchParams.get('q') || '',
          page: requestUrl.searchParams.get('page') || '1',
          pageSize: requestUrl.searchParams.get('pageSize') || '20'
        };
        const requestAbort = createRequestAbortController(
          request,
          'Artist search request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `artist-search:${stableSerialize(payload)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.searchArtists(payload)
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      const artistTracksRoute = pathname.match(/^\/api\/artists\/([^/]+)\/tracks$/);
      if (request.method === 'GET' && artistTracksRoute) {
        const payload = {
          page: requestUrl.searchParams.get('page') || '1',
          pageSize: requestUrl.searchParams.get('pageSize') || '25'
        };
        const requestAbort = createRequestAbortController(
          request,
          'Artist track request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `artist-tracks:${artistTracksRoute[1]}:${stableSerialize(payload)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.listArtistTracks(artistTracksRoute[1], payload)
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      const artistReleasesRoute = pathname.match(/^\/api\/artists\/([^/]+)\/releases$/);
      if (request.method === 'GET' && artistReleasesRoute) {
        const payload = {
          page: requestUrl.searchParams.get('page') || '1',
          pageSize: requestUrl.searchParams.get('pageSize') || '20'
        };
        const requestAbort = createRequestAbortController(
          request,
          'Artist releases request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `artist-releases:${artistReleasesRoute[1]}:${stableSerialize(payload)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.listArtistReleases(artistReleasesRoute[1], payload)
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      const releaseTracksRoute = pathname.match(/^\/api\/releases\/([^/]+)\/tracks$/);
      if (request.method === 'GET' && releaseTracksRoute) {
        const requestAbort = createRequestAbortController(
          request,
          'Release track request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `release-tracks:${releaseTracksRoute[1]}`,
            requestSignal: requestAbort.signal,
            execute: () => services.listReleaseTracks(releaseTracksRoute[1])
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      const artistRoute = pathname.match(/^\/api\/artists\/([^/]+)$/);
      if (request.method === 'GET' && artistRoute) {
        const requestAbort = createRequestAbortController(
          request,
          'Artist profile request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `artist:${artistRoute[1]}`,
            requestSignal: requestAbort.signal,
            execute: () => services.getArtist(artistRoute[1])
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      const trackRoute = pathname.match(/^\/api\/tracks\/([^/]+)$/);
      const trackRelatedRoute = pathname.match(/^\/api\/tracks\/([^/]+)\/related$/);
      if (request.method === 'GET' && trackRelatedRoute) {
        const payload = {
          limit: requestUrl.searchParams.get('limit') || '12'
        };
        const requestAbort = createRequestAbortController(
          request,
          'Related track request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `related:${trackRelatedRoute[1]}:${stableSerialize(payload)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.getRelatedTracks(trackRelatedRoute[1], payload)
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

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
        const wantsStreamingSearch =
          requestUrl.searchParams.get('stream') === '1' ||
          String(request.headers.accept || '').includes('text/event-stream');
        const clientKey = searchCoordinator.resolveClientKey({
          request,
          requestUrl,
          accessToken
        });
        const requestAbort = createRequestAbortController(
          request,
          'Search request was closed by the client.'
        );

        try {
          if (wantsStreamingSearch) {
            startEventStream(response);
            const cacheKey = searchCoordinator.createCacheKey(payload);
            const startedSearch = searchCoordinator.beginSearch({
              clientKey,
              cacheKey,
              requestSignal: requestAbort.signal
            });

            let finalSnapshot = startedSearch.cached;
            if (startedSearch.cached) {
              sendEventStreamMessage(response, 'snapshot', startedSearch.cached);
              sendEventStreamMessage(response, 'done', startedSearch.cached);
              response.end();
              return;
            }

            try {
              for await (const snapshot of services.searchCatalogStream(payload, {
                signal: startedSearch.signal
              })) {
                finalSnapshot = snapshot;
                sendEventStreamMessage(
                  response,
                  snapshot.remote?.progress?.complete ? 'done' : 'snapshot',
                  snapshot
                );
              }

              if (finalSnapshot) {
                searchCoordinator.finishSearch(startedSearch.entry, finalSnapshot);
              }

              if (!isResponseClosed(response)) {
                response.end();
              }
            } finally {
              searchCoordinator.releaseSearch(startedSearch.entry);
            }

            return;
          }

          const result = await searchCoordinator.runSearch({
            clientKey,
            cacheKey: searchCoordinator.createCacheKey(payload),
            requestSignal: requestAbort.signal,
            execute: ({ signal }) => services.searchCatalog(payload, { signal })
          });

          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }

        return;
      }

      if (request.method === 'POST' && pathname === '/api/playback') {
        const body = await readBody(request);
        const requestAbort = createRequestAbortController(
          request,
          'Playback resolution request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `playback:${stableSerialize(body)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.resolvePlayback(body)
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      if (request.method === 'POST' && pathname === '/api/recommendations') {
        const body = await readBody(request);
        const requestAbort = createRequestAbortController(
          request,
          'Recommendation request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `recommendations:${stableSerialize(body)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.getRecommendations(body)
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
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

      if (request.method === 'POST' && pathname === '/api/playlists/import') {
        const body = await readBody(request);
        const requestAbort = createRequestAbortController(
          request,
          'Playlist import request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `playlist-import:${stableSerialize(body)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.importPlaylistFromUrl(body)
          });
          sendJson(response, 201, result);
        } finally {
          requestAbort.detach();
        }
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
        const requestAbort = createRequestAbortController(
          request,
          'Client download resolution request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `client-download:${stableSerialize(body)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.resolveClientDownload(body)
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      if (request.method === 'POST' && pathname === '/api/inspect-link') {
        const body = await readBody(request);
        const requestAbort = createRequestAbortController(
          request,
          'Link inspection request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `inspect-link:${stableSerialize({ url: body.url || '' })}`,
            requestSignal: requestAbort.signal,
            execute: () => services.inspectLink(body.url || '')
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      if (request.method === 'POST' && pathname === '/api/resolve-shared-track') {
        const body = await readBody(request);
        const requestAbort = createRequestAbortController(
          request,
          'Shared track resolution request was closed by the client.'
        );

        try {
          const result = await requestCoordinator.run({
            cacheKey: `resolve-shared-track:${stableSerialize(body)}`,
            requestSignal: requestAbort.signal,
            execute: () => services.resolveSharedTrack(body)
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      if (request.method === 'DELETE' && pathname === '/api/auth/session') {
        const token = extractAccessToken(request, requestUrl);
        sendJson(response, 200, services.revokeAuthSession({ token }));
        return;
      }

      if (request.method === 'POST' && pathname === '/api/library/rescan') {
        const requestAbort = createRequestAbortController(
          request,
          'Library rescan request was closed by the client.'
        );

        try {
          const result = await rescanCoordinator.run({
            cacheKey: 'library:rescan',
            requestSignal: requestAbort.signal,
            execute: () => services.rescanLibrary()
          });
          sendJson(response, 200, result);
        } finally {
          requestAbort.detach();
        }
        return;
      }

      const streamMatch = pathname.match(/^\/stream\/([^/]+)$/);
      if (request.method === 'GET' && streamMatch) {
        streamTrack(request, response, services.getTrack(streamMatch[1]), requestUrl);
        return;
      }

      if (request.method === 'GET' && pathname === '/api/playback-proxy') {
        const requestAbort = createRequestAbortController(
          request,
          'Remote playback proxy request was closed by the client.'
        );

        try {
          await streamRemotePlayback(
            request,
            response,
            requestUrl.searchParams.get('source') || '',
            requestAbort.signal
          );
        } finally {
          requestAbort.detach();
        }
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

      if (String(response.getHeader('Content-Type') || '').includes('text/event-stream')) {
        sendEventStreamMessage(response, 'error', { error: error.message });
        response.end();
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
      server.keepAliveTimeout = 60000;
      server.headersTimeout = 65000;
      server.requestTimeout = 0;

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
