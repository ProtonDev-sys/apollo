const ACTIVE_DOWNLOAD_STATUSES = new Set(['queued', 'running']);
const VIEW_DEFINITIONS = {
  library: {
    kicker: 'Library',
    title: 'Catalog',
    searchPlaceholder: 'Search tracks, artists, albums, or file names'
  },
  discovery: {
    kicker: 'Remote',
    title: 'Discovery',
    searchPlaceholder: 'Search providers or paste a direct track URL'
  },
  downloads: {
    kicker: 'Queue',
    title: 'Jobs',
    searchPlaceholder: 'Filter downloads by title, artist, or status'
  },
  dependencies: {
    kicker: 'Runtime',
    title: 'Dependencies',
    searchPlaceholder: 'Filter dependencies and runtime state'
  },
  playlist: {
    kicker: 'Playlist',
    title: 'Playlist',
    searchPlaceholder: 'Filter playlist tracks'
  }
};
const SETTING_FIELDS = [
  'serverHost',
  'serverPort',
  'apiAuthEnabled',
  'apiSessionTtlHours',
  'autoStartBackgroundServer',
  'libraryDirectory',
  'incomingDirectory',
  'ytDlpPath',
  'ffmpegPath',
  'apiSharedSecret',
  'spotifyClientId',
  'spotifyClientSecret'
];

const elements = {
  searchInput: document.getElementById('global-search'),
  serverBadge: document.getElementById('server-badge'),
  serverUrl: document.getElementById('server-url'),
  statusBanner: document.getElementById('status-banner'),
  statTracks: document.getElementById('stat-tracks'),
  statPlaylists: document.getElementById('stat-playlists'),
  statDownloads: document.getElementById('stat-downloads'),
  statComplete: document.getElementById('stat-complete'),
  viewSwitcher: document.getElementById('view-switcher'),
  playlistList: document.getElementById('playlist-list'),
  dependencySummary: document.getElementById('dependency-summary'),
  mainKicker: document.getElementById('main-kicker'),
  mainTitle: document.getElementById('main-title'),
  mainMeta: document.getElementById('main-meta'),
  mainHero: document.getElementById('main-hero'),
  mainContent: document.getElementById('main-content'),
  detailBody: document.getElementById('detail-body'),
  footerStatus: document.getElementById('footer-status'),
  footerUpdate: document.getElementById('footer-update'),
  footerAuth: document.getElementById('footer-auth'),
  footerDownloads: document.getElementById('footer-downloads')
};

const state = {
  dashboard: null,
  libraryResult: createEmptyLibraryResult(),
  remoteResult: createEmptyRemoteResult(),
  update: createEmptyUpdateState(),
  searchQuery: '',
  selectedView: 'library',
  selectedPlaylistId: '',
  selected: {
    type: '',
    id: ''
  },
  detailTab: 'details',
  viewRequestId: 0,
  isLoadingView: false,
  searchTimer: null,
  refreshTimer: null,
  stopDownloadSubscription: null,
  configRendered: false
};

function createEmptyLibraryResult() {
  return {
    items: [],
    total: 0,
    page: 1,
    pageSize: 200,
    totalPages: 1
  };
}

function createEmptyRemoteResult() {
  return {
    items: [],
    total: 0,
    page: 1,
    pageSize: 18,
    totalPages: 1,
    provider: [],
    providerErrors: {},
    warning: ''
  };
}

