import { readAuthStateSnapshot } from './auth-store.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  readModuleMetadata,
  readModulesStoreSnapshot,
} from './module-store.ts';
import { readModuleDevTargetStateSnapshot } from './module-dev-store.ts';
import { validateModuleUiMetadata } from './module-metadata.ts';
import type { HostPrincipal, ModuleAccessAssignment } from '../types/auth.ts';
import type { ModuleExposurePolicy } from '../types/auth.ts';
import type {
  HostAppAccessMode,
  HostAppEntry,
  HostAppNavigationItem,
  HostAppStatusReason,
} from '../types/apps.ts';
import type { ModuleDevTargetRecord } from '../types/module-dev.ts';
import type {
  InstalledModuleRecord,
  ModuleMetadata,
  ModuleRuntimeStatus,
  ModuleUiMetadata,
} from '../types/modules.ts';

export interface ListHostAppsOptions {
  config?: HostRuntimeConfig;
  runtimeStatusReader?: RuntimeStatusReader;
}

type RuntimeStatusReader = (module: InstalledModuleRecord) => Promise<ModuleRuntimeStatus>;

const DEFAULT_RUNTIME_STATUS_CACHE_TTL_MS = 2_000;

interface RuntimeStatusCacheEntry {
  expiresAt: number;
  promise?: Promise<ModuleRuntimeStatus>;
  settled: boolean;
}

interface ModuleAppCandidate {
  app: HostAppEntry | null;
  visibleToUsers: boolean;
}

export function createCachedRuntimeStatusReader(
  runtimeStatusReader: RuntimeStatusReader,
  options: {
    ttlMs?: number;
    now?: () => number;
  } = {}
): RuntimeStatusReader {
  const ttlMs = options.ttlMs ?? DEFAULT_RUNTIME_STATUS_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, RuntimeStatusCacheEntry>();

  return async module => {
    if (ttlMs <= 0) {
      return runtimeStatusReader(module);
    }

    const cacheKey = getRuntimeStatusCacheKey(module);
    const currentTime = now();
    const cached = cache.get(cacheKey);
    if (cached?.promise && (!cached.settled || cached.expiresAt > currentTime)) {
      return cached.promise;
    }

    const entry: RuntimeStatusCacheEntry = {
      expiresAt: Number.POSITIVE_INFINITY,
      settled: false,
    };
    const promise = Promise.resolve()
      .then(() => runtimeStatusReader(module))
      .then(status => {
        entry.settled = true;
        entry.expiresAt = now() + ttlMs;
        return status;
      })
      .catch(error => {
        cache.delete(cacheKey);
        throw error;
      });

    entry.promise = promise;
    cache.set(cacheKey, entry);

    return promise;
  };
}

export async function listHostApps(
  principal: HostPrincipal,
  options: ListHostAppsOptions = {}
): Promise<HostAppEntry[]> {
  const config = options.config ?? getHostRuntimeConfig();
  const [modulesStore, authState, developerTargetState] = await Promise.all([
    readModulesStoreSnapshot(config),
    readAuthStateSnapshot(config),
    config.moduleDevModeEnabled
      ? readModuleDevTargetStateSnapshot(config)
      : Promise.resolve(null),
  ]);

  const runtimeStatusReader = modulesStore.modules.length > 0
    ? options.runtimeStatusReader ?? (await getDefaultRuntimeStatusReader())
    : null;

  const installedCandidates = runtimeStatusReader
    ? await Promise.all(
        modulesStore.modules.map(module =>
          buildModuleAppCandidate(module, authState.moduleAssignments, runtimeStatusReader, config)
        )
      )
    : [];
  const developerCandidates = developerTargetState
    ? developerTargetState.targets.map(target => buildDeveloperAppCandidate(target))
    : [];
  const candidates = [...installedCandidates, ...developerCandidates];

  return candidates
    .filter(candidate => candidate.app)
    .filter(candidate => shouldReturnApp(candidate as ModuleAppCandidate & { app: HostAppEntry }, principal, authState.moduleAssignments))
    .map(candidate => candidate.app as HostAppEntry)
    .sort(compareHostApps);
}

let defaultRuntimeStatusReaderPromise: Promise<RuntimeStatusReader> | null = null;

async function getDefaultRuntimeStatusReader(): Promise<RuntimeStatusReader> {
  defaultRuntimeStatusReaderPromise ??= import('./module-docker.ts')
    .then(moduleDocker => createCachedRuntimeStatusReader(moduleDocker.getModuleRuntimeStatus));

  return defaultRuntimeStatusReaderPromise;
}

