const fs = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { INSTALLABLE_DEPENDENCIES, resolveExecutablePath } = require('./binaries');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.opus']);

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

class DownloadService extends EventEmitter {
  constructor({ store, libraryService }) {
    super();
    this.store = store;
    this.libraryService = libraryService;
    this.downloads = new Map(store.listDownloads().map((download) => [download.id, download]));
  }

  getDownloads() {
    return [...this.downloads.values()].sort((left, right) => {
      return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
    });
  }

  async queueDownload(item) {
    const record = {
      id: randomUUID(),
      title: item.title || 'Unknown Title',
      artist: item.artist || 'Unknown Artist',
      album: item.album || 'Singles',
      provider: item.provider || 'link',
      sourceUrl: item.externalUrl || item.downloadTarget || '',
      status: 'queued',
      progress: 0,
      message: 'Waiting for worker...',
      outputPath: '',
      trackId: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.downloads.set(record.id, record);
    await this.syncRecord(record);
    void this.processDownload(record.id, item);
    return record;
  }

  async syncRecord(record) {
    record.updatedAt = new Date().toISOString();
    this.downloads.set(record.id, { ...record });
    await this.store.upsertDownload(record);
    this.emit('updated', { ...record });
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

      const child = spawn(ytDlpPath, args, {
        windowsHide: true,
        shell: false
      });

      const progressPattern = /\[download\]\s+(\d+(?:\.\d+)?)%/i;
      const handleOutput = async (buffer) => {
        const line = buffer.toString().trim();
        if (!line) {
          return;
        }

        const match = line.match(progressPattern);
        if (match) {
          record.progress = Math.min(100, Number.parseFloat(match[1]));
        }

        record.message = line;
        await this.syncRecord(record);
      };

      child.stdout?.on('data', (buffer) => {
        void handleOutput(buffer);
      });
      child.stderr?.on('data', (buffer) => {
        void handleOutput(buffer);
      });

      child.on('error', async (error) => {
        record.status = 'failed';
        record.message = error.message;
        await this.syncRecord(record);
      });

      child.on('close', async (code) => {
        if (code !== 0) {
          record.status = 'failed';
          record.message = record.message || `yt-dlp exited with code ${code}`;
          await this.syncRecord(record);
          return;
        }

        const downloadedFile = await findFirstAudioFile(jobDirectory);
        if (!downloadedFile) {
          record.status = 'failed';
          record.message = 'Download finished but no audio file was found.';
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
        await fs.rm(jobDirectory, { recursive: true, force: true });
      });
    } catch (error) {
      record.status = 'failed';
      record.message = error.message;
      await this.syncRecord(record);
      await fs.rm(jobDirectory, { recursive: true, force: true });
    }
  }
}

module.exports = {
  DownloadService
};
