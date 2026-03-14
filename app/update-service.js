const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const UPDATE_POLL_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_UPDATE_CHECK_DELAY_MS = 15 * 1000;

class UpdateService extends EventEmitter {
  constructor({ electronApp }) {
    super();
    this.electronApp = electronApp;
    this.pollTimer = null;
    this.initialCheckTimer = null;
    this.initialized = false;
    this.state = {
      supported: electronApp.isPackaged,
      configured: false,
      checking: false,
      available: false,
      downloaded: false,
      progress: 0,
      version: electronApp.getVersion(),
      message: electronApp.isPackaged
        ? 'Updates are not configured yet.'
        : 'Updates are only available in packaged builds.',
      error: ''
    };
    this.autoUpdater = null;
  }

  getState() {
    return {
      ...this.state
    };
  }

  setState(nextState) {
    this.state = {
      ...this.state,
      ...nextState
    };
    this.emit('changed', this.getState());
  }

  hasBuiltInFeedConfig() {
    return fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  }

  configureFeed() {
    if (!this.autoUpdater) {
      return false;
    }

    const genericUrl = String(process.env.APOLLO_UPDATE_URL || '').trim();
    if (!genericUrl) {
      return false;
    }

    this.autoUpdater.setFeedURL({
      provider: 'generic',
      url: genericUrl,
      channel: String(process.env.APOLLO_UPDATE_CHANNEL || 'latest').trim() || 'latest'
    });
    return true;
  }

  initialize() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    if (!this.electronApp.isPackaged) {
      this.emit('changed', this.getState());
      return;
    }

    try {
      ({ autoUpdater: this.autoUpdater } = require('electron-updater'));
      const configuredFromEnvironment = this.configureFeed();
      const configured = configuredFromEnvironment || this.hasBuiltInFeedConfig();
      this.setState({
        supported: true,
        configured,
        message: configured
          ? 'Ready to check for updates.'
          : 'Set APOLLO_UPDATE_URL or GitHub publish metadata to enable updates.'
      });

      if (!configured) {
        return;
      }

      this.autoUpdater.autoDownload = true;
      this.autoUpdater.autoInstallOnAppQuit = true;

      this.autoUpdater.on('checking-for-update', () => {
        this.setState({
          checking: true,
          error: '',
          message: 'Checking for updates...'
        });
      });

      this.autoUpdater.on('update-available', (info) => {
        this.setState({
          checking: false,
          available: true,
          downloaded: false,
          progress: 0,
          version: info?.version || this.state.version,
          message: `Downloading Apollo ${info?.version || 'update'}...`,
          error: ''
        });
      });

      this.autoUpdater.on('update-not-available', (info) => {
        this.setState({
          checking: false,
          available: false,
          downloaded: false,
          progress: 0,
          version: info?.version || this.electronApp.getVersion(),
          message: 'Apollo is up to date.',
          error: ''
        });
      });

      this.autoUpdater.on('download-progress', (progress) => {
        this.setState({
          checking: false,
          available: true,
          downloaded: false,
          progress: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
          message: `Downloading update... ${Math.round(Number(progress?.percent) || 0)}%`,
          error: ''
        });
      });

      this.autoUpdater.on('update-downloaded', (info) => {
        this.setState({
          checking: false,
          available: true,
          downloaded: true,
          progress: 100,
          version: info?.version || this.state.version,
          message: `Apollo ${info?.version || 'update'} is ready to install.`,
          error: ''
        });
      });

      this.autoUpdater.on('error', (error) => {
        this.setState({
          checking: false,
          error: error.message,
          message: error.message || 'Update check failed.'
        });
      });

      this.initialCheckTimer = setTimeout(() => {
        void this.checkForUpdates();
      }, INITIAL_UPDATE_CHECK_DELAY_MS);

      this.pollTimer = setInterval(() => {
        void this.checkForUpdates();
      }, UPDATE_POLL_INTERVAL_MS);
    } catch (error) {
      this.autoUpdater = null;
      this.setState({
        supported: false,
        configured: false,
        checking: false,
        available: false,
        downloaded: false,
        progress: 0,
        message: `Updates are unavailable: ${error.message}`,
        error: error.message
      });
    }
  }

  async checkForUpdates() {
    if (!this.state.configured) {
      this.setState({
        message: this.electronApp.isPackaged
          ? 'Updates are not configured for this build.'
          : 'Updates are only available in packaged builds.'
      });
      return this.getState();
    }

    if (!this.autoUpdater || this.state.checking || this.state.downloaded) {
      return this.getState();
    }

    this.setState({
      checking: true,
      error: '',
      message: 'Checking for updates...'
    });

    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      this.setState({
        checking: false,
        error: error.message,
        message: error.message || 'Update check failed.'
      });
      throw error;
    }

    return this.getState();
  }

  quitAndInstall() {
    if (!this.state.downloaded) {
      return false;
    }

    this.autoUpdater.quitAndInstall();
    return true;
  }

  dispose() {
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

module.exports = {
  UpdateService
};
