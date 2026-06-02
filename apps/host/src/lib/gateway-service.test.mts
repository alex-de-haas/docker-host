import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deleteGatewayExposure,
  GatewayServiceError,
  listGatewayExposureOptions,
  resolveGatewayTarget,
  upsertGatewayExposure,
} from './gateway-service.ts';
import { writeAppsStore } from './app-store.ts';
import { createEmptyAuthState, writeAuthState } from './auth-store.ts';
import {
  readExternalIngressStateSnapshot,
  writeExternalIngressState,
} from './external-ingress-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('creates gateway exposure for a public module port and resolves target', async () => {
  const config = await createGatewayTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    portPublic: true,
  });

  const exposure = await upsertGatewayExposure({
    moduleId: 'com.example.reports',
    hostname: 'Reports.Example.Test.',
    endpointKey: 'web',
  }, 'user_admin', config);

  assert.equal(exposure.hostname, 'reports.example.test');
  assert.equal(exposure.exposurePolicy, 'loginRequired');
  assert.equal(exposure.identityMode, 'required');

  const anonymousTarget = await resolveGatewayTarget('reports.example.test', null, config);
  assert.equal(anonymousTarget?.targetBaseUrl, 'http://mod-com-example-reports-app:8080');
  assert.equal(anonymousTarget?.access.allowed, false);
  assert.equal(anonymousTarget?.access.reason, 'loginRequired');

  const userTarget = await resolveGatewayTarget(
    'reports.example.test',
    { id: 'user_1', role: 'host.user', email: 'user@example.test' },
    config
  );
  assert.equal(userTarget?.access.allowed, true);
  assert.equal(userTarget?.access.reason, 'authenticated');
});

test('resolves gateway target for legacy single-container module records', async () => {
  const config = await createGatewayTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.legacy',
    portPublic: true,
    containerKey: 'main',
    legacyStoreRecord: true,
  });

  await upsertGatewayExposure({
    moduleId: 'com.example.legacy',
    hostname: 'legacy.example.test',
    endpointKey: 'web',
  }, 'user_admin', config);

  const target = await resolveGatewayTarget(
    'legacy.example.test',
    { id: 'user_1', role: 'host.user', email: 'user@example.test' },
    config
  );

  assert.equal(target?.targetBaseUrl, 'http://legacy-alias:8080');
  assert.equal(target?.networkAlias, 'legacy-alias');
});

test('resolves gateway target from app lifecycle records without legacy module records', async () => {
  const config = await createGatewayTestConfig();
  await writeInstalledApp(config, {
    appId: 'com.example.project-manager',
  });

  await upsertGatewayExposure({
    moduleId: 'com.example.project-manager',
    hostname: 'project.example.test',
    endpointKey: 'web',
  }, 'user_admin', config);

  const target = await resolveGatewayTarget(
    'project.example.test',
    { id: 'user_1', role: 'host.user', email: 'user@example.test' },
    config
  );

  assert.equal(target?.targetBaseUrl, 'http://mod-com-example-project-manager-web:3000');
  assert.equal(target?.networkAlias, 'mod-com-example-project-manager-web');
  assert.equal(target?.containerPort, 3000);
});

test('rejects exposure for endpoints not marked public', async () => {
  const config = await createGatewayTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.identity',
    portPublic: false,
  });

  await assert.rejects(
    upsertGatewayExposure({
      moduleId: 'com.example.identity',
      hostname: 'identity.example.test',
      endpointKey: 'web',
    }, 'user_admin', config),
    (error: unknown) => error instanceof GatewayServiceError && error.code === 'endpoint_not_public'
  );
});