async function buildModuleAppCandidate(
  module: InstalledModuleRecord,
  assignments: ModuleAccessAssignment[],
  runtimeStatusReader: RuntimeStatusReader,
  config: HostRuntimeConfig
): Promise<ModuleAppCandidate> {
  const metadataResult = await safeReadInstalledMetadata(module, config);
  if (!metadataResult.metadata) {
    return {
      app: buildUnavailableApp({
        module,
        metadata: null,
        reason: metadataResult.reason,
        accessMode: getShellAccessMode(module.id, assignments),
      }),
      visibleToUsers: false,
    };
  }

  const uiResult = normalizeInstalledModuleUi(metadataResult.metadata, module.id);
  if (!uiResult.ui) {
    if (uiResult.reason) {
      return {
        app: buildUnavailableApp({
          module,
          metadata: metadataResult.metadata,
          reason: uiResult.reason,
          accessMode: getShellAccessMode(module.id, assignments),
        }),
        visibleToUsers: false,
      };
    }

    return {
      app: null,
      visibleToUsers: false,
    };
  }

  const operationStatus = module.operationStatus || 'installed';
  const accessMode = getShellAccessMode(module.id, assignments);
  if (operationStatus !== 'installed') {
    return {
      app: {
        id: module.id,
        source: 'installed',
        moduleId: module.id,
        displayName: metadataResult.metadata.name || module.id,
        ...(metadataResult.metadata.description ? { description: metadataResult.metadata.description } : {}),
        ...(uiResult.ui.icon ? { icon: uiResult.ui.icon } : {}),
        version: metadataResult.metadata.version || 'unknown',
        status: 'unavailable',
        statusReason: 'moduleOperationUnavailable',
        accessMode,
        operationStatus,
        entryPath: buildAppEntryPath(module.id, uiResult.ui.entrypoint.path),
        embeddedUrl: buildEmbeddedUrl(module.id, uiResult.ui.entrypoint.path),
        navigation: buildNavigation(module.id, uiResult.ui.navigation),
      },
      visibleToUsers: false,
    };
  }

  const runtimeStatus = await safeReadRuntimeStatus(module, runtimeStatusReader);
  const available = runtimeStatus.state === 'running';

  return {
    app: {
      id: module.id,
      source: 'installed',
      moduleId: module.id,
      displayName: metadataResult.metadata.name || module.id,
      ...(metadataResult.metadata.description ? { description: metadataResult.metadata.description } : {}),
      ...(uiResult.ui.icon ? { icon: uiResult.ui.icon } : {}),
      version: metadataResult.metadata.version || 'unknown',
      status: available ? 'available' : 'unavailable',
      statusReason: available ? 'available' : 'runtimeUnavailable',
      accessMode,
      operationStatus,
      runtimeState: runtimeStatus.state,
      entryPath: buildAppEntryPath(module.id, uiResult.ui.entrypoint.path),
      embeddedUrl: buildEmbeddedUrl(module.id, uiResult.ui.entrypoint.path),
      navigation: buildNavigation(module.id, uiResult.ui.navigation),
    },
    visibleToUsers: available,
  };
}

async function safeReadInstalledMetadata(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
): Promise<{
  metadata: ModuleMetadata | null;
  reason: Extract<HostAppStatusReason, 'metadataMissing' | 'metadataInvalid'>;
}> {
  try {
    const metadata = await readModuleMetadata(module, config);
    return {
      metadata,
      reason: metadata ? 'metadataInvalid' : 'metadataMissing',
    };
  } catch {
    return {
      metadata: null,
      reason: 'metadataInvalid',
    };
  }
}

function normalizeInstalledModuleUi(
  metadata: ModuleMetadata,
  moduleId: string
): {
  ui?: ModuleUiMetadata;
  reason?: Extract<HostAppStatusReason, 'metadataInvalid' | 'uiPortMissing' | 'uiPortNotPublic'>;
} {
  if (metadata.ui === undefined) {
    return {};
  }

  const validationErrors: Array<{
    code: string;
    message: string;
    path: string;
    node?: string;
  }> = [];
  const ui = validateModuleUiMetadata(
    metadata.ui,
    '$.ui',
    metadata.endpoints ?? [],
    validationErrors,
    moduleId
  );

  if (ui) {
    return { ui };
  }

  const firstCode = validationErrors[0]?.code;
  if (firstCode === 'module_ui_port_not_found') {
    return { reason: 'uiPortMissing' };
  }

  if (firstCode === 'module_ui_port_not_public') {
    return { reason: 'uiPortNotPublic' };
  }

  return { reason: 'metadataInvalid' };
}

async function safeReadRuntimeStatus(
  module: InstalledModuleRecord,
  runtimeStatusReader: RuntimeStatusReader
): Promise<ModuleRuntimeStatus> {
  try {
    return await runtimeStatusReader(module);
  } catch (error) {
    return {
      state: 'unknown',
      containerId: null,
      containerName: module.containers[0]?.containerName ?? module.id,
      startedAt: null,
      finishedAt: null,
      error: error instanceof Error ? error.message : 'Unknown runtime status error',
    };
  }
}

function getRuntimeStatusCacheKey(module: InstalledModuleRecord) {
  return `${module.id}:${module.containers.map(container => container.containerName).join(',')}`;
}

