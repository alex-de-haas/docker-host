import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeMetadata } from './module-metadata.ts';

test('accepts shell UI metadata with entrypoint and navigation', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: '0.1',
    id: 'com.example.reports',
    name: 'Example Reports',
    version: '1.0.0',
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
          public: true,
        },
      ],
    },
    ui: {
      category: 'Apps',
      icon: 'boxes',
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
  }, '$');

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.metadata?.ui?.entrypoint.portKey, 'http');
  assert.deepEqual(result.metadata?.ui?.navigation, [
    {
      label: 'People',
      path: '/people',
    },
  ]);
});

test('rejects shell UI metadata that points at a non-public runtime port', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: '0.1',
    id: 'com.example.identity',
    name: 'Example Identity',
    version: '1.0.0',
    image: {
      repository: 'ghcr.io/example/identity',
      tag: 'latest',
    },
    runtime: {
      ports: [
        {
          key: 'http',
          containerPort: 3000,
          protocol: 'http',
          public: false,
        },
      ],
    },
    ui: {
      entrypoint: {
        portKey: 'http',
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

test('rejects shell UI paths that are not same-origin absolute paths', () => {
  const result = validateAndNormalizeMetadata({
    schemaVersion: '0.1',
    id: 'com.example.reports',
    name: 'Example Reports',
    version: '1.0.0',
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
          public: true,
        },
      ],
    },
    ui: {
      entrypoint: {
        portKey: 'http',
        path: 'https://reports.example.test',
      },
    },
  }, '$');

  assert.equal(result.metadata, null);
  assert.equal(
    result.validationErrors.some(error => error.code === 'module_ui_path_invalid'),
    true
  );
});