test('public gateway exposures default to no identity and reject required identity', async () => {
  const config = await createGatewayTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.public',
    portPublic: true,
  });

  const exposure = await upsertGatewayExposure({
    moduleId: 'com.example.public',
    hostname: 'public.example.test',
    endpointKey: 'web',
    exposurePolicy: 'public',
  }, 'user_admin', config);

  assert.equal(exposure.identityMode, 'none');

  await assert.rejects(
    upsertGatewayExposure({
      moduleId: 'com.example.public',
      hostname: 'public-required.example.test',
      endpointKey: 'web',
      exposurePolicy: 'public',
      identityMode: 'required',
    }, 'user_admin', config),
    (error: unknown) => error instanceof GatewayServiceError && error.code === 'invalid_identity_mode'
  );
});

test('assignedUsersOnly exposure checks Host module assignments', async () => {
  const config = await createGatewayTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    portPublic: true,
  });
  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_1',
        email: 'user@example.test',
        role: 'host.user',
        passwordHash: 'unused',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    moduleAssignments: [
      {
        moduleId: 'com.example.reports',
        userId: 'user_1',
      },
    ],
  }, config);
  await upsertGatewayExposure({
    moduleId: 'com.example.reports',
    hostname: 'reports.example.test',
    endpointKey: 'web',
    exposurePolicy: 'assignedUsersOnly',
  }, 'user_admin', config);

  const assignedTarget = await resolveGatewayTarget(
    'reports.example.test',
    { id: 'user_1', role: 'host.user', email: 'user@example.test' },
    config
  );
  const unassignedTarget = await resolveGatewayTarget(
    'reports.example.test',
    { id: 'user_2', role: 'host.user', email: 'other@example.test' },
    config
  );

  assert.equal(assignedTarget?.access.allowed, true);
  assert.equal(assignedTarget?.access.reason, 'assigned');
  assert.equal(unassignedTarget?.access.allowed, false);
  assert.equal(unassignedTarget?.access.reason, 'assignmentRequired');
});

test('lists gateway exposure options for installed modules and active users', async () => {
  const config = await createGatewayTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    portPublic: true,
    uiEntrypoint: true,
  });
  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_1',
        email: 'user@example.test',
        displayName: 'User One',
        role: 'host.user',
        passwordHash: 'unused',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'user_disabled',
        email: 'disabled@example.test',
        role: 'host.user',
        passwordHash: 'unused',
        disabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  }, config);

  const options = await listGatewayExposureOptions(config);

  assert.equal(options.gatewayBaseDomain, 'example.test');
  assert.deepEqual(options.users.map(user => user.id), ['user_1']);
  assert.equal(options.modules.length, 1);
  assert.equal(options.modules[0]?.id, 'com.example.reports');
  assert.equal(options.modules[0]?.uiEntrypointPortKey, 'web');
  assert.deepEqual(options.modules[0]?.ports, [
    {
      key: 'web',
      containerPort: 8080,
      protocol: 'http',
      public: true,
      isUiEntrypoint: true,
    },
  ]);
});

