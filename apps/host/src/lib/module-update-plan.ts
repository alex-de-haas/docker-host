import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists } from '@/lib/host-runtime';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import {
  getDockerDaemonStatus,
  getModuleDockerName,
  getModuleNetworkAlias,
  inspectContainerNameReadOnly,
  inspectModuleNetworkReadOnly,
} from '@/lib/module-docker';
import {
  buildDependencyConnections,
  buildImage,
  buildInstallOrder,
  buildModulePaths,
  buildMountCollections,
  buildSettingPrompts,
  buildStorageDirectories,
  canonicalJson,
  collectEnvironmentTargetConflicts,
} from '@/lib/module-install-plan';
import {
  loadMetadataGraph,
  getModuleMetadataMajor,
  validateAndNormalizeMetadata,
} from '@/lib/module-metadata';
import {
  readModuleMetadata,
  readModulesStoreSnapshot,
  resolveModuleMetadataPath,
} from '@/lib/module-store';
import {
  getStoredExternalMounts,
  getStoredStorageMappings,
  resolveContainerDataPath,
} from '@/lib/module-recovery-model';
import type { MetadataGraph } from '@/lib/module-metadata';
import type {
  InstallPlan,
  InstallPlanConflict,
  InstallPlanDependencyNode,
  InstallPlanErrorEnvelope,
  InstallPlanMountCollection,
  InstallPlanSettingPrompt,
  InstallPlanStorageDirectory,
  InstallPlanValidationError,
  InstalledExternalMountMapping,
  InstalledModuleRecord,
  ModuleUpdateChange,
  ModuleUpdateChangeCategory,
  ModuleUpdatePlan,
  ModuleUpdatePlanResponse,
  ModulesStoreData,
  NormalizedModuleMetadata,
} from '@/types/modules';

type ModuleUpdatePlanStatus = 200 | 404 | 409 | 422 | 503;

export type ModuleUpdatePlanResult = {
  status: ModuleUpdatePlanStatus;
  body: ModuleUpdatePlanResponse;
};

export async function createModuleUpdatePlan(
  moduleId: string,
  config = getHostRuntimeConfig()
): Promise<ModuleUpdatePlanResult> {
  const store = await readModulesStoreSnapshot(config);
  const installedModule = store.modules.find(candidate => candidate.id === moduleId);

  if (!installedModule) {
    return errorResult(404, 'module_not_found', `Module "${moduleId}" is not installed.`);
  }

  const status = installedModule.operationStatus || 'installed';
  if (status !== 'installed' && !(status === 'failed' && installedModule.lastOperation === 'update')) {
    return conflictResult(
      'module_update_status_conflict',
      `Module "${moduleId}" cannot be updated while operationStatus is "${status}".`,
      [{
        code: 'module_update_status_conflict',
        message: 'Only installed modules and failed updates can create an update plan.',
        resourceType: 'installed_module',
        resourceId: moduleId,
        path: '$.operationStatus',
        node: moduleId,
        existingValue: status,
        proposedValue: 'updating',
      }]
    );
  }

  const graphResult = await loadMetadataGraph(installedModule.metadataUrl);
  if (!graphResult.graph || graphResult.validationErrors.length > 0) {
    return {
      status: 422,
      body: {
        error: {
          code: 'update_plan_validation_failed',
          message: 'Refreshed module metadata is invalid.',
          validationErrors: graphResult.validationErrors,
          conflicts: [],
        },
      },
    };
  }

  const graph = graphResult.graph;
  const root = graph.nodes.get(graph.rootId);
  if (!root) {
    return errorResult(422, 'update_plan_validation_failed', 'Refreshed metadata graph is missing the root node.');
  }

  if (root.metadata.id !== moduleId) {
    return {
      status: 422,
      body: {
        error: {
          code: 'update_module_id_mismatch',
          message: `Refreshed metadata id "${root.metadata.id}" does not match installed module "${moduleId}".`,
          validationErrors: [{
            code: 'update_module_id_mismatch',
            message: 'Module update metadata must keep the same module id.',
            path: '$.id',
            node: root.metadata.id,
          }],
          conflicts: [],
        },
      },
    };
  }

  const currentMetadata = await safeReadModuleMetadata(installedModule, config);
  const currentDigest = await readLocalMetadataDigest(installedModule, config);
  const plan = buildUpdatePlan({
    graph,
    store,
    installedModule,
    currentMetadata,
    currentMetadataDigest: currentDigest,
    config,
  });
  const hostConflicts = await collectUpdateHostConflicts({
    rootMetadata: root.metadata,
    planDependencies: plan.dependencies,
    installedModule,
    store,
    config,
  });

  const dockerCheck = await collectUpdateDockerConflicts(plan, store, config);
  if (dockerCheck.status === 503) {
    return {
      status: 503,
      body: { error: dockerCheck.error },
    };
  }

  plan.conflicts = [
    ...hostConflicts,
    ...plan.conflicts,
    ...dockerCheck.conflicts,
  ];

  if (plan.conflicts.length > 0) {
    return {
      status: 409,
      body: {
        plan,
        error: {
          code: 'update_plan_conflict',
          message: 'The update plan conflicts with current Host or Docker state.',
          validationErrors: [],
          conflicts: plan.conflicts,
        },
      },
    };
  }

  return {
    status: 200,
    body: { plan },
  };
}