function createEmptyUpdateState() {
  return {
    supported: false,
    configured: false,
    checking: false,
    available: false,
    downloaded: false,
    progress: 0,
    version: '',
    message: 'Updates unavailable.',
    error: ''
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total <= 0) {
    return 'Unknown';
  }

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDateTime(value) {
  if (!value) {
    return 'Unknown';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString();
}

function formatReleaseLabel(track) {
  if (track.releaseYear) {
    return String(track.releaseYear);
  }

  if (track.releaseDate) {
    const parsed = new Date(track.releaseDate);
    if (!Number.isNaN(parsed.getTime())) {
      return String(parsed.getFullYear());
    }
  }

  return '';
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function trackMatchesQuery(track, query) {
  const term = normalizeSearch(query);
  if (!term) {
    return true;
  }

  return [
    track.title,
    track.artist,
    track.album,
    track.genre,
    track.fileName,
    track.provider,
    track.sourcePlatform,
    track.releaseDate,
    track.releaseYear,
    ...(Array.isArray(track.artists) ? track.artists : [])
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(term));
}

function playlistEntryMatchesQuery(entry, query) {
  if (entry.track) {
    return trackMatchesQuery(entry.track, query);
  }

  const term = normalizeSearch(query);
  if (!term) {
    return true;
  }

  return [entry.error, entry.trackId, entry.id]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(term));
}

function downloadMatchesQuery(download, query) {
  const term = normalizeSearch(query);
  if (!term) {
    return true;
  }

  return [
    download.title,
    download.artist,
    download.album,
    download.status,
    download.message,
    download.sourcePlatform,
    download.provider
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(term));
}

function dependencyMatchesQuery(dependency, query) {
  const term = normalizeSearch(query);
  if (!term) {
    return true;
  }

  return [dependency.label, dependency.detail, dependency.path, dependency.version, dependency.stateLabel]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(term));
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function setStatus(message) {
  const text = String(message || '').trim() || 'Ready';
  elements.statusBanner.textContent = text;
  elements.footerStatus.textContent = text;
}

function formatProvider(provider) {
  switch (String(provider || '').toLowerCase()) {
    case 'itunes':
      return 'iTunes';
    case 'soundcloud':
      return 'SoundCloud';
    case 'youtube':
      return 'YouTube';
    case 'spotify':
      return 'Spotify';
    case 'deezer':
      return 'Deezer';
    case 'library':
      return 'Library';
    case 'link':
      return 'Direct';
    default:
      return provider ? String(provider) : 'Unknown';
  }
}

function updateServerBadge() {
  const server = state.dashboard?.server;
  const isRunning = Boolean(server?.running);
  elements.serverBadge.textContent = isRunning ? 'Running' : 'Stopped';
  elements.serverBadge.className = `status-pill ${isRunning ? 'status-pill--ok' : 'status-pill--warn'}`;
  elements.serverUrl.textContent = server?.baseUrl || 'Server unavailable';
}

function renderOverviewStats() {
  const overview = state.dashboard?.overview || {};
  elements.statTracks.textContent = String(overview.trackCount || 0);
  elements.statPlaylists.textContent = String(overview.playlistCount || 0);
  elements.statDownloads.textContent = String(overview.downloadCount || 0);
  elements.statComplete.textContent = String(overview.completedDownloads || 0);
}

function getDependencyItems() {
  const dependencies = state.dashboard?.dependencies || {};
  const auth = state.dashboard?.auth || {};
  const server = state.dashboard?.server || {};
  const update = state.update || createEmptyUpdateState();

  return [
    {
      key: 'ytDlp',
      label: 'yt-dlp',
      available: Boolean(dependencies.ytDlp?.available),
      version: dependencies.ytDlp?.version || '',
      path: dependencies.ytDlp?.path || '',
      detail: dependencies.ytDlp?.available
        ? 'Remote search, link resolution, and downloads are ready.'
        : dependencies.ytDlp?.error || 'Apollo cannot search or download remote tracks until yt-dlp is available.',
      stateLabel: dependencies.ytDlp?.available ? 'Ready' : 'Missing'
    },
    {
      key: 'ffmpeg',
      label: 'ffmpeg',
      available: Boolean(dependencies.ffmpeg?.available),
      version: dependencies.ffmpeg?.version || '',
      path: dependencies.ffmpeg?.path || '',
      detail: dependencies.ffmpeg?.available
        ? 'Audio extraction and metadata writing are available.'
        : dependencies.ffmpeg?.error || 'Apollo cannot finalize server-side downloads until ffmpeg is available.',
      stateLabel: dependencies.ffmpeg?.available ? 'Ready' : 'Missing'
    },
    {
      key: 'spotify',
      label: 'Spotify metadata',
      available: Boolean(dependencies.spotifyConfigured),
      version: '',
      path: '',
      detail: dependencies.spotifyConfigured
        ? 'Client credentials are configured for Spotify metadata lookups.'
        : 'Optional. Add a client ID and secret if you want Spotify-backed search and metadata.',
      stateLabel: dependencies.spotifyConfigured ? 'Configured' : 'Optional'
    },
    {
      key: 'updates',
      label: 'App updates',
      available: Boolean(update.supported && update.configured),
      version: update.version || '',
      path: '',
      detail: update.message || 'Updates are not configured.',
      stateLabel: update.downloaded
        ? 'Ready'
        : update.checking
          ? 'Checking'
          : update.supported && update.configured
            ? 'Configured'
            : 'Off'
    },
    {
      key: 'auth',
      label: 'API auth',
      available: Boolean(auth.enabled && auth.configured),
      version: '',
      path: '',
      detail: auth.enabled
        ? `Shared-secret auth is enabled with ${auth.sessionTtlHours || 0}h sessions.`
        : 'Shared-secret auth is disabled. Apollo is open to the local network segment it is bound to.',
      stateLabel: auth.enabled ? 'Enabled' : 'Off'
    },
    {
      key: 'server',
      label: 'HTTP server',
      available: Boolean(server.running),
      version: '',
      path: server.baseUrl || '',
      detail: server.running
        ? `Apollo is serving at ${server.baseUrl}.`
        : 'Apollo is not currently serving HTTP requests.',
      stateLabel: server.running ? 'Online' : 'Offline'
    }
  ];
}

function getActivePlaylist() {
  return (state.dashboard?.playlists || []).find((playlist) => playlist.id === state.selectedPlaylistId) || null;
}

function getPlaylistEntries(playlist) {
  if (!playlist) {
    return [];
  }

  return (playlist.entries || []).filter((entry) => playlistEntryMatchesQuery(entry, state.searchQuery));
}

function getFilteredDownloads() {
  return (state.dashboard?.downloads || []).filter((download) =>
    downloadMatchesQuery(download, state.searchQuery)
  );
}

function getFilteredDependencies() {
  return getDependencyItems().filter((dependency) =>
    dependencyMatchesQuery(dependency, state.searchQuery)
  );
}

function getRemoteItems() {
  return Array.isArray(state.remoteResult?.items) ? state.remoteResult.items : [];
}

function getLibraryItems() {
  return Array.isArray(state.libraryResult?.items) ? state.libraryResult.items : [];
}

function countActiveDownloads() {
  return (state.dashboard?.downloads || []).filter((download) =>
    ACTIVE_DOWNLOAD_STATUSES.has(download.status)
  ).length;
}

function getViewButtons() {
  const overview = state.dashboard?.overview || {};
  return [
    {
      id: 'library',
      title: 'Library',
      meta: 'Indexed tracks and local metadata',
      count: overview.trackCount || 0
    },
    {
      id: 'discovery',
      title: 'Discovery',
      meta: 'Remote providers and direct links',
      count: state.remoteResult.total || 0
    },
    {
      id: 'downloads',
      title: 'Downloads',
      meta: 'Queue state and completed jobs',
      count: overview.downloadCount || 0
    },
    {
      id: 'dependencies',
      title: 'Dependencies',
      meta: 'Runtime health and configuration',
      count: getDependencyItems().filter((item) => item.available).length
    }
  ];
}

function getSelectedTrackFromLibraryLikeCollections() {
  const candidateId = state.selected.id;
  if (!candidateId) {
    return null;
  }

  const playlist = getActivePlaylist();
  if (playlist) {
    const matchingEntry = (playlist.entries || []).find((entry) => entry.track?.id === candidateId);
    if (matchingEntry?.track) {
      return matchingEntry.track;
    }
  }

  return getLibraryItems().find((track) => track.id === candidateId) || null;
}

function getSelectedRemoteResult() {
  return getRemoteItems().find((item) => item.id === state.selected.id) || null;
}

function getSelectedDownload() {
  return (state.dashboard?.downloads || []).find((download) => download.id === state.selected.id) || null;
}

function getSelectedDependency() {
  return getDependencyItems().find((dependency) => dependency.key === state.selected.id) || null;
}

function getDefaultSearchPlaceholder() {
  if (state.selectedView === 'playlist') {
    return VIEW_DEFINITIONS.playlist.searchPlaceholder;
  }

  return VIEW_DEFINITIONS[state.selectedView]?.searchPlaceholder || 'Search Apollo';
}

function buildPlaylistMetaLine(playlist) {
  const source = playlist.sourcePlatform ? formatProvider(playlist.sourcePlatform) : 'Local';
  return `${source} · ${(playlist.trackIds || []).length} tracks`;
}

function renderInlineEmptyState(title, copy) {
  return `<div class="config-note"><strong>${escapeHtml(title)}</strong><div>${escapeHtml(copy)}</div></div>`;
}

function renderEmptyState(title, copy) {
  return `
    <article class="empty-state">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(copy)}</p>
    </article>
  `;
}

function renderArtworkTile({ artwork, label, variant }) {
  const className = variant === 'large' ? 'art-tile art-tile--large' : 'art-tile';
  if (artwork) {
    return `<div class="${className}"><img src="${escapeHtml(artwork)}" alt="${escapeHtml(label || 'Artwork')}" /></div>`;
  }

  return `
    <div class="${className}" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="16.5" cy="7.5" r="3.5" opacity="0.62"></circle>
        <path d="M6.5 17.5c1.7-3.4 4.7-5.6 9-6.5"></path>
        <path d="M12.5 18.5c.3-2.5 1.2-4.8 2.7-6.7"></path>
      </svg>
    </div>
  `;
}

function syncSelection() {
  const playlists = state.dashboard?.playlists || [];
  if (state.selectedView === 'playlist') {
    if (!playlists.length) {
      state.selectedView = 'library';
      state.selectedPlaylistId = '';
    } else if (!playlists.some((playlist) => playlist.id === state.selectedPlaylistId)) {
      state.selectedPlaylistId = playlists[0].id;
      state.selected = {
        type: 'playlist',
        id: state.selectedPlaylistId
      };
    } else if (
      state.selected.type !== 'track' ||
      !getPlaylistEntries(getActivePlaylist()).some((entry) => entry.track?.id === state.selected.id)
    ) {
      state.selected = {
        type: 'playlist',
        id: state.selectedPlaylistId
      };
    }
  }

  if (state.selectedView === 'library') {
    const items = getLibraryItems();
    if (!items.some((track) => track.id === state.selected.id)) {
      state.selected = items[0]
        ? {
            type: 'track',
            id: items[0].id
          }
        : { type: '', id: '' };
    }
  }

  if (state.selectedView === 'discovery') {
    const items = getRemoteItems();
    if (!items.some((item) => item.id === state.selected.id)) {
      state.selected = items[0]
        ? {
            type: 'remote',
            id: items[0].id
          }
        : { type: '', id: '' };
    }
  }

  if (state.selectedView === 'downloads') {
    const items = getFilteredDownloads();
    if (!items.some((download) => download.id === state.selected.id)) {
      state.selected = items[0]
        ? {
            type: 'download',
            id: items[0].id
          }
        : { type: '', id: '' };
    }
  }

  if (state.selectedView === 'dependencies') {
    const items = getFilteredDependencies();
    if (!items.some((dependency) => dependency.key === state.selected.id)) {
      state.selected = items[0]
        ? {
            type: 'dependency',
            id: items[0].key
          }
        : { type: '', id: '' };
    }
  }
}

function renderSidebar() {
  updateServerBadge();
  renderOverviewStats();

  elements.viewSwitcher.innerHTML = getViewButtons()
    .map((view) => {
      return `
        <button class="view-item ${state.selectedView === view.id ? 'is-active' : ''}" type="button" data-view="${view.id}">
          <span class="view-item__body">
            <strong class="view-item__title">${escapeHtml(view.title)}</strong>
            <span class="view-item__meta">${escapeHtml(view.meta)}</span>
          </span>
          <span class="view-count">${escapeHtml(view.count)}</span>
        </button>
      `;
    })
    .join('');

  elements.playlistList.innerHTML = (state.dashboard?.playlists || [])
    .map((playlist) => {
      const isActive = state.selectedView === 'playlist' && state.selectedPlaylistId === playlist.id;
      const description = playlist.description || buildPlaylistMetaLine(playlist);
      return `
        <article class="playlist-item ${isActive ? 'is-active' : ''}">
          ${renderArtworkTile({
            artwork: playlist.artworkUrl,
            label: playlist.name,
            variant: 'small'
          })}
          <button class="playlist-select" type="button" data-playlist-id="${escapeHtml(playlist.id)}">
            <span class="row-item__body">
              <strong class="view-item__title">${escapeHtml(playlist.name)}</strong>
              <span class="view-item__meta">${escapeHtml(description)}</span>
            </span>
          </button>
          <span class="view-count">${escapeHtml((playlist.trackIds || []).length)}</span>
        </article>
      `;
    })
    .join('') || renderInlineEmptyState('No playlists yet.', 'Create one from the field above.');

  elements.dependencySummary.innerHTML = getDependencyItems()
    .map((dependency) => {
      return `
        <button class="dependency-mini" type="button" data-dependency-id="${escapeHtml(dependency.key)}">
          <span>${escapeHtml(dependency.label)}</span>
          <span class="${dependency.available ? 'status-pill--ok' : 'status-pill--warn'}">
            ${escapeHtml(dependency.stateLabel)}
          </span>
        </button>
      `;
    })
    .join('');
}

function renderMainHeader() {
  const view = getCurrentViewDescriptor();
  elements.mainKicker.textContent = view.kicker;
  elements.mainTitle.textContent = view.title;
  elements.mainMeta.textContent = view.meta;
  elements.searchInput.placeholder = getDefaultSearchPlaceholder();
  elements.searchInput.value = state.searchQuery;
}

function getCurrentViewDescriptor() {
  if (state.selectedView === 'playlist') {
    const playlist = getActivePlaylist();
    return {
      kicker: 'Playlist',
      title: playlist?.name || 'Playlist',
      meta: playlist
        ? `${(playlist.trackIds || []).length} tracks · ${buildPlaylistMetaLine(playlist)}`
        : 'No playlist selected'
    };
  }

  if (state.selectedView === 'library') {
    return {
      kicker: 'Library',
      title: 'Catalog',
      meta: `${state.libraryResult.total || 0} visible tracks`
    };
  }

  if (state.selectedView === 'discovery') {
    const providerLine = (state.remoteResult.provider || []).length
      ? `Providers: ${(state.remoteResult.provider || []).map(formatProvider).join(', ')}`
      : 'Search all providers';
    return {
      kicker: 'Remote',
      title: 'Discovery',
      meta: state.searchQuery
        ? `${state.remoteResult.total || 0} matches · ${providerLine}`
        : providerLine
    };
  }

  if (state.selectedView === 'downloads') {
    const downloads = getFilteredDownloads();
    return {
      kicker: 'Queue',
      title: 'Jobs',
      meta: `${downloads.length} jobs · ${countActiveDownloads()} active`
    };
  }

  return {
    kicker: 'Runtime',
    title: 'Dependencies',
    meta: `${getDependencyItems().filter((item) => item.available).length}/${getDependencyItems().length} ready`
  };
}

function renderMain() {
  renderMainHeader();
  elements.mainHero.innerHTML = renderMainHero();
  elements.mainContent.innerHTML = renderMainContent();
}

function renderMainHero() {
  const overview = state.dashboard?.overview || {};
  const auth = state.dashboard?.auth || {};
  const server = state.dashboard?.server || {};

  if (state.selectedView === 'library') {
    return `
      <div class="hero-grid">
        <article class="hero-card">
          <h3>Local catalog</h3>
          <p>Apollo indexes the library folder and exposes it to desktop and mobile clients.</p>
          <strong>${escapeHtml(overview.trackCount || 0)}</strong>
        </article>
        <article class="hero-card">
          <h3>Playlists</h3>
          <p>Local and imported playlist state lives in the same shared data store.</p>
          <strong>${escapeHtml(overview.playlistCount || 0)}</strong>
        </article>
        <article class="hero-card">
          <h3>Endpoint</h3>
          <p>${escapeHtml(server.running ? 'HTTP API is live.' : 'HTTP API is offline.')}</p>
          <strong>${escapeHtml(server.baseUrl || 'Unavailable')}</strong>
        </article>
      </div>
    `;
  }

  if (state.selectedView === 'discovery') {
    const warning = state.remoteResult.warning
      ? `<p class="config-note">${escapeHtml(state.remoteResult.warning)}</p>`
      : '<p class="config-note">Search across Spotify, YouTube, SoundCloud, iTunes, and Deezer using the same provider stack Apollo exposes through the API.</p>';
    return `
      <div class="hero-grid">
        <article class="hero-card">
          <h3>Search providers</h3>
          ${warning}
          <strong>${escapeHtml(state.remoteResult.total || 0)}</strong>
        </article>
        <article class="hero-card">
          <h3>Queue pressure</h3>
          <p>Remote discoveries can be sent straight into Apollo's download queue.</p>
          <strong>${escapeHtml(countActiveDownloads())}</strong>
        </article>
        <article class="hero-card">
          <h3>Link ingest</h3>
          <p>Paste a direct URL to inspect a single track before queueing it for import.</p>
          <strong>${looksLikeUrl(state.searchQuery) ? 'Direct' : 'Search'}</strong>
        </article>
      </div>
    `;
  }

  if (state.selectedView === 'downloads') {
    const downloads = state.dashboard?.downloads || [];
    const failed = downloads.filter((download) => download.status === 'failed').length;
    return `
      <div class="hero-grid">
        <article class="hero-card">
          <h3>Active</h3>
          <p>Queued and running downloads currently managed by Apollo.</p>
          <strong>${escapeHtml(countActiveDownloads())}</strong>
        </article>
        <article class="hero-card">
          <h3>Completed</h3>
          <p>Jobs that finished and were indexed into the library.</p>
          <strong>${escapeHtml(overview.completedDownloads || 0)}</strong>
        </article>
        <article class="hero-card">
          <h3>Failed</h3>
          <p>Jobs that need operator attention or dependency fixes.</p>
          <strong>${escapeHtml(failed)}</strong>
        </article>
      </div>
    `;
  }

  if (state.selectedView === 'dependencies') {
    return `
      <div class="hero-grid">
        <article class="hero-card">
          <h3>Toolchain</h3>
          <p>yt-dlp and ffmpeg determine whether Apollo can search and import remote tracks.</p>
          <strong>${escapeHtml(
            getDependencyItems().filter((item) => ['ytDlp', 'ffmpeg'].includes(item.key) && item.available).length
          )}/2</strong>
        </article>
        <article class="hero-card">
          <h3>Auth</h3>
          <p>${escapeHtml(auth.enabled ? 'Shared secret enabled.' : 'Shared secret disabled.')}</p>
          <strong>${escapeHtml(auth.enabled ? 'On' : 'Off')}</strong>
        </article>
        <article class="hero-card">
          <h3>Server</h3>
          <p>${escapeHtml(server.running ? 'Apollo is reachable.' : 'Apollo is not bound.')}</p>
          <strong>${escapeHtml(server.host || 'Unknown')}:${escapeHtml(server.port || '')}</strong>
        </article>
      </div>
    `;
  }

  const playlist = getActivePlaylist();
  const entries = getPlaylistEntries(playlist);
  return `
    <div class="hero-grid">
      <article class="hero-card">
        <h3>Tracks</h3>
        <p>Resolved playlist entries currently visible in this view.</p>
        <strong>${escapeHtml(entries.length)}</strong>
      </article>
      <article class="hero-card">
        <h3>Source</h3>
        <p>Original provider or import path for this playlist.</p>
        <strong>${escapeHtml(
          playlist?.sourcePlatform ? formatProvider(playlist.sourcePlatform) : 'Local'
        )}</strong>
      </article>
      <article class="hero-card">
        <h3>Updated</h3>
        <p>Last materialized playlist state in Apollo.</p>
        <strong>${escapeHtml(formatDateTime(playlist?.updatedAt))}</strong>
      </article>
    </div>
  `;
}

function renderMainContent() {
  if (state.isLoadingView) {
    return renderEmptyState('Loading view…', 'Apollo is refreshing the current workspace.');
  }

  if (state.selectedView === 'library') {
    return renderTrackList(getLibraryItems(), { mode: 'library' });
  }

  if (state.selectedView === 'discovery') {
    const content = renderTrackList(getRemoteItems(), { mode: 'remote' });
    const providerErrors = Object.entries(state.remoteResult.providerErrors || {});
    if (!providerErrors.length) {
      return content;
    }

    return `
      <section class="content-stack">
        ${providerErrors
          .map(([provider, message]) => {
            return `
              <article class="config-note">
                <strong>${escapeHtml(formatProvider(provider))}</strong>
                <div>${escapeHtml(message)}</div>
              </article>
            `;
          })
          .join('')}
        ${content}
      </section>
    `;
  }

  if (state.selectedView === 'downloads') {
    const downloads = getFilteredDownloads();
    if (!downloads.length) {
      return renderEmptyState('No jobs in scope.', 'Queue a remote track from Discovery to create a download job.');
    }

    return downloads.map((download) => renderDownloadCard(download)).join('');
  }

  if (state.selectedView === 'dependencies') {
    const items = getFilteredDependencies();
    if (!items.length) {
      return renderEmptyState('No dependencies match this filter.', 'Clear the search field to see the full runtime state.');
    }

    return items
      .map((dependency) => {
        return `
          <article class="dependency-card ${state.selected.type === 'dependency' && state.selected.id === dependency.key ? 'is-active' : ''}">
            <div class="dependency-meta">
              <h3>${escapeHtml(dependency.label)}</h3>
              <span class="status-pill ${dependency.available ? 'status-pill--ok' : 'status-pill--warn'}">
                ${escapeHtml(dependency.stateLabel)}
              </span>
            </div>
            <p>${escapeHtml(dependency.detail)}</p>
            <div class="detail-tags">
              ${dependency.version ? `<span class="tag-chip">${escapeHtml(dependency.version)}</span>` : ''}
              ${dependency.path ? `<span class="tag-chip">${escapeHtml(dependency.path)}</span>` : ''}
              <button class="link-button" type="button" data-dependency-id="${escapeHtml(dependency.key)}">Inspect</button>
            </div>
          </article>
        `;
      })
      .join('');
  }

  const playlist = getActivePlaylist();
  const entries = getPlaylistEntries(playlist);
  if (!playlist) {
    return renderEmptyState('No playlist selected.', 'Choose a playlist from the left rail.');
  }

  if (!entries.length) {
    return renderEmptyState('Playlist is empty in this view.', 'Clear the filter or add tracks from the library or discovery search.');
  }

  return entries
    .map((entry) => {
      if (!entry.track) {
        return `
          <article class="download-card">
            <div class="download-card__meta">
              <h3>Unavailable entry</h3>
              <span class="status-pill status-pill--warn">Unresolved</span>
            </div>
            <p class="download-card__message">${escapeHtml(entry.error || 'Apollo cannot resolve this playlist item yet.')}</p>
          </article>
        `;
      }

      return renderTrackRow(entry.track, {
        mode: 'playlist',
        playlistId: playlist.id
      });
    })
    .join('');
}

function renderTrackList(items, options) {
  if (!items.length) {
    return renderEmptyState(
      state.selectedView === 'discovery' && !state.searchQuery
        ? 'Search remote providers.'
        : 'No results in this view.',
      state.selectedView === 'discovery'
        ? 'Type a song title or paste a direct URL into the search bar.'
        : 'Try a different search term or change the active workspace.'
    );
  }

  return items.map((track) => renderTrackRow(track, options)).join('');
}

function renderTrackRow(track, { mode, playlistId = '' }) {
  const isSelected =
    ((mode === 'remote' && state.selected.type === 'remote') ||
      (mode !== 'remote' && state.selected.type === 'track')) &&
    state.selected.id === track.id;
  const release = formatReleaseLabel(track);
  const pills = [
    track.album ? `<span class="meta-pill">${escapeHtml(track.album)}</span>` : '',
    release ? `<span class="meta-pill">${escapeHtml(release)}</span>` : '',
    track.duration ? `<span class="meta-pill meta-pill--accent">${escapeHtml(formatDuration(track.duration))}</span>` : '',
    `<span class="meta-pill">${escapeHtml(formatProvider(track.provider || track.sourcePlatform))}</span>`
  ]
    .filter(Boolean)
    .join('');

  const actions = [];
  if (mode === 'remote') {
    actions.push(
      `<button class="action-button action-button--accent" type="button" data-action="queue-download" data-remote-id="${escapeHtml(track.id)}">Queue</button>`
    );
  }

  if (mode === 'playlist') {
    actions.push(
      `<button class="action-button" type="button" data-action="remove-from-playlist" data-playlist-id="${escapeHtml(playlistId)}" data-track-id="${escapeHtml(track.id)}">Remove</button>`
    );
  }

  if (track.externalUrl || track.sourceUrl) {
    actions.push(
      `<a class="link-button" href="${escapeHtml(track.externalUrl || track.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>`
    );
  }

  return `
    <article class="row-item ${isSelected ? 'is-active' : ''}">
      ${renderArtworkTile({
        artwork: track.artwork,
        label: `${track.title} ${track.artist}`,
        variant: 'small'
      })}
      <button class="row-select" type="button" data-select-type="${mode === 'remote' ? 'remote' : 'track'}" data-id="${escapeHtml(track.id)}">
        <span class="row-item__body">
          <strong class="row-item__title">${escapeHtml(track.title || 'Unknown Title')}</strong>
          <span class="row-item__meta">
            <span>${escapeHtml(track.artist || 'Unknown Artist')}</span>
            ${pills}
          </span>
        </span>
      </button>
      <div class="row-item__actions">
        ${actions.join('')}
      </div>
    </article>
  `;
}

function renderDownloadCard(download) {
  const statusClass =
    download.status === 'completed'
      ? 'status-pill--ok'
      : download.status === 'failed'
        ? 'status-pill--danger'
        : 'status-pill--warn';
  const isSelected = state.selected.type === 'download' && state.selected.id === download.id;

  return `
    <article class="download-card ${isSelected ? 'is-active' : ''}">
      <div class="download-card__meta">
        <button class="row-select row-select--plain" type="button" data-select-type="download" data-id="${escapeHtml(download.id)}">
          <span class="row-item__body">
            <strong class="row-item__title">${escapeHtml(download.artist || 'Unknown Artist')} - ${escapeHtml(download.title || 'Unknown Title')}</strong>
            <span class="row-item__meta">
              <span class="meta-pill">${escapeHtml(formatProvider(download.provider || download.sourcePlatform))}</span>
              <span class="meta-pill">${escapeHtml(formatDateTime(download.updatedAt || download.createdAt))}</span>
            </span>
          </span>
        </button>
        <span class="status-pill ${statusClass}">${escapeHtml(download.status || 'queued')}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${Math.max(0, Math.min(100, Number(download.progress) || 0))}%"></div>
      </div>
      <p class="download-card__message">${escapeHtml(download.message || 'Waiting for worker...')}</p>
    </article>
  `;
}

function renderDetail(force = false) {
  document.querySelectorAll('[data-detail-tab]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.detailTab === state.detailTab);
  });

  if (state.detailTab === 'config') {
    if (!force && state.configRendered) {
      return;
    }

    elements.detailBody.innerHTML = renderConfigForm();
    hydrateConfigForm();
    state.configRendered = true;
    return;
  }

  state.configRendered = false;
  elements.detailBody.innerHTML = renderDetailPanel();
}

function renderDetailPanel() {
  if (state.selected.type === 'track') {
    const track = getSelectedTrackFromLibraryLikeCollections();
    if (track) {
      return renderTrackDetail(track);
    }
  }

  if (state.selected.type === 'remote') {
    const item = getSelectedRemoteResult();
    if (item) {
      return renderRemoteDetail(item);
    }
  }

  if (state.selected.type === 'download') {
    const download = getSelectedDownload();
    if (download) {
      return renderDownloadDetail(download);
    }
  }

  if (state.selected.type === 'dependency') {
    const dependency = getSelectedDependency();
    if (dependency) {
      return renderDependencyDetail(dependency);
    }
  }

  if (state.selected.type === 'playlist') {
    const playlist = getActivePlaylist();
    if (playlist) {
      return renderPlaylistDetail(playlist);
    }
  }

  return renderDashboardDetail();
}

function renderTrackDetail(track) {
  const playlists = state.dashboard?.playlists || [];
  const addButtons = playlists
    .filter((playlist) => !(playlist.trackIds || []).includes(track.id))
    .slice(0, 8)
    .map((playlist) => {
      return `
        <button class="tag-chip" type="button" data-action="add-to-playlist" data-playlist-id="${escapeHtml(playlist.id)}" data-track-id="${escapeHtml(track.id)}">
          Add to ${escapeHtml(playlist.name)}
        </button>
      `;
    })
    .join('');

  return `
    <section class="detail-shell">
      <div class="detail-hero">
        ${renderArtworkTile({
          artwork: track.artwork,
          label: `${track.title} artwork`,
          variant: 'large'
        })}
        <div class="detail-copy-block">
          <p class="panel-kicker">${escapeHtml(formatProvider(track.provider || track.sourcePlatform))}</p>
          <h2 class="detail-heading">${escapeHtml(track.title || 'Unknown Title')}</h2>
          <p class="detail-copy">${escapeHtml(track.artist || 'Unknown Artist')}</p>
        </div>
      </div>

      <div class="detail-stat-grid">
        <article class="detail-card">
          <h3>Album</h3>
          <strong>${escapeHtml(track.album || 'Singles')}</strong>
        </article>
        <article class="detail-card">
          <h3>Duration</h3>
          <strong>${escapeHtml(formatDuration(track.duration))}</strong>
        </article>
        <article class="detail-card">
          <h3>Release</h3>
          <strong>${escapeHtml(formatReleaseLabel(track) || 'Unknown')}</strong>
        </article>
        <article class="detail-card">
          <h3>ISRC</h3>
          <strong>${escapeHtml(track.isrc || 'Unavailable')}</strong>
        </article>
      </div>

      <div class="detail-actions">
        ${track.externalUrl || track.sourceUrl
          ? `<a class="action-button" href="${escapeHtml(track.externalUrl || track.sourceUrl)}" target="_blank" rel="noreferrer">Open source</a>`
          : ''}
        ${track.downloadTarget
          ? `<a class="action-button" href="${escapeHtml(track.downloadTarget)}" target="_blank" rel="noreferrer">Download target</a>`
          : ''}
      </div>

      <div class="detail-tags">
        ${addButtons || '<span class="config-note">Track is already in every available playlist.</span>'}
      </div>

      <ul class="detail-list">
        <li><strong>Metadata source</strong>${escapeHtml(track.metadataSource || 'Unknown')}</li>
        <li><strong>File name</strong>${escapeHtml(track.fileName || 'Not stored')}</li>
        <li><strong>Provider IDs</strong>${escapeHtml(
          Object.entries(track.providerIds || {})
            .filter(([, value]) => value)
            .map(([key, value]) => `${formatProvider(key)}: ${value}`)
            .join(' · ') || 'None'
        )}</li>
      </ul>
    </section>
  `;
}

function renderRemoteDetail(item) {
  return `
    <section class="detail-shell">
      <div class="detail-hero">
        ${renderArtworkTile({
          artwork: item.artwork,
          label: `${item.title} artwork`,
          variant: 'large'
        })}
        <div class="detail-copy-block">
          <p class="panel-kicker">${escapeHtml(formatProvider(item.provider))}</p>
          <h2 class="detail-heading">${escapeHtml(item.title || 'Untitled')}</h2>
          <p class="detail-copy">${escapeHtml(item.artist || 'Unknown Artist')}</p>
        </div>
      </div>

      <div class="detail-stat-grid">
        <article class="detail-card">
          <h3>Album</h3>
          <strong>${escapeHtml(item.album || 'Unknown')}</strong>
        </article>
        <article class="detail-card">
          <h3>Duration</h3>
          <strong>${escapeHtml(formatDuration(item.duration))}</strong>
        </article>
        <article class="detail-card">
          <h3>Release</h3>
          <strong>${escapeHtml(formatReleaseLabel(item) || 'Unknown')}</strong>
        </article>
        <article class="detail-card">
          <h3>Source type</h3>
          <strong>${looksLikeUrl(state.searchQuery) ? 'Direct link' : 'Provider search'}</strong>
        </article>
      </div>

      <div class="detail-actions">
        <button class="action-button action-button--accent" type="button" data-action="queue-download" data-remote-id="${escapeHtml(item.id)}">
          Queue download
        </button>
        ${item.externalUrl ? `<a class="action-button" href="${escapeHtml(item.externalUrl)}" target="_blank" rel="noreferrer">Open source</a>` : ''}
      </div>

      <ul class="detail-list">
        <li><strong>Metadata source</strong>${escapeHtml(item.metadataSource || formatProvider(item.provider))}</li>
        <li><strong>Download target</strong>${escapeHtml(item.downloadTarget || item.externalUrl || 'Unavailable')}</li>
        <li><strong>Provider IDs</strong>${escapeHtml(
          Object.entries(item.providerIds || {})
            .filter(([, value]) => value)
            .map(([key, value]) => `${formatProvider(key)}: ${value}`)
            .join(' · ') || 'None'
        )}</li>
      </ul>
    </section>
  `;
}

function renderDownloadDetail(download) {
  const statusClass =
    download.status === 'completed'
      ? 'status-pill--ok'
      : download.status === 'failed'
        ? 'status-pill--danger'
        : 'status-pill--warn';
  return `
    <section class="detail-shell">
      <div class="detail-hero">
        ${renderArtworkTile({
          artwork: download.artwork,
          label: `${download.title} artwork`,
          variant: 'large'
        })}
        <div class="detail-copy-block">
          <p class="panel-kicker">Download job</p>
          <h2 class="detail-heading">${escapeHtml(download.artist || 'Unknown Artist')} - ${escapeHtml(download.title || 'Unknown Title')}</h2>
          <div class="detail-actions">
            <span class="status-pill ${statusClass}">${escapeHtml(download.status || 'queued')}</span>
            <span class="tag-chip">${escapeHtml(formatProvider(download.provider || download.sourcePlatform))}</span>
          </div>
        </div>
      </div>

      <div class="detail-stat-grid">
        <article class="detail-card">
          <h3>Progress</h3>
          <strong>${escapeHtml(Math.round(Number(download.progress) || 0))}%</strong>
        </article>
        <article class="detail-card">
          <h3>Updated</h3>
          <strong>${escapeHtml(formatDateTime(download.updatedAt || download.createdAt))}</strong>
        </article>
      </div>

      <div class="progress-track">
        <div class="progress-fill" style="width:${Math.max(0, Math.min(100, Number(download.progress) || 0))}%"></div>
      </div>

      <p class="config-note">${escapeHtml(download.message || 'Waiting for worker...')}</p>

      <ul class="detail-list">
        <li><strong>Output path</strong>${escapeHtml(download.outputPath || 'Not written yet')}</li>
        <li><strong>Source URL</strong>${escapeHtml(download.sourceUrl || 'Unavailable')}</li>
        <li><strong>Track link</strong>${escapeHtml(download.trackId || 'Not indexed yet')}</li>
      </ul>
    </section>
  `;
}

function renderDependencyDetail(dependency) {
  return `
    <section class="detail-shell">
      <div class="detail-hero">
        <div class="detail-copy-block">
          <p class="panel-kicker">Dependency</p>
          <h2 class="detail-heading">${escapeHtml(dependency.label)}</h2>
          <div class="detail-actions">
            <span class="status-pill ${dependency.available ? 'status-pill--ok' : 'status-pill--warn'}">${escapeHtml(dependency.stateLabel)}</span>
            ${dependency.version ? `<span class="tag-chip">${escapeHtml(dependency.version)}</span>` : ''}
          </div>
        </div>
      </div>

      <p class="config-note">${escapeHtml(dependency.detail)}</p>

      ${
        dependency.key === 'updates'
          ? `<div class="detail-actions">
              <button class="action-button" type="button" data-action="check-updates">Check now</button>
              ${state.update.downloaded ? '<button class="action-button action-button--accent" type="button" data-action="install-update">Install update</button>' : ''}
            </div>`
          : ''
      }

      <ul class="detail-list">
        <li><strong>Executable path</strong>${escapeHtml(dependency.path || 'Not configured')}</li>
        <li><strong>Operator hint</strong>${escapeHtml(
          dependency.key === 'ytDlp'
            ? 'Set a valid yt-dlp path in Config if the system install cannot be found.'
            : dependency.key === 'ffmpeg'
              ? 'Set a valid ffmpeg path in Config if Apollo cannot discover it automatically.'
              : dependency.key === 'spotify'
                ? 'Spotify is optional. Provide credentials only if you want metadata-backed Spotify search.'
                : dependency.key === 'updates'
                  ? 'Set APOLLO_UPDATE_URL in packaged builds and host latest.yml plus the installer artifacts.'
                : dependency.key === 'auth'
                  ? 'Shared-secret auth is configured from the Config panel on the right.'
                  : 'Server binding follows the host and port settings from Config.'
        )}</li>
      </ul>
    </section>
  `;
}

function renderPlaylistDetail(playlist) {
  return `
    <section class="detail-shell">
      <div class="detail-hero">
        ${renderArtworkTile({
          artwork: playlist.artworkUrl,
          label: `${playlist.name} artwork`,
          variant: 'large'
        })}
        <div class="detail-copy-block">
          <p class="panel-kicker">${escapeHtml(
            playlist.sourcePlatform ? formatProvider(playlist.sourcePlatform) : 'Local playlist'
          )}</p>
          <h2 class="detail-heading">${escapeHtml(playlist.name)}</h2>
          <p class="detail-copy">${escapeHtml(
            playlist.description || 'Playlist entries can be managed from the library and discovery views.'
          )}</p>
        </div>
      </div>

      <div class="detail-stat-grid">
        <article class="detail-card">
          <h3>Tracks</h3>
          <strong>${escapeHtml((playlist.trackIds || []).length)}</strong>
        </article>
        <article class="detail-card">
          <h3>Updated</h3>
          <strong>${escapeHtml(formatDateTime(playlist.updatedAt))}</strong>
        </article>
      </div>

      <ul class="detail-list">
        <li><strong>Source</strong>${escapeHtml(
          playlist.sourcePlatform ? formatProvider(playlist.sourcePlatform) : 'Created inside Apollo'
        )}</li>
        <li><strong>Owner</strong>${escapeHtml(playlist.ownerName || 'Unknown')}</li>
        <li><strong>Imported</strong>${escapeHtml(formatDateTime(playlist.importedAt || playlist.createdAt))}</li>
      </ul>
    </section>
  `;
}

function renderDashboardDetail() {
  const server = state.dashboard?.server || {};
  const settings = state.dashboard?.settings || {};

  return `
    <section class="detail-shell">
      <div class="detail-hero">
        <div class="detail-copy-block">
          <p class="panel-kicker">Apollo</p>
          <h2 class="detail-heading">Server workstation</h2>
          <p class="detail-copy">This shell now mirrors Apollo Client's harder desktop language while keeping the server-side operator workflow intact.</p>
        </div>
      </div>

      <div class="detail-stat-grid">
        <article class="detail-card">
          <h3>Host</h3>
          <strong>${escapeHtml(server.host || settings.serverHost || '127.0.0.1')}</strong>
        </article>
        <article class="detail-card">
          <h3>Port</h3>
          <strong>${escapeHtml(server.port || settings.serverPort || '4848')}</strong>
        </article>
      </div>

      <ul class="detail-list">
        <li><strong>Library directory</strong>${escapeHtml(settings.libraryDirectory || 'Unset')}</li>
        <li><strong>Incoming directory</strong>${escapeHtml(settings.incomingDirectory || 'Unset')}</li>
        <li><strong>Background server</strong>${escapeHtml(settings.autoStartBackgroundServer ? 'Enabled' : 'Disabled')}</li>
      </ul>
    </section>
  `;
}

function renderConfigForm() {
  const settings = state.dashboard?.settings || {};
  return `
    <form id="settings-form" class="config-form">
      <section class="config-section">
        <div class="form-section-head">
          <p class="panel-kicker">Server</p>
          <h3 class="config-title">Binding and access</h3>
          <p class="config-copy">Control how Apollo binds locally, whether it stays resident in the background, and whether the API requires a shared secret.</p>
        </div>

        <div class="field-grid">
          <label class="field">
            <span class="field-label">Host</span>
            <input id="serverHost" type="text" />
          </label>
          <label class="field">
            <span class="field-label">Port</span>
            <input id="serverPort" type="text" />
          </label>
          <label class="field field--wide field--toggle">
            <span class="field-toggle-copy">
              <strong>Require API auth</strong>
              <span>Gate API and media access behind the shared secret workflow.</span>
            </span>
            <span class="toggle-shell">
              <input id="apiAuthEnabled" type="checkbox" />
              <span class="toggle-ui"></span>
            </span>
          </label>
          <label class="field">
            <span class="field-label">Session TTL (hours)</span>
            <input id="apiSessionTtlHours" type="number" min="1" max="720" />
          </label>
          <label class="field field--wide field--toggle">
            <span class="field-toggle-copy">
              <strong>Start server on login</strong>
              <span>Keep Apollo available after sign-in without opening the window.</span>
            </span>
            <span class="toggle-shell">
              <input id="autoStartBackgroundServer" type="checkbox" />
              <span class="toggle-ui"></span>
            </span>
          </label>
        </div>
      </section>

      <section class="config-section">
        <div class="form-section-head">
          <p class="panel-kicker">Storage</p>
          <h3 class="config-title">Library paths</h3>
          <p class="config-copy">Apollo uses the same directories for the desktop UI, the background server, and the CLI runtime.</p>
        </div>

        <div class="field-grid">
          <label class="field field--wide">
            <span class="field-label">Library directory</span>
            <div class="config-inline-field">
              <input id="libraryDirectory" type="text" />
              <button class="secondary-button" type="button" data-action="pick-directory" data-pick="libraryDirectory">Browse</button>
            </div>
          </label>
          <label class="field field--wide">
            <span class="field-label">Incoming directory</span>
            <div class="config-inline-field">
              <input id="incomingDirectory" type="text" />
              <button class="secondary-button" type="button" data-action="pick-directory" data-pick="incomingDirectory">Browse</button>
            </div>
          </label>
        </div>
      </section>

      <section class="config-section">
        <div class="form-section-head">
          <p class="panel-kicker">Binaries</p>
          <h3 class="config-title">Toolchain overrides</h3>
          <p class="config-copy">Leave these on defaults if yt-dlp and ffmpeg are available on PATH. Override them when Apollo should use a custom install.</p>
        </div>

        <div class="field-grid">
          <label class="field">
            <span class="field-label">yt-dlp path</span>
            <input id="ytDlpPath" type="text" />
          </label>
          <label class="field">
            <span class="field-label">ffmpeg path</span>
            <input id="ffmpegPath" type="text" />
          </label>
        </div>
      </section>

      <section class="config-section">
        <div class="form-section-head">
          <p class="panel-kicker">Credentials</p>
          <h3 class="config-title">Secrets and integrations</h3>
          <p class="config-copy">Apollo stores only the auth hash. Leaving the secret blank keeps the current secret in place.</p>
        </div>

        <div class="field-grid">
          <label class="field">
            <span class="field-label">API shared secret</span>
            <input
              id="apiSharedSecret"
              type="password"
              placeholder="${escapeHtml(
                settings.apiSharedSecretConfigured
                  ? 'Leave blank to keep the current secret'
                  : 'Set a new shared secret'
              )}"
            />
          </label>
          <label class="field">
            <span class="field-label">Spotify client ID</span>
            <input id="spotifyClientId" type="text" />
          </label>
          <label class="field field--wide">
            <span class="field-label">Spotify client secret</span>
            <input id="spotifyClientSecret" type="password" />
          </label>
        </div>
      </section>

      <div class="detail-actions">
        <button class="secondary-button" type="button" data-action="rescan-library">Rescan library</button>
        <button class="primary-button" type="submit">Save settings</button>
      </div>
    </form>
  `;
}

function hydrateConfigForm() {
  const settings = state.dashboard?.settings || {};
  for (const key of SETTING_FIELDS) {
    const input = document.getElementById(key);
    if (!input) {
      continue;
    }

    if (input.type === 'checkbox') {
      input.checked = Boolean(settings[key]);
      continue;
    }

    input.value = key === 'apiSharedSecret' ? '' : settings[key] || '';
  }
}

function collectSettings() {
  return Object.fromEntries(
    SETTING_FIELDS.map((key) => {
      const input = document.getElementById(key);
      if (!input) {
        return [key, ''];
      }

      if (input.type === 'checkbox') {
        return [key, input.checked];
      }

      return [key, input.value.trim()];
    })
  );
}

function renderFooter() {
  const auth = state.dashboard?.auth || {};
  const update = state.update || createEmptyUpdateState();
  elements.footerUpdate.textContent = update.downloaded
    ? 'Update ready'
    : update.checking
      ? 'Checking updates'
      : update.supported && update.configured
        ? 'Updates on'
        : 'Updates off';
  elements.footerAuth.textContent = auth.enabled ? 'Auth on' : 'Auth off';
  elements.footerDownloads.textContent = `${countActiveDownloads()} active jobs`;
}

function renderAll({ forceDetail = false } = {}) {
  renderSidebar();
  renderMain();
  renderFooter();
  renderDetail(forceDetail);
}

function upsertDownloadRecord(download) {
  if (!state.dashboard) {
    return;
  }

  const downloads = Array.isArray(state.dashboard.downloads) ? [...state.dashboard.downloads] : [];
  const index = downloads.findIndex((item) => item.id === download.id);
  if (index >= 0) {
    downloads[index] = {
      ...downloads[index],
      ...download
    };
  } else {
    downloads.unshift(download);
  }

  downloads.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
  state.dashboard.downloads = downloads;
  state.dashboard.overview.downloadCount = downloads.length;
  state.dashboard.overview.completedDownloads = downloads.filter(
    (item) => item.status === 'completed'
  ).length;
}

function upsertPlaylistRecord(playlist) {
  if (!state.dashboard) {
    return;
  }

  const playlists = Array.isArray(state.dashboard.playlists) ? [...state.dashboard.playlists] : [];
  const index = playlists.findIndex((item) => item.id === playlist.id);
  if (index >= 0) {
    playlists[index] = playlist;
  } else {
    playlists.push(playlist);
  }

  state.dashboard.playlists = playlists;
  state.dashboard.overview.playlistCount = playlists.length;
}

async function refreshDashboard({ forceDetail = false } = {}) {
  state.dashboard = await window.mediaApp.getDashboard();
  if (!state.selectedPlaylistId && (state.dashboard.playlists || []).length) {
    state.selectedPlaylistId = state.dashboard.playlists[0].id;
  }

  syncSelection();
  renderAll({ forceDetail });
}

async function refreshViewData() {
  const requestId = ++state.viewRequestId;
  state.isLoadingView = true;
  renderMain();

  try {
    if (state.selectedView === 'library') {
      state.libraryResult = await window.mediaApp.listLibrary({
        query: state.searchQuery,
        page: 1,
        pageSize: 200
      });
    } else if (state.selectedView === 'discovery') {
      if (!state.searchQuery.trim()) {
        state.remoteResult = createEmptyRemoteResult();
      } else if (looksLikeUrl(state.searchQuery)) {
        const item = await window.mediaApp.inspectLink(state.searchQuery.trim());
        state.remoteResult = {
          ...createEmptyRemoteResult(),
          items: item ? [item] : [],
          total: item ? 1 : 0
        };
      } else {
        state.remoteResult = await window.mediaApp.search({
          query: state.searchQuery,
          page: 1,
          pageSize: 18
        });
      }
    }
  } catch (error) {
    setStatus(error.message);
    if (state.selectedView === 'library') {
      state.libraryResult = createEmptyLibraryResult();
    }

    if (state.selectedView === 'discovery') {
      state.remoteResult = createEmptyRemoteResult();
    }
  } finally {
    if (requestId !== state.viewRequestId) {
      return;
    }

    state.isLoadingView = false;
    syncSelection();
    renderAll();
  }
}

function scheduleViewRefresh() {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    void refreshViewData();
  }, state.selectedView === 'discovery' ? 280 : 120);
}

function scheduleDashboardRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    void Promise.all([refreshDashboard(), refreshViewData()]);
  }, 450);
}

async function safely(action) {
  try {
    await action();
  } catch (error) {
    setStatus(error.message);
  }
}

async function handleViewChange(nextView) {
  state.selectedView = nextView;
  state.detailTab = 'details';
  state.configRendered = false;

  if (nextView === 'playlist') {
    if (!state.selectedPlaylistId && (state.dashboard?.playlists || []).length) {
      state.selectedPlaylistId = state.dashboard.playlists[0].id;
    }
    state.selected = {
      type: 'playlist',
      id: state.selectedPlaylistId
    };
    syncSelection();
    renderAll({ forceDetail: true });
    return;
  }

  if (nextView === 'downloads' || nextView === 'dependencies') {
    syncSelection();
    renderAll({ forceDetail: true });
    return;
  }

  await refreshViewData();
}

function handleDocumentClick(event) {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    void safely(() => handleViewChange(viewButton.dataset.view));
    return;
  }

  const detailTabButton = event.target.closest('[data-detail-tab]');
  if (detailTabButton) {
    state.detailTab = detailTabButton.dataset.detailTab;
    state.configRendered = false;
    renderDetail(true);
    return;
  }

  const playlistButton = event.target.closest('[data-playlist-id]');
  if (playlistButton && !event.target.closest('[data-action="remove-from-playlist"]')) {
    state.selectedPlaylistId = playlistButton.dataset.playlistId;
    state.selectedView = 'playlist';
    state.selected = {
      type: 'playlist',
      id: state.selectedPlaylistId
    };
    state.detailTab = 'details';
    syncSelection();
    renderAll({ forceDetail: true });
    return;
  }

  const selectButton = event.target.closest('[data-select-type]');
  if (selectButton) {
    state.selected = {
      type: selectButton.dataset.selectType,
      id: selectButton.dataset.id
    };
    state.detailTab = 'details';
    renderDetail(true);
    renderMain();
    return;
  }

  const dependencyButton = event.target.closest('[data-dependency-id]');
  if (dependencyButton) {
    state.selectedView = 'dependencies';
    state.selected = {
      type: 'dependency',
      id: dependencyButton.dataset.dependencyId
    };
    state.detailTab = 'details';
    syncSelection();
    renderAll({ forceDetail: true });
    return;
  }

  const action = event.target.closest('[data-action]');
  if (!action) {
    return;
  }

  const type = action.dataset.action;
  if (type === 'rescan-library') {
    void safely(async () => {
      await window.mediaApp.rescanLibrary();
      await Promise.all([refreshDashboard(), refreshViewData()]);
      setStatus('Library rescan complete.');
    });
    return;
  }

  if (type === 'check-updates') {
    void safely(async () => {
      state.update = await window.mediaApp.checkForUpdates();
      renderAll({ forceDetail: state.selected.type === 'dependency' && state.selected.id === 'updates' });
      setStatus(state.update.message || 'Checking for updates...');
    });
    return;
  }

  if (type === 'open-library') {
    void safely(async () => {
      await window.mediaApp.openDownloadFolder();
      setStatus('Opened Apollo library folder.');
    });
    return;
  }

  if (type === 'pick-directory') {
    void safely(async () => {
      const selected = await window.mediaApp.pickDirectory();
      if (!selected) {
        return;
      }

      const input = document.getElementById(action.dataset.pick);
      if (input) {
        input.value = selected;
      }
    });
    return;
  }

  if (type === 'queue-download') {
    void safely(async () => {
      const item = getRemoteItems().find((entry) => entry.id === action.dataset.remoteId);
      if (!item) {
        return;
      }

      const queued = await window.mediaApp.startDownload(item);
      upsertDownloadRecord(queued);
      renderAll();
      setStatus(`Queued download: ${item.artist || 'Unknown Artist'} - ${item.title || 'Unknown Title'}`);
    });
    return;
  }

  if (type === 'install-update') {
    void safely(async () => {
      const started = await window.mediaApp.installUpdate();
      if (started) {
        setStatus('Installing update and restarting Apollo...');
      }
    });
    return;
  }

  if (type === 'add-to-playlist') {
    void safely(async () => {
      const playlist = await window.mediaApp.addTrackToPlaylist({
        playlistId: action.dataset.playlistId,
        trackId: action.dataset.trackId
      });
      upsertPlaylistRecord(playlist);
      renderAll({ forceDetail: true });
      setStatus(`Added track to ${playlist.name}.`);
    });
    return;
  }

  if (type === 'remove-from-playlist') {
    void safely(async () => {
      const playlist = await window.mediaApp.removeTrackFromPlaylist({
        playlistId: action.dataset.playlistId,
        trackId: action.dataset.trackId
      });
      upsertPlaylistRecord(playlist);
      syncSelection();
      renderAll({ forceDetail: true });
      setStatus(`Removed track from ${playlist.name}.`);
    });
  }
}

