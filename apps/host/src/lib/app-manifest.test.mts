import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeMetadata } from './module-metadata.ts';
import { buildModulePaths } from './module-install-plan.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('normalizes app.0.1 multi-service docker manifests through the legacy runtime adapter', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: 'app.0.1',
    id: 'com.example.project-manager',
    name: 'Project Manager',
    version: '1.2.3',
    runtimeProfiles: [{
      key: 'docker',
      type: 'docker',
      default: true,
    }],
    services: [
      {
        key: 'api',
        runtimes: {
          docker: {
            type: 'docker',
            image: 'ghcr.io/example/project-manager-api:1.2.3',
            ports: [{
              key: 'http',
              containerPort: 8080,
              protocol: 'http',
            }],
            healthCheck: {
              type: 'http',
              path: '/health',
              successStatus: [200],
            },
          },
        },
      },
      {
        key: 'web',
        dependsOn: ['api'],
        runtimes: {
          docker: {
            type: 'docker',
            image: 'ghcr.io/example/project-manager-web:1.2.3',
            ports: [{
              key: 'http',
              containerPort: 3000,
              protocol: 'http',
              public: true,
            }],
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
      {
        key: 'api',
        service: 'api',
        port: 'http',
        public: false,
      },
    ],
    connections: [{
      source: {
        type: 'endpoint',
        key: 'api',
      },
      targets: [{
        service: 'web',
        type: 'env',
        name: 'API_BASE_URL',
      }],
    }],
    settings: [{
      key: 'APP_BASE_URL',
      type: 'url',
      required: false,
      default: 'http://localhost:3000',
      targets: [{
        service: 'web',
        type: 'env',
        name: 'APP_BASE_URL',
      }],
    }],
    ui: {
      entrypoint: {
        endpoint: 'web',
        path: '/',
      },
    },
    data: {
      enabled: true,
      targets: [{
        runtime: 'docker',
        service: 'api',
        containerPath: '/app/data',
      }],
    },
    dependencies: [{
      id: 'com.example.cache',
      version: '1',
      required: true,
      manifestUrl: 'https://apps.example.test/cache/manifest.json',
    }],
  }, '$');

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.metadata?.sourceSchemaVersion, 'app.0.1');
  assert.equal(result.metadata?.selectedRuntime, 'docker');
  assert.equal(result.metadata?.id, 'com.example.project-manager');
  assert.equal(result.metadata?.containers.length, 2);
  assert.equal(result.metadata?.containers[0]?.key, 'api');
  assert.equal(result.metadata?.containers[0]?.image.repository, 'ghcr.io/example/project-manager-api');
  assert.deepEqual(result.metadata?.containers[1]?.dependsOn, ['api']);
  assert.equal(result.metadata?.containers[1]?.image.repository, 'ghcr.io/example/project-manager-web');
  assert.equal(result.metadata?.ui?.entrypoint.portKey, 'web');
  assert.equal(result.metadata?.endpoints[0]?.container, 'web');
  assert.equal(result.metadata?.endpoints[1]?.container, 'api');
  assert.equal(result.metadata?.connections[0]?.targets[0]?.container, 'web');
  assert.equal(result.metadata?.settings[0]?.targets[0]?.container, 'web');
  assert.equal(result.metadata?.storage.directories[0]?.mount.modulePath, 'data');
  assert.equal(result.metadata?.storage.directories[0]?.targets[0]?.container, 'api');
  assert.equal(result.metadata?.storage.directories[0]?.targets[0]?.containerPath, '/app/data');
  assert.equal(result.metadata?.dependencies[0]?.metadataUrl, 'https://apps.example.test/cache/manifest.json');
});

