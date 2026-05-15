import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModuleInstallRequest,
  computeExternalMountContainerPath,
  getSettingFieldName,
  isSafeExternalMountKey,
  redactModuleInstallRequest,
  validateExternalMountDrafts,
} from './module-install-request.ts';
import type { InstallPlan } from '../types/modules.ts';

test('external mount keys are safe path segments', () => {
  assert.equal(isSafeExternalMountKey('main-media'), true);
  assert.equal(isSafeExternalMountKey('archive_2026'), true);
  assert.equal(isSafeExternalMountKey('../media'), false);
  assert.equal(isSafeExternalMountKey('Media'), false);
  assert.equal(isSafeExternalMountKey(''), false);
});

test('external mount validation computes selections from declared collections', () => {
  const result = validateExternalMountDrafts(planFixture, [
    {
      id: 'row-1',
      moduleId: 'com.example.reports',
      collectionKey: 'libraries',
      key: 'main-media',
      label: 'Main media disk',
      hostPath: '/mnt/media',
      access: 'readWrite',
    },
  ]);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.selections, [
    {
      moduleId: 'com.example.reports',
      collectionKey: 'libraries',
      key: 'main-media',
      label: 'Main media disk',
      hostPath: '/mnt/media',
      containerPath: '/storage/libraries/main-media',
      access: 'readWrite',
    },
  ]);
});

test('required external mount collections enforce minimum item count', () => {
  const result = validateExternalMountDrafts(planFixture, []);

  assert.equal(result.selections.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /At least 1 item required/);
});

test('install request coerces settings and redacts secret preview', () => {
  const formData = new FormData();
  formData.set(getSettingFieldName(planFixture.settings[0]), '45');
  formData.set(getSettingFieldName(planFixture.settings[1]), 'true');
  formData.set(getSettingFieldName(planFixture.settings[2]), 'super-secret');

  const request = buildModuleInstallRequest(planFixture, formData, []);
  const redacted = redactModuleInstallRequest(request);

  assert.deepEqual(request.settings, [
    {
      moduleId: 'com.example.reports',
      key: 'REPORT_RETENTION_DAYS',
      value: 45,
      secret: false,
    },
    {
      moduleId: 'com.example.reports',
      key: 'REPORTS_ENABLED',
      value: true,
      secret: false,
    },
    {
      moduleId: 'com.example.reports',
      key: 'EXTERNAL_API_TOKEN',
      value: 'super-secret',
      secret: true,
    },
  ]);
  assert.equal(redacted.settings[2].value, '<redacted>');
});

test('container path is empty until mount key is safe', () => {
  const collection = planFixture.storage.mountCollections[0];

  assert.equal(computeExternalMountContainerPath(collection, '../bad'), '');
  assert.equal(
    computeExternalMountContainerPath(collection, 'archive'),
    '/storage/libraries/archive'
  );
});

const planFixture: InstallPlan = {
  metadataUrl: 'https://modules.example.test/reports.json',
  metadataDigest: 'sha256:metadata',
  planDigest: 'sha256:plan',
  module: {
    id: 'com.example.reports',
    name: 'Reports',
    version: '1.0.0',
  },
  normalizedMetadata: {
    schemaVersion: '0.1',
    id: 'com.example.reports',
    name: 'Reports',
    version: '1.0.0',
    image: {
      repository: 'ghcr.io/example/reports',
      tag: '1.0.0',
      pullPolicy: 'ifNotPresent',
    },
    dependencies: [],
    settings: [],
    storage: {
      directories: [],
      mountCollections: [],
    },
    runtime: {
      ports: [],
    },
  },
  dependencies: [],
  installOrder: ['com.example.reports'],
  images: [],
  settings: [
    {
      moduleId: 'com.example.reports',
      key: 'REPORT_RETENTION_DAYS',
      type: 'number',
      required: true,
      default: 30,
      target: {
        type: 'env',
        name: 'REPORT_RETENTION_DAYS',
      },
      secret: false,
      redacted: false,
    },
    {
      moduleId: 'com.example.reports',
      key: 'REPORTS_ENABLED',
      type: 'boolean',
      required: true,
      default: true,
      target: {
        type: 'env',
        name: 'REPORTS_ENABLED',
      },
      secret: false,
      redacted: false,
    },
    {
      moduleId: 'com.example.reports',
      key: 'EXTERNAL_API_TOKEN',
      type: 'secret',
      required: true,
      target: {
        type: 'env',
        name: 'EXTERNAL_API_TOKEN',
      },
      secret: true,
      redacted: true,
    },
  ],
  storage: {
    directories: [],
    mountCollections: [
      {
        moduleId: 'com.example.reports',
        key: 'libraries',
        label: 'Libraries',
        required: true,
        minItems: 1,
        maxItems: 2,
        writable: true,
        containerPathPrefix: '/storage/libraries',
        itemContainerPathTemplate: '/storage/libraries/{key}',
        hostPathPolicy: {
          mode: 'adminSelected',
          allowExternal: true,
        },
      },
    ],
  },
  runtime: {
    ports: [],
  },
  paths: {
    moduleDirectoryHost: '/Users/example/.docker-host/modules/com.example.reports',
    moduleDirectoryContainer: '/data/modules/com.example.reports',
    metadataPathHost: '/Users/example/.docker-host/modules/com.example.reports/metadata.json',
    metadataPathContainer: '/data/modules/com.example.reports/metadata.json',
  },
  docker: {
    networkName: 'docker-host-modules',
    containerName: 'mod-com-example-reports',
    networkAliases: ['mod-com-example-reports'],
  },
  conflicts: [],
};
