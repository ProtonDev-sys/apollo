const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

test('UpdateService dispose clears the delayed initial check and poll timer', async () => {
  const updateServiceModulePath = require.resolve('../app/update-service');
  const electronUpdaterModulePath = require.resolve('electron-updater');
  const originalUpdateServiceModule = require.cache[updateServiceModulePath];
  const originalElectronUpdaterModule = require.cache[electronUpdaterModulePath];
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalUpdateUrl = process.env.APOLLO_UPDATE_URL;

  const scheduledTimeouts = [];
  const scheduledIntervals = [];
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = () => {};
  autoUpdater.checkForUpdates = async () => ({});
  autoUpdater.quitAndInstall = () => {};

  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    scheduledTimeouts.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) {
      timer.cleared = true;
    }
  };
  global.setInterval = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    scheduledIntervals.push(timer);
    return timer;
  };
  global.clearInterval = (timer) => {
    if (timer) {
      timer.cleared = true;
    }
  };
  process.env.APOLLO_UPDATE_URL = 'https://updates.example.test/apollo';

  delete require.cache[updateServiceModulePath];
  require.cache[electronUpdaterModulePath] = {
    id: electronUpdaterModulePath,
    filename: electronUpdaterModulePath,
    loaded: true,
    exports: {
      autoUpdater
    }
  };

  try {
    const { UpdateService } = require('../app/update-service');
    const service = new UpdateService({
      electronApp: {
        isPackaged: true,
        getVersion: () => '0.1.0'
      }
    });

    service.initialize();

    assert.equal(scheduledTimeouts.length, 1);
    assert.equal(scheduledIntervals.length, 1);
    assert.equal(scheduledTimeouts[0].cleared, false);
    assert.equal(scheduledIntervals[0].cleared, false);

    service.dispose();

    assert.equal(scheduledTimeouts[0].cleared, true);
    assert.equal(scheduledIntervals[0].cleared, true);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;

    if (originalUpdateUrl === undefined) {
      delete process.env.APOLLO_UPDATE_URL;
    } else {
      process.env.APOLLO_UPDATE_URL = originalUpdateUrl;
    }

    delete require.cache[updateServiceModulePath];
    if (originalUpdateServiceModule) {
      require.cache[updateServiceModulePath] = originalUpdateServiceModule;
    }

    delete require.cache[electronUpdaterModulePath];
    if (originalElectronUpdaterModule) {
      require.cache[electronUpdaterModulePath] = originalElectronUpdaterModule;
    }
  }
});

test('UpdateService ignores duplicate check requests while one is already running', async () => {
  const updateServiceModulePath = require.resolve('../app/update-service');
  const electronUpdaterModulePath = require.resolve('electron-updater');
  const originalUpdateServiceModule = require.cache[updateServiceModulePath];
  const originalElectronUpdaterModule = require.cache[electronUpdaterModulePath];
  const originalUpdateUrl = process.env.APOLLO_UPDATE_URL;

  let resolveCheck;
  let checkCount = 0;
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = () => {};
  autoUpdater.quitAndInstall = () => {};
  autoUpdater.checkForUpdates = () => {
    checkCount += 1;
    return new Promise((resolve) => {
      resolveCheck = resolve;
    });
  };

  process.env.APOLLO_UPDATE_URL = 'https://updates.example.test/apollo';

  delete require.cache[updateServiceModulePath];
  require.cache[electronUpdaterModulePath] = {
    id: electronUpdaterModulePath,
    filename: electronUpdaterModulePath,
    loaded: true,
    exports: {
      autoUpdater
    }
  };

  try {
    const { UpdateService } = require('../app/update-service');
    const service = new UpdateService({
      electronApp: {
        isPackaged: true,
        getVersion: () => '0.1.0'
      }
    });

    service.initialize();
    service.dispose();

    const firstCheck = service.checkForUpdates();
    const secondCheck = service.checkForUpdates();

    assert.equal(checkCount, 1);
    assert.equal(service.getState().checking, true);

    autoUpdater.emit('update-not-available', {
      version: '0.1.0'
    });
    resolveCheck();

    await Promise.all([firstCheck, secondCheck]);

    assert.equal(checkCount, 1);
    assert.equal(service.getState().checking, false);
    assert.equal(service.getState().message, 'Apollo is up to date.');
  } finally {
    if (originalUpdateUrl === undefined) {
      delete process.env.APOLLO_UPDATE_URL;
    } else {
      process.env.APOLLO_UPDATE_URL = originalUpdateUrl;
    }

    delete require.cache[updateServiceModulePath];
    if (originalUpdateServiceModule) {
      require.cache[updateServiceModulePath] = originalUpdateServiceModule;
    }

    delete require.cache[electronUpdaterModulePath];
    if (originalElectronUpdaterModule) {
      require.cache[electronUpdaterModulePath] = originalElectronUpdaterModule;
    }
  }
});

test('UpdateService degrades gracefully when updater configuration fails', async () => {
  const updateServiceModulePath = require.resolve('../app/update-service');
  const electronUpdaterModulePath = require.resolve('electron-updater');
  const originalUpdateServiceModule = require.cache[updateServiceModulePath];
  const originalElectronUpdaterModule = require.cache[electronUpdaterModulePath];
  const originalUpdateUrl = process.env.APOLLO_UPDATE_URL;

  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = () => {
    throw new Error('Invalid update feed URL');
  };
  autoUpdater.checkForUpdates = async () => ({});
  autoUpdater.quitAndInstall = () => {};

  process.env.APOLLO_UPDATE_URL = 'invalid-url';

  delete require.cache[updateServiceModulePath];
  require.cache[electronUpdaterModulePath] = {
    id: electronUpdaterModulePath,
    filename: electronUpdaterModulePath,
    loaded: true,
    exports: {
      autoUpdater
    }
  };

  try {
    const { UpdateService } = require('../app/update-service');
    const service = new UpdateService({
      electronApp: {
        isPackaged: true,
        getVersion: () => '0.1.0'
      }
    });

    assert.doesNotThrow(() => service.initialize());
    assert.equal(service.getState().supported, false);
    assert.equal(service.getState().configured, false);
    assert.match(service.getState().message, /Updates are unavailable: Invalid update feed URL/);
  } finally {
    if (originalUpdateUrl === undefined) {
      delete process.env.APOLLO_UPDATE_URL;
    } else {
      process.env.APOLLO_UPDATE_URL = originalUpdateUrl;
    }

    delete require.cache[updateServiceModulePath];
    if (originalUpdateServiceModule) {
      require.cache[updateServiceModulePath] = originalUpdateServiceModule;
    }

    delete require.cache[electronUpdaterModulePath];
    if (originalElectronUpdaterModule) {
      require.cache[electronUpdaterModulePath] = originalElectronUpdaterModule;
    }
  }
});
