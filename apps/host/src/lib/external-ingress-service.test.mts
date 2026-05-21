import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ExternalIngressServiceError,
  listExternalIngressReadiness,
  refreshExternalIngressReadiness,
  upsertExternalIngressIntent,
} from './external-ingress-service.ts';
import { readExternalIngressStateSnapshot } from './external-ingress-store.ts';
import { writeGatewayExposureState } from './gateway-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { GatewayExposureRecord } from '../types/gateway.ts';

test('lists unmanaged gateway exposures with provider-neutral instructions', async () => {
  const config = await createIngressTestConfig();
  await seedGatewayExposure(config, { id: 'gw_reports' });

  const readiness = await listExternalIngressReadiness(config);

  assert.equal(readiness.length, 1);
  assert.equal(readiness[0].status, 'unmanaged');
  assert.equal(readiness[0].exposure.hostname, 'reports.example.test');
  assert.equal(readiness[0].instructions.some(item => item.title === 'DNS'), true);
  assert.match(readiness[0].nextStep, /manual ingress intent/);
});

test('saves manual intent and validates completed readiness checks', async () => {
  const config = await createIngressTestConfig();
  await seedGatewayExposure(config, { id: 'gw_reports' });

  const planned = await upsertExternalIngressIntent({
    gatewayExposureId: 'gw_reports',
    checklist: {
      dnsConfigured: true,
      reverseProxyConfigured: true,
      tlsConfigured: true,
      websocketForwarding: true,
    },
    markReady: true,
  }, 'user_admin', config);

  assert.equal(planned.status, 'manualReady');

  const refreshed = await refreshExternalIngressReadiness('gw_reports', 'user_admin', config);
  assert.equal(refreshed.status, 'validated');
  assert.equal(refreshed.validation?.checks.every(check => check.status === 'pass'), true);

  const state = await readExternalIngressStateSnapshot(config);
  assert.equal(state.records[0].status, 'validated');
  assert.equal(state.records[0].lastValidation?.status, 'validated');
});

test('marks ingress readiness drifted when gateway exposure changes after manual setup', async () => {
  const config = await createIngressTestConfig();
  await seedGatewayExposure(config, { id: 'gw_reports', exposurePolicy: 'loginRequired' });
  await upsertExternalIngressIntent({
    gatewayExposureId: 'gw_reports',
    checklist: {
      dnsConfigured: true,
      reverseProxyConfigured: true,
      tlsConfigured: true,
      websocketForwarding: true,
    },
    markReady: true,
  }, 'user_admin', config);

  await seedGatewayExposure(config, {
    id: 'gw_reports',
    exposurePolicy: 'assignedUsersOnly',
  });

  const refreshed = await refreshExternalIngressReadiness('gw_reports', 'user_admin', config);

  assert.equal(refreshed.status, 'drifted');
  assert.deepEqual(refreshed.validation?.drift, ['exposurePolicy']);
});

test('rejects manual ingress intent without a gateway base domain', async () => {
  const config = await createIngressTestConfig({ gatewayBaseDomain: null });
  await seedGatewayExposure(config, { id: 'gw_reports' });

  await assert.rejects(
    upsertExternalIngressIntent({ gatewayExposureId: 'gw_reports' }, 'user_admin', config),
    (error: unknown) =>
      error instanceof ExternalIngressServiceError &&
      error.code === 'gateway_base_domain_required'
  );
});

async function createIngressTestConfig(input: {
  gatewayBaseDomain?: string | null;
  hostPublicOrigin?: string | null;
} = {}): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-ingress-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');
  const ingressRootContainer = path.join(dataRootContainer, 'ingress');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    gatewayRootContainer,
    gatewayExposuresPath: path.join(gatewayRootContainer, 'exposures.json'),
    ingressRootContainer,
    ingressStatePath: path.join(ingressRootContainer, 'external-ingress.json'),
    gatewayBaseDomain: input.gatewayBaseDomain === undefined ? 'example.test' : input.gatewayBaseDomain,
    hostPublicOrigin: input.hostPublicOrigin === undefined ? 'https://host.example.test' : input.hostPublicOrigin,
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}

async function seedGatewayExposure(
  config: HostRuntimeConfig,
  input: {
    id: string;
    exposurePolicy?: GatewayExposureRecord['exposurePolicy'];
  }
) {
  const now = new Date().toISOString();
  await writeGatewayExposureState({
    schemaVersion: '0.2',
    exposures: [
      {
        id: input.id,
        moduleId: 'com.example.reports',
        hostname: 'reports.example.test',
        endpointKey: 'web',
        exposurePolicy: input.exposurePolicy ?? 'loginRequired',
        identityMode: 'required',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  }, config);
}
