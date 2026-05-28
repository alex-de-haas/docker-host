import { readModuleDevTargetStateSnapshot } from './module-dev-store.ts';
import {
  readModuleMetadata,
  readModulesStoreSnapshot,
} from './module-store.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

export type AssignableModuleSource = 'installed' | 'developer';

export interface AssignableModuleSummary {
  id: string;
  name: string;
  version?: string;
  operationStatus?: string;
  source: AssignableModuleSource;
}

export async function listAssignableModules(
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<AssignableModuleSummary[]> {
  const [store, developerTargetState] = await Promise.all([
    readModulesStoreSnapshot(config),
    readModuleDevTargetStateSnapshot(config),
  ]);
  const assignableModules = new Map<string, AssignableModuleSummary>();

  await Promise.all(
    store.modules.map(async module => {
      try {
        const metadata = await readModuleMetadata(module, config);
        assignableModules.set(module.id, {
          id: module.id,
          name: metadata?.name || module.id,
          version: metadata?.version,
          operationStatus: module.operationStatus || 'installed',
          source: 'installed',
        });
      } catch {
        assignableModules.set(module.id, {
          id: module.id,
          name: module.id,
          operationStatus: module.operationStatus || 'installed',
          source: 'installed',
        });
      }
    })
  );

  for (const target of developerTargetState.targets) {
    if (!target.enabled || !target.shellApp || assignableModules.has(target.moduleId)) {
      continue;
    }

    assignableModules.set(target.moduleId, {
      id: target.moduleId,
      name: target.shellApp.displayName || target.moduleName || target.moduleId,
      version: target.moduleVersion,
      operationStatus: 'developer',
      source: 'developer',
    });
  }

  return Array.from(assignableModules.values())
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}
