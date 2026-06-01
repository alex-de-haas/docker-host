import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCachedRuntimeStatusReader, listHostApps } from './app-registry-service.ts';
import { createEmptyAuthState, writeAuthState } from './auth-store.ts';
import { writeModuleDevTargetState } from './module-dev-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { HostPrincipal } from '../types/auth.ts';
import type { ModuleDevTargetRecord } from '../types/module-dev.ts';
import type { InstalledModuleRecord, ModuleRuntimeState, ModuleRuntimeStatus } from '../types/modules.ts';

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
  assert.equal(apps[0].icon, 'boxes');
  assert.equal(apps[0].entryPath, '/apps/com.example.reports');
  assert.equal(apps[0].embeddedUrl, 'http://localhost:3101/');
  assert.equal(apps[0].origin, 'http://localhost:3101');
  assert.equal(apps[0].originScope, 'local');
  assert.equal(apps[0].identityTokenUrl, '/api/apps/com.example.reports/identity-token');
  assert.deepEqual(apps[0].navigation, [
    {
      label: 'People',
      path: '/people',
      entryPath: '/apps/com.example.reports?path=%2Fpeople',
      embeddedUrl: 'http://localhost:3101/people',
    },
  ]);
});

test('includes Hosty Shell as a system app for admin management views', async () => {
  const config = await createAppRegistryTestConfig();

  const apps = await listHostApps(admin, {
    config,
    includeSystemApps: true,
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'hosty.shell');
  assert.equal(apps[0].kind, 'system');
  assert.equal(apps[0].system, true);
  assert.equal(apps[0].source, 'system');
  assert.equal(apps[0].status, 'available');
  assert.equal(apps[0].entryPath, '/');
  assert.deepEqual(apps[0].capabilities, ['open', 'update']);
});

test('uses localhost for local fallback shell app origins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
  });

  const apps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
    requestOrigin: 'http://localhost:3000',
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, 'available');
  assert.equal(apps[0].embeddedUrl, 'http://localhost:3101/');
  assert.equal(apps[0].origin, 'http://localhost:3101');
  assert.equal(apps[0].originScope, 'local');
});

test('marks local fallback shell apps unavailable from non-loopback Host origins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
  });

  const apps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
    requestOrigin: 'https://host.example.test',
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, 'unavailable');
  assert.equal(apps[0].statusReason, 'localOriginUnavailable');
  assert.equal(apps[0].embeddedUrl, 'http://localhost:3101/');
  assert.equal(apps[0].origin, 'http://localhost:3101');
  assert.equal(apps[0].originScope, 'local');
});

test('uses configured public origin for shell app origins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    publicOrigin: 'https://reports.example.test',
    withUi: true,
  });

  const apps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
    requestOrigin: 'https://host.example.test',
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, 'available');
  assert.equal(apps[0].embeddedUrl, 'https://reports.example.test/');
  assert.equal(apps[0].origin, 'https://reports.example.test');
  assert.equal(apps[0].originScope, 'public');
});

test('resolves schema 0.3 service endpoints for installed shell app origins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
    schemaVersion: '0.3',
    endpointTargetField: 'service',
  });

  const apps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
    requestOrigin: 'http://localhost:3000',
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, 'available');
  assert.equal(apps[0].statusReason, 'available');
  assert.equal(apps[0].embeddedUrl, 'http://localhost:3101/');
  assert.equal(apps[0].origin, 'http://localhost:3101');
  assert.equal(apps[0].originScope, 'local');
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

test('hides shell apps without published UI port from users and reports upgrade path to admins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
    withPortBindings: false,
  });

  let runtimeStatusReads = 0;
  const runtimeStatusReader = async (): Promise<ModuleRuntimeStatus> => {
    runtimeStatusReads += 1;
    return {
      state: 'running',
      containerId: 'container_1',
      containerName: 'mod-test',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
  };

  const userApps = await listHostApps(assignedUser, { config, runtimeStatusReader });
  const adminApps = await listHostApps(admin, { config, runtimeStatusReader });

  assert.equal(userApps.length, 0);
  assert.equal(adminApps.length, 1);
  assert.equal(adminApps[0].status, 'unavailable');
  assert.equal(adminApps[0].statusReason, 'uiPortMissing');
  assert.equal(runtimeStatusReads, 0);
});