test('normalizes app.0.1 local command runtime profiles for future runtime planning', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: 'app.0.1',
    id: 'com.example.local',
    name: 'Local App',
    version: '0.1.0',
    runtimeProfiles: [{
      key: 'dev',
      type: 'localCommand',
    }],
    services: [{
      key: 'app',
      runtimes: {
        dev: {
          type: 'localCommand',
          command: 'npm run dev',
          workingDirectory: '.',
          environment: {
            NODE_ENV: 'development',
          },
          ports: [{
            key: 'http',
            containerPort: 5173,
            protocol: 'http',
            public: true,
          }],
        },
      },
    }],
    defaultRuntime: 'dev',
    ui: {
      entrypoint: {
        portKey: 'http',
        path: '/',
      },
    },
  }, '$');

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.metadata?.sourceSchemaVersion, 'app.0.1');
  assert.equal(result.metadata?.selectedRuntime, 'dev');
  assert.equal(result.metadata?.containers[0]?.source.type, 'process');
  assert.equal(result.metadata?.containers[0]?.source.command, 'npm run dev');
  assert.equal(result.metadata?.containers[0]?.source.workingDirectory, '.');
});

test('rejects app.0.1 services missing a declared runtime profile', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: 'app.0.1',
    id: 'com.example.partial',
    name: 'Partial App',
    version: '0.1.0',
    runtimeProfiles: [
      {
        key: 'docker',
        type: 'docker',
      },
      {
        key: 'dev',
        type: 'localCommand',
      },
    ],
    defaultRuntime: 'docker',
    services: [{
      key: 'app',
      runtimes: {
        docker: {
          type: 'docker',
          image: 'ghcr.io/example/partial:0.1.0',
        },
      },
    }],
  }, '$');

  assert.equal(result.metadata, null);
  assert.equal(
    result.validationErrors.some(error => error.code === 'app_manifest_service_runtime_missing'),
    true
  );
});

test('rejects app.0.1 non-array collection fields during manifest adaptation', () => {
  const cases: Array<{ name: string; patch: Record<string, unknown>; code: string }> = [
    {
      name: 'endpoints',
      patch: {
        endpoints: {
          key: 'http',
        },
      },
      code: 'app_manifest_endpoints_invalid',
    },
    {
      name: 'settings',
      patch: {
        settings: {
          key: 'APP_URL',
        },
      },
      code: 'app_manifest_settings_invalid',
    },
    {
      name: 'connections',
      patch: {
        connections: {
          source: {
            type: 'endpoint',
            key: 'http',
          },
        },
      },
      code: 'app_manifest_connections_invalid',
    },
    {
      name: 'dependencies',
      patch: {
        dependencies: {
          id: 'com.example.cache',
        },
      },
      code: 'app_manifest_dependencies_invalid',
    },
    {
      name: 'data targets',
      patch: {
        data: {
          enabled: true,
          targets: {
            service: 'app',
          },
        },
      },
      code: 'app_manifest_data_targets_invalid',
    },
  ];

  for (const scenario of cases) {
    const result = validateAndNormalizeMetadata({
      ...createMinimalAppManifest(),
      ...scenario.patch,
    }, '$');

    assert.equal(result.metadata, null, scenario.name);
    assert.equal(
      result.validationErrors.some(error => error.code === scenario.code),
      true,
      scenario.name
    );
  }
});

test('does not infer a public endpoint for multi-service apps without explicit exposure', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: 'app.0.1',
    id: 'com.example.fullstack',
    name: 'Fullstack',
    version: '1.0.0',
    runtimeProfiles: [{
      key: 'docker',
      type: 'docker',
      default: true,
    }],
    services: [
      {
        key: 'api',
        runtimes: {
          docker: {
            type: 'docker',
            image: 'ghcr.io/example/fullstack-api:1.0.0',
            ports: [{
              key: 'http',
              containerPort: 8080,
              protocol: 'http',
            }],
          },
        },
      },
      {
        key: 'web',
        runtimes: {
          docker: {
            type: 'docker',
            image: 'ghcr.io/example/fullstack-web:1.0.0',
            ports: [{
              key: 'http',
              containerPort: 3000,
              protocol: 'http',
            }],
          },
        },
      },
    ],
    ui: {
      entrypoint: {
        endpoint: 'web-http',
        path: '/',
      },
    },
  }, '$');

  assert.equal(result.metadata, null);
  assert.equal(
    result.validationErrors.some(error => error.code === 'module_ui_port_not_public'),
    true
  );
});

