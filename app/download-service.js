const fs = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { INSTALLABLE_DEPENDENCIES, resolveExecutablePath, runProcess } = require('./binaries');
const { createHttpError } = require('./http-error');
const { isTrackEquivalent } = require('./data-store');
const { resolveDownloadMetadata } = require('./search-service');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.opus']);
const ACTIVE_DOWNLOAD_STATUSES = new Set(['queued', 'running']);
const TERMINAL_DOWNLOAD_STATUSES = new Set(['completed', 'failed']);
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
const DEFAULT_PROGRESS_SYNC_INTERVAL_MS = 250;

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function findFirstAudioFile(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstAudioFile(entryPath);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (entry.isFile() && isAudioFile(entryPath)) {
      return entryPath;
    }
  }

  return '';
}

function buildRecordFromItem(item) {
  return {
    id: randomUUID(),
    title: item.title || 'Unknown Title',
    artist: item.artist || 'Unknown Artist',
    album: item.album || 'Singles',
    duration: item.duration || null,
    provider: item.provider || 'link',
    providerIds: item.providerIds || {},
    sourceUrl: item.externalUrl || item.downloadTarget || '',
    status: 'queued',
    progress: 0,
    message: 'Waiting for worker...',
    outputPath: '',
    trackId: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function buildDuplicateMessage(track) {
  const label = [track.artist, track.title].filter(Boolean).join(' - ') || track.title || 'Track';
  return `${label} is already in the library.`;
}

class DownloadService extends EventEmitter {
  constructor({
    store,
    libraryService,
    maxConcurrentDownloads = DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    progressSyncIntervalMs = DEFAULT_PROGRESS_SYNC_INTERVAL_MS
  }) {
    super();
    this.store = store;
    this.libraryService = libraryService;
    this.maxConcurrentDownloads = Math.max(1, Number.parseInt(maxConcurrentDownloads, 10) || 1);
    this.progressSyncIntervalMs = Math.max(
      50,
      Number.parseInt(progressSyncIntervalMs, 10) || DEFAULT_PROGRESS_SYNC_INTERVAL_MS
    );
    this.downloads = new Map(store.listDownloads().map((download) => [download.id, download]));
    this.pendingQueue = [];
    this.activeDownloads = new Set();
    this.pendingSyncTimers = new Map();
  }

  getDownloads() {
    return [...this.downloads.values()].sort((left, right) => {
      return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
    });
  }

  findActiveDownload(candidate) {
    for (const download of this.downloads.values()) {
      if (!ACTIVE_DOWNLOAD_STATUSES.has(download.status)) {
        continue;
      }

      if (isTrackEquivalent(download, candidate)) {
        return download;
      }
    }

    return null;
  }

  async prepareDownloadItem(item) {
    const settings = this.store.getSettings();

    let preparedItem = {
      ...item,
      providerIds: item.providerIds || {}
    };

    try {
      preparedItem = await resolveDownloadMetadata(preparedItem, settings);
    } catch (error) {
      preparedItem = {
        ...preparedItem,
        providerIds: preparedItem.providerIds || {}
      };
    }

    const existingTrack = this.store.findMatchingTrack(preparedItem);
    if (existingTrack) {
      throw createHttpError(409, buildDuplicateMessage(existingTrack));
    }

    const activeDownload = this.findActiveDownload(preparedItem);
    if (activeDownload) {
      throw createHttpError(
        409,
        `${activeDownload.artist} - ${activeDownload.title} is already queued for download.`
      );
    }

    return preparedItem;
  }

  async writeAudioMetadata(sourcePath, metadata, ffmpegPath) {
    const title = String(metadata.title || '').trim();
    const artist = String(metadata.artist || '').trim();
    const album = String(metadata.album || '').trim();
    const args = ['-y', '-i', sourcePath, '-map', '0', '-codec', 'copy'];

    if (title) {
      args.push('-metadata', `title=${title}`);
    }
    if (artist) {
      args.push('-metadata', `artist=${artist}`);
    }
    if (album) {
      args.push('-metadata', `album=${album}`);
    }

    if (args.length === 6) {
      return;
    }

    const tempPath = path.join(
      path.dirname(sourcePath),
      `${path.basename(sourcePath, path.extname(sourcePath))}.tagged${path.extname(sourcePath)}`
    );

    await runProcess(ffmpegPath, [...args, tempPath]);
    await fs.rm(sourcePath, { force: true });
    await fs.rename(tempPath, sourcePath);
  }

  async queueDownload(item) {
    const preparedItem = await this.prepareDownloadItem(item);
    const record = buildRecordFromItem(preparedItem);

    this.downloads.set(record.id, record);
    await this.syncRecord(record);
    this.pendingQueue.push({
      downloadId: record.id,
      item: preparedItem
    });
    void this.pumpQueue();
    return record;
  }

  queueRecordSync(record) {
    if (TERMINAL_DOWNLOAD_STATUSES.has(record.status)) {
      const existingTimer = this.pendingSyncTimers.get(record.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.pendingSyncTimers.delete(record.id);
      }

      return this.syncRecord(record);
    }

    if (this.pendingSyncTimers.has(record.id)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSyncTimers.delete(record.id);
        void this.syncRecord(record).finally(resolve);
      }, this.progressSyncIntervalMs);

      this.pendingSyncTimers.set(record.id, timer);
    });
  }

  async syncRecord(record) {
    record.updatedAt = new Date().toISOString();
    this.downloads.set(record.id, { ...record });
    await this.store.upsertDownload(record);
    this.emit('updated', { ...record });
  }

  async pumpQueue() {
    while (this.activeDownloads.size < this.maxConcurrentDownloads && this.pendingQueue.length) {
      const nextJob = this.pendingQueue.shift();
      if (!nextJob) {
        return;
      }

      this.activeDownloads.add(nextJob.downloadId);
      void this.processDownload(nextJob.downloadId, nextJob.item).finally(() => {
        this.activeDownloads.delete(nextJob.downloadId);
        void this.pumpQueue();
      });
    }
  }

  async runDownloadProcess({ ytDlpPath, args, record }) {
    return new Promise((resolve, reject) => {
      const child = spawn(ytDlpPath, args, {
        windowsHide: true,
        shell: false
      });
      const progressPattern = /\[download\]\s+(\d+(?:\.\d+)?)%/i;

      const handleOutput = (buffer) => {
        const line = buffer.toString().trim();
        if (!line) {
          return;
        }

        const match = line.match(progressPattern);
        if (match) {
          record.progress = Math.min(100, Number.parseFloat(match[1]));
        }

        record.message = line;
        void this.queueRecordSync(record);
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(record.message || `yt-dlp exited with code ${code}`));
      });
    });
  }

  async processDownload(downloadId, item) {
    const settings = this.store.getSettings();
    const record = this.downloads.get(downloadId);
    if (!record) {
      return;
    }

    const jobDirectory = path.join(settings.incomingDirectory, downloadId);

    try {
      const ytDlpPath = await resolveExecutablePath(
        settings.ytDlpPath,
        INSTALLABLE_DEPENDENCIES.ytDlp.binaryName
      );
      const ffmpegPath = await resolveExecutablePath(
        settings.ffmpegPath,
        INSTALLABLE_DEPENDENCIES.ffmpeg.binaryName
      );

      await fs.mkdir(settings.incomingDirectory, { recursive: true });
      await fs.mkdir(settings.libraryDirectory, { recursive: true });
      await fs.mkdir(jobDirectory, { recursive: true });

      record.status = 'running';
      record.message = 'Download started...';
      await this.syncRecord(record);

      const args = [
        '--extract-audio',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '--newline',
        '--ffmpeg-location',
        ffmpegPath,
        '--paths',
        `home:${jobDirectory}`,
        '--output',
        '%(title)s [%(id)s].%(ext)s',
        item.provider === 'spotify'
          ? item.downloadTarget || `ytsearch1:${item.artist} ${item.title} audio`
          : item.downloadTarget || item.externalUrl
      ];

      await this.runDownloadProcess({
        ytDlpPath,
        args,
        record
      });

      const downloadedFile = await findFirstAudioFile(jobDirectory);
      if (!downloadedFile) {
        record.status = 'failed';
        record.message = 'Download finished but no audio file was found.';
        await this.syncRecord(record);
        return;
      }

      await this.writeAudioMetadata(downloadedFile, item, ffmpegPath);

      const existingTrack = this.store.findMatchingTrack(item);
      if (existingTrack) {
        record.status = 'failed';
        record.message = buildDuplicateMessage(existingTrack);
        await this.syncRecord(record);
        return;
      }

      const importedTrack = await this.libraryService.importDownloadedFile(
        downloadedFile,
        {
          title: item.title,
          artist: item.artist,
          album: item.album,
          duration: item.duration,
          provider: item.provider,
          artwork: item.artwork || '',
          providerIds: item.providerIds || {},
          sourceUrl: item.externalUrl || item.downloadTarget || ''
        },
        settings.libraryDirectory
      );

      record.status = 'completed';
      record.progress = 100;
      record.message = 'Downloaded and indexed in the library.';
      record.outputPath = importedTrack.filePath;
      record.trackId = importedTrack.id;
      await this.syncRecord(record);
    } catch (error) {
      record.status = 'failed';
      record.message = error.message;
      await this.syncRecord(record);
    } finally {
      const pendingTimer = this.pendingSyncTimers.get(downloadId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.pendingSyncTimers.delete(downloadId);
      }

      await fs.rm(jobDirectory, { recursive: true, force: true });
    }
  }
}

module.exports = {
  DownloadService
};
