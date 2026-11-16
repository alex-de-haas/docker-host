// Shared normal Core login proof for independently installed provider settings in browser checks.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
export async function authenticateProvider(context, core, csrf, provider) {
  assert.ok(provider?.appId && provider?.origin && provider?.link, 'Pass the actual discovered provider installation.');
  const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const issued = await context.request.post(`${core}/api/apps/${encodeURIComponent(provider.appId)}/launch-code`, {
    headers: { Origin: core, 'X-Hosty-CSRF': csrf }, data: { redirectUri: provider.link,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' },
  });
  assert.equal(issued.status(), 200, 'Core must authorize the provider app itself.');
  const exchanged = await context.request.post(provider.origin + '/api/auth/exchange', {
    headers: { Origin: provider.origin }, data: { code: (await issued.json()).code, codeVerifier: verifier },
  });
  assert.equal(exchanged.status(), 200, 'The provider must accept its own app proof.');
  assert.equal((await (await context.request.get(provider.origin + '/api/auth/session')).json()).status, 'active');
}
export async function createProviderConnection(context, provider, configuration) {
  const response = await context.request.post(provider.origin + '/api/settings/connections', {
    headers: { Origin: provider.origin }, data: configuration,
  });
  assert.equal(response.status(), 200);
  const matches = (await response.json()).connections.filter(row => row.name === configuration.name);
  assert.equal(matches.length, 1); return matches[0];
}
export async function harnessProviderConnection(context, harness, provider, name) {
  const response = await context.request.get(harness + '/api/connections'); assert.equal(response.status(), 200);
  const matches = (await response.json()).connections.filter(row => row.name === name && row.provider?.appId === provider.appId);
  assert.equal(matches.length, 1, 'Harness must discover the configured provider-owned connection.');
  assert.equal(matches[0].kind, 'agent'); return matches[0];
}

export async function authenticateHarness(context, core, csrf, config) {
  const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  assert.ok(config.harnessAppId, 'Pass the actual discovered Harness installation.');
  const issued = await context.request.post(`${core}/api/apps/${encodeURIComponent(config.harnessAppId)}/launch-code`, {
    headers: { Origin: core, 'X-Hosty-CSRF': csrf }, data: { redirectUri: config.link,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' },
  }); assert.equal(issued.status(), 200);
  const exchanged = await context.request.post(config.harness + '/api/auth/app-code', {
    headers: { Origin: config.harness }, data: { code: (await issued.json()).code, codeVerifier: verifier },
  }); assert.equal(exchanged.status(), 200);
}
