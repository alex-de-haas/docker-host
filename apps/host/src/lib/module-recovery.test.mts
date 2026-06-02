import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyModuleRemoveRequest,
  createModuleRemovePlan,
  retryFailedModuleInstall,
} from './module-recovery.ts';
import { readAppsStoreSnapshot, writeAppsStore } from './app-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { ModuleRecoveryDockerOperations } from './module-recovery.ts';
import type { InstalledModuleRecord } from '../types/modules.ts';

test('remove deletes app lifecycle records and app-owned data without legacy module records', async () => {
  const config = await createRecoveryTestConfig();
  await writeInstalledAppFixture(config, {
    appId: 'com.example.notes',
    operationStatus: 'installed',
  });

  const planResult = await createModuleRemovePlan('com.example.notes', true, {
    config,
    docker: fakeRecoveryDocker(),
  });
  assert.equal(planResult.status, 200);
  assert.equal(planResult.body.plan?.moduleDirectory.willDelete, true);

  const result = await applyModuleRemoveRequest('com.example.notes', {
    confirmed: true,
    deleteModuleData: true,
  }, {
    config,
    docker: fakeRecoveryDocker(),
    now: () => '2026-06-02T12:00:00.000Z',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal((await readAppsStoreSnapshot(config)).apps.length, 0);
  await assert.rejects(() => fs.access(path.join(config.appsRootContainer as string, 'com.example.notes')));
  const modulesStore = JSON.parse(await fs.readFile(config.modulesStorePath, 'utf-8')) as {
    modules: unknown[];
  };
  assert.deepEqual(modulesStore.modules, []);
});

test('retry failed install updates app lifecycle records without legacy module records', async () => {
  const config = await createRecoveryTestConfig();
  await writeInstalledAppFixture(config, {
    appId: 'com.example.notes',
    operationStatus: 'failed',
    lastOperation: 'install',
    lastError: {
      operation: 'module.install.com.example.notes',
      httpStatus: 500,
      message: 'Install failed.',
      nextStep: 'Retry.',
      occurredAt: '2026-06-02T11:00:00.000Z',
    },
  });
  const docker = fakeRecoveryDocker();

  const result = await retryFailedModuleInstall('com.example.notes', {
    config,
    docker,
    now: () => '2026-06-02T12:00:00.000Z',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  const appsStore = await readAppsStoreSnapshot(config);
  const app = appsStore.apps.find(candidate => candidate.id === 'com.example.notes');
  assert.equal(app?.operationStatus, 'installed');
  assert.equal(app?.lastError, null);
  assert.equal(app?.updatedAt, '2026-06-02T12:00:00.000Z');
  assert.equal(await exists(path.join(config.appsRootContainer as string, 'com.example.notes', 'data')), true);
});

async function createRecoveryTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'hosty-recovery-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');

  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    dataRootMarkerPath: path.join(dataRootContainer, '.owner'),
    dataRootExpectedMarker: null,
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

async function writeInstalledAppFixture(
  config: HostRuntimeConfig,
  input: {
    appId: string;
    operationStatus: 'installed' | 'failed';
    lastOperation?: InstalledModuleRecord['lastOperation'];
    lastError?: InstalledModuleRecord['lastError'];
  }
) {
  const appRoot = path.join(config.appsRootContainer as string, input.appId);
  const dataPath = path.join(appRoot, 'data');
  await fs.mkdir(dataPath, { recursive: true });
  await fs.writeFile(path.join(dataPath, 'note.txt'), 'content', 'utf-8');
  await fs.writeFile(path.join(appRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'app.0.1',
    id: input.appId,
    name: 'Notes',
    version: '1.0.0',
    runtimeProfiles: [
      {
        key: 'docker',
        type: 'docker',
        default: true,
      },
    ],
    services: [
      {
        key: 'web',
        runtimes: {
          docker: {
            type: 'docker',
            image: 'ghcr.io/example/notes:1.0.0',
            ports: [
              {
                key: 'http',
                containerPort: 3000,
                protocol: 'http',
                public: true,
              },
            ],
          },
        },
      },
    ],
    data: {
      enabled: true,
      targets: [
        {
          service: 'web',
          containerPath: '/data',
        },
      ],
    },
  }, null, 2)}\n`, 'utf-8');
  await writeAppsStore({
    schemaVersion: 'app-store.0.1',
    apps: [
      {
        id: input.appId,
        manifestUrl: 'https://apps.example.test/notes/manifest.json',
        manifestPath: `apps/${input.appId}/manifest.json`,
        selectedRuntime: 'docker',
        containers: [
          {
            key: 'web',
            containerName: 'mod-com-example-notes-web',
            networkAlias: 'mod-com-example-notes-web',
            image: {
              repository: 'ghcr.io/example/notes',
              tag: '1.0.0',
              reference: 'ghcr.io/example/notes:1.0.0',
            },
          },
        ],
        operationStatus: input.operationStatus,
        storageMappings: [
          {
            key: 'data',
            container: 'web',
            containerPath: '/data',
            hostPath: dataPath,
            writable: true,
          },
        ],
        installedAt: '2026-06-02T10:00:00.000Z',
        updatedAt: '2026-06-02T11:00:00.000Z',
        ...(input.lastOperation ? { lastOperation: input.lastOperation } : {}),
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      },
    ],
    updatedAt: new Date().toISOString(),
  }, config);
}

function fakeRecoveryDocker(): ModuleRecoveryDockerOperations {
  return {
    inspectContainerName: async name => ({
      name,
      exists: true,
      id: `container_${name}`,
      image: 'ghcr.io/example/notes:1.0.0',
    }),
    removeContainersIfExist: async module =>
      module.containers.map(container => ({
        removed: true,
        existed: true,
        containerName: container.containerName,
      })),
    ensureNetwork: async config => ({
      name: config.moduleNetwork,
      ready: true,
      error: null,
    }),
    pullImage: async () => undefined,
    createAndStartContainer: async input => ({
      state: 'running',
      containerId: `container_${input.containerName}`,
      containerName: input.containerName,
      startedAt: '2026-06-02T12:00:00.000Z',
      finishedAt: null,
    }),
    ensureContainerStarted: async module => ({
      state: 'running',
      containerId: `container_${module.id}`,
      containerName: module.containers[0]?.containerName ?? module.id,
      startedAt: '2026-06-02T12:00:00.000Z',
      finishedAt: null,
    }),
  };
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
