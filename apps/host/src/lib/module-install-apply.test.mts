import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePublicOrigin } from './module-install-apply.ts';

test('normalizePublicOrigin rejects credentials in origins', () => {
  assert.equal(normalizePublicOrigin('https://user:pass@example.test'), null);
  assert.equal(normalizePublicOrigin('https://user@example.test'), null);
  assert.equal(normalizePublicOrigin('https://example.test'), 'https://example.test');
});
