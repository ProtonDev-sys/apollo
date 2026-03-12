#!/usr/bin/env node

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVICE_NAME = 'apollo.service';

function parseArguments(argv) {
  const [mode = 'install', ...rest] = argv;
  const options = {
    mode,
    execPath: process.env.APOLLO_EXECUTABLE || '',
    servicePath: path.join(os.homedir(), '.config', 'systemd', 'user', SERVICE_NAME)
  };

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--exec') {
      options.execPath = rest[index + 1] || '';
      index += 1;
      continue;
    }

    if (value === '--service-path') {
      options.servicePath = rest[index + 1] || options.servicePath;
      index += 1;
    }
  }

  return options;
}

function buildServiceFile(executablePath) {
  const escapedExec = executablePath.replace(/(["\\])/g, '\\$1');
  return [
    '[Unit]',
    'Description=Apollo background server',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart="${escapedExec}" --background`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

function runSystemctl(args) {
  execFileSync('systemctl', ['--user', ...args], {
    stdio: 'inherit'
  });
}

async function installService({ execPath, servicePath }) {
  if (!execPath) {
    throw new Error('Provide the packaged Apollo executable path with --exec or APOLLO_EXECUTABLE.');
  }

  await fs.mkdir(path.dirname(servicePath), { recursive: true });
  await fs.writeFile(servicePath, buildServiceFile(execPath), 'utf8');

  runSystemctl(['daemon-reload']);
  runSystemctl(['enable', '--now', SERVICE_NAME]);
  console.log(`Installed ${SERVICE_NAME} at ${servicePath}`);
}

async function removeService({ servicePath }) {
  try {
    runSystemctl(['disable', '--now', SERVICE_NAME]);
  } catch (error) {
    // Allow cleanup to continue even if the unit was not active.
  }

  await fs.rm(servicePath, { force: true });

  try {
    runSystemctl(['daemon-reload']);
  } catch (error) {
    // Ignore reload failures after file removal.
  }

  console.log(`Removed ${SERVICE_NAME} from ${servicePath}`);
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('This helper only supports Linux.');
  }

  const options = parseArguments(process.argv.slice(2));
  if (options.mode === 'remove') {
    await removeService(options);
    return;
  }

  if (options.mode !== 'install') {
    throw new Error(`Unknown mode "${options.mode}". Use "install" or "remove".`);
  }

  await installService(options);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
