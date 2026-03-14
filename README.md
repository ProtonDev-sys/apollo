# Apollo

Apollo is a local music server for personal client apps. It ships with:

- a desktop Electron control UI
- a headless CLI that runs the same server stack
- a shared config file used by both UI and CLI
- Windows and Linux packaging targets for easy distribution

## Highlights

- starts a local HTTP API for tracks, playlists, downloads, and streaming
- manages a persistent library catalog and playlist data
- downloads tracks into an organised music library using `yt-dlp` and `ffmpeg`
- normalizes and persists richer track metadata across providers and library rescans
- repairs weak downloaded metadata on later rescans when the original source can still be resolved
- imports playlists from supported external platforms with ordered track metadata
- supports provider search with pagination and direct-link ingest
- exposes stream URLs for future client apps through `/stream/:trackId`

## Requirements

- Node.js 20+
- `yt-dlp`
- `ffmpeg`
- no-key MusicBrainz and iTunes metadata are built in
- optional Spotify API credentials for Spotify metadata search

## Quick start

Install the dependencies, install the project packages, then start Apollo:

```powershell
winget install OpenJS.NodeJS.LTS
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg.Essentials
npm.cmd install
npm.cmd start
```

Default local API:

```text
http://127.0.0.1:4848
```

## Metadata providers

- `MusicBrainz`: no-key artist identity, artist profile data, and release groups
- `iTunes`: no-key general song metadata and default artist track listings
- `Deezer`: no-key fast track and artist metadata
- `YouTube`: search, playback resolution, and download fallback
- `SoundCloud`: search, playback resolution, and download fallback
- `Spotify`: optional metadata source when credentials work, plus direct Spotify track URL handling

Playlist import providers:

- `Spotify`: playlist API import when client credentials are configured
- `Deezer`: no-key playlist API import
- `YouTube` and `SoundCloud`: playlist import through `yt-dlp`

## Setup

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

### 6. Optional background start on login

Apollo can start the server automatically when the user signs in.

Setup in the UI:

1. Start Apollo with `npm.cmd start`
2. In `Config`, enable `Start server on login`
3. Click `Save`

How it works:

- Windows packaged builds register Apollo as a login item and start it in hidden `--background` mode
- development builds fall back to the user Startup folder helper
- Linux desktop sessions install an XDG autostart entry that launches Apollo in hidden `--background` mode
- the server runs without opening the UI window

Notes:

- when enabled, closing the UI window keeps Apollo running in the background
- opening Apollo again reuses the background instance instead of starting a second server
- to stop background mode completely, open Apollo, turn `Start server on login` off, click `Save`, then close the app

### 7. Installer builds

Apollo now includes packaging targets through `electron-builder`.

Build all desktop artifacts:

```powershell
npm.cmd run dist
```

Build Windows installers only:

```powershell
npm.cmd run dist:win
```

Build a portable Windows executable:

```powershell
npm.cmd run dist:portable
```

Build Linux packages only:

```powershell
npm.cmd run dist:linux
```

Build output goes to `dist/`.

Current targets:

- Windows: `nsis` installer and `portable`
- Linux: `AppImage` and `deb`

### 7.1 Background mode and tray behavior

Apollo now keeps a tray icon alive while the background server is enabled.

- closing the main window hides Apollo instead of quitting when background mode is on
- the tray menu can reopen Apollo, open the library folder, toggle `Start with system`, check for updates, and quit cleanly
- Windows packaged builds use the native login-item integration
- Linux desktop builds use XDG autostart when `Start server on login` is enabled

### 7.2 Auto-update feed

Apollo now includes `electron-updater` wiring for packaged builds and is configured to use GitHub Releases for this repository by default.

For local release publishing:

```powershell
$env:GH_TOKEN = "github-personal-access-token"
npm.cmd run release:win
```

That publishes the Windows installer artifacts to the `ProtonDev-sys/apollo` GitHub releases feed.

Installed Windows builds that use the NSIS installer can then use that GitHub feed automatically. Portable builds should be updated manually by replacing the executable. You can still override the feed URL for installed builds with:

```powershell
$env:APOLLO_UPDATE_URL = "https://your-domain.example/apollo"
```

Apollo exposes update checks through both the UI and the tray menu.

Linux background service helper:

Use the user-service helper if you want Apollo managed by `systemd --user` instead of desktop-session autostart:

