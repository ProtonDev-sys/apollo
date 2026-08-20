const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectElectronRuntimeErrors,
  isDirectElectronStartCommand
} = require('../scripts/check-electron-runtime');

function createProject(overrides = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-electron-boundary-'));
  const packageJson = {
    main: 'main.js',
    scripts: {
      start: 'electron .'
    },
    devDependencies: {
      electron: '^37.0.0',
      'electron-builder': '^26.0.12'
    },
    ...overrides.packageJson
  };

  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(projectRoot, 'main.js'), "const { app } = require('electron');\nvoid app;\n");
  fs.writeFileSync(path.join(projectRoot, 'preload.js'), "const { contextBridge } = require('electron');\nvoid contextBridge;\n");

  if (overrides.tauri) {
    fs.mkdirSync(path.join(projectRoot, 'src-tauri'));
  }

  return projectRoot;
}

test('Electron start validation accepts only the direct launch command', () => {
  assert.equal(isDirectElectronStartCommand('electron .'), true);
  assert.equal(isDirectElectronStartCommand(' electron . '), true);
  assert.equal(isDirectElectronStartCommand('echo electron'), false);
  assert.equal(isDirectElectronStartCommand('node -e "console.log(\'electron\')"'), false);
  assert.equal(isDirectElectronStartCommand('electron-builder'), false);
});

test('Electron runtime boundary accepts a valid Electron project', (context) => {
  const projectRoot = createProject();
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  assert.deepEqual(collectElectronRuntimeErrors(projectRoot), []);
});

test('Electron runtime boundary rejects Tauri and fake Electron start scripts', (context) => {
  const projectRoot = createProject({
    packageJson: {
      main: 'main.js',
      scripts: {
        start: 'echo electron'
      },
      dependencies: {
        '@tauri-apps/api': '^2.0.0'
      },
      devDependencies: {
        electron: '^37.0.0',
        'electron-builder': '^26.0.12'
      }
    },
    tauri: true
  });
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const errors = collectElectronRuntimeErrors(projectRoot);
  assert.ok(errors.some((error) => error.includes('direct Electron launch command')));
  assert.ok(errors.some((error) => error.includes('@tauri-apps/api')));
  assert.ok(errors.some((error) => error.includes('src-tauri')));
});
