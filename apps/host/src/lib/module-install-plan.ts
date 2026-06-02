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
  InstallPlanContainer,
  InstallPlanDependencyConnection,
  InstallPlanDependencyNode,
  InstallPlanEndpointOrigin,
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

export interface PublishedPortAllocator {
  allocate: () => number;
}

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
  const portAllocator = createPublishedPortAllocator(store, config);
  const dependencies = orderedNodes
    .filter(node => node.id !== graph.rootId)
    .map(node => buildDependencyNode(graph, node.id, store, config, portAllocator));
  const images = orderedNodes.flatMap(node => buildImages(node.id, node.metadata));
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
  const rootPaths = buildModulePaths(root.id, config, root.metadata);
  const rootContainers = buildPlanContainers(root.id, root.metadata, portAllocator);
  const endpointOrigins = buildPlanEndpointOrigins(root.id, root.metadata, rootContainers);

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
      endpoints: root.metadata.endpoints,
      endpointOrigins,
    },
    paths: rootPaths,
    docker: {
      networkName: config.moduleNetwork,
      containers: rootContainers,
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
  config: HostRuntimeConfig,
  portAllocator?: PublishedPortAllocator
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
    containers: existingModule
      ? buildExistingPlanContainers(node.id, node.metadata, existingModule)
      : buildPlanContainers(node.id, node.metadata, portAllocator),
    paths: buildModulePaths(node.id, config, node.metadata),
    connections: buildDependencyConnections(graph, node.id),
  };
}

export function buildDependencyConnections(
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

      const endpoint = dependencyNode.metadata.endpoints.find(
        candidate => candidate.key === edge.declaration.connection?.endpoint
      );

      if (!endpoint) {
        continue;
      }

      const container = dependencyNode.metadata.containers.find(candidate => candidate.key === endpoint.container);
      const port = container?.runtime.ports.find(candidate => candidate.key === endpoint.port);

      if (!container || !port) {
        continue;
      }

      connections.push({
        consumerId: consumer.id,
        dependencyId,
        endpoint: edge.declaration.connection.endpoint,
        targets: edge.declaration.connection.targets,
        resolvedBaseUrl: `http://${getModuleNetworkAlias(dependencyId, container.key)}:${port.containerPort}`,
      });
    }
  }

  return connections.sort((first, second) => first.consumerId.localeCompare(second.consumerId));
}

