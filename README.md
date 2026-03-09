# Apollo

Apollo is the server-side app for a personal music system. It ships with:

- a minimal Electron config UI
- a headless CLI that runs the same server stack
- a shared config file used by both UI and CLI

## What it does

- starts a local HTTP API for tracks, playlists, downloads, and streaming
- manages a persistent library catalog and playlist data
- downloads tracks into an organised music library using `yt-dlp` and `ffmpeg`
- supports provider search with pagination and direct-link ingest
- exposes stream URLs for future client apps through `/stream/:trackId`

## Requirements

- Node.js 20+
- `yt-dlp`
- `ffmpeg`
- optional Spotify API credentials for Spotify metadata search

## Install and first setup

### 1. Install Node.js

Install Node.js 20 or newer.

Windows:

```powershell
winget install OpenJS.NodeJS.LTS
```

### 2. Install Apollo dependencies

Apollo needs `yt-dlp` and `ffmpeg` for provider search, playback resolution, and server-side downloads.

Windows:

```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg.Essentials
```

If you already have custom installs of either tool, you can point Apollo at them in the UI or shared config file.

### 3. Install project dependencies

From the project folder:

```powershell
npm.cmd install
```

### 4. Optional Spotify setup

Spotify support is metadata-only. It is optional.

If you want Spotify search:

1. Go to `https://developer.spotify.com/dashboard`
2. Sign in with your Spotify account
3. Click `Create app`
4. Give the app a name and description, then create it
5. Open the app you just created in the Spotify Developer Dashboard
6. Copy the `Client ID`
7. Click `View client secret`, then copy the `Client Secret`
8. Paste both values into Apollo in either:

- the Electron UI config screen
- the shared config file at `C:\Users\<you>\AppData\Roaming\apollo\config.json`

If you edit the config file directly, set the Spotify fields there and restart Apollo so the new credentials are loaded.

### 5. Shared config location

Apollo UI and Apollo CLI use the same config file:

```text
C:\Users\<you>\AppData\Roaming\apollo\config.json
```

You can print the exact path on your machine with:

```powershell
npm.cmd run config:path
```

## Run the UI

```powershell
npm.cmd install
npm.cmd start
```

## Run headless

```powershell
npm.cmd run start:cli
```

## Shared config

The Electron app and CLI use the same config file and data directory.

Print the config path:

```powershell
npm.cmd run config:path
```

Print the current config:

```powershell
npm.cmd run config:print
```

Export a copy of the current config:

```powershell
node cli.js export-config .\apollo.config.json
```

## API

Apollo exposes a local HTTP API on the host and port in your config.

Default base URL:

```text
http://127.0.0.1:4848
```

General notes:

- request and response bodies are JSON unless noted otherwise
- set header `Content-Type: application/json` on `POST` requests
- CORS is enabled with `Access-Control-Allow-Origin: *`
- pagination is 1-based
- `pageSize` is capped internally for search and track listing

### `GET /api/health`

Returns server status and library overview.

Example:

```powershell
curl.exe http://127.0.0.1:4848/api/health
```

Response shape:

```json
{
  "status": "ok",
  "server": {
    "running": true,
    "host": "127.0.0.1",
    "port": "4848",
    "baseUrl": "http://127.0.0.1:4848"
  },
  "overview": {
    "trackCount": 0,
    "playlistCount": 0,
    "downloadCount": 0,
    "completedDownloads": 0
  }
}
```

### `GET /api/tracks`

Lists downloaded library tracks only.

Query params:

- `q`: optional text search across title, artist, album, and file path
- `page`: optional, default `1`
- `pageSize`: optional, default `20`

Example:

```powershell
curl.exe "http://127.0.0.1:4848/api/tracks?q=daft&page=1&pageSize=20"
```

Response shape:

