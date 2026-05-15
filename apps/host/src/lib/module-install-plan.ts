import { createHash } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig } from '@/lib/host-runtime';
import {
  getDockerDaemonStatus,
  getModuleDockerName,
  getModuleNetworkAlias,
  inspectContainerNameReadOnly,
  inspectModuleNetworkReadOnly,
} from '@/lib/module-docker';
import { loadMetadataGraph } from '@/lib/module-metadata';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import type { MetadataGraph } from '@/lib/module-metadata';
import { readModulesStoreSnapshot } from '@/lib/module-store';
import type {
  InstallPlan,
  InstallPlanConflict,
  InstallPlanDependencyConnection,
  InstallPlanDependencyNode,
  InstallPlanErrorEnvelope,
  InstallPlanImage,
  InstallPlanMountCollection,
  InstallPlanSettingPrompt,
  InstallPlanStorageDirectory,
  InstallPlanValidationError,
  InstalledModuleRecord,
  InstalledStorageMapping,
  ModulesStoreData,
  NormalizedModuleMetadata,
} from '@/types/modules';

export type InstallPlanResult =
  | {
      status: 200;
      body: { plan: InstallPlan };
    }
  | {
      status: 409;
      body: { plan: InstallPlan; error: InstallPlanErrorEnvelope };
    }
  | {
      status: 422 | 503;
      body: { error: InstallPlanErrorEnvelope };
    };

export async function createInstallPlan(metadataUrl: string): Promise<InstallPlanResult> {
  const { result } = await createInstallPlanWithGraph(metadataUrl);
  return result;
}

export async function createInstallPlanWithGraph(
  metadataUrl: string
): Promise<{ result: InstallPlanResult; graph: MetadataGraph | null }> {
  const graphResult = await loadMetadataGraph(metadataUrl);

  if (!graphResult.graph || graphResult.validationErrors.length > 0) {
    return {
      graph: null,
      result: {
        status: 422,
        body: {
          error: {
            code: 'install_plan_validation_failed',
            message: 'Module metadata is invalid.',
            validationErrors: graphResult.validationErrors,
            conflicts: [],
          },
        },
      },
    };
  }

  const config = getHostRuntimeConfig();
  const store = await readModulesStoreSnapshot(config);
  const plan = buildPlan(graphResult.graph, store, config);
  const hostConflicts = collectHostStateConflicts(plan, store);

  let dockerConflicts: InstallPlanConflict[];
  try {
    const dockerCheck = await collectDockerConflicts(plan, store, config);
    if (dockerCheck.status === 503) {
      return {
        graph: graphResult.graph,
        result: dockerCheck,
      };
    }
    dockerConflicts = dockerCheck.conflicts;
  } catch (error) {
    return {
      graph: graphResult.graph,
      result: dockerUnavailableResult(error),
    };
  }

  const conflicts = [...hostConflicts, ...dockerConflicts];
  plan.conflicts = conflicts;

  if (conflicts.length > 0) {
    return {
      graph: graphResult.graph,
      result: {
        status: 409,
        body: {
          plan,
          error: {
            code: 'install_plan_conflict',
            message: 'The install plan conflicts with current Host or Docker state.',
            validationErrors: [],
            conflicts,
          },
        },
      },
    };
  }

  return {
    graph: graphResult.graph,
    result: {
      status: 200,
      body: { plan },
    },
  };
}

