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
  fitRoot: document.getElementById('fit-root'),
  serverBadge: document.getElementById('server-badge'),
  serverUrl: document.getElementById('server-url'),
  statusBanner: document.getElementById('status-banner'),
  runtimeStartup: document.getElementById('runtime-startup'),
  runtimeAuth: document.getElementById('runtime-auth'),
  runtimeLibrary: document.getElementById('runtime-library'),
  runtimeDependencies: document.getElementById('runtime-dependencies'),
  serverSummary: document.getElementById('server-summary'),
  dependencyList: document.getElementById('dependency-list')
};

const state = {
  dashboard: null,
  stopDownloadSubscription: null,
  refreshTimer: null,
  fitFrame: 0,
  fitObserver: null
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortenValue(value, maxLength = 52) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) {
    return text;
  }

  const leading = Math.max(16, Math.floor((maxLength - 3) * 0.58));
  const trailing = Math.max(10, maxLength - leading - 3);
  return `${text.slice(0, leading)}...${text.slice(-trailing)}`;
}

function setStatus(message) {
  elements.statusBanner.textContent = String(message || '').trim() || 'Ready.';
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

function hydrateSettings(settings) {
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

function getDependencyItems() {
  const dependencies = state.dashboard?.dependencies || {};
  return [
    {
      label: 'yt-dlp',
      ready: Boolean(dependencies.ytDlp?.available),
      detail: dependencies.ytDlp?.available
        ? shortenValue(dependencies.ytDlp.path || 'Available on PATH')
        : dependencies.ytDlp?.error || 'Required for remote search and downloads.'
    },
    {
      label: 'ffmpeg',
      ready: Boolean(dependencies.ffmpeg?.available),
      detail: dependencies.ffmpeg?.available
        ? shortenValue(dependencies.ffmpeg.path || 'Available on PATH')
        : dependencies.ffmpeg?.error || 'Required for download processing.'
    },
    {
      label: 'Spotify metadata',
      ready: Boolean(dependencies.spotifyConfigured),
      detail: dependencies.spotifyConfigured
        ? 'Credentials configured.'
        : 'Optional. Only needed for Spotify-backed metadata.'
    }
  ];
}

function renderRuntime() {
  const dashboard = state.dashboard;
  const settings = dashboard?.settings || {};
  const server = dashboard?.server || {};
  const auth = dashboard?.auth || {};
  const dependencies = getDependencyItems();
  const readyCount = dependencies.filter((dependency) => dependency.ready).length;

  elements.serverBadge.textContent = server.running ? 'Running' : 'Stopped';
  elements.serverBadge.className = `status-pill ${server.running ? 'status-pill--ok' : 'status-pill--warn'}`;
  elements.serverUrl.textContent = server.baseUrl || 'Server unavailable';

  elements.runtimeStartup.textContent = settings.autoStartBackgroundServer ? 'On' : 'Off';
  elements.runtimeAuth.textContent = auth.enabled ? 'On' : 'Off';
  elements.runtimeLibrary.textContent = shortenValue(settings.libraryDirectory || 'Unset', 34);
  elements.runtimeDependencies.textContent = `${readyCount}/${dependencies.length}`;

  elements.serverSummary.innerHTML = [
    {
      label: 'Host',
      value: settings.serverHost || '127.0.0.1',
      meta: 'Network interface binding.'
    },
    {
      label: 'Port',
      value: settings.serverPort || '4848',
      meta: 'HTTP service port.'
    },
    {
      label: 'Background mode',
      value: settings.autoStartBackgroundServer ? 'Enabled' : 'Disabled',
      meta: 'Hide or close without stopping the server.'
    },
    {
      label: 'Auth',
      value: auth.enabled ? `Enabled - ${auth.sessionTtlHours || 0}h TTL` : 'Disabled',
      meta: 'Shared-secret protection.'
    }
  ]
    .map((item) => {
      return `
        <article class="stack-row">
          <span class="stack-row__label">${escapeHtml(item.label)}</span>
          <div class="stack-row__body">
            <strong class="stack-row__value" title="${escapeHtml(item.value)}">${escapeHtml(shortenValue(item.value, 40))}</strong>
            <p class="stack-row__meta">${escapeHtml(item.meta)}</p>
          </div>
        </article>
      `;
    })
    .join('');

  elements.dependencyList.innerHTML = dependencies
    .map((dependency) => {
      return `
        <article class="stack-row">
          <span class="status-pill ${dependency.ready ? 'status-pill--ok' : 'status-pill--warn'}">
            ${dependency.ready ? 'Ready' : 'Needs setup'}
          </span>
          <div class="stack-row__body">
            <strong class="stack-row__value">${escapeHtml(dependency.label)}</strong>
            <p class="stack-row__meta" title="${escapeHtml(dependency.detail)}">${escapeHtml(dependency.detail)}</p>
          </div>
        </article>
      `;
    })
    .join('');
}

function render() {
  hydrateSettings(state.dashboard?.settings || {});
  renderRuntime();
  queueViewportFit();
}

function updateViewportFit() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const horizontalPadding = 16;
  const verticalPadding = 16;

  document.body.classList.toggle('is-compact', width < 1260 || height < 760);
  document.body.classList.toggle('is-tight', width < 1120 || height < 700);
  document.documentElement.style.setProperty('--ui-scale', '1');

  const naturalWidth = Math.max(
    elements.fitRoot.scrollWidth,
    elements.fitRoot.offsetWidth
  );
  const naturalHeight = Math.max(
    elements.fitRoot.scrollHeight,
    elements.fitRoot.offsetHeight
  );
  const scale = Math.min(
    (width - horizontalPadding) / Math.max(1, naturalWidth),
    (height - verticalPadding) / Math.max(1, naturalHeight),
    1
  );

  document.documentElement.style.setProperty('--ui-scale', String(Math.max(0.1, scale)));
}

function queueViewportFit() {
  if (state.fitFrame) {
    window.cancelAnimationFrame(state.fitFrame);
  }

  state.fitFrame = window.requestAnimationFrame(() => {
    state.fitFrame = 0;
    updateViewportFit();
  });
}

function startViewportFitObservers() {
  if ('ResizeObserver' in window && !state.fitObserver) {
    state.fitObserver = new ResizeObserver(() => {
      queueViewportFit();
    });
    state.fitObserver.observe(elements.fitRoot);
  }

  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      queueViewportFit();
    });
  }
}

function scheduleDashboardRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    void refreshDashboard();
  }, 500);
}

async function refreshDashboard() {
  state.dashboard = await window.mediaApp.getDashboard();
  render();
}

async function safely(action) {
  try {
    await action();
  } catch (error) {
    setStatus(error.message);
  }
}

function handleDocumentClick(event) {
  const action = event.target.closest('[data-action]');
  if (!action) {
    return;
  }

  const type = action.dataset.action;
  if (type === 'hide-window') {
    void safely(async () => {
      await window.mediaApp.hideWindow();
      setStatus('Apollo hidden. The tray keeps the service accessible.');
    });
    return;
  }

  if (type === 'open-library') {
    void safely(async () => {
      await window.mediaApp.openDownloadFolder();
      setStatus('Opened the Apollo library folder.');
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
  }
}

function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id !== 'settings-form') {
    return;
  }

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
    render();
    setStatus('Settings saved and Apollo restarted with the new configuration.');
  });
}

document.addEventListener('click', handleDocumentClick);
document.addEventListener('submit', handleSubmit);

state.stopDownloadSubscription = window.mediaApp.onDownloadUpdate((download) => {
  if (download.status === 'completed') {
    setStatus(`Download complete: ${download.artist || 'Unknown Artist'} - ${download.title || 'Unknown Title'}`);
    scheduleDashboardRefresh();
  } else if (download.status === 'failed') {
    setStatus(`Download failed: ${download.message || 'Unknown error'}`);
    scheduleDashboardRefresh();
  }
});

window.addEventListener('beforeunload', () => {
  state.stopDownloadSubscription?.();
  clearTimeout(state.refreshTimer);
  if (state.fitFrame) {
    window.cancelAnimationFrame(state.fitFrame);
  }
  state.fitObserver?.disconnect();
});

window.addEventListener('resize', queueViewportFit);

refreshDashboard()
  .then(() => {
    startViewportFitObservers();
    queueViewportFit();
    setStatus('Apollo is ready. Configure it once, then hide it like a service.');
  })
  .catch((error) => {
    setStatus(error.message);
  });
