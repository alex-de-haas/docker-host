import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeMetadata } from './module-metadata.ts';

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
