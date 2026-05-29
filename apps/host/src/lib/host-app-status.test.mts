import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAppStatusReason, formatAppStatusReasonLabel } from './host-app-status.ts';

test('formats app unavailable reasons for visible diagnostics', () => {
  assert.equal(formatAppStatusReasonLabel('uiPortMissing'), 'UI port missing');
  assert.equal(
    formatAppStatusReason('uiPortMissing'),
    'App UI needs a published Host port. Open the module update review or reinstall the module.'
  );
  assert.equal(formatAppStatusReasonLabel('runtimeUnavailable'), 'Runtime not running');
  assert.equal(formatAppStatusReason('runtimeUnavailable'), 'Module runtime is not running.');
});