function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  if (form.id === 'create-playlist-form') {
    event.preventDefault();
    void safely(async () => {
      const input = document.getElementById('create-playlist-name');
      const name = input?.value.trim();
      if (!name) {
        setStatus('Enter a playlist name.');
        return;
      }

      const playlist = await window.mediaApp.createPlaylist({
        name
      });
      input.value = '';
      upsertPlaylistRecord(playlist);
      state.selectedPlaylistId = playlist.id;
      state.selectedView = 'playlist';
      state.selected = {
        type: 'playlist',
        id: playlist.id
      };
      renderAll({ forceDetail: true });
      setStatus(`Created playlist: ${playlist.name}.`);
    });
    return;
  }

  if (form.id === 'settings-form') {
    event.preventDefault();
    void safely(async () => {
      const payload = await window.mediaApp.saveSettings(collectSettings());
      state.dashboard = {
        ...state.dashboard,
        settings: payload.settings,
        dependencies: payload.dependencies,
        server: payload.server,
        auth: payload.auth
      };
      await Promise.all([refreshDashboard({ forceDetail: true }), refreshViewData()]);
      setStatus('Settings saved and server restarted.');
    });
  }
}

elements.searchInput.addEventListener('input', (event) => {
  state.searchQuery = event.target.value;
  if (
    state.selectedView === 'downloads' ||
    state.selectedView === 'dependencies' ||
    state.selectedView === 'playlist'
  ) {
    syncSelection();
    renderAll();
    return;
  }

  scheduleViewRefresh();
});