test('hides unavailable apps from host users and returns safe diagnostics to admins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
    operationStatus: 'updating',
  });

  let runtimeStatusReads = 0;
  const runtimeStatusReader = async (): Promise<ModuleRuntimeStatus> => {
    runtimeStatusReads += 1;
    throw new Error('runtime status should not be read for modules with unavailable operations');
  };

  const userApps = await listHostApps(assignedUser, { config, runtimeStatusReader });
  const adminApps = await listHostApps(admin, { config, runtimeStatusReader });

  assert.equal(userApps.length, 0);
  assert.equal(adminApps.length, 1);
  assert.equal(adminApps[0].status, 'unavailable');
  assert.equal(adminApps[0].statusReason, 'moduleOperationUnavailable');
  assert.equal(adminApps[0].operationStatus, 'updating');
  assert.equal(runtimeStatusReads, 0);
});

test('includes failed operation context for admin app menu recovery actions', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
    operationStatus: 'failed',
    lastOperation: 'update',
  });

  const adminApps = await listHostApps(admin, {
    config,
    runtimeStatusReader: runtimeStatus('running'),
  });

  assert.equal(adminApps.length, 1);
  assert.equal(adminApps[0].status, 'unavailable');
  assert.equal(adminApps[0].statusReason, 'moduleOperationUnavailable');
  assert.equal(adminApps[0].operationStatus, 'failed');
  assert.equal(adminApps[0].lastOperation, 'update');
});

test('hides stopped shell apps from host users and does not expose raw runtime internals', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
  });

  const userApps = await listHostApps(assignedUser, {
    config,
    runtimeStatusReader: runtimeStatus('not_created'),
  });
  const adminApps = await listHostApps(admin, {
    config,
    runtimeStatusReader: runtimeStatus('not_created'),
  });

  assert.equal(userApps.length, 0);
  assert.equal(adminApps.length, 1);
  assert.equal(adminApps[0].status, 'unavailable');
  assert.equal(adminApps[0].statusReason, 'runtimeUnavailable');
  assert.equal(adminApps[0].runtimeState, 'not_created');
  assert.equal('containerId' in adminApps[0], false);
  assert.equal('containerName' in adminApps[0], false);
});

test('reuses cached runtime status between app registry reads', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
  });

  let now = 1_000;
  let runtimeStatusReads = 0;
  const cachedRuntimeStatusReader = createCachedRuntimeStatusReader(async () => {
    runtimeStatusReads += 1;
    return {
      state: 'running',
      containerId: 'container_1',
      containerName: 'mod-test',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
  }, {
    ttlMs: 5_000,
    now: () => now,
  });

  assert.equal((await listHostApps(admin, {
    config,
    runtimeStatusReader: cachedRuntimeStatusReader,
  })).length, 1);
  assert.equal((await listHostApps(admin, {
    config,
    runtimeStatusReader: cachedRuntimeStatusReader,
  })).length, 1);
  assert.equal(runtimeStatusReads, 1);

  now += 5_001;

  assert.equal((await listHostApps(admin, {
    config,
    runtimeStatusReader: cachedRuntimeStatusReader,
  })).length, 1);
  assert.equal(runtimeStatusReads, 2);
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

test('reports invalid shell UI metadata only to admins', async () => {
  const config = await createAppRegistryTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    name: 'Example Reports',
    withUi: true,
    ui: {
      entrypoint: {
        portKey: 'web',
        path: '/',
      },
      navigation: [
        {
          label: 'People',
          path: '/people',
        },
        {
          label: 'Team',
          path: '/people',
        },
      ],
    },
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
  assert.equal(adminApps[0].moduleId, 'com.example.reports');
  assert.equal(adminApps[0].statusReason, 'metadataInvalid');
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

test('includes enabled developer targets when module developer mode is active', async () => {
  const config = await createAppRegistryTestConfig({ moduleDevModeEnabled: true });
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [createDeveloperTarget()],
    updatedAt: new Date().toISOString(),
  }, config);

  const apps = await listHostApps(assignedUser, { config });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'dev:mdev_reports');
  assert.equal(apps[0].source, 'developer');
  assert.equal(apps[0].moduleId, 'com.example.reports');
  assert.equal(apps[0].developerTargetId, 'mdev_reports');
  assert.equal(apps[0].displayName, 'Reports Dev');
  assert.equal(apps[0].status, 'available');
  assert.equal(apps[0].entryPath, '/apps/dev/mdev_reports');
  assert.equal(apps[0].embeddedUrl, 'http://127.0.0.1:3001/dev/');
  assert.equal(apps[0].origin, 'http://127.0.0.1:3001');
  assert.equal(apps[0].identityTokenUrl, '/api/apps/dev/mdev_reports/identity-token');
  assert.deepEqual(apps[0].navigation, [
    {
      label: 'People',
      path: '/people',
      entryPath: '/apps/dev/mdev_reports?path=%2Fpeople',
      embeddedUrl: 'http://127.0.0.1:3001/dev/people',
    },
  ]);
});

