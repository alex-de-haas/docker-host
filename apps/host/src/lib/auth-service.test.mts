import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authenticateCliToken,
  authenticatePassword,
  authenticateSessionToken,
  bootstrapFirstAdmin,
  createCliTokenForAdmin,
  createSetupToken,
  getAuthStatus,
  listCliTokens,
  revokeCliToken,
  revokeSession,
  rotateCliToken,
} from './auth-service.ts';
import { readAuthStateSnapshot } from './auth-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('bootstraps the first admin with a setup token and creates a session', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);

  const result = await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'Admin@Example.Test',
    displayName: 'Admin',
    password: 'correct horse battery staple',
  }, undefined, config);

  assert.equal(result.user.email, 'admin@example.test');
  assert.equal(result.user.role, 'host.admin');

  const status = await getAuthStatus(config);
  assert.equal(status.setupRequired, false);

  const principal = await authenticateSessionToken(result.sessionToken, undefined, config);
  assert.equal(principal?.email, 'admin@example.test');

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.users.length, 1);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.setupTokens[0]?.usedAt !== undefined, true);
});

test('rejects weak passwords before consuming a setup token', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);

  await assert.rejects(
    bootstrapFirstAdmin({
      setupToken: setup.token,
      email: 'admin@example.test',
      password: 'short',
    }, undefined, config),
    /Password must contain at least 12 characters/
  );

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.users.length, 0);
  assert.equal(state.setupTokens[0]?.usedAt, undefined);
});

test('authenticates and revokes password sessions', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);
  await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);

  const login = await authenticatePassword({
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);

  assert.equal(login.user.role, 'host.admin');
  assert.equal((await authenticateSessionToken(login.sessionToken, undefined, config))?.id, login.user.id);

  assert.equal(await revokeSession(login.sessionToken, undefined, config), true);
  assert.equal(await authenticateSessionToken(login.sessionToken, undefined, config), null);
});

test('creates, rotates, lists, and revokes CLI admin tokens', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);
  const admin = await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);

  const created = await createCliTokenForAdmin(admin.user.id, 'Laptop CLI', config);
  assert.equal(created.cliToken.label, 'Laptop CLI');
  assert.equal((await authenticateCliToken(created.token, undefined, config))?.id, admin.user.id);

  const storedAfterCreate = await readAuthStateSnapshot(config);
  assert.equal(JSON.stringify(storedAfterCreate).includes(created.token), false);
  assert.equal((await listCliTokens(config)).length, 1);

  const rotated = await rotateCliToken(created.tokenId, admin.user.id, 'Rotated CLI', config);
  assert.equal(rotated.cliToken.label, 'Rotated CLI');
  assert.equal(await authenticateCliToken(created.token, undefined, config), null);
  assert.equal((await authenticateCliToken(rotated.token, undefined, config))?.id, admin.user.id);

  const listedAfterRotate = await listCliTokens(config);
  assert.equal(listedAfterRotate.length, 2);
  assert.equal(listedAfterRotate.find(token => token.id === created.tokenId)?.revokedAt !== undefined, true);

  assert.equal(await revokeCliToken(rotated.tokenId, admin.user.id, config), true);
  assert.equal(await authenticateCliToken(rotated.token, undefined, config), null);
});

async function createTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-auth-'));
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