function buildUnavailableApp({
  module,
  metadata,
  reason,
  accessMode,
}: {
  module: InstalledModuleRecord;
  metadata: ModuleMetadata | null;
  reason: HostAppStatusReason;
  accessMode: HostAppAccessMode;
}): HostAppEntry {
  const operationStatus = module.operationStatus || 'installed';
  return {
    id: module.id,
    source: 'installed',
    moduleId: module.id,
    displayName: metadata?.name || module.id,
    ...(metadata?.description ? { description: metadata.description } : {}),
    version: metadata?.version || 'unknown',
    status: 'unavailable',
    statusReason: reason,
    accessMode,
    operationStatus,
    entryPath: buildAppEntryPath(module.id, '/'),
    embeddedUrl: buildEmbeddedUrl(module.id, '/'),
    navigation: [],
  };
}

function buildDeveloperAppCandidate(target: ModuleDevTargetRecord): ModuleAppCandidate {
  if (!target.enabled || !target.shellApp) {
    return {
      app: null,
      visibleToUsers: false,
    };
  }

  const accessMode = getDeveloperShellAccessMode(target.exposurePolicy);

  return {
    app: {
      id: getDeveloperAppId(target.id),
      source: 'developer',
      moduleId: target.moduleId,
      developerTargetId: target.id,
      displayName: target.shellApp.displayName || target.moduleName || target.moduleId,
      ...(target.shellApp.description || target.moduleDescription
        ? { description: target.shellApp.description || target.moduleDescription }
        : {}),
      ...(target.shellApp.icon ? { icon: target.shellApp.icon } : {}),
      version: target.moduleVersion || 'unknown',
      status: 'available',
      statusReason: 'available',
      accessMode,
      entryPath: buildDeveloperAppEntryPath(target.id, target.shellApp.entrypointPath),
      embeddedUrl: buildDeveloperEmbeddedUrl(target.id, target.shellApp.entrypointPath),
      navigation: buildDeveloperNavigation(target.id, target.shellApp.navigation),
    },
    visibleToUsers: true,
  };
}

function getShellAccessMode(
  moduleId: string,
  assignments: ModuleAccessAssignment[]
): HostAppAccessMode {
  return assignments.some(assignment => assignment.moduleId === moduleId)
    ? 'assignedUsersOnly'
    : 'allAuthenticated';
}

function getDeveloperShellAccessMode(exposurePolicy: ModuleExposurePolicy): HostAppAccessMode {
  return exposurePolicy === 'assignedUsersOnly' ? 'assignedUsersOnly' : 'allAuthenticated';
}

function shouldReturnApp(
  candidate: ModuleAppCandidate & { app: HostAppEntry },
  principal: HostPrincipal,
  assignments: ModuleAccessAssignment[]
) {
  if (principal.role === 'host.admin') {
    return true;
  }

  if (!candidate.visibleToUsers) {
    return false;
  }

  if (candidate.app.accessMode === 'allAuthenticated') {
    return true;
  }

  return assignments.some(assignment =>
    assignment.moduleId === candidate.app.moduleId &&
    assignment.userId === principal.id
  );
}

function buildNavigation(
  moduleId: string,
  navigation: ModuleUiMetadata['navigation']
): HostAppNavigationItem[] {
  return navigation.map(item => ({
    label: item.label,
    path: item.path,
    entryPath: buildAppEntryPath(moduleId, item.path),
    embeddedUrl: buildEmbeddedUrl(moduleId, item.path),
  }));
}

function buildDeveloperNavigation(
  targetId: string,
  navigation: NonNullable<ModuleDevTargetRecord['shellApp']>['navigation']
): HostAppNavigationItem[] {
  return navigation.map(item => ({
    label: item.label,
    path: item.path,
    entryPath: buildDeveloperAppEntryPath(targetId, item.path),
    embeddedUrl: buildDeveloperEmbeddedUrl(targetId, item.path),
  }));
}

function buildAppEntryPath(moduleId: string, modulePath: string) {
  const moduleSegment = encodeURIComponent(moduleId);
  return modulePath === '/'
    ? `/apps/${moduleSegment}`
    : `/apps/${moduleSegment}?path=${encodeURIComponent(modulePath)}`;
}

function buildEmbeddedUrl(moduleId: string, modulePath: string) {
  return buildPathShapedEmbedUrl(`/api/apps/${encodeURIComponent(moduleId)}/embed`, modulePath);
}

function getDeveloperAppId(targetId: string) {
  return `dev:${targetId}`;
}

function buildDeveloperAppEntryPath(targetId: string, modulePath: string) {
  const targetSegment = encodeURIComponent(targetId);
  return modulePath === '/'
    ? `/apps/dev/${targetSegment}`
    : `/apps/dev/${targetSegment}?path=${encodeURIComponent(modulePath)}`;
}

function buildDeveloperEmbeddedUrl(targetId: string, modulePath: string) {
  return buildPathShapedEmbedUrl(`/api/apps/dev/${encodeURIComponent(targetId)}/embed`, modulePath);
}

function compareHostApps(left: HostAppEntry, right: HostAppEntry) {
  const nameComparison = left.displayName.localeCompare(right.displayName);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.id.localeCompare(right.id);
}

function buildPathShapedEmbedUrl(embedBasePath: string, modulePath: string) {
  const parsed = new URL(modulePath, 'http://docker-host-embed.local');
  return `${embedBasePath}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
