import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  addUserToBrowserAccountSet,
  addUsersToBrowserAccountSet,
  authenticateCliToken,
  authenticatePassword,
  authenticateSessionToken,
  bootstrapFirstAdmin,
  clearBrowserAccountSet,
  createCliTokenForAdmin,
  createDevAdminSession,
  createDevSession,
  createSetupToken,
  getAuthStatus,
  hasRecentSessionReauthentication,
  isDevAuthAutoLoginEnabled,
  isDevAuthBrowserAccountSeedEnabled,
  listAuthSessions,
  listBrowserAccounts,
  listCliTokens,
  prepareDevBrowserAccountUsers,
  reauthenticateSession,
  recoverHostAdmin,
  removeBrowserAccount,
  revokeCliToken,
  revokeSession,
  revokeSessionById,
  rotateCliToken,
  switchBrowserAccount,
} from './auth-service.ts';
import { listAuthAuditEvents } from './auth-audit.ts';
import { readAuthStateSnapshot, writeAuthState } from './auth-store.ts';
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

test('development auto-login creates a normal admin session only when enabled', async t => {
  const config = await createTestConfig();
  const previousDevAuth = process.env.HOST_DEV_AUTH;
  const previousDevAuthRole = process.env.HOST_DEV_AUTH_ROLE;
  const previousRuntimeMode = process.env.HOST_RUNTIME_MODE;
  t.after(() => {
    restoreEnv('HOST_DEV_AUTH', previousDevAuth);
    restoreEnv('HOST_DEV_AUTH_ROLE', previousDevAuthRole);
    restoreEnv('HOST_RUNTIME_MODE', previousRuntimeMode);
  });

  delete process.env.HOST_DEV_AUTH;
  delete process.env.HOST_DEV_AUTH_ROLE;
  process.env.HOST_RUNTIME_MODE = 'development';
  assert.equal(isDevAuthAutoLoginEnabled(), false);
  await assert.rejects(
    createDevAdminSession(undefined, config),
    /Development auto-login is not enabled/
  );

  process.env.HOST_DEV_AUTH = 'auto';
  process.env.HOST_RUNTIME_MODE = 'production';
  assert.equal(isDevAuthAutoLoginEnabled(), false);

  process.env.HOST_RUNTIME_MODE = 'development';
  assert.equal(isDevAuthAutoLoginEnabled(), true);

  const result = await createDevAdminSession({ userAgent: 'Dev Browser' }, config);

  assert.equal(result.user.email, 'admin@docker-host.local');
  assert.equal(result.user.displayName, 'Dev Admin');
  assert.equal(result.user.role, 'host.admin');
  assert.equal((await authenticateSessionToken(result.sessionToken, undefined, config))?.id, result.user.id);
  assert.equal((await getAuthStatus(config)).setupRequired, false);

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.users.length, 1);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.setupTokens.length, 0);
  assert.equal(JSON.stringify(state).includes('docker-host-dev-admin'), false);
});

test('development auto-login can create a normal user session with a seeded admin', async t => {
  const config = await createTestConfig();
  const previousDevAuth = process.env.HOST_DEV_AUTH;
  const previousDevAuthRole = process.env.HOST_DEV_AUTH_ROLE;
  const previousRuntimeMode = process.env.HOST_RUNTIME_MODE;
  t.after(() => {
    restoreEnv('HOST_DEV_AUTH', previousDevAuth);
    restoreEnv('HOST_DEV_AUTH_ROLE', previousDevAuthRole);
    restoreEnv('HOST_RUNTIME_MODE', previousRuntimeMode);
  });

  process.env.HOST_DEV_AUTH = 'auto';
  process.env.HOST_DEV_AUTH_ROLE = 'user';
  process.env.HOST_RUNTIME_MODE = 'development';

  const result = await createDevSession({ userAgent: 'Dev Browser' }, config);

  assert.equal(result.user.email, 'user@docker-host.local');
  assert.equal(result.user.displayName, 'Dev User');
  assert.equal(result.user.role, 'host.user');
  assert.equal((await authenticateSessionToken(result.sessionToken, undefined, config))?.id, result.user.id);
  assert.equal((await getAuthStatus(config)).setupRequired, false);

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.users.length, 2);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.users.some(user => user.role === 'host.admin' && user.displayName === 'Dev Admin'), true);
  assert.equal(state.users.some(user => user.role === 'host.user' && user.displayName === 'Dev User'), true);
  assert.equal(JSON.stringify(state).includes('docker-host-dev-user'), false);
});

