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

## API surface

The embedded server starts from the host and port configured in the UI.

- `GET /api/health`
- `GET /api/search?query=&scope=all&provider=all&page=1&pageSize=20`
- `GET /api/tracks?q=&page=&pageSize=`
- `POST /api/playback`
- `POST /api/downloads/server`
- `POST /api/downloads/client`
- `GET /api/playlists`
- `POST /api/playlists`
- `POST /api/playlists/:id/tracks`
- `DELETE /api/playlists/:id/tracks/:trackId`
- `GET /api/downloads`
- `POST /api/inspect-link`
- `POST /api/library/rescan`
- `GET /stream/:trackId`