```json
{
  "items": [
    {
      "id": "track-id",
      "title": "Harder Better Faster Stronger",
      "artist": "Daft Punk",
      "album": "Discovery",
      "duration": 224,
      "provider": "library",
      "sourceUrl": "",
      "filePath": "C:\\Music\\Apollo\\library\\Daft Punk\\Discovery\\Harder Better Faster Stronger.mp3",
      "fileName": "Harder Better Faster Stronger.mp3",
      "addedAt": "2026-03-09T10:00:00.000Z",
      "updatedAt": "2026-03-09T10:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "totalPages": 1
}
```

### `GET /api/search`

Searches both the local library and remote providers so clients can search tracks whether they are downloaded or not.

Query params:

- `query` or `q`: search term
- `scope`: `all`, `library`, or `remote`
- `provider`: `all`, `youtube`, `soundcloud`, or `spotify`
- `page`: optional, default `1`
- `pageSize`: optional, default `20`

Example:

```powershell
curl.exe "http://127.0.0.1:4848/api/search?query=daft%20punk&scope=all&provider=all&page=1&pageSize=10"
```

Response shape:

```json
{
  "query": "daft punk",
  "provider": "all",
  "scope": "all",
  "library": {
    "items": [],
    "total": 0,
    "page": 1,
    "pageSize": 10,
    "totalPages": 1
  },
  "remote": {
    "items": [
      {
        "id": "youtube:abc123",
        "provider": "youtube",
        "title": "Daft Punk - One More Time",
        "artist": "Daft Punk",
        "album": "YouTube",
        "duration": 321,
        "artwork": "",
        "externalUrl": "https://www.youtube.com/watch?v=abc123",
        "downloadTarget": "https://www.youtube.com/watch?v=abc123"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 10,
    "totalPages": 1,
    "warning": ""
  }
}
```

Notes:

- `library.items` contain downloaded tracks formatted for playback through Apollo
- `remote.items` contain provider results that can be played directly or queued for download
- Spotify results require `spotifyClientId` and `spotifyClientSecret` in config

### `POST /api/playback`

Resolves a playable URL for either a downloaded library track or a remote result.

For a library track:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/playback `
  -H "Content-Type: application/json" `
  -d "{\"trackId\":\"track-id\"}"
```

For a remote result:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/playback `
  -H "Content-Type: application/json" `
  -d "{\"provider\":\"youtube\",\"title\":\"One More Time\",\"artist\":\"Daft Punk\",\"downloadTarget\":\"https://www.youtube.com/watch?v=abc123\"}"
```

Library response shape:

```json
{
  "type": "library",
  "streamUrl": "http://127.0.0.1:4848/stream/track-id",
  "downloadUrl": "http://127.0.0.1:4848/stream/track-id?download=1",
  "title": "One More Time",
  "artist": "Daft Punk",
  "album": "Discovery"
}
```

Remote response shape:

```json
{
  "type": "remote",
  "streamUrl": "https://resolved-media-url",
  "downloadUrl": "https://resolved-media-url",
  "title": "One More Time",
  "artist": "Daft Punk",
  "album": "Discovery",
  "fileName": "Daft Punk - One More Time.mp3"
}
```

### `POST /api/downloads/server`

Queues a remote item to be downloaded, converted, organised into the library, and indexed on the server.

Example:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/downloads/server `
  -H "Content-Type: application/json" `
  -d "{\"provider\":\"youtube\",\"title\":\"One More Time\",\"artist\":\"Daft Punk\",\"album\":\"Discovery\",\"downloadTarget\":\"https://www.youtube.com/watch?v=abc123\",\"externalUrl\":\"https://www.youtube.com/watch?v=abc123\"}"
