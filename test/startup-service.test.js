const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { StartupService, buildLinuxAutostartEntry } = require('../app/startup-service');

test('buildLinuxAutostartEntry emits a background desktop entry', () => {
  const entry = buildLinuxAutostartEntry({
    executablePath: '/opt/Apollo/apollo',
    appRoot: '/opt/Apollo/resources/app',
    isDefaultApp: false
  });

  assert.match(entry, /\[Desktop Entry\]/);
  assert.match(entry, /Exec="\/opt\/Apollo\/apollo" "--background"/);
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
});

test('StartupService uses Electron login items when available on Windows', {
  skip: process.platform !== 'win32'
}, async () => {
  const startupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'apollo-startup-'));
  const loginCalls = [];
  const service = new StartupService({
    appRoot: process.cwd(),
    startupDirectory,
    electronApp: {
      setLoginItemSettings(payload) {
        loginCalls.push(payload);
      }
    }
  });

  try {
    const enabled = await service.sync({
      autoStartBackgroundServer: true
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.mechanism, 'windows-login-item');
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0].openAtLogin, true);
    assert.deepEqual(loginCalls[0].args, ['--background']);

    const files = await fs.readdir(startupDirectory);
    assert.equal(files.length, 0);

    const disabled = await service.sync({
      autoStartBackgroundServer: false
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.mechanism, 'windows-login-item');
    assert.equal(loginCalls.length, 2);
    assert.equal(loginCalls[1].openAtLogin, false);
  } finally {
    await fs.rm(startupDirectory, { recursive: true, force: true });
  }
});