```bash
npm run linux:service:install -- --exec /absolute/path/to/apollo
```

Remove it with:

```bash
npm run linux:service:remove
```

If you want branded installers, add installer assets under `build/`, such as:

- `build/icon.ico` for Windows
- `build/icon.png` for Linux

### 8. Optional API authentication

Apollo can require one shared secret for all API, stream, and playlist artwork requests. There are no user accounts.

Setup in the UI:

1. Start Apollo with `npm.cmd start`
2. In `Config`, enable `Require API auth`
3. Set `Session TTL (hours)`
4. Set `API shared secret`
5. Click `Save`
6. Give the shared secret to your client through a secure channel

Or configure it in `config.json`:

```json
{
  "settings": {
    "apiAuthEnabled": true,
    "apiSessionTtlHours": 168,
    "apiSharedSecret": "replace-this-with-a-long-secret"
  }
}
```

Restart Apollo after editing the file.

Client flow:

Clients should follow this sequence with any HTTP client.

1. Check whether auth is enabled:

```http
GET /api/auth/status HTTP/1.1
Host: 127.0.0.1:4848
```

Response example:

```json
{
  "enabled": true,
  "configured": true,
  "sessionTtlHours": 168
}
```

2. Create a session token with the shared secret:

```http
POST /api/auth/session HTTP/1.1
Host: 127.0.0.1:4848
Content-Type: application/json

{
  "secret": "replace-this-with-the-shared-secret"
}
```

Response example:

```json
{
  "token": "session-token",
  "tokenType": "Bearer",
  "expiresAt": "2026-03-16T10:00:00.000Z"
}
```

3. Send the returned token on later API requests:

```http
GET /api/health HTTP/1.1
Host: 127.0.0.1:4848
Authorization: Bearer session-token
```

Notes:

- leave `API shared secret` blank in the UI if you want to keep the current secret
- changing the shared secret revokes all existing sessions
- restarting Apollo revokes all existing sessions
- the shared secret is stored as a hash, not plaintext
- session tokens are stored only in memory
- for browser media or images, use `?access_token=...` on `/stream/...` and `/media/...` URLs if headers are not possible
- auth does not add TLS; for anything beyond localhost or a trusted LAN, use HTTPS or a VPN

## Run the UI

```powershell
npm.cmd start
```

If `Start server on login` is enabled, Apollo launches in hidden background mode at sign-in and the UI window stays closed until you open the app manually.

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
- when API auth is enabled, send `Authorization: Bearer <token>` on all API requests after login
- send `X-Client-Id: <stable-client-id>` on search requests so Apollo can cancel older in-flight searches from the same client without affecting other clients
- CORS is enabled with `Access-Control-Allow-Origin: *`
- Apollo reuses in-flight work for identical expensive requests and keeps a short in-memory cache for recent search, playback, download-resolution, and inspect-link responses
- library rescans batch catalog writes instead of persisting each discovered file individually
- library rescans read embedded file tags and try to repair weak stored metadata from the original source when possible
- MusicBrainz-backed artist requests are throttled and cached because MusicBrainz documents a 1 request/second rate limit
- multi-provider search fans out across the requested providers in parallel unless the client disconnects or a newer request from the same client supersedes the older one
- artist search results are enriched with Deezer artwork and top releases when possible to reduce client follow-up calls
- pagination is 1-based
- `pageSize` is capped internally for search and track listing
- track-like responses include normalized metadata fields: `normalizedTitle`, `normalizedArtist`, `normalizedAlbum`, `normalizedDuration`, and `metadataSource`
- track-like responses can also include richer metadata such as `artists`, `albumArtist`, `trackNumber`, `discNumber`, `releaseDate`, `releaseYear`, `genre`, `explicit`, `isrc`, `sourcePlatform`, and `sourceUrl`
- shared-track resolution accepts compact public IDs like `deezer:<id>`, `spotify:<id>`, `youtube:<id>`, and `itunes:<id>`

### `GET /api/auth/status`

Returns whether API auth is enabled and whether a shared secret is configured.

Response example:

```json
{
  "enabled": true,
  "configured": true,
  "sessionTtlHours": 168
}
```

### `POST /api/auth/session`

Authenticates a client with the shared secret and returns a session token.

Request body:

```json
{
  "secret": "your-shared-secret"
}
```

