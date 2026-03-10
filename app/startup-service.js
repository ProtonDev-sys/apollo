const fs = require('fs/promises');
const path = require('path');

const STARTUP_SCRIPT_NAME = 'Apollo Background Server.vbs';

function isWindows() {
  return process.platform === 'win32';
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

class StartupService {
  constructor({ appRoot, startupDirectory = '', isDefaultApp = process.defaultApp }) {
    this.appRoot = appRoot;
    this.startupDirectory = startupDirectory;
    this.isDefaultApp = isDefaultApp;
  }

  isSupported() {
    return isWindows();
  }

  async sync(settings) {
    if (!this.isSupported()) {
      return {
        supported: false,
        enabled: false
      };
    }

    const startupScriptPath = getStartupScriptPath(this.startupDirectory || getWindowsStartupDirectory());
    if (!settings.autoStartBackgroundServer) {
      await fs.rm(startupScriptPath, { force: true });
      return {
        supported: true,
        enabled: false,
        path: startupScriptPath
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
      path: startupScriptPath
    };
  }
}

module.exports = {
  StartupService
};