```

Response shape:

```json
{
  "id": "download-id",
  "title": "One More Time",
  "artist": "Daft Punk",
  "album": "Discovery",
  "provider": "youtube",
  "sourceUrl": "https://www.youtube.com/watch?v=abc123",
  "status": "queued",
  "progress": 0,
  "message": "Waiting for worker...",
  "outputPath": "",
  "trackId": "",
  "createdAt": "2026-03-09T10:00:00.000Z",
  "updatedAt": "2026-03-09T10:00:00.000Z"
}
```

Statuses:

- `queued`
- `running`
- `completed`
- `failed`

### `GET /api/downloads`

Lists download jobs, newest first.

Example:

```powershell
curl.exe http://127.0.0.1:4848/api/downloads
```

Response shape:

```json
{
  "items": [
    {
      "id": "download-id",
      "status": "completed",
      "progress": 100,
      "message": "Downloaded and indexed in the library.",
      "trackId": "track-id",
      "outputPath": "C:\\Music\\Apollo\\library\\Daft Punk\\Discovery\\One More Time.mp3"
    }
  ]
}
```

### `POST /api/downloads/client`

Resolves a download URL for the client without storing the file on the Apollo server.

For a library track:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/downloads/client `
  -H "Content-Type: application/json" `
  -d "{\"trackId\":\"track-id\"}"
```

For a remote result:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/downloads/client `
  -H "Content-Type: application/json" `
  -d "{\"provider\":\"youtube\",\"title\":\"One More Time\",\"artist\":\"Daft Punk\",\"downloadTarget\":\"https://www.youtube.com/watch?v=abc123\"}"
```

Response shape:

```json
{
  "type": "remote",
  "downloadUrl": "https://resolved-media-url",
  "fileName": "Daft Punk - One More Time.mp3",
  "title": "One More Time",
  "artist": "Daft Punk"
}
```

### `POST /api/inspect-link`

Inspects a direct media URL and returns a normalized item that can be used for playback or download.

Example:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/inspect-link `
  -H "Content-Type: application/json" `
  -d "{\"url\":\"https://www.youtube.com/watch?v=abc123\"}"
```

Response shape:

```json
{
  "id": "link:abc123",
  "provider": "youtube",
  "title": "One More Time",
  "artist": "Daft Punk",
  "album": "Singles",
  "duration": 321,
  "artwork": "",
  "externalUrl": "https://www.youtube.com/watch?v=abc123",
  "downloadTarget": "https://www.youtube.com/watch?v=abc123"
}
```

### `POST /api/library/rescan`

Rescans the configured library directory and reindexes files.

Example:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/library/rescan
```

Response shape:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 8,
  "totalPages": 1
}
```

### `GET /api/playlists`

Lists playlists with expanded track objects.

Example:

```powershell
curl.exe http://127.0.0.1:4848/api/playlists
```

Response shape:

```json
{
  "items": [
    {
      "id": "playlist-id",
      "name": "Favorites",
      "description": "",
      "trackIds": ["track-id"],
      "tracks": [
        {
          "id": "track-id",
          "title": "One More Time",
          "artist": "Daft Punk"
        }
      ],
      "createdAt": "2026-03-09T10:00:00.000Z",
      "updatedAt": "2026-03-09T10:00:00.000Z"
    }
  ]
}
```

### `POST /api/playlists`

Creates a playlist.

Example:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/playlists `
  -H "Content-Type: application/json" `
  -d "{\"name\":\"Favorites\",\"description\":\"Main rotation\"}"
```

### `POST /api/playlists/:id/tracks`

Adds a downloaded library track to a playlist.

Example:

```powershell
curl.exe -X POST http://127.0.0.1:4848/api/playlists/playlist-id/tracks `
  -H "Content-Type: application/json" `
  -d "{\"trackId\":\"track-id\"}"
```

### `DELETE /api/playlists/:id/tracks/:trackId`

Removes a track from a playlist.

Example:

```powershell
curl.exe -X DELETE http://127.0.0.1:4848/api/playlists/playlist-id/tracks/track-id
```

### `GET /stream/:trackId`

Streams a downloaded library file from Apollo.

Examples:

```powershell
curl.exe http://127.0.0.1:4848/stream/track-id
curl.exe -OJ "http://127.0.0.1:4848/stream/track-id?download=1"
```

Notes:

- supports `Range` requests for media playback
- add `?download=1` to force a file download
- only works for downloaded library tracks, not remote provider items

### Error responses

When a request fails, Apollo returns JSON like:

```json
{
  "error": "Track not found."
}
```

Common cases:

- `404` for unknown routes or missing stream tracks
- `500` for validation, dependency, provider, or runtime failures
