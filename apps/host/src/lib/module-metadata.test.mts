import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAndNormalizeMetadata } from './module-metadata.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('accepts shell UI metadata with entrypoint and navigation', () => {
  const result = validateAndNormalizeMetadata(createMetadata({
    ui: {
      category: 'Apps',
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
  }), '$');

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.metadata?.ui?.entrypoint.portKey, 'web');
  assert.deepEqual(result.metadata?.ui?.navigation, [
    {
      label: 'People',
      path: '/people',
    },
  ]);
});

test('rejects shell UI metadata that points at a non-public endpoint', () => {
  const result = validateAndNormalizeMetadata(createMetadata({
    id: 'com.example.identity',
    name: 'Example Identity',
    endpointPublic: false,
    ui: {
      entrypoint: {
        portKey: 'web',
        path: '/',
      },
    },
  }), '$');

  assert.equal(result.metadata, null);
  assert.equal(
    result.validationErrors.some(error => error.code === 'module_ui_port_not_public'),
    true
  );
});

test('rejects shell UI paths that are not same-origin absolute paths', () => {
  const result = validateAndNormalizeMetadata(createMetadata({
    ui: {
      entrypoint: {
        portKey: 'web',
        path: 'https://reports.example.test',
      },
    },
  }), '$');

  assert.equal(result.metadata, null);
  assert.equal(
    result.validationErrors.some(error => error.code === 'module_ui_path_invalid'),
    true
  );
});

test('rejects duplicate shell UI navigation paths', () => {
  const result = validateAndNormalizeMetadata(createMetadata({
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
  }), '$');

  assert.equal(result.metadata, null);
  assert.equal(
    result.validationErrors.some(error => error.code === 'module_ui_navigation_duplicate_path'),
    true
  );
});

test('rejects empty optional shell UI category and icon values', () => {
  const result = validateAndNormalizeMetadata(createMetadata({
    ui: {
      category: '',
      icon: ' ',
      entrypoint: {
        portKey: 'web',
        path: '/',
      },
    },
  }), '$');

  assert.equal(result.metadata, null);
  assert.equal(
    result.validationErrors.some(error => error.code === 'module_ui_category_invalid'),
    true
  );
  assert.equal(
    result.validationErrors.some(error => error.code === 'module_ui_icon_invalid'),
    true
  );
});

test('accepts schema 0.3 service metadata with process source and health check', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: '0.3',
    id: 'com.example.dev-reports',
    name: 'Example Dev Reports',
    version: '1.0.0',
    services: [
      {
        key: 'app',
        source: {
          type: 'process',
          command: 'npm run dev',
          workingDirectory: '.',
          environment: {
            NODE_ENV: 'development',
          },
        },
        runtime: {
          ports: [
            {
              key: 'http',
              containerPort: 3000,
              localPort: 3100,
              protocol: 'http',
            },
          ],
        },
        healthCheck: {
          type: 'http',
          path: '/api/health',
          intervalSeconds: 10,
          timeoutSeconds: 2,
          successStatus: [200, 204, 200],
        },
      },
    ],
    endpoints: [
      {
        key: 'web',
        service: 'app',
        port: 'http',
        public: true,
      },
    ],
  }, '$');

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.metadata?.schemaVersion, '0.3');
  assert.equal(result.metadata?.services[0]?.source.type, 'process');
  assert.equal(result.metadata?.services[0]?.source.command, 'npm run dev');
  assert.equal(result.metadata?.services[0]?.runtime.ports[0]?.localPort, 3100);
  assert.deepEqual(result.metadata?.services[0]?.healthCheck?.successStatus, [200, 204]);
  assert.equal(result.metadata?.endpoints[0]?.container, 'app');
  assert.equal(result.metadata?.endpoints[0]?.service, 'app');
});

test('accepts demo module production and dev metadata as two-service fixtures', () => {
  for (const fileName of ['metadata.json', 'metadata.dev.json']) {
    const result = validateAndNormalizeMetadata(
      JSON.parse(readFileSync(path.join(repoRoot, 'modules/demo-module', fileName), 'utf8')),
      '$'
    );

    assert.deepEqual(result.validationErrors, []);
    assert.deepEqual(result.metadata?.services.map(service => service.key), ['backend', 'frontend']);
    assert.deepEqual(result.metadata?.endpoints.map(endpoint => endpoint.key), ['api', 'http']);
    assert.equal(result.metadata?.ui?.entrypoint.portKey, 'http');
    assert.equal(result.metadata?.connections[0]?.source.key, 'api');
    assert.equal(result.metadata?.connections[0]?.targets[0]?.container, 'frontend');
  }
});

function createMetadata(input: {
  id?: string;
  name?: string;
  endpointPublic?: boolean;
  ui: unknown;
}) {
  return {
    schemaVersion: '0.2',
    id: input.id ?? 'com.example.reports',
    name: input.name ?? 'Example Reports',
    version: '1.0.0',
    containers: [
      {
        key: 'app',
        image: {
          repository: 'ghcr.io/example/reports',
          tag: 'latest',
        },
        runtime: {
          ports: [
            {
              key: 'http',
              containerPort: 3000,
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
        public: input.endpointPublic ?? true,
      },
    ],
    ui: input.ui,
  };
}