function buildUpdatePlan({
  graph,
  store,
  installedModule,
  currentMetadata,
  currentMetadataDigest,
  config,
}: {
  graph: MetadataGraph;
  store: ModulesStoreData;
  installedModule: InstalledModuleRecord;
  currentMetadata: NormalizedModuleMetadata | null;
  currentMetadataDigest: string | null;
  config: HostRuntimeConfig;
}): ModuleUpdatePlan {
  const root = graph.nodes.get(graph.rootId);
  if (!root) {
    throw new Error('Update planner invariant failed: root metadata node is missing.');
  }

  const installOrder = buildInstallOrder(graph);
  const dependencies = installOrder
    .filter(moduleId => moduleId !== root.id)
    .map(moduleId => buildUpdateDependencyNode(graph, moduleId, store, config));
  const images = installOrder.map(moduleId => {
    const node = graph.nodes.get(moduleId);
    if (!node) {
      throw new Error(`Update planner invariant failed: metadata node "${moduleId}" is missing.`);
    }
    return buildImage(moduleId, node.metadata);
  });
  const settings = buildUpdateSettingPrompts(root.metadata, installedModule, dependencies);
  const preservedSettings = buildPreservedSettings(root.metadata, installedModule);
  const storageDirectories = buildUpdateStorageDirectories(root.metadata, installedModule, dependencies, config);
  const externalMountPlan = buildUpdateExternalMountPlan(root.metadata, installedModule, dependencies);
  const paths = buildModulePaths(root.id, config);
  const changes = buildUpdateChanges({
    currentMetadata,
    proposedMetadata: root.metadata,
    installedModule,
    dependencies,
    preservedSettings,
    storageDirectories,
    preservedExternalMounts: externalMountPlan.preservedExternalMounts,
    removedExternalMounts: externalMountPlan.removedExternalMounts,
  });
  const replacementReasons = buildReplacementReasons(changes, root.metadata, installedModule);
  const planWithoutDigest = {
    moduleId: root.id,
    metadataUrl: root.metadataUrl,
    currentMetadataDigest,
    refreshedMetadataDigest: graph.rootDigest,
    module: {
      id: root.id,
      currentName: currentMetadata?.name || installedModule.id,
      proposedName: root.metadata.name,
      currentVersion: currentMetadata?.version || 'unknown',
      proposedVersion: root.metadata.version,
      ...(currentMetadata?.description ? { currentDescription: currentMetadata.description } : {}),
      ...(root.metadata.description ? { proposedDescription: root.metadata.description } : {}),
    },
    normalizedMetadata: root.metadata,
    dependencies,
    installOrder,
    images,
    settings,
    preservedSettings,
    storage: {
      directories: storageDirectories,
      mountCollections: externalMountPlan.mountCollections,
      preservedExternalMounts: externalMountPlan.preservedExternalMounts,
      removedExternalMounts: externalMountPlan.removedExternalMounts,
    },
    runtime: {
      ports: root.metadata.runtime.ports.map(port => ({
        ...port,
        hostPublished: false as const,
      })),
      ...(root.metadata.runtime.resources ? { resources: root.metadata.runtime.resources } : {}),
    },
    paths,
    docker: {
      networkName: config.moduleNetwork,
      containerName: installedModule.containerName || getModuleDockerName(root.id),
      networkAliases: [getModuleNetworkAlias(root.id)],
      replacementRequired: replacementReasons.length > 0,
      replacementReasons,
    },
    changes,
    warnings: buildWarnings(changes, externalMountPlan.removedExternalMounts),
    conflicts: [],
  };

  const updatePlanDigest = `sha256:${createHash('sha256')
    .update(canonicalJson(buildUpdateDigestInput(planWithoutDigest)))
    .digest('hex')}`;

  return {
    ...planWithoutDigest,
    updatePlanDigest,
  };
}