test('keeps developer targets that point back to the Host origin out of apps', async () => {
  const config = await createAppRegistryTestConfig({ moduleDevModeEnabled: true });
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [
      createDeveloperTarget({
        id: 'mdev_self',
        targetBaseUrl: 'http://localhost:3000',
        targetPathPrefix: '',
      }),
      createDeveloperTarget({
        id: 'mdev_reports',
        targetBaseUrl: 'http://127.0.0.1:3001/dev',
        targetPathPrefix: '/dev',
      }),
    ],
    updatedAt: new Date().toISOString(),
  }, config);

  const apps = await listHostApps(admin, {
    config,
    requestOrigin: 'http://127.0.0.1:3000',
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'dev:mdev_reports');
  assert.equal(apps[0].embeddedUrl, 'http://127.0.0.1:3001/dev/');
});

test('maps loopback developer app origins to the Host request hostname', async () => {
  const config = await createAppRegistryTestConfig({ moduleDevModeEnabled: true });
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [createDeveloperTarget()],
    updatedAt: new Date().toISOString(),
  }, config);

  const apps = await listHostApps(assignedUser, {
    config,
    requestOrigin: 'http://localhost:3000',
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].origin, 'http://localhost:3001');
  assert.equal(apps[0].embeddedUrl, 'http://localhost:3001/dev/');
  assert.deepEqual(apps[0].navigation, [
    {
      label: 'People',
      path: '/people',
      entryPath: '/apps/dev/mdev_reports?path=%2Fpeople',
      embeddedUrl: 'http://localhost:3001/dev/people',
    },
  ]);
});

test('keeps disabled developer targets out of apps without requiring a dev-mode launch flag', async () => {
  const disabledTargetConfig = await createAppRegistryTestConfig({ moduleDevModeEnabled: true });
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [createDeveloperTarget({ enabled: false })],
    updatedAt: new Date().toISOString(),
  }, disabledTargetConfig);

  assert.deepEqual(await listHostApps(admin, { config: disabledTargetConfig }), []);
});

test('filters assigned developer targets for host users but keeps them visible to admins', async () => {
  const config = await createAppRegistryTestConfig({ moduleDevModeEnabled: true });
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [createDeveloperTarget({ exposurePolicy: 'assignedUsersOnly' })],
    updatedAt: new Date().toISOString(),
  }, config);
  await writeAuthState({
    ...createEmptyAuthState(),
    moduleAssignments: [
      {
        moduleId: 'com.example.reports',
        userId: assignedUser.id,
      },
    ],
  }, config);

  const assignedApps = await listHostApps(assignedUser, { config });
  const unassignedApps = await listHostApps(unassignedUser, { config });
  const adminApps = await listHostApps(admin, { config });

  assert.equal(assignedApps.length, 1);
  assert.equal(assignedApps[0].accessMode, 'assignedUsersOnly');
  assert.equal(unassignedApps.length, 0);
  assert.equal(adminApps.length, 1);
  assert.equal(adminApps[0].accessMode, 'assignedUsersOnly');
});

async function createAppRegistryTestConfig(input: { moduleDevModeEnabled?: boolean } = {}): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-apps-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');
  const moduleDevRootContainer = path.join(dataRootContainer, 'dev');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    moduleDevModeEnabled: input.moduleDevModeEnabled,
    moduleDevRootContainer,
    moduleDevTargetsPath: path.join(moduleDevRootContainer, 'module-targets.json'),
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