function buildPlan(
  graph: MetadataGraph,
  store: ModulesStoreData,
  config: HostRuntimeConfig
): InstallPlan {
  const root = graph.nodes.get(graph.rootId);
  if (!root) {
    throw new Error('Install planner invariant failed: root metadata node is missing.');
  }

  const installOrder = buildInstallOrder(graph);
  const orderedNodes = installOrder.map(moduleId => {
    const node = graph.nodes.get(moduleId);
    if (!node) {
      throw new Error(`Install planner invariant failed: metadata node "${moduleId}" is missing.`);
    }

    return node;
  });
  const dependencies = orderedNodes
    .filter(node => node.id !== graph.rootId)
    .map(node => buildDependencyNode(graph, node.id, store, config));
  const images = orderedNodes.map(node => buildImage(node.id, node.metadata));
  const administratorInputModuleIds = new Set([
    graph.rootId,
    ...dependencies
      .filter(dependency => dependency.installAction === 'install')
      .map(dependency => dependency.id),
  ]);
  const nodesRequiringAdministratorInput = orderedNodes.filter(node =>
    administratorInputModuleIds.has(node.id)
  );
  const settings = nodesRequiringAdministratorInput.flatMap(node =>
    buildSettingPrompts(node.id, node.metadata)
  );
  const directories = orderedNodes.flatMap(node => buildStorageDirectories(node.id, node.metadata, config));
  const mountCollections = nodesRequiringAdministratorInput.flatMap(node =>
    buildMountCollections(node.id, node.metadata)
  );
  const rootPaths = buildModulePaths(root.id, config);
  const rootContainerName = getModuleDockerName(root.id);
  const rootNetworkAlias = getModuleNetworkAlias(root.id);

  const planWithoutDigest: Omit<InstallPlan, 'planDigest'> = {
    metadataUrl: root.metadataUrl,
    metadataDigest: graph.rootDigest,
    module: {
      id: root.metadata.id,
      name: root.metadata.name,
      ...(root.metadata.description ? { description: root.metadata.description } : {}),
      version: root.metadata.version,
    },
    normalizedMetadata: root.metadata,
    dependencies,
    installOrder,
    images,
    settings,
    storage: {
      directories,
      mountCollections,
    },
    runtime: {
      ports: root.metadata.runtime.ports.map(port => ({
        ...port,
        hostPublished: false,
      })),
      ...(root.metadata.runtime.resources ? { resources: root.metadata.runtime.resources } : {}),
    },
    paths: rootPaths,
    docker: {
      networkName: config.moduleNetwork,
      containerName: rootContainerName,
      networkAliases: [rootNetworkAlias],
    },
    conflicts: [],
  };
  const planDigest = `sha256:${createHash('sha256')
    .update(canonicalJson(buildDigestInput(planWithoutDigest)))
    .digest('hex')}`;

  return {
    ...planWithoutDigest,
    planDigest,
  };
}

function buildDependencyNode(
  graph: MetadataGraph,
  moduleId: string,
  store: ModulesStoreData,
  config: HostRuntimeConfig
): InstallPlanDependencyNode {
  const node = graph.nodes.get(moduleId);
  if (!node) {
    throw new Error(`Install planner invariant failed: dependency node "${moduleId}" is missing.`);
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
      containerName: getModuleDockerName(node.id),
      networkAlias: getModuleNetworkAlias(node.id),
    },
    paths: buildModulePaths(node.id, config),
    connections: buildDependencyConnections(graph, node.id),
  };
}

function buildDependencyConnections(
  graph: MetadataGraph,
  dependencyId: string
): InstallPlanDependencyConnection[] {
  const connections: InstallPlanDependencyConnection[] = [];
  const dependencyNode = graph.nodes.get(dependencyId);

  if (!dependencyNode) {
    return connections;
  }

  for (const consumer of graph.nodes.values()) {
    for (const edge of consumer.dependencies) {
      if (edge.dependencyId !== dependencyId || !edge.declaration.connection) {
        continue;
      }

      const endpoint = dependencyNode.metadata.runtime.ports.find(
        port => port.key === edge.declaration.connection?.endpoint
      );

      if (!endpoint) {
        continue;
      }

      connections.push({
        consumerId: consumer.id,
        dependencyId,
        endpoint: edge.declaration.connection.endpoint,
        baseUrlEnv: edge.declaration.connection.baseUrlEnv,
        resolvedBaseUrl: `http://${getModuleNetworkAlias(dependencyId)}:${endpoint.containerPort}`,
      });
    }
  }

  return connections.sort((first, second) => first.consumerId.localeCompare(second.consumerId));
}

function buildInstallOrder(
  graph: MetadataGraph
) {
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(moduleId: string) {
    if (visited.has(moduleId)) {
      return;
    }

    visited.add(moduleId);
    const node = graph.nodes.get(moduleId);
    if (!node) {
      return;
    }

    for (const dependency of node.dependencies) {
      visit(dependency.dependencyId);
    }

    order.push(moduleId);
  }

  visit(graph.rootId);
  return order;
}