Response example:

```json
{
  "token": "session-token",
  "tokenType": "Bearer",
  "expiresAt": "2026-03-16T10:00:00.000Z"
}
```

### `DELETE /api/auth/session`

Revokes the current session token.

### `GET /api/health`

Returns server status and library overview.

Response example:

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

Response example:

```json
{
  "items": [
    {
      "id": "track-id",
      "title": "Harder Better Faster Stronger",
      "artist": "Daft Punk",
      "artists": ["Daft Punk"],
      "album": "Discovery",
      "albumArtist": "Daft Punk",
      "trackNumber": 4,
      "discNumber": 1,
      "duration": 224,
      "releaseDate": "2001-03-07",
      "releaseYear": 2001,
      "genre": "French House",
      "explicit": false,
      "provider": "library",
      "sourcePlatform": "youtube",
      "artwork": "",
      "sourceUrl": "https://www.youtube.com/watch?v=abc123",
      "providerIds": {
        "deezer": "",
        "itunes": "",
        "spotify": "",
        "youtube": "",
        "soundcloud": "",
        "isrc": ""
      },
      "isrc": "",
      "externalUrl": "http://127.0.0.1:4848/stream/track-id",
      "downloadTarget": "http://127.0.0.1:4848/stream/track-id?download=1",
      "trackId": "track-id",
      "fileName": "Harder Better Faster Stronger.mp3",
      "normalizedTitle": "harder better faster stronger",
      "normalizedArtist": "daft punk",
      "normalizedAlbum": "discovery",
      "normalizedDuration": 224,
      "metadataSource": "library"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "totalPages": 1
}
```

### `DELETE /api/tracks/:trackId`

Deletes a downloaded track from the Apollo library.

Behavior:

- removes the audio file from disk
- removes the track from the catalog
- unlinks the track from any playlists that reference it
- preserves imported remote playlist entries when Apollo still has stored source metadata for them

Path params:

- `trackId`: Apollo track ID

Response example:

```json
{
  "ok": true,
  "id": "track-id",
  "filePath": "C:\\Music\\Apollo\\library\\Daft Punk\\Discovery\\One More Time.mp3"
}
```

### `GET /api/search`

Searches both the local library and remote providers so clients can search tracks whether they are downloaded or not.

Query params:

- `query` or `q`: search term
- `scope`: `all`, `library`, or `remote`
- `provider`: `all`, `youtube`, `soundcloud`, `spotify`, `itunes`, or `deezer`
- `stream`: optional, set to `1` to stream partial results over Server-Sent Events
- `clientId`: optional fallback for client identification if you cannot send `X-Client-Id`
- `page`: optional, default `1`
- `pageSize`: optional, default `20`