function buildUpdateDependencyNode(
  graph: MetadataGraph,
  moduleId: string,
  store: ModulesStoreData,
  config: HostRuntimeConfig
): InstallPlanDependencyNode {
  const node = graph.nodes.get(moduleId);
  if (!node) {
    throw new Error(`Update planner invariant failed: dependency node "${moduleId}" is missing.`);
  }

  const existingModule = store.modules.find(module => module.id === moduleId);

  return {
    id: node.metadata.id,
    name: node.metadata.name,
    ...(node.metadata.description ? { description: node.metadata.description } : {}),
    version: node.metadata.version,
    metadataUrl: node.metadataUrl,
    requiredBy: [...new Set(node.requiredBy)].sort(),
    normalizedMetadata: node.metadata,
    installAction: existingModule ? 'reuse' : 'install',
    docker: {
      containerName: existingModule?.containerName || getModuleDockerName(node.id),
      networkAlias: getModuleNetworkAlias(node.id),
    },
    paths: buildModulePaths(node.id, config),
    connections: buildDependencyConnections(graph, node.id),
  };
}

function buildUpdateSettingPrompts(
  rootMetadata: NormalizedModuleMetadata,
  installedModule: InstalledModuleRecord,
  dependencies: InstallPlanDependencyNode[]
) {
  const rootPrompts = buildSettingPrompts(rootMetadata.id, rootMetadata)
    .filter(prompt => !hasCompatibleStoredSetting(prompt, installedModule));
  const dependencyPrompts = dependencies
    .filter(dependency => dependency.installAction === 'install')
    .flatMap(dependency => buildSettingPrompts(dependency.id, dependency.normalizedMetadata));

  return [...rootPrompts, ...dependencyPrompts];
}

function buildPreservedSettings(
  metadata: NormalizedModuleMetadata,
  installedModule: InstalledModuleRecord
): ModuleUpdatePlan['preservedSettings'] {
  return buildSettingPrompts(metadata.id, metadata)
    .filter(prompt => hasCompatibleStoredSetting(prompt, installedModule))
    .map(prompt => ({
      moduleId: prompt.moduleId,
      key: prompt.key,
      secret: prompt.secret,
      target: prompt.target,
    }));
}

function hasCompatibleStoredSetting(
  prompt: InstallPlanSettingPrompt,
  installedModule: InstalledModuleRecord
) {
  if (!Object.prototype.hasOwnProperty.call(installedModule.settings || {}, prompt.key)) {
    return false;
  }

  const storedMetadataSetting = promptForCurrentSetting(prompt.key, installedModule);
  if (!storedMetadataSetting) {
    return false;
  }

  return storedMetadataSetting.type === prompt.type &&
    storedMetadataSetting.target?.type === prompt.target.type &&
    storedMetadataSetting.target?.name === prompt.target.name;
}

function promptForCurrentSetting(key: string, installedModule: InstalledModuleRecord) {
  return installedModuleMetadataCache.get(installedModule)?.settings.find(setting => setting.key === key) ?? null;
}

const installedModuleMetadataCache = new WeakMap<InstalledModuleRecord, NormalizedModuleMetadata>();

