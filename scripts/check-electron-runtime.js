#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const FORBIDDEN_TAURI_ENTRIES = Object.freeze([
  'src-tauri',
  'tauri.conf.json',
  'tauri.conf.json5',
  'Tauri.toml'
]);

function isDirectElectronStartCommand(value) {
  return String(value || '').trim() === 'electron .';
}

function collectElectronRuntimeErrors(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const dependencyGroups = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies
  ].filter(Boolean);
  const dependencyNames = new Set(dependencyGroups.flatMap((group) => Object.keys(group)));
  const errors = [];

  if (packageJson.main !== 'main.js') {
    errors.push('package.json must use main.js as the Electron main-process entry.');
  }

  if (!isDirectElectronStartCommand(packageJson.scripts?.start)) {
    errors.push('The start script must be the direct Electron launch command: electron .');
  }

  if (!dependencyNames.has('electron')) {
    errors.push('Electron must remain an explicit project dependency.');
  }

  if (!dependencyNames.has('electron-builder')) {
    errors.push('electron-builder must remain the application packager.');
  }

  for (const dependencyName of dependencyNames) {
    if (dependencyName === 'tauri' || dependencyName.startsWith('@tauri-apps/')) {
      errors.push(`Tauri dependency is not allowed: ${dependencyName}`);
    }
  }

  for (const entryName of FORBIDDEN_TAURI_ENTRIES) {
    if (fs.existsSync(path.join(projectRoot, entryName))) {
      errors.push(`Tauri project entry is not allowed: ${entryName}`);
    }
  }

  for (const requiredFile of ['main.js', 'preload.js']) {
    const filePath = path.join(projectRoot, requiredFile);
    if (!fs.existsSync(filePath)) {
      errors.push(`Missing Electron runtime file: ${requiredFile}`);
      continue;
    }

    const source = fs.readFileSync(filePath, 'utf8');
    if (!/require\(['"]electron['"]\)/.test(source)) {
      errors.push(`${requiredFile} must import Electron directly.`);
    }
  }

  return errors;
}

function run(projectRoot = path.resolve(__dirname, '..')) {
  const errors = collectElectronRuntimeErrors(projectRoot);
  if (errors.length) {
    for (const error of errors) {
      process.stderr.write(`error: ${error}\n`);
    }
    process.exitCode = 1;
    return false;
  }

  process.stdout.write('Electron runtime boundary verified; no Tauri project surface detected.\n');
  return true;
}

if (require.main === module) {
  run();
}

module.exports = {
  FORBIDDEN_TAURI_ENTRIES,
  isDirectElectronStartCommand,
  collectElectronRuntimeErrors,
  run
};