Response example:

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
        "title": "One More Time",
        "artist": "Daft Punk",
        "artists": ["Daft Punk"],
        "album": "YouTube",
        "albumArtist": "Daft Punk",
        "duration": 321,
        "releaseDate": "",
        "releaseYear": null,
        "genre": "",
        "explicit": null,
        "sourcePlatform": "youtube",
        "artwork": "",
        "externalUrl": "https://www.youtube.com/watch?v=abc123",
        "downloadTarget": "https://www.youtube.com/watch?v=abc123",
        "sourceUrl": "https://www.youtube.com/watch?v=abc123",
        "providerIds": {
          "deezer": "",
          "itunes": "",
          "spotify": "",
          "youtube": "abc123",
          "soundcloud": "",
          "isrc": ""
        },
        "isrc": "",
        "normalizedTitle": "one more time",
        "normalizedArtist": "daft punk",
        "normalizedAlbum": "youtube",
        "normalizedDuration": 321,
        "metadataSource": "youtube"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 10,
    "totalPages": 1,
    "providerErrors": {},
    "warning": ""
  }
}
```

Notes:

- `library.items` contain downloaded tracks formatted for playback through Apollo
- `remote.items` contain provider results that can be played directly or queued for download
- `stream=1` or `Accept: text/event-stream` switches the endpoint to SSE mode and emits `snapshot` events as providers finish, followed by a final `done` event
- SSE search snapshots include `remote.progress.complete`, `remote.progress.completedProviders`, `remote.progress.pendingProviders`, `remote.progress.lastProvider`, and `remote.progress.lastStatus`
- if the same client sends a newer search before the previous one completes, Apollo cancels the older search and keeps the newer one
- different `X-Client-Id` values are isolated, so one client does not cancel another client's search
- Apollo keeps a short in-memory cache of recent identical searches to avoid repeating provider work
- duplicate remote results from fallback/provider overlap are collapsed into a single best result
- `itunes` is the built-in no-key metadata provider for general song search
- `deezer` is another no-key fast metadata provider for cold search
- multi-provider search fans out to each selected provider in parallel unless the client disconnects or a newer search from the same client supersedes it
- Spotify track URLs work through `query=<spotify track url>` or `POST /api/inspect-link`
- if Spotify catalog search is blocked by Spotify, Apollo falls back to YouTube audio results and returns the original Spotify failure in `remote.providerErrors.spotify`
- `provider=all` includes `spotify`, `youtube`, `soundcloud`, `itunes`, and `deezer`

### `GET /api/artists`

Searches artists using MusicBrainz. This does not require API keys.

Query params:

- `query` or `q`: artist name
- `page`: optional, default `1`
- `pageSize`: optional, default `20`

Response example:

```json
{
  "items": [
    {
      "id": "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
      "name": "Daft Punk",
      "sortName": "Daft Punk",
      "type": "Group",
      "country": "FR",
      "area": "France",
      "disambiguation": "French electronic duo",
      "lifeSpan": {
        "begin": "1993",
        "end": "2021-02-22",
        "ended": true
      },
      "tags": ["electronic", "house"],
      "source": "musicbrainz"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "totalPages": 1
}
```

Notes:

- Apollo enriches artist results with artwork, Deezer IDs, and a few top releases when a Deezer match is available

### `GET /api/artists/:artistId`

Returns a MusicBrainz artist profile with aliases, genres, and a trimmed set of external links.

### `GET /api/artists/:artistId/releases`

Returns release groups for the artist from MusicBrainz.

Response items include:

- `id`
- `title`
- `primaryType`
- `secondaryTypes`
- `firstReleaseDate`

### `GET /api/releases/:releaseId/tracks`

Returns a release tracklist for a MusicBrainz release-group ID.

Behavior:

- Apollo resolves the release group to the best release available
- the response includes track order, release metadata, and Apollo-compatible `downloadTarget` values

### `GET /api/artists/:artistId/tracks`

Returns a practical artist song list without API keys.

Behavior:

- prefers iTunes song metadata for cleaner artist-track results
- falls back to MusicBrainz recordings if iTunes has no usable tracks
- each track still includes a `downloadTarget` that Apollo can resolve through YouTube for playback/download

### `POST /api/recommendations`

Returns related playable tracks from no-key metadata sources.

Request body:

```json
{
  "title": "One More Time",
  "artist": "Daft Punk",
  "album": "Discovery",
  "limit": 5
}
```

Or seed from a downloaded Apollo track:

```json
{
  "trackId": "track-id",
  "limit": 5
}
```

Notes:

- recommendations prefer local library matches, Deezer artist top tracks, and iTunes artist tracks
- responses include provider IDs, artwork, duration, and stable IDs so clients can dedupe cleanly

### `GET /api/tracks/:trackId/related`

Convenience wrapper around recommendations for a downloaded Apollo track.

Query params:

- `limit`: optional, default `12`

### `POST /api/playback`

Resolves a playable URL for either a downloaded library track or a remote result.

Request body for a library track:

```json
{
  "trackId": "track-id"
}
```

Request body for a remote result:

```json
{
  "provider": "youtube",
  "title": "One More Time",
  "artist": "Daft Punk",
  "album": "Discovery",
  "downloadTarget": "https://www.youtube.com/watch?v=abc123"
}
```

Response for a library track:

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

Response for a remote result:

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

Notes:

- identical concurrent playback-resolution requests share one upstream lookup
- recent identical playback-resolution requests are served from a short in-memory cache

### Download APIs

Apollo has two download endpoints:

- `POST /api/downloads/server` downloads a remote track into the Apollo server library
- `POST /api/downloads/client` returns a direct download URL so the client can download the file itself

### `POST /api/downloads/server`

Queues a remote item to be downloaded, converted, organised into the library, and indexed on the server.

Request body:

```json
{
  "provider": "youtube",
  "title": "One More Time",
  "artist": "Daft Punk",
  "artists": ["Daft Punk"],
  "album": "Discovery",
  "albumArtist": "Daft Punk",
  "trackNumber": 1,
  "discNumber": 1,
  "releaseDate": "2001-11-30",
  "genre": "French House",
  "explicit": false,
  "downloadTarget": "https://www.youtube.com/watch?v=abc123",
  "externalUrl": "https://www.youtube.com/watch?v=abc123"
}
```

Response example:

```json
{
  "id": "download-id",
  "title": "One More Time",
  "artist": "Daft Punk",
  "artists": ["Daft Punk"],
  "album": "Discovery",
  "albumArtist": "Daft Punk",
  "trackNumber": 1,
  "discNumber": 1,
  "releaseDate": "2001-11-30",
  "releaseYear": 2001,
  "genre": "French House",
  "explicit": false,
  "provider": "youtube",
  "sourcePlatform": "youtube",
  "artwork": "https://example.com/cover.jpg",
  "isrc": "GBDUW0100001",
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

Notes:

- Apollo rejects duplicate downloads when the same track is already in the library or already queued
- Apollo resolves provider metadata before downloading, merges in stronger metadata from supported public APIs when useful, then tags the audio file before import
- written/imported metadata includes `title`, `artist`, `album`, `albumArtist`, `trackNumber`, `discNumber`, `releaseDate`, `genre`, and `isrc` when available

### `GET /api/downloads`

Lists download jobs, newest first.

Response example:

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

Request body for a library track:

```json
{
  "trackId": "track-id"
}
```

Request body for a remote result:

```json
{
  "provider": "youtube",
  "title": "One More Time",
  "artist": "Daft Punk",
  "album": "Discovery",
  "downloadTarget": "https://www.youtube.com/watch?v=abc123"
}
```

Response example:

```json
{
  "type": "remote",
  "downloadUrl": "https://resolved-media-url",
  "fileName": "Daft Punk - One More Time.mp3",
  "title": "One More Time",
  "artist": "Daft Punk"
}
```

Notes:

- identical concurrent client-download resolution requests share one upstream lookup
- recent identical client-download resolution requests are served from a short in-memory cache

### `POST /api/inspect-link`

Inspects a direct media URL and returns a normalized item that can be used for playback or download.

Request body:

```json
{
  "url": "https://www.youtube.com/watch?v=abc123"
}
```

Response example:

```json
{
  "id": "link:abc123",
  "provider": "youtube",
  "title": "One More Time",
  "artist": "Daft Punk",
  "artists": ["Daft Punk"],
  "album": "Singles",
  "albumArtist": "Daft Punk",
  "duration": 321,
  "releaseDate": "",
  "releaseYear": null,
  "genre": "",
  "explicit": null,
  "sourcePlatform": "youtube",
  "artwork": "",
  "externalUrl": "https://www.youtube.com/watch?v=abc123",
  "sourceUrl": "https://www.youtube.com/watch?v=abc123",
  "downloadTarget": "https://www.youtube.com/watch?v=abc123",
  "providerIds": {
    "deezer": "",
    "itunes": "",
    "spotify": "",
    "youtube": "abc123",
    "soundcloud": "",
    "isrc": ""
  },
  "isrc": "",
  "normalizedTitle": "one more time",
  "normalizedArtist": "daft punk",
  "normalizedAlbum": "singles",
  "normalizedDuration": 321,
  "metadataSource": "youtube"
}
```

Notes:

- identical concurrent inspect-link requests share one upstream lookup
- recent identical inspect-link requests are served from a short in-memory cache

### `POST /api/resolve-shared-track`

Resolves a compact shared track token into a full Apollo-compatible track object.

Request body:

```json
{
  "id": "deezer:3709069532"
}
```

Response example:

```json
{
  "id": "deezer:3709069532",
  "title": "Veridis Quo",
  "artist": "Daft Punk",
  "artists": ["Daft Punk"],
  "album": "Discovery",
  "albumArtist": "Daft Punk",
  "duration": 345,
  "provider": "deezer",
  "sourcePlatform": "deezer",
  "artwork": "https://example.com/discovery.jpg",
  "externalUrl": "https://www.deezer.com/track/3709069532",
  "downloadTarget": "ytsearch1:Daft Punk Veridis Quo audio",
  "sourceUrl": "https://www.deezer.com/track/3709069532",
  "providerIds": {
    "deezer": "3709069532",
    "itunes": "",
    "spotify": "",
    "youtube": "",
    "soundcloud": "",
    "isrc": "GBDUW0100002"
  },
  "isrc": "GBDUW0100002",
  "playable": true,
  "normalizedTitle": "veridis quo",
  "normalizedArtist": "daft punk",
  "normalizedAlbum": "discovery",
  "normalizedDuration": 345,
  "metadataSource": "deezer"
}
```

Supported namespaces:

- `deezer:<track-id>`
- `spotify:<track-id>`
- `youtube:<video-id>`
- `itunes:<track-id>`
- `library:<apollo-track-id>` only when the receiving server already has that exact local Apollo track ID

Notes:

- this endpoint exists so clients do not need provider-specific hydration rules in the renderer
- `soundcloud:<id>` is rejected because a bare SoundCloud ID is not reliably resolvable without a canonical URL
- `library:<id>` is local to one Apollo server; if another server does not know that track ID it cannot resolve it
- identical concurrent shared-track resolution requests share one upstream lookup

### `POST /api/library/rescan`

Rescans the configured library directory and reindexes files.

Response example:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 8,
  "totalPages": 1
}
```

Notes:

- if several rescans are requested at the same time, Apollo shares one in-flight rescan instead of starting multiple scans
- discovered tracks are written back in batches so large rescans do not hammer the state file
- rescans read embedded file tags instead of relying only on folder names
- tracks with weak stored metadata are re-enriched from their original source URL or provider identity when Apollo can still resolve them

### `GET /api/playlists`

Lists playlists with expanded ordered entries and flattened track objects.

Response example:

```json
{
  "items": [
    {
      "id": "playlist-id",
      "name": "Favorites",
      "title": "Favorites",
      "description": "",
      "artworkUrl": "https://example.com/playlist.jpg",
      "sourcePlatform": "spotify",
      "sourcePlaylistId": "37i9dQZF1DXcBWIGoYBM5M",
      "sourceUrl": "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      "sourceSnapshotId": "snapshot-id",
      "ownerName": "Spotify",
      "importedAt": "2026-03-11T12:00:00.000Z",
      "trackIds": ["track-id"],
      "entries": [
        {
          "id": "entry-id",
          "order": 0,
          "trackId": "track-id",
          "unavailable": false,
          "error": "",
          "addedAt": "2026-03-11T12:00:00.000Z",
          "track": {
            "id": "track-id",
            "title": "One More Time",
            "artist": "Daft Punk",
            "provider": "library"
          }
        }
      ],
      "tracks": [
        {
          "id": "track-id",
          "title": "One More Time",
          "artist": "Daft Punk",
          "provider": "library"
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

Request body:

```json
{
  "name": "Favorites",
  "description": "Main rotation"
}
```

### `POST /api/playlists/import`

Imports a playlist from a supported external provider and stores ordered playlist entries.

Request body:

```json
{
  "url": "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
}
```

Behavior:

- supported providers are Spotify, Deezer, YouTube, and SoundCloud
- Spotify playlist import requires configured Spotify client credentials
- imported playlist entries keep provider metadata even when Apollo does not already have the track downloaded
- imported entries are linked to matching Apollo library tracks when possible
- unavailable provider items are preserved as playlist entries with `unavailable` and `error`

### `POST /api/playlists/:id/tracks`

Adds a downloaded library track to a playlist.

Path params:

- `id`: playlist ID

Request body:

```json
{
  "trackId": "track-id"
}
```

### `DELETE /api/playlists/:id/tracks/:trackId`

Removes a track from a playlist.

Path params:

- `id`: playlist ID
- `trackId`: library track ID

Notes:

- playlist order is preserved through `entries[].order`
- `tracks[]` is a convenience flattened view of the resolved entry tracks
- imported playlists can contain a mix of linked local tracks and provider-backed remote entries

### `GET /stream/:trackId`

When API auth is enabled, either:

- send `Authorization: Bearer <token>`
- or append `?access_token=<token>` to the URL

Streams a downloaded library file from Apollo.

Notes:

- supports `Range` requests for media playback
- long-lived audio streams are kept open without the normal HTTP request timeout
- add `?download=1` to force a file download
- `trackId` is the ID of a downloaded library track
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