function buildUpdateStorageDirectories(
  rootMetadata: NormalizedModuleMetadata,
  installedModule: InstalledModuleRecord,
  dependencies: InstallPlanDependencyNode[],
  config: HostRuntimeConfig
): InstallPlanStorageDirectory[] {
  const defaultRootDirectories = buildStorageDirectories(rootMetadata.id, rootMetadata, config);
  const storedByKey = new Map(getStoredStorageMappings(installedModule).map(mapping => [mapping.key, mapping]));
  const rootDirectories = defaultRootDirectories.map(directory => {
    const stored = storedByKey.get(directory.key);
    if (!stored) {
      return directory;
    }

    return {
      ...directory,
      hostPath: stored.hostPath,
      containerHostPath: resolveContainerDataPath(stored.hostPath, config) || directory.containerHostPath,
      readOnly: stored.readOnly ?? directory.readOnly,
      writable: stored.writable ?? directory.writable,
      required: stored.required ?? directory.required,
    };
  });
  const dependencyDirectories = dependencies
    .filter(dependency => dependency.installAction === 'install')
    .flatMap(dependency => buildStorageDirectories(dependency.id, dependency.normalizedMetadata, config));

  return [...rootDirectories, ...dependencyDirectories];
}

function buildUpdateExternalMountPlan(
  rootMetadata: NormalizedModuleMetadata,
  installedModule: InstalledModuleRecord,
  dependencies: InstallPlanDependencyNode[]
): {
  mountCollections: InstallPlanMountCollection[];
  preservedExternalMounts: InstalledExternalMountMapping[];
  removedExternalMounts: InstalledExternalMountMapping[];
} {
  const storedMounts = getStoredExternalMounts(installedModule);
  const proposedRootCollections = buildMountCollections(rootMetadata.id, rootMetadata);
  const proposedCollectionKeys = new Set(proposedRootCollections.map(collection => collection.key));
  const preservedExternalMounts = storedMounts.filter(mount =>
    proposedCollectionKeys.has(mount.collectionKey)
  );
  const removedExternalMounts = storedMounts.filter(mount =>
    !proposedCollectionKeys.has(mount.collectionKey)
  );
  const rootCollectionsNeedingInput = proposedRootCollections.flatMap(collection => {
    const preservedCount = preservedExternalMounts.filter(
      mount => mount.collectionKey === collection.key
    ).length;
    const requiredCount = collection.required ? Math.max(0, collection.minItems - preservedCount) : 0;
    const maxItems =
      collection.maxItems === null
        ? null
        : Math.max(0, collection.maxItems - preservedCount);

    if (requiredCount === 0 && maxItems === 0) {
      return [];
    }

    return [{
      ...collection,
      required: requiredCount > 0,
      minItems: requiredCount,
      maxItems,
    }];
  });
  const dependencyCollections = dependencies
    .filter(dependency => dependency.installAction === 'install')
    .flatMap(dependency => buildMountCollections(dependency.id, dependency.normalizedMetadata));

  return {
    mountCollections: [...rootCollectionsNeedingInput, ...dependencyCollections],
    preservedExternalMounts,
    removedExternalMounts,
  };
}