test('development auto-login can seed switchable admin and user browser accounts', async t => {
  const config = await createTestConfig();
  const previousDevAuth = process.env.HOST_DEV_AUTH;
  const previousDevAuthRole = process.env.HOST_DEV_AUTH_ROLE;
  const previousSeedAccounts = process.env.HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS;
  const previousRuntimeMode = process.env.HOST_RUNTIME_MODE;
  t.after(() => {
    restoreEnv('HOST_DEV_AUTH', previousDevAuth);
    restoreEnv('HOST_DEV_AUTH_ROLE', previousDevAuthRole);
    restoreEnv('HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS', previousSeedAccounts);
    restoreEnv('HOST_RUNTIME_MODE', previousRuntimeMode);
  });

  process.env.HOST_DEV_AUTH = 'auto';
  delete process.env.HOST_DEV_AUTH_ROLE;
  process.env.HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS = 'enabled';
  process.env.HOST_RUNTIME_MODE = 'development';

  assert.equal(isDevAuthBrowserAccountSeedEnabled(), true);
  const result = await createDevSession({ userAgent: 'Dev Browser' }, config);

  assert.equal(result.user.email, 'admin@docker-host.local');
  assert.equal(result.user.role, 'host.admin');
  assert.equal(result.browserAccountUsers.length, 2);
  assert.equal(result.browserAccountUsers.some(user => user.role === 'host.admin'), true);
  assert.equal(result.browserAccountUsers.some(user => user.role === 'host.user'), true);

  const accountSet = await addUsersToBrowserAccountSet({
    accountSetToken: null,
    userIds: result.browserAccountUsers.map(user => user.id),
  }, undefined, config);

  assert.equal(accountSet.addedUserIds.length, 2);

  const listed = await listBrowserAccounts(accountSet.accountSetToken, result.user, config);
  assert.equal(listed.accounts.length, 2);
  assert.equal(listed.accounts[0]?.email, 'admin@docker-host.local');
  assert.equal(listed.accounts[0]?.active, true);
  assert.equal(listed.accounts[1]?.email, 'user@docker-host.local');
  assert.equal(listed.accounts[1]?.active, false);
});

test('development browser account seeding repairs an existing admin-only account set', async t => {
  const config = await createTestConfig();
  const previousDevAuth = process.env.HOST_DEV_AUTH;
  const previousDevAuthRole = process.env.HOST_DEV_AUTH_ROLE;
  const previousSeedAccounts = process.env.HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS;
  const previousRuntimeMode = process.env.HOST_RUNTIME_MODE;
  t.after(() => {
    restoreEnv('HOST_DEV_AUTH', previousDevAuth);
    restoreEnv('HOST_DEV_AUTH_ROLE', previousDevAuthRole);
    restoreEnv('HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS', previousSeedAccounts);
    restoreEnv('HOST_RUNTIME_MODE', previousRuntimeMode);
  });

  process.env.HOST_DEV_AUTH = 'auto';
  delete process.env.HOST_DEV_AUTH_ROLE;
  delete process.env.HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS;
  process.env.HOST_RUNTIME_MODE = 'development';

  const login = await createDevSession({ userAgent: 'Dev Browser' }, config);
  let accountSet = await addUserToBrowserAccountSet({
    accountSetToken: null,
    userId: login.user.id,
  }, undefined, config);

  assert.equal((await listBrowserAccounts(accountSet.accountSetToken, login.user, config)).accounts.length, 1);

  process.env.HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS = 'enabled';
  const devUsers = await prepareDevBrowserAccountUsers(config);
  accountSet = await addUsersToBrowserAccountSet({
    accountSetToken: accountSet.accountSetToken,
    userIds: devUsers.map(user => user.id),
  }, undefined, config);

  const listed = await listBrowserAccounts(accountSet.accountSetToken, login.user, config);
  assert.equal(listed.accounts.length, 2);
  assert.equal(listed.accounts.some(account => account.email === 'admin@docker-host.local'), true);
  assert.equal(listed.accounts.some(account => account.email === 'user@docker-host.local'), true);
});