test('uses default app data mapping when targets do not match selected runtime profile', () => {
  const result = validateAndNormalizeMetadata({
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
      {
        key: 'dev',
        type: 'localCommand',
      },
    ],
    services: [{
      key: 'app',
      runtimes: {
        docker: {
          type: 'docker',
          image: 'ghcr.io/example/notes:1.0.0',
          ports: [{
            key: 'http',
            containerPort: 3000,
            protocol: 'http',
          }],
        },
        dev: {
          type: 'localCommand',
          command: 'npm run dev',
          ports: [{
            key: 'http',
            containerPort: 3000,
            protocol: 'http',
          }],
        },
      },
    }],
    data: {
      enabled: true,
      targets: [{
        runtime: 'dev',
        service: 'app',
        containerPath: '/dev/data',
      }],
    },
  }, '$');

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.metadata?.storage.directories[0]?.targets[0]?.container, 'app');
  assert.equal(result.metadata?.storage.directories[0]?.targets[0]?.containerPath, '/app/data');
});

test('keeps legacy app.0.1 top-level runtimes as a single-service compatibility shape', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: 'app.0.1',
    id: 'com.example.legacy-notes',
    name: 'Legacy Notes',
    version: '1.2.3',
    runtimes: [{
      key: 'docker',
      type: 'docker',
      image: 'ghcr.io/example/legacy-notes:1.2.3',
      ports: [{
        key: 'http',
        containerPort: 3000,
        protocol: 'http',
        public: true,
      }],
    }],
    defaultRuntime: 'docker',
    ui: {
      entrypoint: '/',
    },
  }, '$');

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.metadata?.sourceSchemaVersion, 'app.0.1');
  assert.equal(result.metadata?.selectedRuntime, 'docker');
  assert.equal(result.metadata?.containers[0]?.key, 'docker');
  assert.equal(result.metadata?.containers[0]?.image.repository, 'ghcr.io/example/legacy-notes');
  assert.equal(result.metadata?.ui?.entrypoint.portKey, 'http');
});

test('buildModulePaths stores app manifests and data under apps layout', () => {
  const paths = buildModulePaths('com.example.notes', configFixture, {
    sourceSchemaVersion: 'app.0.1',
  });

  assert.equal(paths.moduleDirectoryHost, '/host/.hosty/apps/com.example.notes');
  assert.equal(paths.moduleDirectoryContainer, '/data/apps/com.example.notes');
  assert.equal(paths.metadataPathHost, '/host/.hosty/apps/com.example.notes/manifest.json');
  assert.equal(paths.metadataPathContainer, '/data/apps/com.example.notes/manifest.json');
});

function createMinimalAppManifest() {
  return {
    schemaVersion: 'app.0.1',
    id: 'com.example.notes',
    name: 'Notes',
    version: '1.0.0',
    runtimeProfiles: [{
      key: 'docker',
      type: 'docker',
      default: true,
    }],
    services: [{
      key: 'app',
      runtimes: {
        docker: {
          type: 'docker',
          image: 'ghcr.io/example/notes:1.0.0',
          ports: [{
            key: 'http',
            containerPort: 3000,
            protocol: 'http',
          }],
        },
      },
    }],
  };
}

const configFixture: HostRuntimeConfig = {
  dataRootHost: '/host/.hosty',
  dataRootContainer: '/data',
  dataRootMarkerPath: '/data/.owner',
  dataRootExpectedMarker: null,
  appsRootContainer: '/data/apps',
  appsStorePath: '/data/apps.json',
  modulesRootContainer: '/data/modules',
  modulesStorePath: '/data/modules.json',
  authRootContainer: '/data/auth',
  authStatePath: '/data/auth/state.json',
  authAuditPath: '/data/auth/audit.json',
  gatewayRootContainer: '/data/gateway',
  gatewayExposuresPath: '/data/gateway/exposures.json',
  gatewayBaseDomain: null,
  hostPublicOrigin: null,
  hostInternalOrigin: 'http://host.docker.internal:3000',
  dockerSocketPath: '/var/run/docker.sock',
  moduleNetwork: 'docker-host-modules',
};