function buildUpdateChanges({
  currentMetadata,
  proposedMetadata,
  installedModule,
  dependencies,
  preservedSettings,
  storageDirectories,
  preservedExternalMounts,
  removedExternalMounts,
}: {
  currentMetadata: NormalizedModuleMetadata | null;
  proposedMetadata: NormalizedModuleMetadata;
  installedModule: InstalledModuleRecord;
  dependencies: InstallPlanDependencyNode[];
  preservedSettings: ModuleUpdatePlan['preservedSettings'];
  storageDirectories: InstallPlanStorageDirectory[];
  preservedExternalMounts: InstalledExternalMountMapping[];
  removedExternalMounts: InstalledExternalMountMapping[];
}): ModuleUpdateChange[] {
  const changes: ModuleUpdateChange[] = [];

  addChangeIfDifferent(changes, {
    category: 'metadata',
    action: 'changed',
    title: 'Module version',
    moduleId: proposedMetadata.id,
    path: '$.version',
    currentValue: currentMetadata?.version,
    proposedValue: proposedMetadata.version,
  });
  addChangeIfDifferent(changes, {
    category: 'image',
    action: 'changed',
    title: 'Docker image',
    moduleId: proposedMetadata.id,
    path: '$.image',
    currentValue: currentMetadata?.image,
    proposedValue: proposedMetadata.image,
  });
  addChangeIfDifferent(changes, {
    category: 'runtime',
    action: 'changed',
    title: 'Runtime ports',
    moduleId: proposedMetadata.id,
    path: '$.runtime.ports',
    currentValue: currentMetadata?.runtime.ports,
    proposedValue: proposedMetadata.runtime.ports,
  });
  addChangeIfDifferent(changes, {
    category: 'runtime',
    action: 'changed',
    title: 'Runtime resources',
    moduleId: proposedMetadata.id,
    path: '$.runtime.resources',
    currentValue: currentMetadata?.runtime.resources,
    proposedValue: proposedMetadata.runtime.resources,
  });

  for (const setting of proposedMetadata.settings) {
    const preserved = preservedSettings.some(candidate => candidate.key === setting.key);
    changes.push({
      category: 'settings',
      action: preserved ? 'preserved' : 'changed',
      title: preserved ? `Setting ${setting.key} preserved` : `Setting ${setting.key} requires review`,
      moduleId: proposedMetadata.id,
      path: `$.settings[?(@.key=="${setting.key}")]`,
      proposedValue: {
        key: setting.key,
        type: setting.type,
        target: setting.target,
        secret: setting.type === 'secret',
      },
    });
  }

  for (const currentSetting of currentMetadata?.settings || []) {
    if (!proposedMetadata.settings.some(setting => setting.key === currentSetting.key)) {
      changes.push({
        category: 'settings',
        action: 'removed',
        title: `Setting ${currentSetting.key} removed`,
        moduleId: proposedMetadata.id,
        path: `$.settings[?(@.key=="${currentSetting.key}")]`,
        currentValue: {
          key: currentSetting.key,
          type: currentSetting.type,
          target: currentSetting.target,
          secret: currentSetting.type === 'secret',
        },
      });
    }
  }

  for (const directory of storageDirectories.filter(directory => directory.moduleId === proposedMetadata.id)) {
    const stored = getStoredStorageMappings(installedModule).find(mapping => mapping.key === directory.key);
    changes.push({
      category: 'storage',
      action: stored ? 'preserved' : 'added',
      title: stored ? `Storage ${directory.key} preserved` : `Storage ${directory.key} added`,
      moduleId: directory.moduleId,
      path: `$.storage.directories[?(@.key=="${directory.key}")]`,
      currentValue: stored,
      proposedValue: directory,
    });
  }

  for (const currentDirectory of currentMetadata?.storage.directories || []) {
    if (!proposedMetadata.storage.directories.some(directory => directory.key === currentDirectory.key)) {
      changes.push({
        category: 'storage',
        action: 'removed',
        title: `Storage ${currentDirectory.key} removed from runtime`,
        moduleId: proposedMetadata.id,
        path: `$.storage.directories[?(@.key=="${currentDirectory.key}")]`,
        currentValue: currentDirectory,
      });
    }
  }

  for (const mount of preservedExternalMounts) {
    changes.push({
      category: 'externalMounts',
      action: 'preserved',
      title: `External mount ${mount.key} preserved`,
      moduleId: proposedMetadata.id,
      path: `$.storage.mountCollections[?(@.key=="${mount.collectionKey}")]`,
      proposedValue: {
        ...mount,
        hostPath: mount.hostPath,
      },
    });
  }

  for (const mount of removedExternalMounts) {
    changes.push({
      category: 'externalMounts',
      action: 'removed',
      title: `External mount ${mount.key} removed from runtime`,
      moduleId: proposedMetadata.id,
      path: `$.storage.mountCollections[?(@.key=="${mount.collectionKey}")]`,
      currentValue: {
        ...mount,
        hostPath: mount.hostPath,
      },
    });
  }

  for (const dependency of dependencies) {
    changes.push({
      category: 'dependencies',
      action: dependency.installAction === 'install' ? 'install' : 'reuse',
      title: `${dependency.installAction === 'install' ? 'Install' : 'Reuse'} dependency ${dependency.id}`,
      moduleId: dependency.id,
      path: '$.dependencies',
      proposedValue: {
        id: dependency.id,
        metadataUrl: dependency.metadataUrl,
        version: dependency.version,
        installAction: dependency.installAction,
      },
    });
  }

  if (proposedMetadata.image.pullPolicy === 'always') {
    changes.push({
      category: 'docker',
      action: 'replace',
      title: 'Image pull policy requires container replacement',
      moduleId: proposedMetadata.id,
      path: '$.image.pullPolicy',
      proposedValue: proposedMetadata.image.pullPolicy,
    });
  }

  return changes;
}

