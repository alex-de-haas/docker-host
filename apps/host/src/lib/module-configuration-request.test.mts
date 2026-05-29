import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModuleConfigurationRequest,
  getConfigurationSettingFieldName,
  redactModuleConfigurationRequest,
} from './module-configuration-request.ts';
import {
  getEndpointHostPortFieldName,
  getEndpointOriginFieldName,
} from './module-install-request.ts';
import type { ModuleConfigurationPlan } from '../types/modules.ts';

test('configuration request preserves stored secret when left blank', () => {
  const formData = new FormData();
  formData.set(getConfigurationSettingFieldName(planFixture.settings[0]), '60');
  formData.set(getConfigurationSettingFieldName(planFixture.settings[1]), '');

  const request = buildModuleConfigurationRequest(planFixture, formData, []);

  assert.deepEqual(request.settings, [
    {
      moduleId: 'com.example.reports',
      key: 'REPORT_RETENTION_DAYS',
      value: 60,
      secret: false,
    },
  ]);
});

test('configuration request preserves empty optional number and boolean values', () => {
  const plan: ModuleConfigurationPlan = {
    ...planFixture,
    settings: [
      ...planFixture.settings,
      {
        moduleId: 'com.example.reports',
        key: 'OPTIONAL_RETENTION_DAYS',
        type: 'number',
        required: false,
        targets: [{ container: 'app', type: 'env', name: 'OPTIONAL_RETENTION_DAYS' }],
        secret: false,
        redacted: false,
        valueSet: true,
      },
      {
        moduleId: 'com.example.reports',
        key: 'ENABLE_EXPORTS',
        type: 'boolean',
        required: false,
        targets: [{ container: 'app', type: 'env', name: 'ENABLE_EXPORTS' }],
        secret: false,
        redacted: false,
        valueSet: true,
      },
    ],
  };
  const formData = new FormData();
  formData.set(getConfigurationSettingFieldName(plan.settings[2]), '');
  formData.set(getConfigurationSettingFieldName(plan.settings[3]), '');

  const request = buildModuleConfigurationRequest(plan, formData, []);

  assert.deepEqual(request.settings, [
    {
      moduleId: 'com.example.reports',
      key: 'OPTIONAL_RETENTION_DAYS',
      value: '',
      secret: false,
    },
    {
      moduleId: 'com.example.reports',
      key: 'ENABLE_EXPORTS',
      value: '',
      secret: false,
    },
  ]);
});

test('configuration request carries endpoint origin edits and redacts secret preview', () => {
  const formData = new FormData();
  formData.set(getConfigurationSettingFieldName(planFixture.settings[1]), 'new-secret');
  formData.set(getEndpointHostPortFieldName(planFixture.runtime.endpointOrigins[0]), '3201');
  formData.set(getEndpointOriginFieldName(planFixture.runtime.endpointOrigins[0]), 'https://reports.example.com');

  const request = buildModuleConfigurationRequest(planFixture, formData, []);
  const redacted = redactModuleConfigurationRequest(request);

  assert.deepEqual(request.endpointOrigins, [
    {
      moduleId: 'com.example.reports',
      endpoint: 'web',
      hostPort: 3201,
      publicOrigin: 'https://reports.example.com',
    },
  ]);
  assert.equal(redacted.settings[0].value, '<redacted>');
});

const planFixture: ModuleConfigurationPlan = {
  moduleId: 'com.example.reports',
  moduleName: 'Reports',
  moduleVersion: '1.0.0',
  metadataUrl: 'https://modules.example.test/reports.json',
  configurationDigest: 'sha256:configuration',
  settings: [
    {
      moduleId: 'com.example.reports',
      key: 'REPORT_RETENTION_DAYS',
      type: 'number',
      required: true,
      default: 30,
      targets: [{ container: 'app', type: 'env', name: 'REPORT_RETENTION_DAYS' }],
      secret: false,
      redacted: false,
      valueSet: true,
    },
    {
      moduleId: 'com.example.reports',
      key: 'EXTERNAL_API_TOKEN',
      type: 'secret',
      required: true,
      targets: [{ container: 'app', type: 'env', name: 'EXTERNAL_API_TOKEN' }],
      secret: true,
      redacted: true,
      valueSet: true,
    },
  ],
  runtime: {
    endpoints: [],
    endpointOrigins: [
      {
        moduleId: 'com.example.reports',
        endpoint: 'web',
        container: 'app',
        portKey: 'http',
        containerPort: 3000,
        hostPort: 3100,
        protocol: 'http',
        localOrigin: 'http://localhost:3100',
        publicOrigin: null,
        requiredForUi: true,
      },
    ],
  },
  storage: {
    mountCollections: [],
    externalMounts: [],
  },
  conflicts: [],
  warnings: [],
};