export function buildInstallOrder(
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

export function buildImages(moduleId: string, metadata: NormalizedModuleMetadata): InstallPlanImage[] {
  return metadata.containers
    .filter(container => (container.source?.type ?? 'image') === 'image')
    .map(container => ({
      moduleId,
      container: container.key,
      repository: container.image.repository,
      tag: container.image.tag,
      reference: `${container.image.repository}:${container.image.tag}`,
      pullPolicy: container.image.pullPolicy,
    }));
}

export function buildPlanContainers(
  moduleId: string,
  metadata: NormalizedModuleMetadata,
  portAllocator?: PublishedPortAllocator
): InstallPlanContainer[] {
  return metadata.containers.map(container => {
    const sourceType = container.source?.type ?? 'image';
    const image: InstallPlanImage = {
      moduleId,
      container: container.key,
      repository: container.image.repository,
      tag: container.image.tag,
      reference: `${container.image.repository}:${container.image.tag}`,
      pullPolicy: container.image.pullPolicy,
    };

    const endpointsByPortKey = new Map(
      metadata.endpoints
        .filter(endpoint => endpoint.container === container.key && endpoint.public)
        .map(endpoint => [endpoint.port, endpoint])
    );

    return {
      moduleId,
      key: container.key,
      runtimeKind: sourceType === 'process' ? 'localCommand' : 'docker',
      containerName: sourceType === 'process'
        ? getModuleProcessName(moduleId, container.key)
        : getModuleDockerName(moduleId, container.key),
      networkAlias: sourceType === 'process'
        ? ''
        : getModuleNetworkAlias(moduleId, container.key),
      image,
      dependsOn: container.dependsOn,
      ports: container.runtime.ports.map(port => {
        const endpoint = endpointsByPortKey.get(port.key);
        if (!endpoint) {
          return {
            ...port,
            hostPublished: false,
          };
        }

        const hostPort = portAllocator?.allocate() ?? 0;
        return {
          ...port,
          hostPublished: true,
          hostPort,
          endpointKey: endpoint.key,
          localOrigin: buildLocalEndpointOrigin(hostPort),
          publicOrigin: null,
        };
      }),
      ...(container.runtime.resources ? { resources: container.runtime.resources } : {}),
      endpoints: metadata.endpoints.filter(endpoint => endpoint.container === container.key),
    };
  });
}

function buildExistingPlanContainers(
  moduleId: string,
  metadata: NormalizedModuleMetadata,
  installed: InstalledModuleRecord
): InstallPlanContainer[] {
  const installedContainers = new Map(installed.containers.map(container => [container.key, container]));
  return buildPlanContainers(moduleId, metadata).map(container => {
    const installedContainer = installedContainers.get(container.key);
    const installedPorts = new Map((installedContainer?.ports ?? []).map(port => [port.key, port]));

    return {
      ...container,
      containerName: installedContainer?.containerName ?? container.containerName,
      networkAlias: installedContainer?.networkAlias ?? container.networkAlias,
      ports: container.ports.map(port => {
        const installedPort = installedPorts.get(port.key);
        if (!installedPort) {
          return port;
        }

        return {
          ...port,
          hostPublished: true,
          hostPort: installedPort.hostPort,
          endpointKey: installedPort.endpointKey,
          localOrigin: buildLocalEndpointOrigin(installedPort.hostPort),
          publicOrigin: installedPort.publicOrigin ?? null,
        };
      }),
    };
  });
}

export function buildPlanEndpointOrigins(
  moduleId: string,
  metadata: NormalizedModuleMetadata,
  containers: InstallPlanContainer[]
): InstallPlanEndpointOrigin[] {
  return metadata.endpoints.flatMap(endpoint => {
    if (!endpoint.public) {
      return [];
    }

    const container = containers.find(candidate => candidate.key === endpoint.container);
    const port = container?.ports.find(candidate => candidate.key === endpoint.port && candidate.hostPublished);
    if (!container || !port?.hostPort || !port.localOrigin) {
      return [];
    }

    return [{
      moduleId,
      endpoint: endpoint.key,
      container: endpoint.container,
      portKey: endpoint.port,
      containerPort: port.containerPort,
      hostPort: port.hostPort,
      protocol: port.protocol,
      localOrigin: port.localOrigin,
      publicOrigin: port.publicOrigin ?? null,
      requiredForUi: metadata.ui?.entrypoint.portKey === endpoint.key,
    }];
  });
}

export function buildSettingPrompts(
  moduleId: string,
  metadata: NormalizedModuleMetadata
): InstallPlanSettingPrompt[] {
  return metadata.settings.map(setting => ({
    moduleId,
    key: setting.key,
    type: setting.type,
    required: setting.required,
    targets: setting.targets,
    ...(setting.type !== 'secret' && Object.prototype.hasOwnProperty.call(setting, 'default')
      ? { default: setting.default }
      : {}),
    secret: setting.type === 'secret',
    redacted: setting.type === 'secret',
  }));
}

export function buildStorageDirectories(
  moduleId: string,
  metadata: NormalizedModuleMetadata,
  config: HostRuntimeConfig
): InstallPlanStorageDirectory[] {
  const modulePaths = buildModulePaths(moduleId, config, metadata);

  return metadata.storage.directories.flatMap(directory => directory.targets.map(target => {
    const modulePathSegments = directory.mount.modulePath.split('/');
    const hostPath = path.join(modulePaths.moduleDirectoryHost, ...modulePathSegments);
    const containerHostPath = path.join(modulePaths.moduleDirectoryContainer, ...modulePathSegments);

    return {
      moduleId,
      key: directory.key,
      container: target.container,
      containerPath: target.containerPath,
      modulePath: directory.mount.modulePath,
      hostPath,
      containerHostPath,
      required: directory.required,
      writable: target.writable,
      readOnly: !target.writable,
    };
  }));
}

export function buildMountCollections(
  moduleId: string,
  metadata: NormalizedModuleMetadata
): InstallPlanMountCollection[] {
  return metadata.storage.mountCollections.map(collection => ({
    moduleId,
    ...collection,
  }));
}

export function buildModulePaths(
  moduleId: string,
  config: HostRuntimeConfig,
  metadata?: Pick<NormalizedModuleMetadata, 'sourceSchemaVersion'>
) {
  // Temporary compatibility boundary: app manifests use the new apps layout,
  // while legacy Docker module metadata keeps the old modules layout.
  const useAppLayout = metadata?.sourceSchemaVersion === 'app.0.1';
  const rootHost = useAppLayout
    ? path.join(config.dataRootHost, 'apps')
    : path.join(config.dataRootHost, 'modules');
  const rootContainer = useAppLayout
    ? (config.appsRootContainer ?? path.join(config.dataRootContainer, 'apps'))
    : config.modulesRootContainer;
  const manifestFileName = useAppLayout ? 'manifest.json' : 'metadata.json';
  const moduleDirectoryHost = path.join(rootHost, moduleId);
  const moduleDirectoryContainer = path.join(rootContainer, moduleId);

  return {
    moduleDirectoryHost,
    moduleDirectoryContainer,
    metadataPathHost: path.join(moduleDirectoryHost, manifestFileName),
    metadataPathContainer: path.join(moduleDirectoryContainer, manifestFileName),
  };
}

export function createPublishedPortAllocator(
  store: ModulesStoreData,
  config: HostRuntimeConfig
): PublishedPortAllocator {
  const range = config.moduleHostPortRange ?? { start: 3100, end: 3999 };
  const reserved = new Set<number>();

  for (const installedModule of store.modules) {
    for (const container of installedModule.containers) {
      for (const port of container.ports ?? []) {
        reserved.add(port.hostPort);
      }
    }
    for (const process of installedModule.processes ?? []) {
      for (const port of process.ports ?? []) {
        reserved.add(port.hostPort);
      }
    }
  }

  let nextPort = range.start;
  return {
    allocate() {
      while (nextPort <= range.end && reserved.has(nextPort)) {
        nextPort += 1;
      }

      if (nextPort > range.end) {
        throw new Error(`No free module host ports are available in ${range.start}-${range.end}.`);
      }

      const allocated = nextPort;
      reserved.add(allocated);
      nextPort += 1;
      return allocated;
    },
  };
}

export function buildLocalEndpointOrigin(hostPort: number) {
  return `http://localhost:${hostPort}`;
}

function collectHostStateConflicts(plan: InstallPlan, store: ModulesStoreData) {
  const conflicts: InstallPlanConflict[] = [];
  const existingById = new Map(store.modules.map(module => [module.id, module]));
  const plannedModuleIds = new Set(plan.installOrder);
  const plannedContainerNames = new Map<string, string>();
  const plannedNetworkAliases = new Map<string, string>();
  const plannedHostPorts = new Map<number, { moduleId: string; container: string; portKey: string }>();
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

  for (const target of getPlanContainers(plan)) {
    const nodeId = target.moduleId;
    const nodeContainerName = target.containerName;
    const nodeAlias = target.networkAlias;

    if (target.runtimeKind === 'docker' && nodeContainerName) {
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

    if (target.runtimeKind === 'docker' && nodeAlias) {
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

    for (const port of target.ports) {
      if (!port.hostPublished || !port.hostPort) {
        continue;
      }

      const existingPort = plannedHostPorts.get(port.hostPort);
      if (existingPort) {
        conflicts.push({
          code: 'host_port_conflict',
          message: `Host port "${port.hostPort}" is assigned more than once in the install plan.`,
          resourceType: 'host_port',
          resourceId: String(port.hostPort),
          path: '$.docker.containers',
          node: nodeId,
          existingValue: `${existingPort.moduleId}:${existingPort.container}:${existingPort.portKey}`,
          proposedValue: `${nodeId}:${target.key}:${port.key}`,
        });
      }

      plannedHostPorts.set(port.hostPort, {
        moduleId: nodeId,
        container: target.key,
        portKey: port.key,
      });
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

    for (const installedContainer of installedModule.containers) {
      const existingContainerName = installedContainer.containerName;
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
    }

    for (const installedContainer of installedModule.containers) {
      const existingAlias = installedContainer.networkAlias;
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

    for (const installedContainer of installedModule.containers) {
      for (const installedPort of installedContainer.ports ?? []) {
        const plannedPortOwner = plannedHostPorts.get(installedPort.hostPort);
        if (!plannedPortOwner) {
          continue;
        }

        conflicts.push({
          code: 'host_port_conflict',
          message: `Host port "${installedPort.hostPort}" conflicts with installed module "${installedModule.id}".`,
          resourceType: 'host_port',
          resourceId: String(installedPort.hostPort),
          path: '$.docker.containers',
          node: plannedPortOwner.moduleId,
          existingValue: installedModule.id,
          proposedValue: `${plannedPortOwner.moduleId}:${plannedPortOwner.container}:${plannedPortOwner.portKey}`,
        });
      }
    }

    for (const installedProcess of installedModule.processes ?? []) {
      for (const installedPort of installedProcess.ports ?? []) {
        const plannedPortOwner = plannedHostPorts.get(installedPort.hostPort);
        if (!plannedPortOwner) {
          continue;
        }

        conflicts.push({
          code: 'host_port_conflict',
          message: `Host port "${installedPort.hostPort}" conflicts with installed app process "${installedProcess.processName}".`,
          resourceType: 'host_port',
          resourceId: String(installedPort.hostPort),
          path: '$.runtime.endpointOrigins',
          node: plannedPortOwner.moduleId,
          existingValue: installedModule.id,
          proposedValue: `${plannedPortOwner.moduleId}:${plannedPortOwner.container}:${plannedPortOwner.portKey}`,
        });
      }
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

export function collectEnvironmentTargetConflicts(plan: InstallPlan): InstallPlanConflict[] {
  const conflicts: InstallPlanConflict[] = [];
  const metadataById = new Map<string, NormalizedModuleMetadata>([
    [plan.module.id, plan.normalizedMetadata],
    ...plan.dependencies.map(dependency => [dependency.id, dependency.normalizedMetadata] as const),
  ]);

  for (const [moduleId, metadata] of metadataById) {
    const envTargets = new Map<string, { path: string; source: string }>();

    metadata.settings.forEach((setting, index) => {
      setting.targets.forEach((target, targetIndex) => {
        addEnvTarget({
          envTargets,
          conflicts,
          moduleId,
          container: target.container,
          name: target.name,
          path: moduleId === plan.module.id
            ? `$.settings[${index}].targets[${targetIndex}].name`
            : `$.dependencies[?(@.id=="${moduleId}")].normalizedMetadata.settings[${index}].targets[${targetIndex}].name`,
          source: `setting:${setting.key}`,
        });
      });
    });

    metadata.dependencies.forEach((dependency, index) => {
      if (!dependency.connection) {
        return;
      }

      dependency.connection.targets.forEach((target, targetIndex) => addEnvTarget({
          envTargets,
          conflicts,
          moduleId,
          container: target.container,
          name: target.name,
          path: moduleId === plan.module.id
            ? `$.dependencies[${index}].connection.targets[${targetIndex}].name`
            : `$.dependencies[?(@.id=="${moduleId}")].normalizedMetadata.dependencies[${index}].connection.targets[${targetIndex}].name`,
          source: `dependency:${dependency.id}`,
        }));
    });

    metadata.connections.forEach((connection, index) => {
      connection.targets.forEach((target, targetIndex) => {
        addEnvTarget({
          envTargets,
          conflicts,
          moduleId,
          container: target.container,
          name: target.name,
          path: moduleId === plan.module.id
            ? `$.connections[${index}].targets[${targetIndex}].name`
            : `$.dependencies[?(@.id=="${moduleId}")].normalizedMetadata.connections[${index}].targets[${targetIndex}].name`,
          source: `connection:${connection.source.key}`,
        });
      });
    });
  }

  return conflicts;
}

function addEnvTarget({
  envTargets,
  conflicts,
  moduleId,
  container,
  name,
  path: targetPath,
  source,
}: {
  envTargets: Map<string, { path: string; source: string }>;
  conflicts: InstallPlanConflict[];
  moduleId: string;
  container: string;
  name: string;
  path: string;
  source: string;
}) {
  const targetKey = `${container}:${name}`;
  const existing = envTargets.get(targetKey);

  if (existing) {
    conflicts.push({
      code: 'environment_variable_target_conflict',
      message: `Environment variable "${name}" is assigned by multiple plan inputs for module "${moduleId}" container "${container}".`,
      resourceType: 'environment_variable',
      resourceId: targetKey,
      path: targetPath,
      node: moduleId,
      existingValue: existing.source,
      proposedValue: source,
    });
    return;
  }

  envTargets.set(targetKey, { path: targetPath, source });
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
  const plannedDockerContainers = collectPlannedDockerContainers(plan, store);
  if (plannedDockerContainers.length === 0) {
    return {
      status: 200,
      conflicts: [],
    };
  }

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
  const plannedDockerTargets = new Map<string, { moduleId: string; containerName: string; alias: string }>(
    plannedDockerContainers.map(container => [
      `${container.moduleId}:${container.key}`,
      {
        moduleId: container.moduleId,
        containerName: container.containerName,
        alias: container.networkAlias,
      },
    ])
  );

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
      const installedContainerNames = new Set((installed?.containers ?? []).map(container => container.containerName));
      const aliasBelongsToReusableContainer = reusable && installedContainerNames.has(aliasReservation.containerName);

      if (!aliasBelongsToReusableContainer) {
        conflicts.push({
          code: 'network_alias_conflict',
          message: `Network alias "${target.alias}" is already used on Docker network "${config.moduleNetwork}".`,
          resourceType: 'docker_network_alias',
          resourceId: target.alias,
          path: '$.docker.containers',
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

function collectPlannedDockerContainers(
  plan: InstallPlan,
  store: ModulesStoreData
): Array<Pick<InstallPlanContainer, 'moduleId' | 'key' | 'containerName' | 'networkAlias'>> {
  const existingById = new Map(store.modules.map(module => [module.id, module]));
  const rootContainers = plan.docker.containers.filter(container => container.runtimeKind === 'docker');
  const dependencyContainers = plan.dependencies.flatMap(dependency => {
    const installed = existingById.get(dependency.id);
    if (installed) {
      return installed.containers.map(container => ({
        moduleId: dependency.id,
        key: container.key,
        containerName: container.containerName,
        networkAlias: container.networkAlias,
      }));
    }

    return dependency.containers.filter(container => container.runtimeKind === 'docker');
  });

  return [...rootContainers, ...dependencyContainers];
}

function getModuleProcessName(moduleId: string, processKey = 'main') {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `proc-${normalized || 'app'}-${processKey}`;
}

function getPlanContainers(plan: InstallPlan): InstallPlanContainer[] {
  return [
    ...plan.docker.containers,
    ...plan.dependencies.flatMap(dependency => dependency.containers),
  ];
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

export function canonicalJson(value: unknown): string {
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
      message: 'Request body must be { "manifestUrl": "https://..." } or legacy { "metadataUrl": "https://..." }.',
      path: '$.manifestUrl',
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

  const source = value as { manifestUrl?: unknown; metadataUrl?: unknown };
  const manifestUrl = source.manifestUrl;
  if (typeof manifestUrl === 'string' && manifestUrl.trim()) {
    return manifestUrl.trim();
  }

  const metadataUrl = source.metadataUrl;
  return typeof metadataUrl === 'string' && metadataUrl.trim() ? metadataUrl.trim() : null;
}