function addChangeIfDifferent(
  changes: ModuleUpdateChange[],
  change: ModuleUpdateChange
) {
  if (canonicalJson(change.currentValue) === canonicalJson(change.proposedValue)) {
    return;
  }
  changes.push(change);
}

function buildReplacementReasons(
  changes: ModuleUpdateChange[],
  proposedMetadata: NormalizedModuleMetadata,
  installedModule: InstalledModuleRecord
) {
  const reasons = new Set<string>();
  const runtimeCategories = new Set<ModuleUpdateChangeCategory>([
    'image',
    'settings',
    'storage',
    'externalMounts',
    'dependencies',
    'runtime',
    'docker',
  ]);

  for (const change of changes) {
    if (runtimeCategories.has(change.category) && change.action !== 'unchanged') {
      reasons.add(change.category);
    }
  }

  if (proposedMetadata.image.pullPolicy === 'always') {
    reasons.add('pullPolicy=always');
  }

  if (!installedModule.containerName) {
    reasons.add('containerName');
  }

  return [...reasons].sort();
}

function buildWarnings(
  changes: ModuleUpdateChange[],
  removedExternalMounts: InstalledExternalMountMapping[]
) {
  const warnings: string[] = [];

  if (changes.some(change => change.category === 'storage' && change.action === 'removed')) {
    warnings.push('Removed module-owned storage declarations are not deleted automatically.');
  }

  if (removedExternalMounts.length > 0) {
    warnings.push('External host paths removed from runtime are not deleted from the filesystem.');
  }

  return warnings;
}

async function collectUpdateHostConflicts({
  rootMetadata,
  planDependencies,
  installedModule,
  store,
  config,
}: {
  rootMetadata: NormalizedModuleMetadata;
  planDependencies: InstallPlanDependencyNode[];
  installedModule: InstalledModuleRecord;
  store: ModulesStoreData;
  config: HostRuntimeConfig;
}) {
  const conflicts: InstallPlanConflict[] = [];
  const existingById = new Map(store.modules.map(module => [module.id, module]));
  const fakePlan = buildEnvironmentConflictPlan({
    rootMetadata,
    planDependencies,
    installedModule,
    config,
  });

  conflicts.push(...collectEnvironmentTargetConflicts(fakePlan));

  for (const dependency of planDependencies) {
    const existing = existingById.get(dependency.id);

    if (!existing) {
      continue;
    }

    if ((existing.operationStatus || 'installed') !== 'installed') {
      conflicts.push({
        code: 'update_dependency_status_conflict',
        message: `Dependency "${dependency.id}" has operationStatus "${existing.operationStatus}".`,
        resourceType: 'installed_module',
        resourceId: dependency.id,
        path: '$.dependencies',
        node: dependency.id,
        existingValue: existing.operationStatus,
        proposedValue: 'installed',
      });
      continue;
    }

    if (existing.metadataUrl !== dependency.metadataUrl) {
      conflicts.push({
        code: 'update_dependency_metadata_url_conflict',
        message: `Installed dependency "${dependency.id}" uses a different metadata URL.`,
        resourceType: 'installed_module',
        resourceId: dependency.id,
        path: '$.dependencies',
        node: dependency.id,
        existingValue: existing.metadataUrl,
        proposedValue: dependency.metadataUrl,
      });
    }

    const existingMetadata = await safeReadModuleMetadata(existing, config);
    const existingMajor = existingMetadata ? getModuleMetadataMajor(existingMetadata.version) : null;
    const proposedMajor = getModuleMetadataMajor(dependency.version);
    if (existingMajor && proposedMajor && existingMajor !== proposedMajor) {
      conflicts.push({
        code: 'update_dependency_version_conflict',
        message: `Installed dependency "${dependency.id}" has incompatible major version.`,
        resourceType: 'installed_module',
        resourceId: dependency.id,
        path: '$.dependencies',
        node: dependency.id,
        existingValue: existingMajor,
        proposedValue: proposedMajor,
      });
    }
  }

  const plannedStoragePaths = new Map(
    fakePlan.storage.directories.map(directory => [path.resolve(directory.hostPath), directory])
  );
  const plannedModuleIds = new Set([rootMetadata.id, ...planDependencies.map(dependency => dependency.id)]);

  for (const installedOtherModule of store.modules) {
    if (plannedModuleIds.has(installedOtherModule.id)) {
      continue;
    }

    for (const mapping of getStoredStorageMappings(installedOtherModule)) {
      const planned = plannedStoragePaths.get(path.resolve(mapping.hostPath));
      if (!planned) {
        continue;
      }

      conflicts.push({
        code: 'storage_mapping_conflict',
        message: `Storage host path "${mapping.hostPath}" conflicts with installed module "${installedOtherModule.id}".`,
        resourceType: 'storage_mapping',
        resourceId: mapping.hostPath,
        path: '$.storage.directories',
        node: planned.moduleId,
        existingValue: installedOtherModule.id,
        proposedValue: planned.moduleId,
      });
    }
  }

  return conflicts;
}

