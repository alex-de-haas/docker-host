import assert from 'node:assert/strict';
import test from 'node:test';
import { findSameSourceInstalledModuleId } from './module-install-or-update-plan.ts';
import type { InstallPlanConflict } from '../types/modules.ts';

test('detects same-source installed module conflicts as update handoff candidates', () => {
  const conflicts: InstallPlanConflict[] = [
    {
      code: 'module_id_conflict',
      message: 'Module is already installed.',
      resourceType: 'installed_module',
      resourceId: 'com.example.reports',
      path: '$.id',
      existingValue: 'https://modules.example.test/reports.json',
      proposedValue: 'https://modules.example.test/reports.json',
    },
  ];

  assert.equal(findSameSourceInstalledModuleId(conflicts), 'com.example.reports');
});

test('does not hand off install conflicts from a different metadata URL', () => {
  const conflicts: InstallPlanConflict[] = [
    {
      code: 'module_id_conflict',
      message: 'Module is already installed.',
      resourceType: 'installed_module',
      resourceId: 'com.example.reports',
      path: '$.id',
      existingValue: 'https://modules.example.test/reports.json',
      proposedValue: 'https://mirror.example.test/reports.json',
    },
  ];

  assert.equal(findSameSourceInstalledModuleId(conflicts), null);
});
