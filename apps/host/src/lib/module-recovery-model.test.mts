import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  findDependentModules,
  getResolvedDependencies,
  getStoredExternalMounts,
  getStoredStorageMappings,
  resolveContainerDataPath,
} from './module-recovery-model.ts';
import type { ModulesStoreData } from '../types/modules.ts';

test('findDependentModules uses stored resolved dependency state', () => {
  const store: ModulesStoreData = {
    schemaVersion: '0.2',
    hostSettings: {},
    updatedAt: '2026-05-15T00:00:00.000Z',
    modules: [
      {
        id: 'com.example.identity',
        metadataUrl: 'https://example.test/identity.json',
        operationStatus: 'installed',
        containers: [
          {
            key: 'app',
            containerName: 'mod-com-example-identity-app',
            networkAlias: 'mod-com-example-identity-app',
            image: {
              repository: 'ghcr.io/example/identity',
              tag: '1.0.0',
              reference: 'ghcr.io/example/identity:1.0.0',
            },
          },
        ],
      },
      {
        id: 'com.example.reports',
        metadataUrl: 'https://example.test/reports.json',
        operationStatus: 'installed',
        containers: [
          {
            key: 'app',
            containerName: 'mod-com-example-reports-app',
            networkAlias: 'mod-com-example-reports-app',
            image: {
              repository: 'ghcr.io/example/reports',
              tag: '1.0.0',
              reference: 'ghcr.io/example/reports:1.0.0',
            },
          },
        ],
        resolvedDependencies: [
          {
            id: 'com.example.identity',
            endpoint: 'http',
            targets: [
              {
                container: 'app',
                type: 'env',
                name: 'IDENTITY_BASE_URL',
              },
            ],
            resolvedBaseUrl: 'http://mod-com-example-identity:8080',
          },
        ],
      },
    ],
  };

  assert.deepEqual(findDependentModules('com.example.identity', store), [
    { id: 'com.example.reports' },
  ]);
  assert.deepEqual(findDependentModules('com.example.reports', store), []);
});

test('stored mappings normalize object and array forms', () => {
  const arrayModule = {
    id: 'com.example.array',
    metadataUrl: 'https://example.test/array.json',
    storageMappings: [
      {
        key: 'data',
        hostPath: '/host/data',
        containerPath: '/app/data',
      },
    ],
    externalMounts: [
      {
        collectionKey: 'libraries',
        key: 'main',
        hostPath: '/media/main',
        containerPath: '/storage/libraries/main',
        access: 'readWrite' as const,
        readOnly: false,
      },
    ],
    resolvedDependencies: [
      {
        id: 'com.example.identity',
      },
    ],
  };
  const objectModule = {
    id: 'com.example.object',
    metadataUrl: 'https://example.test/object.json',
    storageMappings: {
      cache: {
        key: 'cache',
        hostPath: '/host/cache',
        containerPath: '/app/cache',
      },
    },
    externalMounts: {
      libraries: [
        {
          collectionKey: 'libraries',
          key: 'archive',
          hostPath: '/media/archive',
          containerPath: '/storage/libraries/archive',
          access: 'readOnly' as const,
          readOnly: true,
        },
      ],
    },
    resolvedDependencies: {
      identity: {
        id: 'com.example.identity',
      },
    },
  };

  assert.equal(getStoredStorageMappings(arrayModule).length, 1);
  assert.equal(getStoredStorageMappings(objectModule).length, 1);
  assert.equal(getStoredExternalMounts(arrayModule).length, 1);
  assert.equal(getStoredExternalMounts(objectModule).length, 1);
  assert.deepEqual(getResolvedDependencies(arrayModule), [{ id: 'com.example.identity' }]);
  assert.deepEqual(getResolvedDependencies(objectModule), [{ id: 'com.example.identity' }]);
});

test('resolveContainerDataPath maps only paths inside the Host data root', () => {
  const config = {
    dataRootHost: '/Users/example/.docker-host',
    dataRootContainer: '/data',
    modulesRootContainer: '/data/modules',
    modulesStorePath: '/data/modules.json',
    authRootContainer: '/data/auth',
    authStatePath: '/data/auth/state.json',
    authAuditPath: '/data/auth/audit.ndjson',
    gatewayRootContainer: '/data/gateway',
    gatewayExposuresPath: '/data/gateway/exposures.json',
    gatewayBaseDomain: null,
    hostPublicOrigin: null,
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };

  assert.equal(
    resolveContainerDataPath('/Users/example/.docker-host/modules/com.example/data', config),
    path.join('/data', 'modules', 'com.example', 'data')
  );
  assert.equal(resolveContainerDataPath('/mnt/media', config), null);
});
