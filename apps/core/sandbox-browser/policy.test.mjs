import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, appNavigation } from './policy.mjs';

test('redacts auth values with whitespace and standalone bearer credentials', () => {
  for (const text of ['password = secret-value', 'token: secret-value', 'Authorization: Bearer secret-value', 'Bearer secret-value', 'hostysb_grant_secret-value'])
    assert.ok(!redact(text).includes('secret-value'));
  assert.equal(redact('ordinary diagnostic'), 'ordinary diagnostic');
});
test('navigation keeps the selected app and excludes browser-control paths', () => {
  const target = new URL('http://app.hosty.localhost:3100/');
  for (const path of ['/people', '/roles', '/settings?view=test']) assert.equal(appNavigation(path, target).origin, target.origin);
  for (const path of ['https://evil.test/', '//evil.test/', '/bad\\path', '/bad\npath', '/_hosty/callback', '/a/../_hosty/callback'])
    assert.throws(() => appNavigation(path, target), /sandbox_navigation_invalid/);
});