function buildImage(moduleId: string, metadata: NormalizedModuleMetadata): InstallPlanImage {
  return {
    moduleId,
    repository: metadata.image.repository,
    tag: metadata.image.tag,
    reference: `${metadata.image.repository}:${metadata.image.tag}`,
    pullPolicy: metadata.image.pullPolicy,
  };
}

function buildSettingPrompts(
  moduleId: string,
  metadata: NormalizedModuleMetadata
): InstallPlanSettingPrompt[] {
  return metadata.settings.map(setting => ({
    moduleId,
    key: setting.key,
    type: setting.type,
    required: setting.required,
    target: setting.target,
    ...(setting.type !== 'secret' && Object.prototype.hasOwnProperty.call(setting, 'default')
      ? { default: setting.default }
      : {}),
    secret: setting.type === 'secret',
    redacted: setting.type === 'secret',
  }));
}

function buildStorageDirectories(
  moduleId: string,
  metadata: NormalizedModuleMetadata,
  config: HostRuntimeConfig
): InstallPlanStorageDirectory[] {
  const modulePaths = buildModulePaths(moduleId, config);

  return metadata.storage.directories.map(directory => {
    const modulePathSegments = directory.mount.modulePath.split('/');
    const hostPath = path.join(modulePaths.moduleDirectoryHost, ...modulePathSegments);
    const containerHostPath = path.join(modulePaths.moduleDirectoryContainer, ...modulePathSegments);

    return {
      moduleId,
      key: directory.key,
      containerPath: directory.containerPath,
      modulePath: directory.mount.modulePath,
      hostPath,
      containerHostPath,
      required: directory.required,
      writable: directory.writable,
      readOnly: !directory.writable,
    };
  });
}

function buildMountCollections(
  moduleId: string,
  metadata: NormalizedModuleMetadata
): InstallPlanMountCollection[] {
  return metadata.storage.mountCollections.map(collection => ({
    moduleId,
    ...collection,
  }));
}

function buildModulePaths(moduleId: string, config: HostRuntimeConfig) {
  const moduleDirectoryHost = path.join(config.dataRootHost, 'modules', moduleId);
  const moduleDirectoryContainer = path.join(config.modulesRootContainer, moduleId);

  return {
    moduleDirectoryHost,
    moduleDirectoryContainer,
    metadataPathHost: path.join(moduleDirectoryHost, 'metadata.json'),
    metadataPathContainer: path.join(moduleDirectoryContainer, 'metadata.json'),
  };
}

