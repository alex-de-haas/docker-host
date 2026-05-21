import type {
  InstalledModuleContainerRecord,
  InstalledModuleRecord,
  ModuleAggregateRuntimeStatus,
  ModuleRuntimeStatus,
} from '../types/modules.ts';

interface ModuleContainerDependencyMetadata {
  containers?: Array<{
    key: string;
    dependsOn?: string[];
  }>;
}

export function getModuleContainersInStartOrder(
  module: Pick<InstalledModuleRecord, 'containers'>,
  metadata?: ModuleContainerDependencyMetadata | null
): InstalledModuleContainerRecord[] {
  const containers = [...module.containers];
  const knownContainerKeys = new Set(containers.map(container => container.key));
  const dependenciesByContainer = new Map(
    (metadata?.containers ?? []).map(container => [
      container.key,
      (container.dependsOn ?? []).filter(dependencyKey => knownContainerKeys.has(dependencyKey)),
    ])
  );
  const ordered: InstalledModuleContainerRecord[] = [];
  const remaining = new Map(containers.map(container => [container.key, container]));

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(container =>
      (dependenciesByContainer.get(container.key) ?? []).every(dependencyKey => !remaining.has(dependencyKey))
    );

    if (ready.length === 0) {
      return containers;
    }

    for (const container of ready) {
      ordered.push(container);
      remaining.delete(container.key);
    }
  }

  return ordered;
}

export function getModuleContainersInStopOrder(
  module: Pick<InstalledModuleRecord, 'containers'>,
  metadata?: ModuleContainerDependencyMetadata | null
): InstalledModuleContainerRecord[] {
  return [...getModuleContainersInStartOrder(module, metadata)].reverse();
}

export function buildModuleAggregateRuntimeStatus(
  runtimeStatuses: ModuleRuntimeStatus[]
): ModuleAggregateRuntimeStatus {
  if (runtimeStatuses.length === 0) {
    return {
      state: 'not_created',
      runningContainers: 0,
      totalContainers: 0,
    };
  }

  const runningContainers = runtimeStatuses.filter(status => status.state === 'running').length;
  const states = runtimeStatuses.map(status => status.state);
  const firstError = runtimeStatuses.find(status => status.error)?.error;
  const state = states.every(candidate => candidate === 'not_created')
    ? 'not_created'
    : states.every(candidate => candidate === 'running')
      ? 'running'
      : states.every(candidate => candidate === 'exited' || candidate === 'created')
        ? 'exited'
        : states.every(candidate => candidate === 'unknown')
          ? 'unknown'
          : 'degraded';

  return {
    state,
    runningContainers,
    totalContainers: runtimeStatuses.length,
    ...(firstError ? { error: firstError } : {}),
  };
}
