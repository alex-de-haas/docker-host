import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listHostApps } from './app-registry-service.ts';
import { createEmptyAuthState, writeAuthState } from './auth-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { HostPrincipal } from '../types/auth.ts';
import type { ModuleRuntimeState, ModuleRuntimeStatus } from '../types/modules.ts';

const admin: HostPrincipal = {
  id: 'user_admin',
  role: 'host.admin',
  email: 'admin@example.test',
};

const assignedUser: HostPrincipal = {
  id: 'user_assigned',
  role: 'host.user',
  email: 'assigned@example.test',
};

const unassignedUser: HostPrincipal = {
  id: 'user_unassigned',
  role: 'host.user',
  email: 'unassigned@example.test',
};

test('returns available shell apps to authenticated Host users', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
  });

  const apps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'com.example.reports');
  assert.equal(apps[0].accessMode, 'allAuthenticated');
  assert.equal(apps[0].status, 'available');
  assert.equal(apps[0].entryPath, '/apps/com.example.reports');
  assert.equal(apps[0].embeddedUrl, '/api/apps/com.example.reports/embed?path=%2F');
  assert.deepEqual(apps[0].navigation, [
    {
      label: 'People',
      path: '/people',
      entryPath: '/apps/com.example.reports?path=%2Fpeople',
      embeddedUrl: '/api/apps/com.example.reports/embed?path=%2Fpeople',
    },
  ]);
});

test('filters assigned shell apps for host users but keeps them visible to admins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
  });
  await writeAuthState({
    ...createEmptyAuthState(),
    moduleAssignments: [
      {
        moduleId: 'com.example.reports',
        userId: assignedUser.id,
      },
    ],
  }, config);

  const assignedApps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });
  const unassignedApps = await listHostApps(unassignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });
  const adminApps = await listHostApps(admin, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });

  assert.equal(assignedApps.length, 1);
  assert.equal(assignedApps[0].accessMode, 'assignedUsersOnly');
  assert.equal(unassignedApps.length, 0);
  assert.equal(adminApps.length, 1);
  assert.equal(adminApps[0].accessMode, 'assignedUsersOnly');
});

test('hides unavailable apps from host users and returns safe diagnostics to admins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
    operationStatus: 'updating',
  });

  const userApps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });
  const adminApps = await listHostApps(admin, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });

  assert.equal(userApps.length, 0);
  assert.equal(adminApps.length, 1);
  assert.equal(adminApps[0].status, 'unavailable');
  assert.equal(adminApps[0].statusReason, 'moduleOperationUnavailable');
  assert.equal(adminApps[0].operationStatus, 'updating');
});

test('does not infer shell apps from modules without explicit UI metadata', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.identity',
    name: 'Example Identity',
    withUi: false,
  });

  const apps = await listHostApps(admin, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });

  assert.equal(apps.length, 0);
});

test('reports missing metadata only to admins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeModulesStore(config, [
    {
      id: 'com.example.missing',
      metadataUrl: 'https://modules.example.test/missing.json',
      operationStatus: 'installed',
    },
  ]);

  const userApps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });
  const adminApps = await listHostApps(admin, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });

  assert.equal(userApps.length, 0);
  assert.equal(adminApps.length, 1);
  assert.equal(adminApps[0].moduleId, 'com.example.missing');
  assert.equal(adminApps[0].statusReason, 'metadataMissing');
});

async function createAppRegistryTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-apps-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
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

async function writeInstalledModule(
  config: HostRuntimeConfig,
  input: {
    moduleId: string;
    name: string;
    withUi: boolean;
    operationStatus?: 'installed' | 'installing' | 'updating' | 'failed' | 'removing';
  }
) {
  const moduleRoot = path.join(config.modulesRootContainer, input.moduleId);
  await fs.mkdir(moduleRoot, { recursive: true });
  await writeModulesStore(config, [
    {
      id: input.moduleId,
      metadataUrl: 'https://modules.example.test/module.json',
      operationStatus: input.operationStatus || 'installed',
    },
  ]);
  await fs.writeFile(path.join(moduleRoot, 'metadata.json'), `${JSON.stringify({
    schemaVersion: '0.1',
    id: input.moduleId,
    name: input.name,
    description: `${input.name} fixture.`,
    version: '1.0.0',
    image: {
      repository: 'ghcr.io/example/module',
      tag: 'latest',
    },
    runtime: {
      ports: [
        {
          key: 'http',
          containerPort: 3000,
          protocol: 'http',
          public: true,
        },
      ],
    },
    ...(input.withUi
      ? {
          ui: {
            entrypoint: {
              portKey: 'http',
              path: '/',
            },
            navigation: [
              {
                label: 'People',
                path: '/people',
              },
            ],
          },
        }
      : {}),
  }, null, 2)}\n`);
}

async function writeModulesStore(
  config: HostRuntimeConfig,
  modules: Array<{
    id: string;
    metadataUrl: string;
    operationStatus?: 'installed' | 'installing' | 'updating' | 'failed' | 'removing';
  }>
) {
  await fs.mkdir(config.modulesRootContainer, { recursive: true });
  await fs.writeFile(config.modulesStorePath, `${JSON.stringify({
    schemaVersion: '0.1',
    hostSettings: {},
    modules,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

function runtimeStatus(state: ModuleRuntimeState) {
  return async (): Promise<ModuleRuntimeStatus> => ({
    state,
    containerId: state === 'not_created' ? null : 'container_1',
    containerName: 'mod-test',
    startedAt: state === 'running' ? new Date().toISOString() : null,
    finishedAt: null,
  });
}