test('development admin session helper always creates an admin session', async t => {
  const config = await createTestConfig();
  const previousDevAuth = process.env.HOST_DEV_AUTH;
  const previousDevAuthRole = process.env.HOST_DEV_AUTH_ROLE;
  const previousRuntimeMode = process.env.HOST_RUNTIME_MODE;
  t.after(() => {
    restoreEnv('HOST_DEV_AUTH', previousDevAuth);
    restoreEnv('HOST_DEV_AUTH_ROLE', previousDevAuthRole);
    restoreEnv('HOST_RUNTIME_MODE', previousRuntimeMode);
  });

  process.env.HOST_DEV_AUTH = 'auto';
  process.env.HOST_DEV_AUTH_ROLE = 'user';
  process.env.HOST_RUNTIME_MODE = 'development';

  const result = await createDevAdminSession({ userAgent: 'Dev Browser' }, config);

  assert.equal(result.user.email, 'admin@docker-host.local');
  assert.equal(result.user.displayName, 'Dev Admin');
  assert.equal(result.user.role, 'host.admin');
  assert.equal((await authenticateSessionToken(result.sessionToken, undefined, config))?.role, 'host.admin');
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

test('browser account sets remember users and switch with a fresh session', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);
  const admin = await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);
  const regularUser = await addTestUser(config, {
    id: 'user_regular',
    email: 'user@example.test',
    displayName: 'Regular User',
    role: 'host.user',
  });

  const firstAccountSet = await addUserToBrowserAccountSet({
    accountSetToken: null,
    userId: admin.user.id,
  }, { userAgent: 'Test Browser' }, config);
  const secondAccountSet = await addUserToBrowserAccountSet({
    accountSetToken: firstAccountSet.accountSetToken,
    userId: regularUser.id,
  }, { userAgent: 'Test Browser' }, config);

  assert.equal(secondAccountSet.accountSetToken, firstAccountSet.accountSetToken);

  const listed = await listBrowserAccounts(firstAccountSet.accountSetToken, admin.user, config);
  assert.equal(listed.accounts.length, 2);
  assert.equal(listed.accounts[0]?.id, admin.user.id);
  assert.equal(listed.accounts[0]?.active, true);
  assert.equal(listed.accounts[1]?.id, regularUser.id);

  const switched = await switchBrowserAccount({
    accountSetToken: firstAccountSet.accountSetToken,
    userId: regularUser.id,
  }, { userAgent: 'Test Browser' }, config);

  assert.equal(switched.user.role, 'host.user');
  assert.equal((await authenticateSessionToken(switched.sessionToken, undefined, config))?.id, regularUser.id);
  assert.equal(await hasRecentSessionReauthentication(switched.session.id, config), false);

  const afterSwitch = await listBrowserAccounts(firstAccountSet.accountSetToken, switched.user, config);
  assert.equal(afterSwitch.accounts[0]?.id, regularUser.id);
  assert.equal(afterSwitch.accounts[0]?.active, true);

  const audit = await listAuthAuditEvents({ type: 'auth.account_set.switched' }, config);
  assert.equal(audit.events.length, 1);
});

test('browser account sets exclude disabled users and refuse switching to them', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);
  const admin = await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);
  const regularUser = await addTestUser(config, {
    id: 'user_regular',
    email: 'user@example.test',
    displayName: 'Regular User',
    role: 'host.user',
  });
  const accountSet = await addUserToBrowserAccountSet({
    accountSetToken: null,
    userId: admin.user.id,
  }, undefined, config);
  await addUserToBrowserAccountSet({
    accountSetToken: accountSet.accountSetToken,
    userId: regularUser.id,
  }, undefined, config);

  const state = await readAuthStateSnapshot(config);
  await writeAuthState({
    ...state,
    users: state.users.map(user =>
      user.id === regularUser.id ? { ...user, disabled: true } : user
    ),
  }, config);

  const listed = await listBrowserAccounts(accountSet.accountSetToken, admin.user, config);
  assert.equal(listed.accounts.some(account => account.id === regularUser.id), false);

  await assert.rejects(
    switchBrowserAccount({
      accountSetToken: accountSet.accountSetToken,
      userId: regularUser.id,
    }, undefined, config),
    /disabled or does not exist/
  );
});

test('browser account removal and clear revoke active sessions', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);
  const admin = await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);
  const regularUser = await addTestUser(config, {
    id: 'user_regular',
    email: 'user@example.test',
    displayName: 'Regular User',
    role: 'host.user',
  });
  const accountSet = await addUserToBrowserAccountSet({
    accountSetToken: null,
    userId: admin.user.id,
  }, undefined, config);
  await addUserToBrowserAccountSet({
    accountSetToken: accountSet.accountSetToken,
    userId: regularUser.id,
  }, undefined, config);
  const switched = await switchBrowserAccount({
    accountSetToken: accountSet.accountSetToken,
    userId: regularUser.id,
  }, undefined, config);

  const removed = await removeBrowserAccount({
    accountSetToken: accountSet.accountSetToken,
    userId: regularUser.id,
    activeSessionToken: switched.sessionToken,
  }, undefined, config);

  assert.equal(removed.removed, true);
  assert.equal(removed.activeSessionRevoked, true);
  assert.equal(await authenticateSessionToken(switched.sessionToken, undefined, config), null);
  assert.equal((await listBrowserAccounts(accountSet.accountSetToken, admin.user, config)).accounts.length, 1);

  const cleared = await clearBrowserAccountSet({
    accountSetToken: accountSet.accountSetToken,
    activeSessionToken: admin.sessionToken,
    actorUserId: admin.user.id,
  }, undefined, config);

  assert.equal(cleared.accountSetRevoked, true);
  assert.equal(cleared.activeSessionRevoked, true);
  assert.equal(await authenticateSessionToken(admin.sessionToken, undefined, config), null);
  assert.equal((await listBrowserAccounts(accountSet.accountSetToken, admin.user, config)).accounts.length, 0);
});

