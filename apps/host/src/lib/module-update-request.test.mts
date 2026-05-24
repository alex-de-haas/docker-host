import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModuleUpdateRequest,
  getUpdateSettingFieldName,
  redactModuleUpdateRequest,
} from './module-update-request.ts';
import type { ModuleUpdatePlan } from '../types/modules.ts';

test('update request carries reviewed digest and coerces setting values', () => {
  const formData = new FormData();
  formData.set(getUpdateSettingFieldName(planFixture.settings[0]), '45');
  formData.set(getUpdateSettingFieldName(planFixture.settings[1]), 'true');
  formData.set(getUpdateSettingFieldName(planFixture.settings[2]), 'super-secret');

  const request = buildModuleUpdateRequest(planFixture, formData, []);
  const redacted = redactModuleUpdateRequest(request);

  assert.equal(request.updatePlanDigest, 'sha256:update-plan');
  assert.equal(request.confirmed, true);
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

const planFixture: ModuleUpdatePlan = {
  moduleId: 'com.example.reports',
  metadataUrl: 'https://modules.example.test/reports.json',
  currentMetadataDigest: 'sha256:old',
  refreshedMetadataDigest: 'sha256:new',
  updatePlanDigest: 'sha256:update-plan',
  module: {
    id: 'com.example.reports',
    currentName: 'Reports',
    proposedName: 'Reports',
    currentVersion: '1.0.0',
    proposedVersion: '1.1.0',
  },
  normalizedMetadata: {
    schemaVersion: '0.2',
    id: 'com.example.reports',
    name: 'Reports',
    version: '1.1.0',
    containers: [
      {
        key: 'app',
        dependsOn: [],
        image: {
          repository: 'ghcr.io/example/reports',
          tag: '1.1.0',
          pullPolicy: 'ifNotPresent',
        },
        runtime: {
          ports: [],
        },
      },
    ],
    endpoints: [],
    connections: [],
    dependencies: [],
    settings: [],
    storage: {
      directories: [],
      mountCollections: [],
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
      targets: [
        {
          container: 'app',
          type: 'env',
          name: 'REPORT_RETENTION_DAYS',
        },
      ],
      secret: false,
      redacted: false,
    },
    {
      moduleId: 'com.example.reports',
      key: 'REPORTS_ENABLED',
      type: 'boolean',
      required: true,
      default: true,
      targets: [
        {
          container: 'app',
          type: 'env',
          name: 'REPORTS_ENABLED',
        },
      ],
      secret: false,
      redacted: false,
    },
    {
      moduleId: 'com.example.reports',
      key: 'EXTERNAL_API_TOKEN',
      type: 'secret',
      required: true,
      targets: [
        {
          container: 'app',
          type: 'env',
          name: 'EXTERNAL_API_TOKEN',
        },
      ],
      secret: true,
      redacted: true,
    },
  ],
  preservedSettings: [],
  storage: {
    directories: [],
    mountCollections: [],
    preservedExternalMounts: [],
    removedExternalMounts: [],
  },
  runtime: {
    endpoints: [],
    endpointOrigins: [],
  },
  paths: {
    moduleDirectoryHost: '/Users/example/.docker-host/modules/com.example.reports',
    moduleDirectoryContainer: '/data/modules/com.example.reports',
    metadataPathHost: '/Users/example/.docker-host/modules/com.example.reports/metadata.json',
    metadataPathContainer: '/data/modules/com.example.reports/metadata.json',
  },
  docker: {
    networkName: 'docker-host-modules',
    containers: [
      {
        moduleId: 'com.example.reports',
        key: 'app',
        containerName: 'mod-com-example-reports-app',
        networkAlias: 'mod-com-example-reports-app',
        image: {
          moduleId: 'com.example.reports',
          container: 'app',
          repository: 'ghcr.io/example/reports',
          tag: '1.1.0',
          reference: 'ghcr.io/example/reports:1.1.0',
          pullPolicy: 'ifNotPresent',
        },
        dependsOn: [],
        ports: [],
        endpoints: [],
      },
    ],
    replacementRequired: true,
    replacementReasons: ['image'],
  },
  changes: [],
  warnings: [],
  conflicts: [],
};
