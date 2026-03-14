const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const STARTUP_SCRIPT_NAME = 'Apollo Background Server.vbs';
const LINUX_AUTOSTART_NAME = 'apollo-background.desktop';

function isWindows() {
  return process.platform === 'win32';
}

function isLinux() {
  return process.platform === 'linux';
}

function getWindowsStartupDirectory() {
  return path.join(
    process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
  );
}

function getStartupScriptPath(startupDirectory = getWindowsStartupDirectory()) {
  if (!isWindows()) {
    return '';
  }

  return path.join(startupDirectory, STARTUP_SCRIPT_NAME);
}

function escapeVbsString(value) {
  return String(value || '').replace(/"/g, '""');
}

function buildLaunchArguments(appRoot, isDefaultApp = process.defaultApp) {
  const args = [];
  if (isDefaultApp) {
    args.push(appRoot);
  }

  args.push('--background');
  return args;
}

function getLinuxAutostartDirectory() {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'autostart'
  );
}

function getLinuxAutostartPath(autostartDirectory = getLinuxAutostartDirectory()) {
  if (!isLinux()) {
    return '';
  }

  return path.join(autostartDirectory, LINUX_AUTOSTART_NAME);
}

function buildStartupScript({ executablePath, appRoot, isDefaultApp }) {
  const args = buildLaunchArguments(appRoot, isDefaultApp)
    .map((value) => `"${escapeVbsString(value)}"`)
    .join(' ');

  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${escapeVbsString(appRoot)}"`,
    `shell.Run """${escapeVbsString(executablePath)}"" ${args}", 0, False`
  ].join('\r\n');
}

function escapeDesktopEntry(value) {
  return String(value || '').replace(/(["\\$`])/g, '\\$1');
}

function buildLinuxAutostartEntry({ executablePath, appRoot, isDefaultApp }) {
  const args = buildLaunchArguments(appRoot, isDefaultApp)
    .map((value) => `"${escapeDesktopEntry(value)}"`)
    .join(' ');

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Apollo Background Server',
    'Comment=Start Apollo in background mode at login',
    `Exec="${escapeDesktopEntry(executablePath)}" ${args}`.trim(),
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupNotify=false'
  ].join('\n');
}

class StartupService {
  constructor({
    appRoot,
    startupDirectory = '',
    linuxAutostartDirectory = '',
    isDefaultApp = process.defaultApp,
    electronApp = null
  }) {
    this.appRoot = appRoot;
    this.startupDirectory = startupDirectory;
    this.linuxAutostartDirectory = linuxAutostartDirectory;
    this.isDefaultApp = isDefaultApp;
    this.electronApp = electronApp;
  }

  isSupported() {
    return isWindows() || isLinux();
  }

  syncWindowsLoginItem(enabled) {
    if (!this.electronApp?.setLoginItemSettings) {
      return false;
    }

    const args = buildLaunchArguments(this.appRoot, this.isDefaultApp);
    this.electronApp.setLoginItemSettings({
      openAtLogin: enabled,
      args
    });
    return true;
  }

  async sync(settings) {
    if (!this.isSupported()) {
      return {
        supported: false,
        enabled: false
      };
    }

    if (isWindows()) {
      const startupScriptPath = getStartupScriptPath(
        this.startupDirectory || getWindowsStartupDirectory()
      );

      if (!settings.autoStartBackgroundServer) {
        this.syncWindowsLoginItem(false);
        await fs.rm(startupScriptPath, { force: true });
        return {
          supported: true,
          enabled: false,
          path: startupScriptPath,
          mechanism: 'windows-login-item'
        };
      }

      if (this.syncWindowsLoginItem(true)) {
        await fs.rm(startupScriptPath, { force: true });
        return {
          supported: true,
          enabled: true,
          path: process.execPath,
          mechanism: 'windows-login-item'
        };
      }

      await fs.mkdir(path.dirname(startupScriptPath), { recursive: true });
      await fs.writeFile(
        startupScriptPath,
        buildStartupScript({
          executablePath: process.execPath,
          appRoot: this.appRoot,
          isDefaultApp: this.isDefaultApp
        }),
        'utf8'
      );

      return {
        supported: true,
        enabled: true,
        path: startupScriptPath,
        mechanism: 'windows-startup-folder'
      };
    }

    const autostartPath = getLinuxAutostartPath(
      this.linuxAutostartDirectory || getLinuxAutostartDirectory()
    );
    if (!settings.autoStartBackgroundServer) {
      await fs.rm(autostartPath, { force: true });
      return {
        supported: true,
        enabled: false,
        path: autostartPath,
        mechanism: 'linux-xdg-autostart'
      };
    }

    await fs.mkdir(path.dirname(autostartPath), { recursive: true });
    await fs.writeFile(
      autostartPath,
      buildLinuxAutostartEntry({
        executablePath: process.execPath,
        appRoot: this.appRoot,
        isDefaultApp: this.isDefaultApp
      }),
      'utf8'
    );

    return {
      supported: true,
      enabled: true,
      path: autostartPath,
      mechanism: 'linux-xdg-autostart'
    };
  }
}

module.exports = {
  StartupService,
  buildLinuxAutostartEntry
};
