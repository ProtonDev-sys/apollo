#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { createRuntime } = require('./app/runtime');
const { ensureAppDataDirectory, APP_NAME } = require('./app/paths');

function getDefaultMusicRoot() {
  return path.join(os.homedir(), 'Music');
}

function printUsage() {
  console.log(`Apollo CLI

Usage:
  node cli.js start
  node cli.js config-path
  node cli.js print-config
  node cli.js export-config [targetPath]
`);
}

async function main() {
  const command = process.argv[2] || 'start';
  const baseDir = await ensureAppDataDirectory();

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return;
  }

  const runtime = await createRuntime({
    baseDir,
    musicRoot: getDefaultMusicRoot()
  });

  if (command === 'config-path') {
    console.log(runtime.getConfigPath());
    return;
  }

  if (command === 'print-config') {
    const raw = await fs.readFile(runtime.getConfigPath(), 'utf8');
    console.log(raw);
    return;
  }

  if (command === 'export-config') {
    const targetPath = process.argv[3];
    if (!targetPath) {
      throw new Error('Provide a target file path for export-config.');
    }

    await fs.copyFile(runtime.getConfigPath(), path.resolve(targetPath));
    console.log(`Exported config to ${path.resolve(targetPath)}`);
    return;
  }

  if (command !== 'start') {
    throw new Error(`Unknown command: ${command}`);
  }

  const dashboard = await runtime.start();
  console.log(`${APP_NAME} server running at ${dashboard.server.baseUrl}`);
  console.log(`Shared config: ${runtime.getConfigPath()}`);
  console.log(`Library: ${dashboard.settings.libraryDirectory}`);

  const shutdown = async (signal) => {
    console.log(`Stopping ${APP_NAME} server (${signal})...`);
    await runtime.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
