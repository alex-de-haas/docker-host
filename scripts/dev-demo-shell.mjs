#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.resolve(process.env.HOST_DATA_ROOT_HOST || path.join(repoRoot, '.docker-host-dev-demo'));
const hostPort = process.env.PORT || '3000';
const demoPort = '3100';
const targetId = process.env.HOST_DEMO_MODULE_DEV_TARGET_ID || 'mdev_local_demo_module';
const targetHostname = process.env.HOST_DEMO_MODULE_HOSTNAME || 'demo.localhost';
const metadataUrl = process.env.HOST_DEMO_MODULE_METADATA_URL ||
  `http://localhost:${hostPort}/fixtures/modules/demo-module`;
const targetBaseUrl = process.env.HOST_DEMO_MODULE_TARGET_URL ||
  `http://127.0.0.1:${demoPort}`;
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
  ? process.execPath
  : process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm';
const npmBaseArgs = npmExecPath ? [npmExecPath] : [];

const metadata = await readDemoMetadata();
const target = buildDemoTarget(metadata);
await seedDemoTarget(target);

console.log(`Seeded developer app "${target.moduleName}" in ${path.join(dataRoot, 'dev', 'module-targets.json')}`);
console.log(`Host URL: http://localhost:${hostPort}/apps`);
console.log(`Demo target: ${targetBaseUrl}`);

if (process.argv.includes('--seed-only')) {
  process.exit(0);
}

const children = [];
let shuttingDown = false;

start('demo-module', ['run', 'demo-module:dev'], {
  PORT: demoPort,
  DEMO_PUBLIC_URL: targetBaseUrl,
  DOCKER_HOST_INTERNAL_ORIGIN: `http://localhost:${hostPort}`,
  DOCKER_HOST_MODULE_ID: target.moduleId,
  MODULE_ID: target.moduleId,
  MODULE_VERSION: target.moduleVersion,
});

start('host', ['run', 'host:dev'], {
  HOST_DATA_ROOT_HOST: dataRoot,
  HOST_DATA_ROOT_CONTAINER: dataRoot,
  HOST_DEV_AUTH: 'auto',
  HOST_INTERNAL_ORIGIN: `http://localhost:${hostPort}`,
  HOST_MODULE_DEV_MODE: 'enabled',
  HOST_ENABLE_DEV_FIXTURES: 'true',
  PORT: hostPort,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopChildren(signal);
  });
}

function start(label, args, env) {
  const child = spawn(npmCommand, [...npmBaseArgs, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'inherit',
  });

  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    console.error(`${label} stopped with ${reason}.`);
    stopChildren('SIGTERM', code ?? 1);
  });
}

function stopChildren(signal, exitCode = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 250);
}

async function readDemoMetadata() {
  const metadataPath = path.join(repoRoot, 'modules/demo-module/metadata.json');
  return JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
}

async function seedDemoTarget(nextTarget) {
  const targetsPath = path.join(dataRoot, 'dev', 'module-targets.json');
  await fs.mkdir(path.dirname(targetsPath), { recursive: true });

  const now = new Date().toISOString();
  const current = await readJsonIfExists(targetsPath, {
    schemaVersion: '0.1',
    targets: [],
    updatedAt: now,
  });
  const existing = Array.isArray(current.targets)
    ? current.targets.find(candidate => candidate?.id === nextTarget.id)
    : null;
  const target = {
    ...nextTarget,
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : now,
    updatedAt: now,
  };
  const targets = Array.isArray(current.targets)
    ? [
        ...current.targets.filter(candidate => candidate?.id !== nextTarget.id),
        target,
      ]
    : [target];

  await fs.writeFile(
    targetsPath,
    `${JSON.stringify({
      schemaVersion: '0.1',
      targets,
      updatedAt: now,
    }, null, 2)}\n`,
    'utf-8'
  );
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

function buildDemoTarget(moduleMetadata) {
  const ui = moduleMetadata.ui;
  if (!ui?.entrypoint?.portKey) {
    throw new Error('Demo module metadata must define ui.entrypoint.portKey.');
  }

  const endpoint = moduleMetadata.endpoints?.find(candidate => candidate?.key === ui.entrypoint.portKey);
  if (!endpoint) {
    throw new Error(`Demo module metadata does not define endpoint "${ui.entrypoint.portKey}".`);
  }

  if (endpoint.public !== true) {
    throw new Error(`Demo module endpoint "${endpoint.key}" must be public.`);
  }

  const container = moduleMetadata.containers?.find(candidate => candidate?.key === endpoint.container);
  if (!container) {
    throw new Error(`Demo module endpoint "${endpoint.key}" references unknown container "${endpoint.container}".`);
  }

  const port = container.runtime?.ports?.find(candidate => candidate.key === endpoint.port);
  if (!port) {
    throw new Error(
      `Demo module endpoint "${endpoint.key}" references unknown port "${endpoint.port}" on container "${container.key}".`
    );
  }

  return {
    id: targetId,
    moduleId: moduleMetadata.id,
    moduleName: moduleMetadata.name,
    moduleVersion: moduleMetadata.version,
    ...(moduleMetadata.description ? { moduleDescription: moduleMetadata.description } : {}),
    metadataUrl,
    hostname: targetHostname,
    portKey: endpoint.key,
    targetBaseUrl,
    targetPathPrefix: '',
    containerPort: port.containerPort,
    protocol: port.protocol,
    exposurePolicy: 'loginRequired',
    identityMode: 'required',
    enabled: true,
    shellApp: {
      displayName: moduleMetadata.name || moduleMetadata.id,
      ...(moduleMetadata.description ? { description: moduleMetadata.description } : {}),
      ...(ui.icon ? { icon: ui.icon } : {}),
      entrypointPath: ui.entrypoint.path || '/',
      navigation: Array.isArray(ui.navigation)
        ? ui.navigation.map(item => ({
            label: item.label,
            path: item.path,
          }))
        : [],
    },
  };
}