test('throttles session activity writes for recently seen sessions', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);
  const login = await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);
  const before = await readAuthStateSnapshot(config);

  assert.equal((await authenticateSessionToken(login.sessionToken, undefined, config))?.id, login.user.id);

  const after = await readAuthStateSnapshot(config);
  assert.equal(after.sessions[0]?.lastSeenAt, before.sessions[0]?.lastSeenAt);
  assert.equal(after.sessions[0]?.idleExpiresAt, before.sessions[0]?.idleExpiresAt);
});

test('rate limits rejected session audit events for repeated invalid cookies', async () => {
  const config = await createTestConfig();
  const request = {
    origin: 'https://host.example.test',
    userAgent: 'Test Browser',
  };

  assert.equal(await authenticateSessionToken('dhs_invalid', request, config), null);
  assert.equal(await authenticateSessionToken('dhs_invalid', request, config), null);

  const audit = await listAuthAuditEvents({ type: 'auth.session.rejected' }, config);
  assert.equal(audit.events.length, 1);
});

test('lists and revokes sessions by id', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);
  const admin = await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);

  const login = await authenticatePassword({
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, {
    origin: 'https://host.example.test',
    userAgent: 'Test Browser',
  }, config);

  const sessions = await listAuthSessions({
    currentSessionId: login.session.id,
  }, config);
  const listed = sessions.find(session => session.id === login.session.id);
  assert.equal(listed?.current, true);
  assert.equal(listed?.active, true);
  assert.equal(listed?.request?.userAgent, 'Test Browser');

  assert.equal(await revokeSessionById(login.session.id, admin.user.id, undefined, config), true);

  const revokedSessions = await listAuthSessions({
    includeRevoked: true,
  }, config);
  const revoked = revokedSessions.find(session => session.id === login.session.id);
  assert.equal(revoked?.active, false);
  assert.equal(typeof revoked?.revokedAt, 'string');

  assert.equal(await authenticateSessionToken(login.sessionToken, undefined, config), null);
});

test('recovery token restores a local Host administrator', async () => {
  const config = await createTestConfig();
  const recovery = await createSetupToken('recovery', config);

  const result = await recoverHostAdmin({
    recoveryToken: recovery.token,
    email: 'restored@example.test',
    displayName: 'Restored Admin',
    password: 'correct horse battery staple',
  }, undefined, config);

  assert.equal(result.user.email, 'restored@example.test');
  assert.equal(result.user.role, 'host.admin');
  assert.equal((await authenticateSessionToken(result.sessionToken, undefined, config))?.id, result.user.id);

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.setupTokens.find(token => token.id === recovery.tokenId)?.usedAt !== undefined, true);
});

test('reauthenticates a session with password and consumes recovery token fallback', async () => {
  const config = await createTestConfig();
  const setup = await createSetupToken('first-admin', config);
  const admin = await bootstrapFirstAdmin({
    setupToken: setup.token,
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);

  assert.equal(await hasRecentSessionReauthentication(admin.session.id, config), false);
  await reauthenticateSession({
    sessionId: admin.session.id,
    userId: admin.user.id,
    password: 'correct horse battery staple',
  }, undefined, config);
  assert.equal(await hasRecentSessionReauthentication(admin.session.id, config), true);

  const recovery = await createSetupToken('recovery', config);
  const login = await authenticatePassword({
    email: 'admin@example.test',
    password: 'correct horse battery staple',
  }, undefined, config);

  await reauthenticateSession({
    sessionId: login.session.id,
    userId: admin.user.id,
    recoveryToken: recovery.token,
  }, undefined, config);
  assert.equal(await hasRecentSessionReauthentication(login.session.id, config), true);

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.setupTokens.find(token => token.id === recovery.tokenId)?.usedAt !== undefined, true);
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

async function addTestUser(
  config: HostRuntimeConfig,
  input: {
    id: string;
    email: string;
    displayName: string;
    role: 'host.admin' | 'host.user';
  }
) {
  const state = await readAuthStateSnapshot(config);
  const now = new Date().toISOString();
  const user = {
    id: input.id,
    email: input.email,
    displayName: input.displayName,
    role: input.role,
    authProvider: 'local' as const,
    createdAt: now,
    updatedAt: now,
  };

  await writeAuthState({
    ...state,
    users: [...state.users, user],
  }, config);

  return user;
}

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

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