function collectHostStateConflicts(plan: InstallPlan, store: ModulesStoreData) {
  const conflicts: InstallPlanConflict[] = [];
  const existingById = new Map(store.modules.map(module => [module.id, module]));
  const plannedModuleIds = new Set(plan.installOrder);
  const plannedContainerNames = new Map<string, string>();
  const plannedNetworkAliases = new Map<string, string>();
  const plannedStoragePaths = new Map<string, InstallPlanStorageDirectory>();

  const rootExisting = existingById.get(plan.module.id);
  if (rootExisting) {
    conflicts.push({
      code: 'module_id_conflict',
      message: `Module "${plan.module.id}" is already installed.`,
      resourceType: 'installed_module',
      resourceId: plan.module.id,
      path: '$.id',
      node: plan.module.id,
      existingValue: rootExisting.metadataUrl,
      proposedValue: plan.metadataUrl,
    });
  }

  for (const nodeId of plan.installOrder) {
    const nodeContainerName = nodeId === plan.module.id
      ? plan.docker.containerName
      : plan.dependencies.find(dependency => dependency.id === nodeId)?.docker.containerName;
    const nodeAlias = nodeId === plan.module.id
      ? plan.docker.networkAliases[0]
      : plan.dependencies.find(dependency => dependency.id === nodeId)?.docker.networkAlias;

    if (nodeContainerName) {
      const existingNode = plannedContainerNames.get(nodeContainerName);
      if (existingNode && existingNode !== nodeId) {
        conflicts.push({
          code: 'container_name_conflict',
          message: `Generated container name "${nodeContainerName}" is used by multiple planned modules.`,
          resourceType: 'docker_container',
          resourceId: nodeContainerName,
          path: '$.id',
          node: nodeId,
          existingValue: existingNode,
          proposedValue: nodeId,
        });
      }
      plannedContainerNames.set(nodeContainerName, nodeId);
    }

    if (nodeAlias) {
      const existingNode = plannedNetworkAliases.get(nodeAlias);
      if (existingNode && existingNode !== nodeId) {
        conflicts.push({
          code: 'network_alias_conflict',
          message: `Generated network alias "${nodeAlias}" is used by multiple planned modules.`,
          resourceType: 'docker_network_alias',
          resourceId: nodeAlias,
          path: '$.id',
          node: nodeId,
          existingValue: existingNode,
          proposedValue: nodeId,
        });
      }
      plannedNetworkAliases.set(nodeAlias, nodeId);
    }
  }

  for (const dependency of plan.dependencies) {
    const existing = existingById.get(dependency.id);
    if (existing && existing.metadataUrl !== dependency.metadataUrl) {
      conflicts.push({
        code: 'installed_dependency_metadata_url_conflict',
        message: `Installed dependency "${dependency.id}" uses a different metadata URL.`,
        resourceType: 'installed_module',
        resourceId: dependency.id,
        path: '$.dependencies',
        node: dependency.id,
        existingValue: existing.metadataUrl,
        proposedValue: dependency.metadataUrl,
      });
    }
  }

  for (const installedModule of store.modules) {
    if (plannedModuleIds.has(installedModule.id)) {
      continue;
    }

    const existingContainerName =
      installedModule.containerName || getModuleDockerName(installedModule.id);
    const plannedContainerOwner = plannedContainerNames.get(existingContainerName);

    if (plannedContainerOwner) {
      conflicts.push({
        code: 'container_name_conflict',
        message: `Generated container name "${existingContainerName}" conflicts with installed module "${installedModule.id}".`,
        resourceType: 'docker_container',
        resourceId: existingContainerName,
        path: '$.id',
        node: plannedContainerOwner,
        existingValue: installedModule.id,
        proposedValue: plannedContainerOwner,
      });
    }

    const existingAlias = getModuleNetworkAlias(installedModule.id);
    const plannedAliasOwner = plannedNetworkAliases.get(existingAlias);

    if (plannedAliasOwner) {
      conflicts.push({
        code: 'network_alias_conflict',
        message: `Generated network alias "${existingAlias}" conflicts with installed module "${installedModule.id}".`,
        resourceType: 'docker_network_alias',
        resourceId: existingAlias,
        path: '$.id',
        node: plannedAliasOwner,
        existingValue: installedModule.id,
        proposedValue: plannedAliasOwner,
      });
    }
  }

  for (const conflict of collectEnvironmentTargetConflicts(plan)) {
    conflicts.push(conflict);
  }

  for (const directory of plan.storage.directories) {
    const normalized = normalizeHostPath(directory.hostPath);
    const existing = plannedStoragePaths.get(normalized);

    if (existing && existing.moduleId !== directory.moduleId) {
      conflicts.push({
        code: 'storage_mapping_conflict',
        message: `Storage host path "${directory.hostPath}" is used by multiple planned modules.`,
        resourceType: 'storage_mapping',
        resourceId: directory.hostPath,
        path: '$.storage.directories',
        node: directory.moduleId,
        existingValue: existing.moduleId,
        proposedValue: directory.moduleId,
      });
    }

    plannedStoragePaths.set(normalized, directory);
  }

  for (const installedModule of store.modules) {
    if (plannedModuleIds.has(installedModule.id)) {
      continue;
    }

    for (const existingMapping of getInstalledStorageMappings(installedModule)) {
      const planned = plannedStoragePaths.get(normalizeHostPath(existingMapping.hostPath));

      if (planned) {
        conflicts.push({
          code: 'storage_mapping_conflict',
          message: `Storage host path "${existingMapping.hostPath}" conflicts with installed module "${installedModule.id}".`,
          resourceType: 'storage_mapping',
          resourceId: existingMapping.hostPath,
          path: '$.storage.directories',
          node: planned.moduleId,
          existingValue: installedModule.id,
          proposedValue: planned.moduleId,
        });
      }
    }
  }

  return conflicts;
}