function createDeveloperTarget(
  input: {
    id?: string;
    enabled?: boolean;
    exposurePolicy?: ModuleDevTargetRecord['exposurePolicy'];
    targetBaseUrl?: string;
    targetPathPrefix?: string;
  } = {}
): ModuleDevTargetRecord {
  const now = new Date().toISOString();
  return {
    id: input.id ?? 'mdev_reports',
    moduleId: 'com.example.reports',
    moduleName: 'Reports',
    moduleVersion: '1.0.0',
    moduleDescription: 'Reports developer target.',
    metadataUrl: 'http://127.0.0.1:3000/metadata.json',
    hostname: 'reports.localhost',
    portKey: 'web',
    targetBaseUrl: input.targetBaseUrl ?? 'http://127.0.0.1:3001/dev',
    targetPathPrefix: input.targetPathPrefix ?? '/dev',
    containerPort: 3000,
    protocol: 'http',
    exposurePolicy: input.exposurePolicy ?? 'loginRequired',
    identityMode: 'required',
    enabled: input.enabled ?? true,
    shellApp: {
      displayName: 'Reports Dev',
      description: 'Reports developer target.',
      icon: 'boxes',
      entrypointPath: '/',
      navigation: [
        {
          label: 'People',
          path: '/people',
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function writeInstalledModule(
  config: HostRuntimeConfig,
  input: {
    moduleId: string;
    name: string;
    withUi: boolean;
    ui?: unknown;
    operationStatus?: 'installed' | 'installing' | 'updating' | 'failed' | 'removing';
    lastOperation?: InstalledModuleRecord['lastOperation'];
    withPortBindings?: boolean;
    publicOrigin?: string;
    schemaVersion?: '0.2' | '0.3';
    endpointTargetField?: 'container' | 'service';
  }
) {
  const moduleRoot = path.join(config.modulesRootContainer, input.moduleId);
  const schemaVersion = input.schemaVersion ?? '0.2';
  const endpointTargetField = input.endpointTargetField ?? 'container';
  const runtimeNode = {
    ports: [
      {
        key: 'http',
        containerPort: 3000,
        protocol: 'http',
      },
    ],
  };
  await fs.mkdir(moduleRoot, { recursive: true });
  await writeModulesStore(config, [
    {
      id: input.moduleId,
      metadataUrl: 'https://modules.example.test/module.json',
      operationStatus: input.operationStatus || 'installed',
      lastOperation: input.lastOperation,
      containers: [
        {
          key: 'app',
          containerName: `mod-${input.moduleId.replace(/\./g, '-')}-app`,
          networkAlias: `mod-${input.moduleId.replace(/\./g, '-')}-app`,
          image: {
            repository: 'ghcr.io/example/module',
            tag: 'latest',
            reference: 'ghcr.io/example/module:latest',
            pullPolicy: 'ifNotPresent',
          },
          ...(input.withPortBindings === false
            ? {}
            : {
                ports: [
                  {
                    key: 'http',
                    endpointKey: 'web',
                    containerPort: 3000,
                    hostPort: 3101,
                    protocol: 'http',
                    hostPublished: true,
                    ...(input.publicOrigin ? { publicOrigin: input.publicOrigin } : {}),
                  },
                ],
              }),
        },
      ],
    },
  ]);
  await fs.writeFile(path.join(moduleRoot, 'metadata.json'), `${JSON.stringify({
    schemaVersion,
    id: input.moduleId,
    name: input.name,
    description: `${input.name} fixture.`,
    version: '1.0.0',
    ...(schemaVersion === '0.3'
      ? {
          services: [
            {
              key: 'app',
              source: {
                type: 'image',
                image: {
                  repository: 'ghcr.io/example/module',
                  tag: 'latest',
                },
              },
              runtime: runtimeNode,
            },
          ],
        }
      : {
          containers: [
            {
              key: 'app',
              image: {
                repository: 'ghcr.io/example/module',
                tag: 'latest',
              },
              runtime: runtimeNode,
            },
          ],
        }),
    endpoints: [
      {
        key: 'web',
        [endpointTargetField]: 'app',
        port: 'http',
        public: true,
      },
    ],
    ...(input.withUi
      ? {
          ui: input.ui ?? {
            icon: 'boxes',
            entrypoint: {
              portKey: 'web',
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
    lastOperation?: InstalledModuleRecord['lastOperation'];
    containers?: unknown[];
  }>
) {
  await fs.mkdir(config.modulesRootContainer, { recursive: true });
  await fs.writeFile(config.modulesStorePath, `${JSON.stringify({
    schemaVersion: '0.2',
    hostSettings: {},
    modules: modules.map(module => ({
      ...module,
      containers: module.containers ?? [
        {
          key: 'app',
          containerName: `mod-${module.id.replace(/\./g, '-')}-app`,
          networkAlias: `mod-${module.id.replace(/\./g, '-')}-app`,
          image: {
            repository: 'ghcr.io/example/module',
            tag: 'latest',
            reference: 'ghcr.io/example/module:latest',
            pullPolicy: 'ifNotPresent',
          },
        },
      ],
    })),
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
