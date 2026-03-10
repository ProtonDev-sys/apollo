const elements = {
  statusBanner: document.getElementById('status-banner'),
  serverBadge: document.getElementById('server-badge'),
  serverUrl: document.getElementById('server-url'),
  dependencyGrid: document.getElementById('dependency-grid'),
  saveSettings: document.getElementById('save-settings'),
  rescanLibrary: document.getElementById('rescan-library'),
  openLibraryFolder: document.getElementById('open-library-folder'),
  statTracks: document.getElementById('stat-tracks'),
  statPlaylists: document.getElementById('stat-playlists'),
  statDownloads: document.getElementById('stat-downloads'),
  statComplete: document.getElementById('stat-complete'),
  settings: {
    serverHost: document.getElementById('serverHost'),
    serverPort: document.getElementById('serverPort'),
    apiAuthEnabled: document.getElementById('apiAuthEnabled'),
    apiSessionTtlHours: document.getElementById('apiSessionTtlHours'),
    libraryDirectory: document.getElementById('libraryDirectory'),
    incomingDirectory: document.getElementById('incomingDirectory'),
    ytDlpPath: document.getElementById('ytDlpPath'),
    ffmpegPath: document.getElementById('ffmpegPath'),
    apiSharedSecret: document.getElementById('apiSharedSecret'),
    spotifyClientId: document.getElementById('spotifyClientId'),
    spotifyClientSecret: document.getElementById('spotifyClientSecret')
  }
};

const state = {
  dashboard: null
};

function setStatus(text) {
  elements.statusBanner.textContent = text;
}

async function safely(action) {
  try {
    await action();
  } catch (error) {
    setStatus(error.message);
  }
}

function hydrateSettings(settings) {
  Object.entries(elements.settings).forEach(([key, input]) => {
    if (input.type === 'checkbox') {
      input.checked = Boolean(settings[key]);
      return;
    }

    input.value = settings[key] || '';
  });
}

function collectSettings() {
  return Object.fromEntries(
    Object.entries(elements.settings).map(([key, input]) => [
      key,
      input.type === 'checkbox' ? input.checked : input.value.trim()
    ])
  );
}

function renderStatus(dashboard) {
  const server = dashboard.server;
  const overview = dashboard.overview;
  const auth = dashboard.auth;

  elements.serverBadge.textContent = server.running ? 'Running' : 'Stopped';
  elements.serverBadge.className = `status-pill ${server.running ? 'ok' : 'warn'}`;
  elements.serverUrl.textContent = server.baseUrl
    ? auth.enabled
      ? `${server.baseUrl} (auth required)`
      : server.baseUrl
    : 'Server unavailable';
  elements.statTracks.textContent = overview.trackCount;
  elements.statPlaylists.textContent = overview.playlistCount;
  elements.statDownloads.textContent = overview.downloadCount;
  elements.statComplete.textContent = overview.completedDownloads;
}

function renderDependencies(dashboard) {
  const deps = dashboard.dependencies;
  const rows = [
    {
      label: 'yt-dlp',
      status: deps.ytDlp.available ? 'Ready' : 'Missing',
      detail: deps.ytDlp.available ? 'Configured and available.' : 'Needed for remote search, playback resolution, and downloads.'
    },
    {
      label: 'ffmpeg',
      status: deps.ffmpeg.available ? 'Ready' : 'Missing',
      detail: deps.ffmpeg.available ? 'Configured and available.' : 'Needed for server-side audio downloads.'
    },
    {
      label: 'Spotify API credentials',
      status: deps.spotifyConfigured ? 'Ready' : 'Optional',
      detail: deps.spotifyConfigured
        ? 'Configured for Spotify metadata search'
        : 'Not installable here. Add client ID and secret only if you want Spotify metadata search.'
    }
  ];

  elements.dependencyGrid.innerHTML = rows
    .map((row) => {
      return `
        <article class="list-row">
          <div>
            <strong>${row.label}</strong>
            <p class="muted small-text">${row.detail}</p>
          </div>
          <span class="status-pill ${row.status === 'Ready' ? 'ok' : 'warn'}">${row.status}</span>
        </article>
      `;
    })
    .join('');
}

async function refreshDashboard() {
  state.dashboard = await window.mediaApp.getDashboard();
  hydrateSettings(state.dashboard.settings);
  renderStatus(state.dashboard);
  renderDependencies(state.dashboard);
}

elements.saveSettings.addEventListener('click', async () => safely(async () => {
  const payload = await window.mediaApp.saveSettings(collectSettings());
  state.dashboard.settings = payload.settings;
  state.dashboard.server = payload.server;
  state.dashboard.dependencies = payload.dependencies;
  hydrateSettings(payload.settings);
  renderStatus(state.dashboard);
  renderDependencies(state.dashboard);
  setStatus('Settings saved and server restarted.');
}));

elements.rescanLibrary.addEventListener('click', async () => safely(async () => {
  await window.mediaApp.rescanLibrary();
  await refreshDashboard();
  setStatus('Library rescan complete.');
}));

elements.openLibraryFolder.addEventListener('click', async () => safely(async () => {
  await window.mediaApp.openDownloadFolder();
}));

document.querySelectorAll('.pick-dir').forEach((button) => {
  button.addEventListener('click', async () => safely(async () => {
    const selected = await window.mediaApp.pickDirectory();
    if (selected) {
      elements.settings[button.dataset.pick].value = selected;
    }
  }));
});

refreshDashboard()
  .then(() => {
    setStatus('Server manager ready.');
  })
  .catch((error) => {
    setStatus(error.message);
  });