function buildEnvironmentConflictPlan({
  rootMetadata,
  planDependencies,
  installedModule,
  config,
}: {
  rootMetadata: NormalizedModuleMetadata;
  planDependencies: InstallPlanDependencyNode[];
  installedModule: InstalledModuleRecord;
  config: HostRuntimeConfig;
}): InstallPlan {
  const paths = buildModulePaths(rootMetadata.id, config);

  return {
    metadataUrl: installedModule.metadataUrl,
    metadataDigest: installedModule.metadataDigest || '',
    planDigest: '',
    module: {
      id: rootMetadata.id,
      name: rootMetadata.name,
      ...(rootMetadata.description ? { description: rootMetadata.description } : {}),
      version: rootMetadata.version,
    },
    normalizedMetadata: rootMetadata,
    dependencies: planDependencies,
    installOrder: [rootMetadata.id, ...planDependencies.map(dependency => dependency.id)],
    images: [buildImage(rootMetadata.id, rootMetadata), ...planDependencies.map(dependency => buildImage(dependency.id, dependency.normalizedMetadata))],
    settings: buildSettingPrompts(rootMetadata.id, rootMetadata),
    storage: {
      directories: [
        ...buildStorageDirectories(rootMetadata.id, rootMetadata, config),
        ...planDependencies
          .filter(dependency => dependency.installAction === 'install')
          .flatMap(dependency => buildStorageDirectories(dependency.id, dependency.normalizedMetadata, config)),
      ],
      mountCollections: [],
    },
    runtime: {
      ports: rootMetadata.runtime.ports.map(port => ({ ...port, hostPublished: false })),
      ...(rootMetadata.runtime.resources ? { resources: rootMetadata.runtime.resources } : {}),
    },
    paths,
    docker: {
      networkName: config.moduleNetwork,
      containerName: installedModule.containerName || getModuleDockerName(rootMetadata.id),
      networkAliases: [getModuleNetworkAlias(rootMetadata.id)],
    },
    conflicts: [],
  };
}

async function collectUpdateDockerConflicts(
  plan: ModuleUpdatePlan,
  store: ModulesStoreData,
  config: HostRuntimeConfig
): Promise<
  | {
      status: 200;
      conflicts: InstallPlanConflict[];
    }
  | {
      status: 503;
      error: InstallPlanErrorEnvelope;
    }
