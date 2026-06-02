import path from 'node:path';
import { readAuthStateSnapshot } from './auth-store.ts';
import { readAppsStoreSnapshot } from './app-store.ts';
import type { InstalledAppRecord } from './app-store.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  readModuleMetadata,
  readModulesStoreSnapshot,
} from './module-store.ts';
import { readModuleDevTargetStateSnapshot } from './module-dev-store.ts';
import { validateAndNormalizeMetadata, validateModuleUiMetadata } from './module-metadata.ts';
import type { HostPrincipal, ModuleAccessAssignment } from '../types/auth.ts';
import type { ModuleExposurePolicy } from '../types/auth.ts';
import type {
  HostAppAccessMode,
  HostAppEntry,
  HostAppNavigationItem,
  HostAppOriginScope,
  HostAppStatusReason,
} from '../types/apps.ts';
import type { ModuleDevTargetRecord } from '../types/module-dev.ts';
import type {
  InstalledModuleRecord,
  ModuleMetadata,
  NormalizedModuleMetadata,
  ModuleRuntimeStatus,
  ModuleUiMetadata,
} from '../types/modules.ts';

export interface ListHostAppsOptions {
  config?: HostRuntimeConfig;
  runtimeStatusReader?: RuntimeStatusReader;
  requestOrigin?: string;
  includeSystemApps?: boolean;
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

type AppRegistryMetadata = (ModuleMetadata | NormalizedModuleMetadata) & {
  selectedRuntime?: string;
};

interface InstalledUiRoute {
  origin: string;
  originScope: HostAppOriginScope;
  embeddedUrl: string;
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
  const [modulesStore, appsStore, authState, developerTargetState] = await Promise.all([
    readModulesStoreSnapshot(config),
    readAppsStoreSnapshot(config),
    readAuthStateSnapshot(config),
    readModuleDevTargetStateSnapshot(config),
  ]);
  const installedModules = mergeInstalledRuntimeRecords(
    modulesStore.modules,
    appsStore.apps,
    config
  );

  const runtimeStatusReader = installedModules.some(module => module.containers.length > 0)
    ? options.runtimeStatusReader ?? (await getDefaultRuntimeStatusReader())
    : null;

