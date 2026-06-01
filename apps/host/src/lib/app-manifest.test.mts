import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeMetadata } from './module-metadata.ts';
import { buildModulePaths } from './module-install-plan.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('normalizes app.0.1 docker manifests through the legacy runtime adapter', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: 'app.0.1',
    id: 'com.example.notes',
    name: 'Notes',
    version: '1.2.3',
    runtimes: [{
      key: 'docker',
      type: 'docker',
      image: 'ghcr.io/example/notes:1.2.3',
      ports: [{
        key: 'http',
        containerPort: 3000,
        protocol: 'http',
      }],
    }],
    ui: {
      entrypoint: '/',
    },
    data: {
      enabled: true,
      targets: [{
        runtime: 'docker',
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
  assert.equal(result.metadata?.id, 'com.example.notes');
  assert.equal(result.metadata?.containers[0]?.image.reference, undefined);
  assert.equal(result.metadata?.containers[0]?.image.repository, 'ghcr.io/example/notes');
  assert.equal(result.metadata?.containers[0]?.image.tag, '1.2.3');
  assert.equal(result.metadata?.ui?.entrypoint.portKey, 'http');
  assert.equal(result.metadata?.storage.directories[0]?.mount.modulePath, 'data');
  assert.equal(result.metadata?.storage.directories[0]?.targets[0]?.containerPath, '/app/data');
  assert.equal(result.metadata?.dependencies[0]?.metadataUrl, 'https://apps.example.test/cache/manifest.json');
});

test('normalizes app.0.1 local command runtime profiles for future runtime planning', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: 'app.0.1',
    id: 'com.example.local',
    name: 'Local App',
    version: '0.1.0',
    runtimes: [{
      key: 'dev',
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
  assert.equal(result.metadata?.containers[0]?.source.type, 'process');
  assert.equal(result.metadata?.containers[0]?.source.command, 'npm run dev');
  assert.equal(result.metadata?.containers[0]?.source.workingDirectory, '.');
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
