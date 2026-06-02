import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeAppsStore } from './app-store.ts';
import { listAssignableModules } from './user-access-options.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

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
