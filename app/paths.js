const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const APP_NAME = 'apollo';
const LEGACY_APP_NAME = 'spotify-download-desktop';

function getBaseDataDirectory() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

function getLegacyBaseDataDirectory() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), LEGACY_APP_NAME);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', LEGACY_APP_NAME);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), LEGACY_APP_NAME);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function copyDirectory(sourcePath, targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const targetEntry = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, targetEntry);
      continue;
    }

    if (entry.isFile()) {
      await fs.copyFile(sourceEntry, targetEntry);
    }
  }
}

async function ensureAppDataDirectory() {
  const targetPath = getBaseDataDirectory();
  const legacyPath = getLegacyBaseDataDirectory();

  if (!(await pathExists(targetPath)) && (await pathExists(legacyPath))) {
    await copyDirectory(legacyPath, targetPath);
  }

  await fs.mkdir(targetPath, { recursive: true });
  return targetPath;
}

module.exports = {
  APP_NAME,
  ensureAppDataDirectory,
  getBaseDataDirectory
};
