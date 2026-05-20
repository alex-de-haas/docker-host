#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] || 'admin';
if (!['admin', 'user'].includes(mode)) {
  console.error('Usage: node scripts/dev-auth-shell.mjs <admin|user>');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDataRootName = mode === 'user'
  ? '.docker-host-dev-user'
  : '.docker-host-dev';
const dataRootHost = path.resolve(
  process.env.HOST_DATA_ROOT_HOST || path.join(repoRoot, defaultDataRootName)
);
const dataRootContainer = process.env.HOST_DATA_ROOT_CONTAINER || dataRootHost;
const childEnv = {
  ...process.env,
  HOST_DATA_ROOT_HOST: dataRootHost,
  HOST_DATA_ROOT_CONTAINER: dataRootContainer,
  HOST_DEV_AUTH: 'auto',
};

if (mode === 'user') {
  childEnv.HOST_DEV_AUTH_ROLE = 'user';
} else {
  delete childEnv.HOST_DEV_AUTH_ROLE;
}

const npmExecPath = process.env.npm_execpath;
const command = npmExecPath
  ? process.execPath
  : process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm';
const args = npmExecPath
  ? [npmExecPath, 'run', 'host:dev']
  : ['run', 'host:dev'];

const child = spawn(command, args, {
  cwd: repoRoot,
  env: childEnv,
  stdio: 'inherit',
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true;
    if (!child.killed) {
      child.kill(signal);
    }

    setTimeout(() => {
      process.exit(0);
    }, 500).unref();
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(shuttingDown ? 0 : 1);
    return;
  }

  process.exit(code ?? 0);
});
