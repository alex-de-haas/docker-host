import assert from 'node:assert/strict';
import test from 'node:test';
import { getSidebarHostApps } from './host-app-navigation.ts';
import type { HostAppEntry } from '../types/apps.ts';

test('hides system apps from sidebar app navigation', () => {
  const apps = [
    createApp({ id: 'hosty.shell', source: 'system', system: true, displayName: 'Hosty Shell' }),
    createApp({ id: 'hosty.backups', source: 'system', system: true, displayName: 'Hosty Backups' }),
    createApp({ id: 'com.example.reports', source: 'installed', system: false, displayName: 'Reports' }),
  ];

  assert.deepEqual(
    getSidebarHostApps(apps).map(app => app.id),
    ['com.example.reports']
  );
});

function createApp(input: Pick<HostAppEntry, 'id' | 'source' | 'system' | 'displayName'>): HostAppEntry {
  return {
    ...input,
    kind: input.system ? 'system' : 'runtime',
    moduleId: input.id,
    version: '1.0.0',
    status: 'available',
    statusReason: 'available',
    accessMode: 'assignedUsersOnly',
    capabilities: [],
    entryPath: input.id === 'hosty.shell' ? '/' : `/apps/${encodeURIComponent(input.id)}`,
    embeddedUrl: '',
    origin: null,
    identityTokenUrl: null,
    navigation: [],
  };
}
