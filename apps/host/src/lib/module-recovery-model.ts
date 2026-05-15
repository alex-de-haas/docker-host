import path from 'node:path';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type {
  InstalledExternalMountMapping,
  InstalledModuleRecord,
  InstalledStorageMapping,
  ModuleRecoveryPlan,
  ModulesStoreData,
  ResolvedDependency,
} from '../types/modules.ts';

export function findDependentModules(
  moduleId: string,
  store: ModulesStoreData
): ModuleRecoveryPlan['dependents'] {
  return store.modules
    .filter(candidate => candidate.id !== moduleId)
    .filter(candidate => getResolvedDependencies(candidate).some(dependency => dependency.id === moduleId))
    .map(candidate => ({
      id: candidate.id,
    }));
}

export function getStoredStorageMappings(module: InstalledModuleRecord): InstalledStorageMapping[] {
  const mappings = module.storageMappings || module.storage?.directories || [];
  return Array.isArray(mappings) ? mappings : Object.values(mappings);
}

export function getStoredExternalMounts(module: InstalledModuleRecord): InstalledExternalMountMapping[] {
  const mounts = module.externalMounts || [];
  return Array.isArray(mounts) ? mounts : Object.values(mounts).flat();
}

export function getResolvedDependencies(module: InstalledModuleRecord): ResolvedDependency[] {
  const dependencies = module.resolvedDependencies || module.dependencies || [];
  return Array.isArray(dependencies) ? dependencies : Object.values(dependencies);
}

export function resolveContainerDataPath(hostPath: string, config: HostRuntimeConfig) {
  const relative = path.relative(config.dataRootHost, hostPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return path.join(config.dataRootContainer, relative);
}
