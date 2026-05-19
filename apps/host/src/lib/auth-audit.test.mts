import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listAuthAuditEvents, purgeAuthAuditEvents } from './auth-audit.ts';
import { appendAuthAuditEvent } from './auth-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('lists audit events with filters, pagination, and malformed line counts', async () => {
  const config = await createTestConfig();

  await appendAuthAuditEvent({
    type: 'auth.login.succeeded',
    actorUserId: 'user_1',
    success: true,
    target: {
      type: 'auth.session',
      id: 'session_1',
    },
    details: {
      tokenId: 'cli_1',
      token: 'raw-token',
      nested: {
        password: 'raw-password',
      },
    },
  }, config);
  await fs.appendFile(config.authAuditPath, '{not valid json}\n', 'utf-8');
  await appendAuthAuditEvent({
    type: 'auth.login.failed',
    success: false,
    details: {
      reason: 'invalid_credentials',
    },
  }, config);

  const filtered = await listAuthAuditEvents({ success: false, limit: 1 }, config);
  assert.equal(filtered.events.length, 1);
  assert.equal(filtered.events[0]?.type, 'auth.login.failed');
  assert.equal(filtered.malformedLineCount, 1);

  const all = await listAuthAuditEvents({ limit: 1 }, config);
  assert.equal(all.events.length, 1);
  assert.equal(all.nextCursor, 1);
  assert.equal(all.events[0]?.details?.tokenId, 'cli_1');
  assert.equal(all.events[0]?.details?.token, '[redacted]');
  assert.deepEqual(all.events[0]?.details?.nested, { password: '[redacted]' });
});

test('purges audit events by retention and keeps purge marker', async () => {
  const config = await createTestConfig();
  await fs.mkdir(config.authRootContainer, { recursive: true });
  await fs.writeFile(config.authAuditPath, [
    JSON.stringify({
      id: 'evt_old',
      type: 'auth.login.failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      success: false,
    }),
    JSON.stringify({
      id: 'evt_recent',
      type: 'auth.login.succeeded',
      createdAt: new Date().toISOString(),
      success: true,
    }),
    '',
  ].join('\n'), 'utf-8');

  const result = await purgeAuthAuditEvents({ retentionDays: 30, actorUserId: 'user_admin' }, config);
  assert.equal(result.deletedCount, 1);

  const listed = await listAuthAuditEvents({}, config);
  assert.equal(listed.events.some(event => event.id === 'evt_old'), false);
  assert.equal(listed.events.some(event => event.id === 'evt_recent'), true);
  assert.equal(listed.events.some(event => event.type === 'auth.audit.purged'), true);
});

async function createTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-audit-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    gatewayRootContainer: path.join(dataRootContainer, 'gateway'),
    gatewayExposuresPath: path.join(dataRootContainer, 'gateway', 'exposures.json'),
    gatewayBaseDomain: null,
    hostPublicOrigin: null,
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}
