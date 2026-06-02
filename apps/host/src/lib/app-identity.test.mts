import assert from 'node:assert/strict';
import test from 'node:test';
import { getInstalledUiEndpointKey } from './app-identity.ts';

test('resolves installed identity endpoint from app.0.1 UI manifests', () => {
  const manifest = {
    schemaVersion: 'app.0.1',
    id: 'com.example.project-manager',
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
        key: 'app',
        runtimes: {
          docker: {
            type: 'docker',
            image: {
              repository: 'ghcr.io/example/project-manager',
              tag: 'latest',
            },
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
        key: 'http',
        service: 'app',
        port: 'http',
        public: true,
      },
    ],
    ui: {
      entrypoint: {
        endpoint: 'http',
        path: '/',
      },
    },
  };

  assert.equal(getInstalledUiEndpointKey(manifest as never), 'http');
});

test('keeps legacy metadata UI portKey support for identity endpoints', () => {
  const metadata = {
    schemaVersion: '0.3',
    id: 'com.example.reports',
    name: 'Reports',
    version: '1.0.0',
    containers: [],
    ui: {
      entrypoint: {
        portKey: 'web',
        path: '/',
      },
      navigation: [],
    },
  };

  assert.equal(getInstalledUiEndpointKey(metadata as never), 'web');
});