function collectEnvironmentTargetConflicts(plan: InstallPlan): InstallPlanConflict[] {
  const conflicts: InstallPlanConflict[] = [];
  const metadataById = new Map<string, NormalizedModuleMetadata>([
    [plan.module.id, plan.normalizedMetadata],
    ...plan.dependencies.map(dependency => [dependency.id, dependency.normalizedMetadata] as const),
  ]);

  for (const [moduleId, metadata] of metadataById) {
    const envTargets = new Map<string, { path: string; source: string }>();

    metadata.settings.forEach((setting, index) => {
      addEnvTarget({
        envTargets,
        conflicts,
        moduleId,
        name: setting.target.name,
        path: moduleId === plan.module.id
          ? `$.settings[${index}].target.name`
          : `$.dependencies[?(@.id=="${moduleId}")].normalizedMetadata.settings[${index}].target.name`,
        source: `setting:${setting.key}`,
      });
    });

    metadata.dependencies.forEach((dependency, index) => {
      if (!dependency.connection) {
        return;
      }

      addEnvTarget({
        envTargets,
        conflicts,
        moduleId,
        name: dependency.connection.baseUrlEnv,
        path: moduleId === plan.module.id
          ? `$.dependencies[${index}].connection.baseUrlEnv`
          : `$.dependencies[?(@.id=="${moduleId}")].normalizedMetadata.dependencies[${index}].connection.baseUrlEnv`,
        source: `dependency:${dependency.id}`,
      });
    });
  }

  return conflicts;
}

function addEnvTarget({
  envTargets,
  conflicts,
  moduleId,
  name,
  path: targetPath,
  source,
}: {
  envTargets: Map<string, { path: string; source: string }>;
  conflicts: InstallPlanConflict[];
  moduleId: string;
  name: string;
  path: string;
  source: string;
}) {
  const existing = envTargets.get(name);

  if (existing) {
    conflicts.push({
      code: 'environment_variable_target_conflict',
      message: `Environment variable "${name}" is assigned by multiple plan inputs for module "${moduleId}".`,
      resourceType: 'environment_variable',
      resourceId: name,
      path: targetPath,
      node: moduleId,
      existingValue: existing.source,
      proposedValue: source,
    });
    return;
  }

  envTargets.set(name, { path: targetPath, source });
}

async function collectDockerConflicts(
  plan: InstallPlan,
  store: ModulesStoreData,
  config: HostRuntimeConfig
): Promise<
  | {
      status: 200;
      conflicts: InstallPlanConflict[];
    }
  | {
      status: 503;
      body: { error: InstallPlanErrorEnvelope };
    }
