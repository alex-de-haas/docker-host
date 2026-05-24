import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlanContainers } from './module-install-plan.ts';
import type { NormalizedModuleMetadata } from '../types/modules.ts';

test('buildPlanContainers assigns host ports only to public endpoints', () => {
  let nextPort = 3100;
  const containers = buildPlanContainers('com.example.reports', metadataFixture, {
    allocate: () => nextPort++,
  });

  assert.deepEqual(containers[0].ports, [
    {
      key: 'http',
      containerPort: 3000,
      protocol: 'http',
      hostPublished: true,
      hostPort: 3100,
      endpointKey: 'web',
      localOrigin: 'http://localhost:3100',
      publicOrigin: null,
    },
    {
      key: 'admin',
      containerPort: 3001,
      protocol: 'http',
      hostPublished: false,
    },
  ]);
});

const metadataFixture: NormalizedModuleMetadata = {
  schemaVersion: '0.2',
  id: 'com.example.reports',
  name: 'Reports',
  version: '1.0.0',
  containers: [
    {
      key: 'app',
      dependsOn: [],
      image: {
        repository: 'ghcr.io/example/reports',
        tag: 'latest',
        pullPolicy: 'ifNotPresent',
      },
      runtime: {
        ports: [
          {
            key: 'http',
            containerPort: 3000,
            protocol: 'http',
          },
          {
            key: 'admin',
            containerPort: 3001,
            protocol: 'http',
          },
        ],
      },
    },
  ],
  endpoints: [
    {
      key: 'web',
      container: 'app',
      port: 'http',
      public: true,
    },
  ],
  connections: [],
  dependencies: [],
  settings: [],
  storage: {
    directories: [],
    mountCollections: [],
  },
};
