#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.resolve(
  process.env.DOCKER_HOST_HOME ||
  process.env.HOST_DATA_ROOT_HOST ||
  path.join(repoRoot, '.docker-host-dev-demo')
);
const hostPort = process.env.HOST_DEV_PORT || process.env.PORT || '3000';
const metadataPath = path.join(repoRoot, 'modules/demo-module/metadata.dev.json');
const cliProjectPath = path.join(repoRoot, 'apps/cli/src/Haas.DockerHost.Cli/Haas.DockerHost.Cli.csproj');
const cliBaseArgs = ['run', '--project', cliProjectPath, '--'];
const passthroughArgs = process.argv.slice(2);
const cliEnv = {
  ...process.env,
  DOCKER_HOST_HOME: dataRoot,
  HOST_DEV_AUTH: process.env.HOST_DEV_AUTH ?? 'auto',
  HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS: process.env.HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS ?? 'enabled',
  HOST_ENABLE_DEV_FIXTURES: process.env.HOST_ENABLE_DEV_FIXTURES ?? 'true',
};

try {
  await runCli(['config', 'set', 'HOST_DEV_REPOSITORY_PATH', repoRoot]);
  await runCli(['config', 'set', 'HOST_DEV_PORT', hostPort]);
  await runCli(['dev', 'up', '--manifest', metadataPath, ...passthroughArgs]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('dotnet', [...cliBaseArgs, ...args], {
      cwd: repoRoot,
      env: cliEnv,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`docker-host CLI stopped with signal ${signal}.`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`docker-host CLI exited with code ${code ?? 1}.`));
        return;
      }

      resolve();
    });
  });
}