> {
  const dockerStatus = await getDockerDaemonStatus();
  if (!dockerStatus.connected) {
    return {
      status: 503,
      body: {
        error: {
          code: 'docker_unavailable',
          message: 'Docker daemon must be reachable before an install plan can be returned.',
          validationErrors: [],
          conflicts: [],
        },
      },
    };
  }

  const conflicts: InstallPlanConflict[] = [];
  const existingById = new Map(store.modules.map(module => [module.id, module]));
  const plannedDockerTargets = new Map<string, { moduleId: string; containerName: string; alias: string }>();

  plannedDockerTargets.set(plan.module.id, {
    moduleId: plan.module.id,
    containerName: plan.docker.containerName,
    alias: plan.docker.networkAliases[0],
  });

  for (const dependency of plan.dependencies) {
    const installed = existingById.get(dependency.id);

    plannedDockerTargets.set(dependency.id, {
      moduleId: dependency.id,
      containerName: installed?.containerName || dependency.docker.containerName,
      alias: dependency.docker.networkAlias,
    });
  }

  for (const target of plannedDockerTargets.values()) {
    const status = await inspectContainerNameReadOnly(target.containerName);
    const reusable = isReusableInstalledDependency(target.moduleId, plan.module.id, existingById);

    if (!status.exists && reusable) {
      conflicts.push({
        code: 'reusable_dependency_conflict',
        message: `Reusable dependency "${target.moduleId}" is missing Docker container "${target.containerName}".`,
        resourceType: 'docker_container',
        resourceId: target.containerName,
        path: '$.dependencies',
        node: target.moduleId,
        existingValue: null,
        proposedValue: target.containerName,
      });
      continue;
    }

    if (status.exists && !reusable) {
      conflicts.push({
        code: 'container_name_conflict',
        message: `Container name "${target.containerName}" already exists in Docker.`,
        resourceType: 'docker_container',
        resourceId: target.containerName,
        path: '$.id',
        node: target.moduleId,
        existingValue: status.id,
        proposedValue: target.containerName,
      });
    }
  }

  const network = await inspectModuleNetworkReadOnly(config);
  if (network.exists) {
    for (const target of plannedDockerTargets.values()) {
      const aliasReservation = network.aliases.find(alias => alias.alias === target.alias);
      if (!aliasReservation) {
        continue;
      }

      const reusable = isReusableInstalledDependency(target.moduleId, plan.module.id, existingById);
      const installed = existingById.get(target.moduleId);
      const installedContainerName = installed?.containerName || (installed ? getModuleDockerName(installed.id) : null);
      const aliasBelongsToReusableContainer =
        reusable && installedContainerName && aliasReservation.containerName === installedContainerName;

      if (!aliasBelongsToReusableContainer) {
        conflicts.push({
          code: 'network_alias_conflict',
          message: `Network alias "${target.alias}" is already used on Docker network "${config.moduleNetwork}".`,
          resourceType: 'docker_network_alias',
          resourceId: target.alias,
          path: '$.docker.networkAliases',
          node: target.moduleId,
          existingValue: aliasReservation.containerName,
          proposedValue: target.alias,
        });
      }
    }
  }

  return {
    status: 200,
    conflicts,
  };
}

function dockerUnavailableResult(error: unknown): InstallPlanResult {
  return {
    status: 503,
    body: {
      error: {
        code: 'docker_unavailable',
        message: error instanceof Error
          ? error.message
          : 'Docker daemon must be reachable before an install plan can be returned.',
        validationErrors: [],
        conflicts: [],
      },
    },
  };
}

function isReusableInstalledDependency(
  moduleId: string,
  rootModuleId: string,
  existingById: Map<string, InstalledModuleRecord>
) {
  return moduleId !== rootModuleId && existingById.has(moduleId);
}

function getInstalledStorageMappings(module: InstalledModuleRecord): InstalledStorageMapping[] {
  const mappings = module.storageMappings || module.storage?.directories || [];

  if (Array.isArray(mappings)) {
    return mappings;
  }

  return Object.values(mappings);
}

function normalizeHostPath(value: string) {
  return path.resolve(value);
}

function buildDigestInput(plan: Omit<InstallPlan, 'planDigest'>) {
  return {
    metadataUrl: plan.metadataUrl,
    module: plan.module,
    normalizedMetadata: plan.normalizedMetadata,
    dependencies: plan.dependencies,
    installOrder: plan.installOrder,
    images: plan.images,
    settings: plan.settings.map(setting => ({
      ...setting,
      ...(setting.secret ? { default: undefined } : {}),
    })),
    storage: plan.storage,
    runtime: plan.runtime,
    paths: plan.paths,
    docker: plan.docker,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter(key => object[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function buildInstallPlanRequestValidationError(): InstallPlanResult {
  const validationErrors: InstallPlanValidationError[] = [
    {
      code: 'install_plan_request_invalid',
      message: 'Request body must be { "metadataUrl": "https://..." }.',
      path: '$.metadataUrl',
    },
  ];

  return {
    status: 422,
    body: {
      error: {
        code: 'install_plan_validation_failed',
        message: 'Install plan request is invalid.',
        validationErrors,
        conflicts: [],
      },
    },
  };
}

export function extractInstallPlanMetadataUrl(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const metadataUrl = (value as { metadataUrl?: unknown }).metadataUrl;
  return typeof metadataUrl === 'string' && metadataUrl.trim() ? metadataUrl.trim() : null;
}
