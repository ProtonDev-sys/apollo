const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const INSTALLABLE_DEPENDENCIES = {
  ytDlp: {
    packageId: 'yt-dlp.yt-dlp',
    binaryName: 'yt-dlp'
  },
  ffmpeg: {
    packageId: 'Gyan.FFmpeg.Essentials',
    binaryName: 'ffmpeg'
  }
};

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      ...options
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}`));
    });
  });
}

async function getBinaryVersion(binaryPath) {
  const executableName = path.basename(binaryPath).toLowerCase();
  const versionArgs = executableName.includes('ffmpeg') ? ['-version'] : ['--version'];

  try {
    const { stdout } = await runProcess(binaryPath, versionArgs);
    return {
      available: true,
      version: stdout.trim()
    };
  } catch (error) {
    return {
      available: false,
      version: '',
      error: error.message
    };
  }
}

function buildBinaryCandidates(configuredPath, binaryName) {
  const binaryFile =
    process.platform === 'win32' && !binaryName.endsWith('.exe')
      ? `${binaryName}.exe`
      : binaryName;
  const candidates = [configuredPath, binaryName, binaryFile].filter(Boolean);

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', binaryFile)
    );
  }

  return [...new Set(candidates)];
}

async function findBinaryInDirectory(rootPath, binaryFile, maxDepth = 4) {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(rootPath, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === binaryFile.toLowerCase()) {
        return entryPath;
      }
    }

    if (maxDepth <= 0) {
      return '';
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const nested = await findBinaryInDirectory(
        path.join(rootPath, entry.name),
        binaryFile,
        maxDepth - 1
      );
      if (nested) {
        return nested;
      }
    }
  } catch (error) {
    return '';
  }

  return '';
}

async function findWinGetBinaryCandidate(packageId, binaryName) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    return '';
  }

  const binaryFile =
    process.platform === 'win32' && !binaryName.endsWith('.exe')
      ? `${binaryName}.exe`
      : binaryName;
  const packagesRoot = path.join(
    process.env.LOCALAPPDATA,
    'Microsoft',
    'WinGet',
    'Packages'
  );

  try {
    const entries = await fs.readdir(packagesRoot, { withFileTypes: true });
    const matchingDirectories = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(packageId)
    );

    for (const directory of matchingDirectories) {
      const locatedBinary = await findBinaryInDirectory(
        path.join(packagesRoot, directory.name),
        binaryFile
      );
      if (locatedBinary) {
        return locatedBinary;
      }
    }
  } catch (error) {
    return '';
  }

  return '';
}

async function getResolvedBinaryState(configuredPath, binaryName, packageId) {
  const candidates = buildBinaryCandidates(configuredPath, binaryName);
  const winGetPath = await findWinGetBinaryCandidate(packageId, binaryName);
  if (winGetPath) {
    candidates.push(winGetPath);
  }

  let lastError = 'Executable not found.';
  for (const candidate of [...new Set(candidates)]) {
    const result = await getBinaryVersion(candidate);
    if (result.available) {
      return {
        ...result,
        version: result.version.split(/\r?\n/)[0].trim(),
        path: candidate
      };
    }

    lastError = result.error || lastError;
  }

  return {
    available: false,
    version: '',
    path: '',
    error: lastError
  };
}

async function getDependencyState(settings) {
  const [ytDlp, ffmpeg] = await Promise.all([
    getResolvedBinaryState(
      settings.ytDlpPath,
      INSTALLABLE_DEPENDENCIES.ytDlp.binaryName,
      INSTALLABLE_DEPENDENCIES.ytDlp.packageId
    ),
    getResolvedBinaryState(
      settings.ffmpegPath,
      INSTALLABLE_DEPENDENCIES.ffmpeg.binaryName,
      INSTALLABLE_DEPENDENCIES.ffmpeg.packageId
    )
  ]);

  return {
    ytDlp,
    ffmpeg,
    spotifyConfigured: Boolean(settings.spotifyClientId && settings.spotifyClientSecret)
  };
}

async function resolveExecutablePath(configuredPath, binaryName) {
  const packageId =
    binaryName === INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
      ? INSTALLABLE_DEPENDENCIES.ytDlp.packageId
      : INSTALLABLE_DEPENDENCIES.ffmpeg.packageId;
  const dependency = await getResolvedBinaryState(configuredPath, binaryName, packageId);
  if (!dependency.available) {
    throw new Error(dependency.error || `Unable to find ${binaryName}.`);
  }

  return dependency.path;
}

module.exports = {
  INSTALLABLE_DEPENDENCIES,
  runProcess,
  getDependencyState,
  resolveExecutablePath
};
