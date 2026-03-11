const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { createAbortError, isAbortError } = require('./http-error');

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
const RESOLVED_BINARY_STATE_TTL_MS = 60 * 1000;
const resolvedBinaryStateCache = new Map();
const resolvedBinaryStateInflight = new Map();

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      ...options
    });
    const signal = options.signal;

    let stdout = '';
    let stderr = '';
    let settled = false;

    function finishWithError(error) {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    }

    function finishWithSuccess(payload) {
      if (settled) {
        return;
      }

      settled = true;
      resolve(payload);
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (signal?.aborted || isAbortError(error)) {
        finishWithError(signal?.reason || createAbortError());
        return;
      }

      finishWithError(error);
    });
    child.on('close', (code) => {
      if (signal?.aborted) {
        finishWithError(signal.reason || createAbortError());
        return;
      }

      if (code === 0) {
        finishWithSuccess({ stdout, stderr });
        return;
      }

      finishWithError(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}`));
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
  const cacheKey = JSON.stringify({
    configuredPath: configuredPath || '',
    binaryName,
    packageId
  });
  const cached = resolvedBinaryStateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.payload
    };
  }

  const inFlight = resolvedBinaryStateInflight.get(cacheKey);
  if (inFlight) {
    return inFlight.then((payload) => ({ ...payload }));
  }

  const resolveState = (async () => {
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

  const payload = {
    available: false,
    version: '',
    path: '',
    error: lastError
  };

  resolvedBinaryStateCache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + RESOLVED_BINARY_STATE_TTL_MS
  });
  return payload;
  })();

  resolvedBinaryStateInflight.set(cacheKey, resolveState);

  try {
    const payload = await resolveState;
    resolvedBinaryStateCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + RESOLVED_BINARY_STATE_TTL_MS
    });

    return {
      ...payload
    };
  } finally {
    if (resolvedBinaryStateInflight.get(cacheKey) === resolveState) {
      resolvedBinaryStateInflight.delete(cacheKey);
    }
  }
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