  const installedCandidates = installedModules.length > 0
    ? await Promise.all(
        installedModules.map(module =>
          buildModuleAppCandidate(module, authState.moduleAssignments, runtimeStatusReader, config, options.requestOrigin)
        )
      )
    : [];
  const developerCandidates = developerTargetState
    ? developerTargetState.targets.map(target => buildDeveloperAppCandidate(target, options.requestOrigin))
    : [];
  const systemCandidates = options.includeSystemApps && principal.role === 'host.admin'
    ? [buildShellSystemAppCandidate()]
    : [];
  const candidates = [...systemCandidates, ...installedCandidates, ...developerCandidates];

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

function mergeInstalledRuntimeRecords(
  moduleRecords: InstalledModuleRecord[],
  appRecords: InstalledAppRecord[],
  config: HostRuntimeConfig
): InstalledModuleRecord[] {
  const appsById = new Map(appRecords.map(app => [app.id, app]));
  const moduleIds = new Set(moduleRecords.map(module => module.id));
  const mergedModules = moduleRecords.map(module => {
    const app = appsById.get(module.id);
    if (!app) {
      return module;
    }

    return {
      ...module,
      ...(app.manifestUrl && !module.manifestUrl ? { manifestUrl: app.manifestUrl } : {}),
      ...(app.manifestPath && !module.manifestPath ? { manifestPath: app.manifestPath } : {}),
      ...(app.selectedChannel ? { selectedChannel: app.selectedChannel } : {}),
      ...(app.selectedRuntime ? { selectedRuntime: app.selectedRuntime } : {}),
    };
  });
  const appOnlyModules = appRecords
    .filter(app => !moduleIds.has(app.id))
    .map(app => appRecordToInstalledModuleRecord(app, config));

  return [...mergedModules, ...appOnlyModules];
}

function appRecordToInstalledModuleRecord(
  app: InstalledAppRecord,
  config: HostRuntimeConfig
): InstalledModuleRecord {
  const manifestPath = app.manifestPath ?? path.posix.join('apps', app.id, 'manifest.json');
  const resolvedManifestPath = resolveAppManifestPathForModuleRecord(manifestPath, config);

  return {
    id: app.id,
    metadataUrl: app.manifestUrl ?? manifestPath,
    ...(app.manifestUrl ? { manifestUrl: app.manifestUrl } : {}),
    metadataPath: resolvedManifestPath,
    manifestPath: resolvedManifestPath,
    ...(app.selectedChannel ? { selectedChannel: app.selectedChannel } : {}),
    ...(app.selectedRuntime ? { selectedRuntime: app.selectedRuntime } : {}),
    containers: [],
    operationStatus: 'installed',
    installedAt: app.installedAt,
    updatedAt: app.updatedAt,
  };
}

function resolveAppManifestPathForModuleRecord(
  manifestPath: string,
  config: HostRuntimeConfig
) {
  return path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(config.dataRootContainer, manifestPath);
}

async function buildModuleAppCandidate(
  module: InstalledModuleRecord,
  assignments: ModuleAccessAssignment[],
  runtimeStatusReader: RuntimeStatusReader | null,
  config: HostRuntimeConfig,
  requestOrigin: string | undefined
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
  const route = uiResult.ui
    ? resolveInstalledUiRoute(module, metadataResult.metadata, uiResult.ui)
    : null;
  if (!route && uiResult.ui) {
    return {
      app: buildUnavailableApp({
        module,
        metadata: metadataResult.metadata,
        reason: 'uiPortMissing',
        accessMode,
      }),
      visibleToUsers: false,
    };
  }

  if (operationStatus !== 'installed') {
    return {
      app: {
        id: module.id,
        kind: 'runtime',
        system: false,
        source: 'installed',
        moduleId: module.id,
        displayName: metadataResult.metadata.name || module.id,
        ...(metadataResult.metadata.description ? { description: metadataResult.metadata.description } : {}),
        ...(uiResult.ui.icon ? { icon: uiResult.ui.icon } : {}),
        version: metadataResult.metadata.version || 'unknown',
        status: 'unavailable',
        statusReason: 'moduleOperationUnavailable',
        accessMode,
        capabilities: getRuntimeAppCapabilities(module),
        selectedChannel: module.selectedChannel,
        selectedRuntime: getSelectedRuntime(module, metadataResult.metadata),
        operationStatus,
        lastOperation: module.lastOperation,
        entryPath: buildAppEntryPath(module.id, uiResult.ui.entrypoint.path),
        embeddedUrl: route?.embeddedUrl ?? '',
        origin: route?.origin ?? null,
        ...(route ? { originScope: route.originScope } : {}),
        identityTokenUrl: buildIdentityTokenUrl(module.id),
        navigation: route ? buildNavigation(module.id, uiResult.ui.navigation, route.origin) : [],
      },
      visibleToUsers: false,
    };
  }

  if (!runtimeStatusReader) {
    return {
      app: buildUnavailableApp({
        module,
        metadata: metadataResult.metadata,
        reason: 'runtimeUnavailable',
        accessMode,
      }),
      visibleToUsers: false,
    };
  }

  const runtimeStatus = await safeReadRuntimeStatus(module, runtimeStatusReader);
  const runtimeAvailable = runtimeStatus.state === 'running';
  const localOriginReachable = !route ||
    route.originScope !== 'local' ||
    isLocalOriginReachableFromRequest(requestOrigin);
  const available = runtimeAvailable && localOriginReachable;

  return {
    app: {
      id: module.id,
      kind: 'runtime',
      system: false,
      source: 'installed',
      moduleId: module.id,
      displayName: metadataResult.metadata.name || module.id,
      ...(metadataResult.metadata.description ? { description: metadataResult.metadata.description } : {}),
      ...(uiResult.ui.icon ? { icon: uiResult.ui.icon } : {}),
      version: metadataResult.metadata.version || 'unknown',
      status: available ? 'available' : 'unavailable',
      statusReason: runtimeAvailable
        ? (localOriginReachable ? 'available' : 'localOriginUnavailable')
        : 'runtimeUnavailable',
      accessMode,
      capabilities: getRuntimeAppCapabilities(module),
      selectedChannel: module.selectedChannel,
      selectedRuntime: getSelectedRuntime(module, metadataResult.metadata),
      operationStatus,
      lastOperation: module.lastOperation,
      runtimeState: runtimeStatus.state,
      entryPath: buildAppEntryPath(module.id, uiResult.ui.entrypoint.path),
      embeddedUrl: route?.embeddedUrl ?? '',
      origin: route?.origin ?? null,
      ...(route ? { originScope: route.originScope } : {}),
      identityTokenUrl: buildIdentityTokenUrl(module.id),
      navigation: route ? buildNavigation(module.id, uiResult.ui.navigation, route.origin) : [],
    },
    visibleToUsers: runtimeAvailable,
  };
}

async function safeReadInstalledMetadata(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
): Promise<{
  metadata: AppRegistryMetadata | null;
  reason: Extract<HostAppStatusReason, 'metadataMissing' | 'metadataInvalid'>;
}> {
  try {
    const metadata = await readModuleMetadata(module, config);
    const normalizedMetadata = normalizeMetadataForAppRegistry(metadata);
    return {
      metadata: normalizedMetadata,
      reason: metadata ? 'metadataInvalid' : 'metadataMissing',
    };
  } catch {
    return {
      metadata: null,
      reason: 'metadataInvalid',
    };
  }
}

function normalizeMetadataForAppRegistry(
  metadata: ModuleMetadata | null
): AppRegistryMetadata | null {
  if (!metadata) {
    return null;
  }

  if (metadata.schemaVersion !== 'app.0.1') {
    return metadata;
  }

  return validateAndNormalizeMetadata(metadata, '$').metadata;
}

function normalizeInstalledModuleUi(
  metadata: AppRegistryMetadata,
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
  metadata: AppRegistryMetadata | null;
  reason: HostAppStatusReason;
  accessMode: HostAppAccessMode;
}): HostAppEntry {
  const operationStatus = module.operationStatus || 'installed';
  return {
    id: module.id,
    kind: 'runtime',
    system: false,
    source: 'installed',
    moduleId: module.id,
    displayName: metadata?.name || module.id,
    ...(metadata?.description ? { description: metadata.description } : {}),
    version: metadata?.version || 'unknown',
    status: 'unavailable',
    statusReason: reason,
    accessMode,
    capabilities: getRuntimeAppCapabilities(module),
    selectedChannel: module.selectedChannel,
    selectedRuntime: getSelectedRuntime(module, metadata),
    operationStatus,
    lastOperation: module.lastOperation,
    entryPath: buildAppEntryPath(module.id, '/'),
    embeddedUrl: '',
    origin: null,
    identityTokenUrl: null,
    navigation: [],
  };
}

function getSelectedRuntime(
  module: InstalledModuleRecord,
  metadata: AppRegistryMetadata | null
) {
  return module.selectedRuntime ?? metadata?.selectedRuntime ?? 'docker';
}

function buildDeveloperAppCandidate(
  target: ModuleDevTargetRecord,
  requestOrigin: string | undefined
): ModuleAppCandidate {
  if (!target.enabled || !target.shellApp || isSelfReferentialDeveloperTarget(target, requestOrigin)) {
    return {
      app: null,
      visibleToUsers: false,
    };
  }

  const accessMode = getDeveloperShellAccessMode(target.exposurePolicy);
  const origin = resolveDeveloperBrowserOrigin(target, requestOrigin);

  return {
    app: {
      id: getDeveloperAppId(target.id),
      kind: 'runtime',
      system: false,
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
      capabilities: ['open'],
      selectedRuntime: 'localCommand',
      entryPath: buildDeveloperAppEntryPath(target.id, target.shellApp.entrypointPath),
      embeddedUrl: buildDirectUrl(origin, buildDeveloperModulePath(target, target.shellApp.entrypointPath)),
      origin,
      identityTokenUrl: buildDeveloperIdentityTokenUrl(target.id),
      navigation: buildDeveloperNavigation(target.id, target.shellApp.navigation, target, origin),
    },
    visibleToUsers: true,
  };
}

function buildShellSystemAppCandidate(): ModuleAppCandidate {
  return {
    app: {
      id: 'hosty.shell',
      kind: 'system',
      system: true,
      source: 'system',
      moduleId: 'hosty.shell',
      displayName: 'Hosty Shell',
      description: 'Default Hosty management UI.',
      version: process.env.HOST_IMAGE?.trim() || 'bundled',
      status: 'available',
      statusReason: 'available',
      accessMode: 'assignedUsersOnly',
      capabilities: ['open', 'update'],
      selectedRuntime: 'host-core',
      entryPath: '/',
      embeddedUrl: '',
      origin: null,
      identityTokenUrl: null,
      navigation: [],
    },
    visibleToUsers: false,
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
  navigation: ModuleUiMetadata['navigation'],
  origin: string
): HostAppNavigationItem[] {
  return navigation.map(item => ({
    label: item.label,
    path: item.path,
    entryPath: buildAppEntryPath(moduleId, item.path),
    embeddedUrl: buildDirectUrl(origin, item.path),
  }));
}

function buildDeveloperNavigation(
  targetId: string,
  navigation: NonNullable<ModuleDevTargetRecord['shellApp']>['navigation'],
  target: ModuleDevTargetRecord,
  origin: string
): HostAppNavigationItem[] {
  return navigation.map(item => ({
    label: item.label,
    path: item.path,
    entryPath: buildDeveloperAppEntryPath(targetId, item.path),
    embeddedUrl: buildDirectUrl(origin, buildDeveloperModulePath(target, item.path)),
  }));
}

function buildAppEntryPath(moduleId: string, modulePath: string) {
  const moduleSegment = encodeURIComponent(moduleId);
  return modulePath === '/'
    ? `/apps/${moduleSegment}`
    : `/apps/${moduleSegment}?path=${encodeURIComponent(modulePath)}`;
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

function compareHostApps(left: HostAppEntry, right: HostAppEntry) {
  if (left.kind !== right.kind) {
    return left.kind === 'system' ? -1 : 1;
  }

  const nameComparison = left.displayName.localeCompare(right.displayName);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.id.localeCompare(right.id);
}

function getRuntimeAppCapabilities(module: InstalledModuleRecord) {
  const operationStatus = module.operationStatus || 'installed';
  if (operationStatus === 'removing') {
    return [];
  }

  return [
    'open',
    'update',
    'restart',
    'stop',
    'configure',
    'remove',
  ];
}

function resolveInstalledUiRoute(
  module: InstalledModuleRecord,
  metadata: AppRegistryMetadata,
  ui: ModuleUiMetadata
): InstalledUiRoute | null {
  const endpoint = metadata.endpoints?.find(candidate => candidate.key === ui.entrypoint.portKey);
  const endpointContainerKey = endpoint?.container ?? endpoint?.service;
  const container = module.containers.find(candidate => candidate.key === endpointContainerKey);
  const port = container?.ports?.find(candidate =>
    candidate.endpointKey === endpoint?.key ||
    candidate.key === endpoint?.port
  );
  if (!endpoint || !port?.hostPort) {
    return null;
  }

  const originScope: HostAppOriginScope = port.publicOrigin ? 'public' : 'local';
  const origin = port.publicOrigin || buildLocalOrigin(port.hostPort);
  return {
    origin,
    originScope,
    embeddedUrl: buildDirectUrl(origin, ui.entrypoint.path),
  };
}

function buildLocalOrigin(hostPort: number) {
  return `http://localhost:${hostPort}`;
}

function isLocalOriginReachableFromRequest(requestOrigin: string | undefined) {
  const hostOrigin = parseHttpOrigin(requestOrigin);
  return !hostOrigin || isCanonicalLoopbackHostname(hostOrigin.hostname);
}

function buildDirectUrl(origin: string, modulePath: string) {
  const parsed = new URL(modulePath, withTrailingSlash(origin));
  return parsed.toString();
}

function withTrailingSlash(origin: string) {
  return origin.endsWith('/') ? origin : `${origin}/`;
}

function buildIdentityTokenUrl(moduleId: string) {
  return `/api/apps/${encodeURIComponent(moduleId)}/identity-token`;
}

function buildDeveloperIdentityTokenUrl(targetId: string) {
  return `/api/apps/dev/${encodeURIComponent(targetId)}/identity-token`;
}

function resolveDeveloperOrigin(target: ModuleDevTargetRecord) {
  return new URL(target.targetBaseUrl).origin;
}

function isSelfReferentialDeveloperTarget(
  target: ModuleDevTargetRecord,
  requestOrigin: string | undefined
) {
  const targetOrigin = parseHttpOrigin(resolveDeveloperBrowserOrigin(target, requestOrigin));
  const hostOrigin = parseHttpOrigin(requestOrigin);
  if (!targetOrigin || !hostOrigin) {
    return false;
  }

  return isSameHttpOrigin(targetOrigin, hostOrigin);
}

function parseHttpOrigin(value: string | undefined) {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function resolveDeveloperBrowserOrigin(
  target: ModuleDevTargetRecord,
  requestOrigin: string | undefined
) {
  const targetOrigin = parseHttpOrigin(resolveDeveloperOrigin(target));
  const hostOrigin = parseHttpOrigin(requestOrigin);
  if (
    targetOrigin &&
    hostOrigin &&
    isCanonicalLoopbackHostname(targetOrigin.hostname) &&
    isCanonicalLoopbackHostname(hostOrigin.hostname)
  ) {
    targetOrigin.hostname = hostOrigin.hostname;
    return targetOrigin.origin;
  }

  return resolveDeveloperOrigin(target);
}

function isSameHttpOrigin(left: URL, right: URL) {
  return left.protocol === right.protocol &&
    getEffectivePort(left) === getEffectivePort(right) &&
    (
      left.hostname === right.hostname ||
      (isCanonicalLoopbackHostname(left.hostname) && isCanonicalLoopbackHostname(right.hostname))
    );
}

function getEffectivePort(url: URL) {
  if (url.port) {
    return url.port;
  }

  return url.protocol === 'https:' ? '443' : '80';
}

function isCanonicalLoopbackHostname(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1';
}

function buildDeveloperModulePath(target: ModuleDevTargetRecord, modulePath: string) {
  const prefix = target.targetPathPrefix.replace(/\/+$/, '');
  if (!prefix) {
    return modulePath;
  }

  const parsed = new URL(modulePath, 'http://docker-host-dev.local');
  return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