> {
  const dockerStatus = await getDockerDaemonStatus();
  if (!dockerStatus.connected) {
    return {
      status: 503,
      error: {
        code: 'docker_unavailable',
        message: 'Docker daemon must be reachable before an update plan can be returned.',
        validationErrors: [],
        conflicts: [],
      },
    };
  }

  const conflicts: InstallPlanConflict[] = [];
  const existingById = new Map(store.modules.map(module => [module.id, module]));

  for (const dependency of plan.dependencies) {
    const installed = existingById.get(dependency.id);
    const containerName = installed?.containerName || dependency.docker.containerName;
    const container = await inspectContainerNameReadOnly(containerName);

    if (dependency.installAction === 'reuse' && !container.exists) {
      conflicts.push({
        code: 'update_dependency_container_missing',
        message: `Reusable dependency "${dependency.id}" is missing Docker container "${containerName}".`,
        resourceType: 'docker_container',
        resourceId: containerName,
        path: '$.dependencies',
        node: dependency.id,
        existingValue: null,
        proposedValue: containerName,
      });
    }

    if (dependency.installAction === 'install' && container.exists) {
      conflicts.push({
        code: 'container_name_conflict',
        message: `Container name "${containerName}" already exists in Docker.`,
        resourceType: 'docker_container',
        resourceId: containerName,
        path: '$.dependencies',
        node: dependency.id,
        existingValue: container.id,
        proposedValue: containerName,
      });
    }
  }

  const network = await inspectModuleNetworkReadOnly(config);
  if (network.exists) {
    const allowedNames = new Set([
      plan.docker.containerName,
      ...plan.dependencies
        .filter(dependency => dependency.installAction === 'reuse')
        .map(dependency => existingById.get(dependency.id)?.containerName || dependency.docker.containerName),
    ]);
    const targets = [
      { moduleId: plan.moduleId, alias: plan.docker.networkAliases[0] },
      ...plan.dependencies.map(dependency => ({
        moduleId: dependency.id,
        alias: dependency.docker.networkAlias,
      })),
    ];

    for (const target of targets) {
      const alias = network.aliases.find(candidate => candidate.alias === target.alias);
      if (!alias || allowedNames.has(alias.containerName)) {
        continue;
      }

      conflicts.push({
        code: 'network_alias_conflict',
        message: `Network alias "${target.alias}" is already used on Docker network "${config.moduleNetwork}".`,
        resourceType: 'docker_network_alias',
        resourceId: target.alias,
        path: '$.docker.networkAliases',
        node: target.moduleId,
        existingValue: alias.containerName,
        proposedValue: target.alias,
      });
    }
  }

  return { status: 200, conflicts };
}

function buildUpdateDigestInput(
  plan: Omit<ModuleUpdatePlan, 'updatePlanDigest'>
) {
  return {
    moduleId: plan.moduleId,
    metadataUrl: plan.metadataUrl,
    refreshedMetadataDigest: plan.refreshedMetadataDigest,
    module: plan.module,
    normalizedMetadata: plan.normalizedMetadata,
    dependencies: plan.dependencies,
    installOrder: plan.installOrder,
    images: plan.images,
    settings: plan.settings.map(setting => ({
      ...setting,
      ...(setting.secret ? { default: undefined, redacted: true } : {}),
    })),
    preservedSettings: plan.preservedSettings,
    storage: plan.storage,
    runtime: plan.runtime,
    paths: plan.paths,
    docker: plan.docker,
    changes: plan.changes.map(change => ({
      ...change,
      currentValue: redactDigestValue(change.currentValue),
      proposedValue: redactDigestValue(change.proposedValue),
    })),
  };
}

function redactDigestValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redactDigestValue);
  }

  const object = value as Record<string, unknown>;
  if (object.secret === true) {
    return {
      ...object,
      value: '<redacted>',
      currentValue: '<redacted>',
      proposedValue: '<redacted>',
    };
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, redactDigestValue(entry)])
  );
}

async function safeReadModuleMetadata(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
): Promise<NormalizedModuleMetadata | null> {
  try {
    const metadata = await readModuleMetadata(module, config);
    if (!metadata) {
      return null;
    }

    const normalized = validateAndNormalizeMetadata(metadata, '$').metadata;
    if (normalized) {
      installedModuleMetadataCache.set(module, normalized);
    }
    return normalized;
  } catch {
    return null;
  }
}

async function readLocalMetadataDigest(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
) {
  const metadataPath = resolveModuleMetadataPath(module, config);
  if (!(await pathExists(metadataPath))) {
    return null;
  }

  const raw = await fs.readFile(metadataPath);
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function conflictResult(
  code: string,
  message: string,
  conflicts: InstallPlanConflict[]
): ModuleUpdatePlanResult {
  return {
    status: 409,
    body: {
      error: {
        code,
        message,
        validationErrors: [],
        conflicts,
      },
    },
  };
}

function errorResult(
  status: 404 | 422,
  code: string,
  message: string,
  validationErrors: InstallPlanValidationError[] = []
): ModuleUpdatePlanResult {
  return {
    status,
    body: {
      error: {
        code,
        message,
        validationErrors,
        conflicts: [],
      },
    },
  };
}