test('deleting a gateway exposure removes linked external ingress readiness', async () => {
  const config = await createGatewayTestConfig();
  await writeInstalledModule(config, {
    moduleId: 'com.example.reports',
    portPublic: true,
  });
  const exposure = await upsertGatewayExposure({
    moduleId: 'com.example.reports',
    hostname: 'reports.example.test',
    portKey: 'web',
  }, 'user_admin', config);
  const now = new Date().toISOString();
  await writeExternalIngressState({
    schemaVersion: '0.1',
    records: [
      {
        id: 'ing_reports',
        gatewayExposureId: exposure.id,
        mode: 'manual',
        status: 'planned',
        checklist: {},
        snapshot: {
          moduleId: exposure.moduleId,
          hostname: exposure.hostname,
          portKey: exposure.portKey,
          exposurePolicy: exposure.exposurePolicy,
          identityMode: exposure.identityMode,
          gatewayBaseDomain: config.gatewayBaseDomain,
          hostPublicOrigin: config.hostPublicOrigin,
          trustedProxyMode: false,
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  }, config);

  await deleteGatewayExposure(exposure.id, 'user_admin', config);

  const ingress = await readExternalIngressStateSnapshot(config);
  assert.deepEqual(ingress.records, []);
});

async function createGatewayTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-gateway-'));
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

async function writeInstalledApp(
  config: HostRuntimeConfig,
  input: {
    appId: string;
  }
) {
  const appRoot = path.join(config.appsRootContainer as string, input.appId);
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'app.0.1',
    id: input.appId,
    name: 'Project Manager',
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
            image: 'ghcr.io/example/project-manager:1.0.0',
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
    endpoints: [
      {
        key: 'web',
        service: 'web',
        port: 'http',
        public: true,
      },
    ],
  }, null, 2)}\n`, 'utf-8');
  await writeAppsStore({
    schemaVersion: 'app-store.0.1',
    apps: [
      {
        id: input.appId,
        manifestUrl: 'https://apps.example.test/project-manager/manifest.json',
        manifestPath: `apps/${input.appId}/manifest.json`,
        selectedRuntime: 'docker',
        containers: [
          {
            key: 'web',
            containerName: 'mod-com-example-project-manager-web',
            networkAlias: 'mod-com-example-project-manager-web',
            image: {
              repository: 'ghcr.io/example/project-manager',
              tag: '1.0.0',
              reference: 'ghcr.io/example/project-manager:1.0.0',
            },
            ports: [
              {
                key: 'http',
                endpointKey: 'web',
                containerPort: 3000,
                hostPort: 3102,
                protocol: 'http',
                hostPublished: true,
              },
            ],
          },
        ],
        operationStatus: 'installed',
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    updatedAt: new Date().toISOString(),
  }, config);
}

async function writeInstalledModule(
  config: HostRuntimeConfig,
  input: {
    moduleId: string;
    portPublic: boolean;
    uiEntrypoint?: boolean;
    containerKey?: string;
    legacyStoreRecord?: boolean;
  }
) {
  const containerKey = input.containerKey ?? 'app';
  const moduleRoot = path.join(config.modulesRootContainer, input.moduleId);
  await fs.mkdir(moduleRoot, { recursive: true });
  await fs.writeFile(config.modulesStorePath, `${JSON.stringify({
    schemaVersion: '0.2',
    hostSettings: {},
    modules: [
      input.legacyStoreRecord
        ? {
            id: input.moduleId,
            metadataUrl: 'https://modules.example.test/module.json',
            operationStatus: 'installed',
            containerName: 'legacy-container',
            networkAlias: 'legacy-alias',
            image: {
              repository: 'ghcr.io/example/module',
              tag: 'latest',
              reference: 'ghcr.io/example/module:latest',
              pullPolicy: 'ifNotPresent',
            },
          }
        : {
            id: input.moduleId,
            metadataUrl: 'https://modules.example.test/module.json',
            operationStatus: 'installed',
            containers: [{
              key: containerKey,
              containerName: `mod-${input.moduleId.replace(/\./g, '-')}-${containerKey}`,
              networkAlias: `mod-${input.moduleId.replace(/\./g, '-')}-${containerKey}`,
              image: {
                repository: 'ghcr.io/example/module',
                tag: 'latest',
                reference: 'ghcr.io/example/module:latest',
                pullPolicy: 'ifNotPresent',
              },
            }],
          },
    ],
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  await fs.writeFile(path.join(moduleRoot, 'metadata.json'), `${JSON.stringify({
    schemaVersion: '0.2',
    id: input.moduleId,
    name: 'Example Module',
    version: '1.0.0',
    containers: [{
      key: containerKey,
      image: {
        repository: 'ghcr.io/example/module',
        tag: 'latest',
      },
      runtime: {
        ports: [{
          key: 'http',
          containerPort: 8080,
          protocol: 'http',
        }],
      },
    }],
    endpoints: [{
      key: 'web',
      container: containerKey,
      port: 'http',
      public: input.portPublic,
    }],
    ...(input.uiEntrypoint
      ? {
          ui: {
            entrypoint: {
              portKey: 'web',
              path: '/',
            },
            navigation: [],
          },
        }
      : {}),
  }, null, 2)}\n`);
}
