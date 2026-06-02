import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeAppsStore } from './app-store.ts';
import { writeModuleDevTargetState } from './module-dev-store.ts';
import { listAssignableModules } from './user-access-options.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { ModuleDevTargetRecord } from '../types/module-dev.ts';

test('assignable modules include enabled developer shell apps', async () => {
  const config = await createTestConfig();
  const now = new Date().toISOString();
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [createDeveloperTarget({ now })],
    updatedAt: now,
  }, config);

  const modules = await listAssignableModules(config);

  assert.deepEqual(modules, [
    {
      id: 'com.example.reports',
      name: 'Reports Dev',
      version: '1.0.0',
      operationStatus: 'developer',
      source: 'developer',
    },
  ]);
});

test('assignable modules skip disabled and shell-less developer targets', async () => {
  const config = await createTestConfig();
  const now = new Date().toISOString();
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [
      createDeveloperTarget({ id: 'mdev_disabled', enabled: false, now }),
      createDeveloperTarget({ id: 'mdev_api_only', moduleId: 'com.example.api', shellApp: null, now }),
    ],
    updatedAt: now,
  }, config);

  const modules = await listAssignableModules(config);

  assert.deepEqual(modules, []);
});

test('assignable modules include app lifecycle records without legacy module records', async () => {
  const config = await createTestConfig();
  const appRoot = path.join(config.appsRootContainer as string, 'com.example.notes');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'app.0.1',
    id: 'com.example.notes',
    name: 'Notes',
    version: '1.0.0',
    runtimeProfiles: [
      {
        key: 'docker',
        type: 'docker',
        default: true,
      },
    ],
    services: [],
  }, null, 2)}\n`, 'utf-8');
  await writeAppsStore({
    schemaVersion: 'app-store.0.1',
    apps: [
      {
        id: 'com.example.notes',
        manifestPath: 'apps/com.example.notes/manifest.json',
        selectedRuntime: 'docker',
        containers: [],
        operationStatus: 'installed',
      },
    ],
    updatedAt: new Date().toISOString(),
  }, config);

  const modules = await listAssignableModules(config);

  assert.deepEqual(modules, [
    {
      id: 'com.example.notes',
      name: 'Notes',
      version: '1.0.0',
      operationStatus: 'installed',
      source: 'installed',
    },
  ]);
});

async function createTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-user-access-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');

  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    appsRootContainer: path.join(dataRootContainer, 'apps'),
    appsStorePath: path.join(dataRootContainer, 'apps.json'),
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    moduleDevModeEnabled: true,
    moduleDevRootContainer: path.join(dataRootContainer, 'dev'),
    moduleDevTargetsPath: path.join(dataRootContainer, 'dev', 'module-targets.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    gatewayRootContainer,
    gatewayExposuresPath: path.join(gatewayRootContainer, 'exposures.json'),
    gatewayBaseDomain: 'example.test',
    hostPublicOrigin: 'https://host.example.test',
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}

function createDeveloperTarget(input: {
  id?: string;
  moduleId?: string;
  enabled?: boolean;
  shellApp?: ModuleDevTargetRecord['shellApp'] | null;
  now: string;
}): ModuleDevTargetRecord {
  return {
    id: input.id ?? 'mdev_reports',
    moduleId: input.moduleId ?? 'com.example.reports',
    moduleName: 'Reports',
    moduleVersion: '1.0.0',
    moduleDescription: 'Reports developer target.',
    metadataUrl: 'http://127.0.0.1:3000/metadata.json',
    hostname: 'reports.localhost',
    portKey: 'web',
    targetBaseUrl: 'http://127.0.0.1:3001/dev',
    targetPathPrefix: '/dev',
    containerPort: 3000,
    protocol: 'http',
    exposurePolicy: 'assignedUsersOnly',
    identityMode: 'required',
    enabled: input.enabled ?? true,
    ...(input.shellApp !== null ? {
      shellApp: input.shellApp ?? {
        displayName: 'Reports Dev',
        description: 'Reports developer target.',
        icon: 'boxes',
        entrypointPath: '/',
        navigation: [],
      },
    } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  };
}
