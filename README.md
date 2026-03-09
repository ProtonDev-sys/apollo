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
