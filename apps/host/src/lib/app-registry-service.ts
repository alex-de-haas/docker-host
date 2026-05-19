import { readAuthStateSnapshot } from './auth-store.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  readModuleMetadata,
  readModulesStoreSnapshot,
} from './module-store.ts';
import { validateModuleUiMetadata } from './module-metadata.ts';
import type { HostPrincipal, ModuleAccessAssignment } from '../types/auth.ts';
import type {
  HostAppAccessMode,
  HostAppEntry,
  HostAppNavigationItem,
  HostAppStatusReason,
} from '../types/apps.ts';
import type {
  InstalledModuleRecord,
  ModuleMetadata,
  ModuleRuntimeStatus,
  ModuleUiMetadata,
} from '../types/modules.ts';

export interface ListHostAppsOptions {
  config?: HostRuntimeConfig;
  runtimeStatusReader?: (module: InstalledModuleRecord) => Promise<ModuleRuntimeStatus>;
}

interface ModuleAppCandidate {
  app: HostAppEntry | null;
  visibleToUsers: boolean;
}

export async function listHostApps(
  principal: HostPrincipal,
  options: ListHostAppsOptions = {}
): Promise<HostAppEntry[]> {
  const config = options.config ?? getHostRuntimeConfig();
  const runtimeStatusReader = options.runtimeStatusReader ?? await getDefaultRuntimeStatusReader();
  const [modulesStore, authState] = await Promise.all([
    readModulesStoreSnapshot(config),
    readAuthStateSnapshot(config),
  ]);

  const candidates = await Promise.all(
    modulesStore.modules.map(module =>
      buildModuleAppCandidate(module, authState.moduleAssignments, runtimeStatusReader, config)
    )
  );

  return candidates
    .filter(candidate => candidate.app)
    .filter(candidate => shouldReturnApp(candidate as ModuleAppCandidate & { app: HostAppEntry }, principal, authState.moduleAssignments))
    .map(candidate => candidate.app as HostAppEntry)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function getDefaultRuntimeStatusReader() {
  const moduleDocker = await import('./module-docker.ts');
  return moduleDocker.getModuleRuntimeStatus;
}

async function buildModuleAppCandidate(
  module: InstalledModuleRecord,
  assignments: ModuleAccessAssignment[],
  runtimeStatusReader: (module: InstalledModuleRecord) => Promise<ModuleRuntimeStatus>,
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
  const runtimeStatus = await safeReadRuntimeStatus(module, runtimeStatusReader);
  const accessMode = getShellAccessMode(module.id, assignments);
  const available = operationStatus === 'installed' && runtimeStatus.state === 'running';

  return {
    app: {
      id: module.id,
      moduleId: module.id,
      displayName: metadataResult.metadata.name || module.id,
      ...(metadataResult.metadata.description ? { description: metadataResult.metadata.description } : {}),
      ...(uiResult.ui.icon ? { icon: uiResult.ui.icon } : {}),
      version: metadataResult.metadata.version || 'unknown',
      status: available ? 'available' : 'unavailable',
      statusReason: available
        ? 'available'
        : operationStatus !== 'installed'
          ? 'moduleOperationUnavailable'
          : 'runtimeUnavailable',
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
    metadata.runtime?.ports ?? [],
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
  runtimeStatusReader: (module: InstalledModuleRecord) => Promise<ModuleRuntimeStatus>
): Promise<ModuleRuntimeStatus> {
  try {
    return await runtimeStatusReader(module);
  } catch (error) {
    return {
      state: 'unknown',
      containerId: null,
      containerName: module.containerName || module.id,
      startedAt: null,
      finishedAt: null,
      error: error instanceof Error ? error.message : 'Unknown runtime status error',
    };
  }
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

function getShellAccessMode(
  moduleId: string,
  assignments: ModuleAccessAssignment[]
): HostAppAccessMode {
  return assignments.some(assignment => assignment.moduleId === moduleId)
    ? 'assignedUsersOnly'
    : 'allAuthenticated';
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

function buildAppEntryPath(moduleId: string, modulePath: string) {
  const moduleSegment = encodeURIComponent(moduleId);
  return modulePath === '/'
    ? `/apps/${moduleSegment}`
    : `/apps/${moduleSegment}?path=${encodeURIComponent(modulePath)}`;
}

function buildEmbeddedUrl(moduleId: string, modulePath: string) {
  return `/api/apps/${encodeURIComponent(moduleId)}/embed?path=${encodeURIComponent(modulePath)}`;
}