document.addEventListener('click', handleDocumentClick);
document.addEventListener('submit', handleSubmit);

state.stopDownloadSubscription = window.mediaApp.onDownloadUpdate((download) => {
  upsertDownloadRecord(download);
  if (download.status === 'completed') {
    setStatus(`Download complete: ${download.artist || 'Unknown Artist'} - ${download.title || 'Unknown Title'}`);
    scheduleDashboardRefresh();
  } else if (download.status === 'failed') {
    setStatus(`Download failed: ${download.message || 'Unknown error'}`);
    scheduleDashboardRefresh();
  } else {
    renderFooter();
    if (state.selectedView === 'downloads') {
      syncSelection();
      renderMain();
    }
    if (state.selected.type === 'download' && state.selected.id === download.id && state.detailTab === 'details') {
      renderDetail(true);
    }
  }
});

window.mediaApp.onUpdateState((payload) => {
  state.update = {
    ...createEmptyUpdateState(),
    ...payload
  };
  renderFooter();
  if (state.selectedView === 'dependencies') {
    renderMain();
  }
  if (state.selected.type === 'dependency' && state.selected.id === 'updates' && state.detailTab === 'details') {
    renderDetail(true);
  }
});

window.addEventListener('beforeunload', () => {
  state.stopDownloadSubscription?.();
  clearTimeout(state.searchTimer);
  clearTimeout(state.refreshTimer);
});

async function boot() {
  state.update = {
    ...createEmptyUpdateState(),
    ...(await window.mediaApp.getUpdateState())
  };
  await refreshDashboard();
  await refreshViewData();
  setStatus('Apollo server manager ready.');
}

boot().catch((error) => {
  setStatus(error.message);
});
