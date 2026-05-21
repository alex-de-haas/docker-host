import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModuleAggregateRuntimeStatus,
  getModuleContainersInStartOrder,
  getModuleContainersInStopOrder,
} from './module-lifecycle.ts';
import type {
  InstalledModuleRecord,
  ModuleRuntimeStatus,
} from '../types/modules.ts';

test('orders module containers by dependency graph for start and stop', () => {
  const appModule = moduleFixture(['worker', 'frontend', 'backend']);
  const metadata = {
    containers: [
      { key: 'frontend', dependsOn: ['backend'] },
      { key: 'backend', dependsOn: ['worker'] },
      { key: 'worker', dependsOn: [] },
    ],
  };

  assert.deepEqual(
    getModuleContainersInStartOrder(appModule, metadata).map(container => container.key),
    ['worker', 'backend', 'frontend']
  );
  assert.deepEqual(
    getModuleContainersInStopOrder(appModule, metadata).map(container => container.key),
    ['frontend', 'backend', 'worker']
  );
});

test('container ordering falls back to stored order when dependencies cycle', () => {
  const appModule = moduleFixture(['api', 'worker']);
  const metadata = {
    containers: [
      { key: 'api', dependsOn: ['worker'] },
      { key: 'worker', dependsOn: ['api'] },
    ],
  };

  assert.deepEqual(
    getModuleContainersInStartOrder(appModule, metadata).map(container => container.key),
    ['api', 'worker']
  );
});

test('aggregate runtime status distinguishes missing, degraded, stopped, and unknown modules', () => {
  assert.deepEqual(buildModuleAggregateRuntimeStatus([]), {
    state: 'not_created',
    runningContainers: 0,
    totalContainers: 0,
  });
  assert.equal(buildModuleAggregateRuntimeStatus([
    runtimeStatus('frontend', 'not_created'),
    runtimeStatus('backend', 'not_created'),
  ]).state, 'not_created');
  assert.equal(buildModuleAggregateRuntimeStatus([
    runtimeStatus('frontend', 'running'),
    runtimeStatus('backend', 'not_created'),
  ]).state, 'degraded');
  assert.equal(buildModuleAggregateRuntimeStatus([
    runtimeStatus('frontend', 'created'),
    runtimeStatus('backend', 'exited'),
  ]).state, 'exited');
  assert.equal(buildModuleAggregateRuntimeStatus([
    runtimeStatus('frontend', 'unknown', 'Docker inspect failed.'),
    runtimeStatus('backend', 'unknown', 'Docker inspect failed.'),
  ]).state, 'unknown');
});

function moduleFixture(keys: string[]): InstalledModuleRecord {
  return {
    id: 'com.example.app',
    metadataUrl: 'https://example.test/app.json',
    containers: keys.map(key => ({
      key,
      containerName: `mod-com-example-app-${key}`,
      networkAlias: `mod-com-example-app-${key}`,
      image: {
        repository: `ghcr.io/example/app-${key}`,
        tag: '1.0.0',
        reference: `ghcr.io/example/app-${key}:1.0.0`,
      },
    })),
  };
}

function runtimeStatus(
  key: string,
  state: ModuleRuntimeStatus['state'],
  error?: string
): ModuleRuntimeStatus {
  return {
    state,
    containerId: state === 'not_created' ? null : `container-${key}`,
    containerName: `mod-com-example-app-${key}`,
    startedAt: state === 'running' ? '2026-05-21T09:00:00.000Z' : null,
    finishedAt: state === 'exited' ? '2026-05-21T09:05:00.000Z' : null,
    ...(error ? { error } : {}),
  };
}
