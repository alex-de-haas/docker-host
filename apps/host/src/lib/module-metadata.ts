import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  APP_MANIFEST_SCHEMA_VERSION,
  convertAppManifestToModuleMetadata,
} from '@/lib/app-manifest';
import type { AppManifestConversionOptions } from '@/lib/app-manifest';
import type {
  InstallPlanValidationError,
  ModuleImagePullPolicy,
  ModuleRuntimePortMetadata,
  ModuleSettingType,
  ModuleStorageMountCollectionMetadata,
  ModuleEnvTarget,
  NormalizedModuleContainerMetadata,
  ModuleUiMetadata,
  NormalizedModuleDependencyMetadata,
  NormalizedModuleEndpointMetadata,
  NormalizedModuleMetadata,
  NormalizedModuleSettingMetadata,
  NormalizedModuleStorageMountCollectionMetadata,
  NormalizedModuleStorageDirectoryMetadata,
} from '@/types/modules';

const SUPPORTED_SCHEMA_VERSIONS = new Set(['0.2', '0.3']);
const MAX_METADATA_BYTES = 1024 * 1024;
const METADATA_FETCH_TIMEOUT_MS = 10_000;
const MAX_DEPENDENCY_NODES = 32;
const SUPPORTED_PULL_POLICIES = new Set<ModuleImagePullPolicy>([
  'ifNotPresent',
  'always',
  'manual',
]);
const SUPPORTED_SETTING_TYPES = new Set<ModuleSettingType>([
  'string',
  'number',
  'boolean',
  'url',
  'secret',
]);
const MAX_UI_LABEL_LENGTH = 80;
const MAX_UI_PATH_LENGTH = 512;
const MAX_UI_ICON_LENGTH = 64;

export interface MetadataGraphDependencyEdge {
  declaration: NormalizedModuleDependencyMetadata;
  dependencyId: string;
}

export interface MetadataGraphNode {
  id: string;
  metadataUrl: string;
  metadata: NormalizedModuleMetadata;
  rawBytes: Buffer;
  dependencies: MetadataGraphDependencyEdge[];
  requiredBy: string[];
}

export interface MetadataGraph {
  rootId: string;
  rootDigest: string;
  nodes: Map<string, MetadataGraphNode>;
}

interface DependencyDeclaration {
  id: string;
  version: string;
  metadataUrl: string;
  path: string;
  node: string;
}

export async function loadMetadataGraph(
  metadataUrlInput: string,
  options: AppManifestConversionOptions = {}
): Promise<{
  graph: MetadataGraph | null;
  validationErrors: InstallPlanValidationError[];
}> {
  const validationErrors: InstallPlanValidationError[] = [];
  const nodes = new Map<string, MetadataGraphNode>();
  const dependencyDeclarations = new Map<string, DependencyDeclaration>();
  const rootUrl = normalizeMetadataUrl(metadataUrlInput, '$.metadataUrl', validationErrors);

  if (!rootUrl) {
    return { graph: null, validationErrors };
  }

  const rootId = await loadNode({
    metadataUrl: rootUrl,
    path: '$',
    stack: [],
    nodes,
    dependencyDeclarations,
    validationErrors,
    options,
  });

  if (!rootId) {
    return { graph: null, validationErrors };
  }

  const root = nodes.get(rootId);

  return {
    graph: root
      ? {
          rootId,
          rootDigest: `sha256:${createHash('sha256').update(root.rawBytes).digest('hex')}`,
          nodes,
        }
      : null,
    validationErrors,
  };
}

export function getModuleMetadataMajor(version: string) {
  const match = /^(\d+)(?:[.-].*)?$/.exec(version);
  return match?.[1] ?? null;
}

async function loadNode({
  metadataUrl,
  path: nodePath,
  stack,
  nodes,
  dependencyDeclarations,
  validationErrors,
  declaration,
  options = {},
}: {
  metadataUrl: string;
  path: string;
  stack: string[];
  nodes: Map<string, MetadataGraphNode>;
  dependencyDeclarations: Map<string, DependencyDeclaration>;
  validationErrors: InstallPlanValidationError[];
  declaration?: NormalizedModuleDependencyMetadata;
  options?: AppManifestConversionOptions;
}): Promise<string | null> {
  const downloaded = await downloadMetadataJson(metadataUrl, nodePath, validationErrors);

  if (!downloaded) {
    return null;
  }

  const validation = validateAndNormalizeMetadata(downloaded.json, nodePath, stack.length === 0 ? options : {});
  validationErrors.push(...validation.validationErrors);

  if (!validation.metadata) {
    return null;
  }

  const metadata = validation.metadata;

  if (declaration && metadata.id !== declaration.id) {
    validationErrors.push({
      code: 'dependency_id_mismatch',
      message: `Downloaded dependency id "${metadata.id}" does not match declared id "${declaration.id}".`,
      path: `${nodePath}.id`,
      node: declaration.id,
    });
    return null;
  }

  if (declaration) {
    const major = getModuleMetadataMajor(metadata.version);

    if (major !== declaration.version) {
      validationErrors.push({
        code: 'dependency_version_mismatch',
        message: `Dependency "${declaration.id}" requires major version "${declaration.version}", but downloaded metadata is "${metadata.version}".`,
        path: `${nodePath}.version`,
        node: declaration.id,
      });
      return null;
    }
  }

  if (stack.includes(metadata.id)) {
    validationErrors.push({
      code: 'dependency_cycle',
      message: `Dependency graph contains a cycle: ${[...stack, metadata.id].join(' -> ')}.`,
      path: nodePath,
      node: metadata.id,
    });
    return null;
  }

  const existing = nodes.get(metadata.id);
  if (existing) {
    return existing.id;
  }

  if (stack.length > 0 && nodes.size >= MAX_DEPENDENCY_NODES + 1) {
    validationErrors.push({
      code: 'dependency_graph_too_large',
      message: `Dependency graph exceeds the maximum of ${MAX_DEPENDENCY_NODES} unique dependency nodes.`,
      path: nodePath,
      node: metadata.id,
    });
    return null;
  }

  const node: MetadataGraphNode = {
    id: metadata.id,
    metadataUrl,
    metadata,
    rawBytes: downloaded.rawBytes,
    dependencies: [],
    requiredBy: [],
  };
  nodes.set(metadata.id, node);

  for (const [index, dependency] of metadata.dependencies.entries()) {
    const dependencyPath = `${nodePath}.dependencies[${index}]`;
    const existingDeclaration = dependencyDeclarations.get(dependency.id);

    if (existingDeclaration && existingDeclaration.metadataUrl !== dependency.metadataUrl) {
      validationErrors.push({
        code: 'dependency_metadata_url_conflict',
        message: `Dependency "${dependency.id}" is declared with conflicting metadata URLs.`,
        path: `${dependencyPath}.metadataUrl`,
        node: metadata.id,
      });
      continue;
    }

    if (existingDeclaration && existingDeclaration.version !== dependency.version) {
      validationErrors.push({
        code: 'dependency_version_conflict',
        message: `Dependency "${dependency.id}" is declared with conflicting major versions.`,
        path: `${dependencyPath}.version`,
        node: metadata.id,
      });
      continue;
    }

    dependencyDeclarations.set(dependency.id, {
      id: dependency.id,
      version: dependency.version,
      metadataUrl: dependency.metadataUrl,
      path: dependencyPath,
      node: metadata.id,
    });

    const dependencyId = await loadNode({
      metadataUrl: dependency.metadataUrl,
      path: dependencyPath,
      stack: [...stack, metadata.id],
      nodes,
      dependencyDeclarations,
      validationErrors,
      declaration: dependency,
      options: {},
    });

    if (!dependencyId) {
      continue;
    }

    const dependencyNode = nodes.get(dependencyId);
    if (!dependencyNode) {
      continue;
    }

    dependencyNode.requiredBy.push(metadata.id);
    node.dependencies.push({ declaration: dependency, dependencyId });

    if (dependency.connection) {
      const endpoint = dependencyNode.metadata.endpoints.find(
        candidate => candidate.key === dependency.connection?.endpoint
      );

      if (!endpoint) {
        validationErrors.push({
          code: 'dependency_endpoint_missing',
          message: `Dependency "${dependency.id}" does not expose endpoint "${dependency.connection.endpoint}".`,
          path: `${dependencyPath}.connection.endpoint`,
          node: metadata.id,
        });
      }
    }
  }

  return metadata.id;
}

async function downloadMetadataJson(
  metadataUrl: string,
  nodePath: string,
  validationErrors: InstallPlanValidationError[]
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(metadataUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      validationErrors.push({
        code: 'metadata_fetch_failed',
        message: `Metadata URL returned HTTP ${response.status}.`,
        path: nodePath,
      });
      return null;
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_METADATA_BYTES) {
      validationErrors.push({
        code: 'metadata_too_large',
        message: `Metadata response exceeds the ${MAX_METADATA_BYTES} byte limit.`,
        path: nodePath,
      });
      return null;
    }

    const rawBytes = await readResponseBytes(response, nodePath, validationErrors);
    if (!rawBytes) {
      return null;
    }

    const text = rawBytes.toString('utf-8');

    try {
      return {
        rawBytes,
        json: JSON.parse(text) as unknown,
      };
    } catch {
      validationErrors.push({
        code: 'metadata_json_invalid',
        message: 'Metadata response is not valid JSON.',
        path: nodePath,
      });
      return null;
    }
  } catch (error) {
    validationErrors.push({
      code: error instanceof Error && error.name === 'AbortError'
        ? 'metadata_fetch_timeout'
        : 'metadata_fetch_failed',
      message:
        error instanceof Error && error.name === 'AbortError'
          ? `Metadata fetch exceeded the ${METADATA_FETCH_TIMEOUT_MS / 1000} second timeout.`
          : error instanceof Error
            ? error.message
            : 'Metadata URL could not be fetched.',
      path: nodePath,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBytes(
  response: Response,
  nodePath: string,
  validationErrors: InstallPlanValidationError[]
) {
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_METADATA_BYTES) {
      validationErrors.push({
        code: 'metadata_too_large',
        message: `Metadata response exceeds the ${MAX_METADATA_BYTES} byte limit.`,
        path: nodePath,
      });
      return null;
    }

    return Buffer.from(arrayBuffer);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > MAX_METADATA_BYTES) {
      await reader.cancel();
      validationErrors.push({
        code: 'metadata_too_large',
        message: `Metadata response exceeds the ${MAX_METADATA_BYTES} byte limit.`,
        path: nodePath,
      });
      return null;
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

export function validateAndNormalizeMetadata(
  value: unknown,
  nodePath: string,
  options: AppManifestConversionOptions = {}
): {
  metadata: NormalizedModuleMetadata | null;
  validationErrors: InstallPlanValidationError[];
} {
  const validationErrors: InstallPlanValidationError[] = [];

  if (!isPlainObject(value)) {
    return {
      metadata: null,
      validationErrors: [
        {
          code: 'metadata_schema_invalid',
          message: 'Metadata must be a JSON object.',
          path: nodePath,
        },
      ],
    };
  }

  if (value.schemaVersion === APP_MANIFEST_SCHEMA_VERSION) {
    const converted = convertAppManifestToModuleMetadata(value, nodePath, options);
    if (!converted.metadata) {
      return {
        metadata: null,
        validationErrors: converted.validationErrors,
      };
    }

    const normalized = validateAndNormalizeMetadata(converted.metadata, nodePath);
    return {
      metadata: normalized.metadata
        ? {
            ...normalized.metadata,
            sourceSchemaVersion: APP_MANIFEST_SCHEMA_VERSION,
            ...(converted.selectedRuntime ? { selectedRuntime: converted.selectedRuntime } : {}),
          }
        : null,
      validationErrors: [
        ...converted.validationErrors,
        ...normalized.validationErrors,
      ],
    };
  }

  rejectUnknownFields(
    value,
    nodePath,
    ['schemaVersion', 'id', 'name', 'description', 'version', 'containers', 'services', 'endpoints', 'connections', 'dependencies', 'settings', 'storage', 'ui'],
    validationErrors
  );

  const schemaVersion = readRequiredString(value, 'schemaVersion', nodePath, validationErrors);
  const id = readRequiredString(value, 'id', nodePath, validationErrors);
  const name = readRequiredString(value, 'name', nodePath, validationErrors);
  const description = readOptionalString(value, 'description', nodePath, validationErrors);
  const version = readRequiredString(value, 'version', nodePath, validationErrors);
  const containers = schemaVersion === '0.3' && value.services !== undefined
    ? validateServices(value.services, `${nodePath}.services`, validationErrors, id)
    : validateContainers(value.containers, `${nodePath}.containers`, validationErrors, id);
  const containerKeys = new Set(containers.map(container => container.key));
  const endpoints = validateEndpoints(value.endpoints, `${nodePath}.endpoints`, containers, validationErrors, id);
  const endpointKeys = new Set(endpoints.map(endpoint => endpoint.key));
  const connections = validateConnections(value.connections, `${nodePath}.connections`, endpointKeys, containerKeys, validationErrors, id);
  const dependencies = validateDependencies(value.dependencies, `${nodePath}.dependencies`, validationErrors, id, containerKeys);
  const settings = validateSettings(value.settings, `${nodePath}.settings`, validationErrors, containerKeys);
  const storage = validateStorage(value.storage, `${nodePath}.storage`, validationErrors, id, containerKeys);
  const ui = validateModuleUiMetadata(value.ui, `${nodePath}.ui`, endpoints, validationErrors, id);

  if (schemaVersion && !SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    validationErrors.push({
      code: 'unsupported_schema_version',
      message: `Unsupported metadata schemaVersion "${schemaVersion}".`,
      path: `${nodePath}.schemaVersion`,
      node: id,
    });
  }

  if (id && !isSafeModuleId(id)) {
    validationErrors.push({
      code: 'module_id_invalid',
      message: 'Module id must be a safe lowercase identifier using letters, numbers, dots, and hyphens.',
      path: `${nodePath}.id`,
      node: id,
    });
  }

  if (version && !getModuleMetadataMajor(version)) {
    validationErrors.push({
      code: 'module_version_invalid',
      message: 'Module version must contain a readable numeric major version.',
      path: `${nodePath}.version`,
      node: id,
    });
  }

  if (validationErrors.length > 0 || !schemaVersion || !id || !name || !version || containers.length === 0) {
    return { metadata: null, validationErrors };
  }

  return {
    metadata: {
      schemaVersion: schemaVersion as '0.2' | '0.3',
      id,
      name,
      ...(description ? { description } : {}),
      version,
      containers,
      services: containers,
      endpoints,
      connections,
      dependencies,
      settings,
      storage,
      ...(ui ? { ui } : {}),
    },
    validationErrors,
  };
}

function validateContainers(
  value: unknown,
  pathToContainers: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleContainerMetadata[] {
  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'containers must be a non-empty array.',
      path: pathToContainers,
      node: moduleId,
    });
    return [];
  }

  if (value.length === 0) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'containers must include at least one container.',
      path: pathToContainers,
      node: moduleId,
    });
    return [];
  }

  const containers: NormalizedModuleContainerMetadata[] = [];
  const seenKeys = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToContainers}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'containers[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['key', 'dependsOn', 'image', 'runtime'], validationErrors, moduleId);
    const key = readRequiredString(item, 'key', itemPath, validationErrors, moduleId);
    const image = validateImage(item.image, `${itemPath}.image`, validationErrors, moduleId);
    const dependsOn = validateContainerDependsOn(item.dependsOn, `${itemPath}.dependsOn`, validationErrors, moduleId);
    const runtime = validateRuntime(item.runtime, `${itemPath}.runtime`, validationErrors, moduleId);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'container_key_duplicate',
        message: `Container key "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (key && !isSafeContractKey(key)) {
      validationErrors.push({
        code: 'container_key_invalid',
        message: 'containers[].key must match ^[a-z][a-z0-9-]{0,62}$.',
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }

    if (key && isSafeContractKey(key) && image && runtime) {
      containers.push({
        key,
        dependsOn,
        source: {
          type: 'image',
        },
        image,
        runtime,
      });
    }
  });

  validateContainerDependencyGraph(containers, pathToContainers, validationErrors, moduleId);
  return containers;
}

function validateServices(
  value: unknown,
  pathToServices: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleContainerMetadata[] {
  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'services must be a non-empty array.',
      path: pathToServices,
      node: moduleId,
    });
    return [];
  }

  if (value.length === 0) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'services must include at least one service.',
      path: pathToServices,
      node: moduleId,
    });
    return [];
  }

  const services: NormalizedModuleContainerMetadata[] = [];
  const seenKeys = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToServices}[${index}]`;
    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'services[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['key', 'dependsOn', 'source', 'runtime', 'healthCheck'], validationErrors, moduleId);
    const key = readRequiredString(item, 'key', itemPath, validationErrors, moduleId);
    const source = validateServiceSource(item.source, `${itemPath}.source`, validationErrors, moduleId);
    const dependsOn = validateContainerDependsOn(item.dependsOn, `${itemPath}.dependsOn`, validationErrors, moduleId);
    const runtime = validateRuntime(item.runtime, `${itemPath}.runtime`, validationErrors, moduleId);
    const healthCheck = validateHealthCheck(item.healthCheck, `${itemPath}.healthCheck`, validationErrors, moduleId);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'service_key_duplicate',
        message: `Service key "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (key && !isSafeContractKey(key)) {
      validationErrors.push({
        code: 'service_key_invalid',
        message: 'services[].key must match ^[a-z][a-z0-9-]{0,62}$.',
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }

    if (key && isSafeContractKey(key) && source && runtime) {
      services.push({
        key,
        dependsOn,
        source: source.source,
        image: source.image,
        runtime,
        ...(healthCheck ? { healthCheck } : {}),
      });
    }
  });

  validateContainerDependencyGraph(services, pathToServices, validationErrors, moduleId);
  return services;
}

function validateServiceSource(
  value: unknown,
  pathToSource: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): { source: NormalizedModuleContainerMetadata['source']; image: NormalizedModuleContainerMetadata['image'] } | null {
  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'services[].source must be an object.',
      path: pathToSource,
      node: moduleId,
    });
    return null;
  }

  const type = readRequiredString(value, 'type', pathToSource, validationErrors, moduleId);
  if (type === 'image') {
    rejectUnknownFields(value, pathToSource, ['type', 'image'], validationErrors, moduleId);
    const image = validateImage(value.image, `${pathToSource}.image`, validationErrors, moduleId);
    return image ? {
      source: { type: 'image' },
      image,
    } : null;
  }

  if (type === 'process') {
    rejectUnknownFields(value, pathToSource, ['type', 'command', 'workingDirectory', 'environment'], validationErrors, moduleId);
    const command = readRequiredString(value, 'command', pathToSource, validationErrors, moduleId);
    const workingDirectory = readOptionalString(value, 'workingDirectory', pathToSource, validationErrors, moduleId);
    const environment = validateStringMap(value.environment, `${pathToSource}.environment`, validationErrors, moduleId);
    if (!command) {
      return null;
    }

    return {
      source: {
        type: 'process',
        command,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(environment ? { environment } : {}),
      },
      image: {
        repository: '__process__',
        tag: 'dev',
        pullPolicy: 'manual',
      },
    };
  }

  if (type) {
    validationErrors.push({
      code: 'service_source_type_unsupported',
      message: `services[].source.type "${type}" is not supported.`,
      path: `${pathToSource}.type`,
      node: moduleId,
    });
  }

  return null;
}

function validateContainerDependsOn(
  value: unknown,
  pathToDependsOn: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'containers[].dependsOn must be an array.',
      path: pathToDependsOn,
      node: moduleId,
    });
    return [];
  }

  const dependencies: string[] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToDependsOn}[${index}]`;
    if (typeof item !== 'string' || item.trim() === '') {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'containers[].dependsOn[] must be a non-empty string.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    const key = item.trim();
    if (!isSafeContractKey(key)) {
      validationErrors.push({
        code: 'container_key_invalid',
        message: 'containers[].dependsOn[] must match ^[a-z][a-z0-9-]{0,62}$.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    if (!seen.has(key)) {
      dependencies.push(key);
      seen.add(key);
    }
  });

  return dependencies;
}

function validateContainerDependencyGraph(
  containers: NormalizedModuleContainerMetadata[],
  pathToContainers: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
) {
  const containerKeys = new Set(containers.map(container => container.key));

  containers.forEach((container, index) => {
    container.dependsOn.forEach((dependencyKey, dependencyIndex) => {
      if (!containerKeys.has(dependencyKey)) {
        validationErrors.push({
          code: 'container_dependency_missing',
          message: `Container "${container.key}" depends on unknown container "${dependencyKey}".`,
          path: `${pathToContainers}[${index}].dependsOn[${dependencyIndex}]`,
          node: moduleId,
        });
      }
    });
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(container: NormalizedModuleContainerMetadata, stack: string[]) {
    if (visited.has(container.key)) {
      return;
    }

    if (visiting.has(container.key)) {
      validationErrors.push({
        code: 'container_dependency_cycle',
        message: `Container dependency graph contains a cycle: ${[...stack, container.key].join(' -> ')}.`,
        path: pathToContainers,
        node: moduleId,
      });
      return;
    }

    visiting.add(container.key);
    for (const dependencyKey of container.dependsOn) {
      const dependency = containers.find(candidate => candidate.key === dependencyKey);
      if (dependency) {
        visit(dependency, [...stack, container.key]);
      }
    }
    visiting.delete(container.key);
    visited.add(container.key);
  }

  containers.forEach(container => visit(container, []));
}

function validateImage(
  value: unknown,
  pathToImage: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleContainerMetadata['image'] | null {
  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'image must be an object.',
      path: pathToImage,
      node: moduleId,
    });
    return null;
  }

  rejectUnknownFields(value, pathToImage, ['repository', 'tag', 'pullPolicy'], validationErrors, moduleId);
  const repository = readRequiredString(value, 'repository', pathToImage, validationErrors, moduleId);
  const tag = readRequiredString(value, 'tag', pathToImage, validationErrors, moduleId);
  const pullPolicy = readOptionalString(value, 'pullPolicy', pathToImage, validationErrors, moduleId) ?? 'ifNotPresent';

  if (repository && /\s/.test(repository)) {
    validationErrors.push({
      code: 'image_repository_invalid',
      message: 'image.repository must not contain whitespace.',
      path: `${pathToImage}.repository`,
      node: moduleId,
    });
  }

  if (tag && /\s/.test(tag)) {
    validationErrors.push({
      code: 'image_tag_invalid',
      message: 'image.tag must not contain whitespace.',
      path: `${pathToImage}.tag`,
      node: moduleId,
    });
  }

  if (!SUPPORTED_PULL_POLICIES.has(pullPolicy as ModuleImagePullPolicy)) {
    validationErrors.push({
      code: 'unsupported_pull_policy',
      message: `image.pullPolicy "${pullPolicy}" is not supported.`,
      path: `${pathToImage}.pullPolicy`,
      node: moduleId,
    });
  }

  if (!repository || !tag || !SUPPORTED_PULL_POLICIES.has(pullPolicy as ModuleImagePullPolicy)) {
    return null;
  }

  return {
    repository,
    tag,
    pullPolicy: pullPolicy as ModuleImagePullPolicy,
  };
}

function validateEndpoints(
  value: unknown,
  pathToEndpoints: string,
  containers: NormalizedModuleContainerMetadata[],
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleEndpointMetadata[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'endpoints must be an array.',
      path: pathToEndpoints,
      node: moduleId,
    });
    return [];
  }

  const endpoints: NormalizedModuleEndpointMetadata[] = [];
  const seenKeys = new Set<string>();
  const containersByKey = new Map(containers.map(container => [container.key, container]));

  value.forEach((item, index) => {
    const itemPath = `${pathToEndpoints}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'endpoints[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['key', 'container', 'service', 'port', 'public'], validationErrors, moduleId);
    const key = readRequiredString(item, 'key', itemPath, validationErrors, moduleId);
    const containerKey = readEndpointServiceKey(item, itemPath, validationErrors, moduleId);
    const portKey = readRequiredString(item, 'port', itemPath, validationErrors, moduleId);
    const isPublic = readRequiredBoolean(item, 'public', itemPath, validationErrors, moduleId);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'endpoint_key_duplicate',
        message: `Endpoint key "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (key && !isSafeContractKey(key)) {
      validationErrors.push({
        code: 'endpoint_key_invalid',
        message: 'endpoints[].key must match ^[a-z][a-z0-9-]{0,62}$.',
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }

    const container = containerKey ? containersByKey.get(containerKey) : undefined;
    if (containerKey && !container) {
      validationErrors.push({
        code: 'endpoint_container_missing',
        message: `Endpoint "${key || index}" references unknown container "${containerKey}".`,
        path: `${itemPath}.container`,
        node: moduleId,
      });
    }

    const port = container?.runtime.ports.find(candidate => candidate.key === portKey);
    if (container && portKey && !port) {
      validationErrors.push({
        code: 'endpoint_port_missing',
        message: `Endpoint "${key || index}" references unknown port "${portKey}" on container "${container.key}".`,
        path: `${itemPath}.port`,
        node: moduleId,
      });
    }

    if (key && isSafeContractKey(key) && container && port && isPublic !== undefined) {
      endpoints.push({
        key,
        container: container.key,
        service: container.key,
        port: port.key,
        public: isPublic,
      });
    }
  });

  return endpoints;
}

function readEndpointServiceKey(
  value: Record<string, unknown>,
  itemPath: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
) {
  const service = readOptionalString(value, 'service', itemPath, validationErrors, moduleId);
  const container = readOptionalString(value, 'container', itemPath, validationErrors, moduleId);
  if (service && container && service !== container) {
    validationErrors.push({
      code: 'endpoint_target_conflict',
      message: 'endpoints[] must not declare different service and container targets.',
      path: itemPath,
      node: moduleId,
    });
  }

  const target = service || container;
  if (!target) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'endpoints[].service is required.',
      path: `${itemPath}.service`,
      node: moduleId,
    });
  }

  return target;
}

function validateConnections(
  value: unknown,
  pathToConnections: string,
  endpointKeys: Set<string>,
  containerKeys: Set<string>,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleMetadata['connections'] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'connections must be an array.',
      path: pathToConnections,
      node: moduleId,
    });
    return [];
  }

  return value.flatMap((item, index) => {
    const itemPath = `${pathToConnections}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'connections[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return [];
    }

    rejectUnknownFields(item, itemPath, ['source', 'targets'], validationErrors, moduleId);
    const source = validateConnectionSource(item.source, `${itemPath}.source`, endpointKeys, validationErrors, moduleId);
    const targets = validateEnvTargets(item.targets, `${itemPath}.targets`, containerKeys, validationErrors, moduleId, {
      required: true,
      fieldName: 'connections[].targets',
    });

    return source && targets.length > 0
      ? [{ source, targets }]
      : [];
  });
}

function validateConnectionSource(
  value: unknown,
  pathToSource: string,
  endpointKeys: Set<string>,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleMetadata['connections'][number]['source'] | null {
  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'connections[].source must be an object.',
      path: pathToSource,
      node: moduleId,
    });
    return null;
  }

  rejectUnknownFields(value, pathToSource, ['type', 'key'], validationErrors, moduleId);
  const type = readRequiredString(value, 'type', pathToSource, validationErrors, moduleId);
  const key = readRequiredString(value, 'key', pathToSource, validationErrors, moduleId);

  if (type && type !== 'endpoint') {
    validationErrors.push({
      code: 'unsupported_connection_source',
      message: `Connection source type "${type}" is not supported.`,
      path: `${pathToSource}.type`,
      node: moduleId,
    });
  }

  if (key && !endpointKeys.has(key)) {
    validationErrors.push({
      code: 'connection_endpoint_missing',
      message: `Connection source references unknown endpoint "${key}".`,
      path: `${pathToSource}.key`,
      node: moduleId,
    });
  }

  return type === 'endpoint' && key && endpointKeys.has(key)
    ? { type: 'endpoint', key }
    : null;
}

function validateDependencies(
  value: unknown,
  pathToDependencies: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string,
  containerKeys: Set<string> = new Set()
): NormalizedModuleDependencyMetadata[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'dependencies must be an array.',
      path: pathToDependencies,
      node: moduleId,
    });
    return [];
  }

  const seen = new Set<string>();
  const dependencies: NormalizedModuleDependencyMetadata[] = [];

  value.forEach((item, index) => {
    const itemPath = `${pathToDependencies}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'dependencies[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['id', 'version', 'required', 'metadataUrl', 'connection'], validationErrors, moduleId);
    const id = readRequiredString(item, 'id', itemPath, validationErrors, moduleId);
    const version = readRequiredString(item, 'version', itemPath, validationErrors, moduleId);
    const required = readRequiredBoolean(item, 'required', itemPath, validationErrors, moduleId);
    const metadataUrl = readRequiredString(item, 'metadataUrl', itemPath, validationErrors, moduleId);
    const connection = validateDependencyConnection(item.connection, `${itemPath}.connection`, validationErrors, moduleId, containerKeys);

    if (id && id === moduleId) {
      validationErrors.push({
        code: 'dependency_self_reference',
        message: 'A module cannot depend on itself.',
        path: `${itemPath}.id`,
        node: moduleId,
      });
    }

    if (id && seen.has(id)) {
      validationErrors.push({
        code: 'dependency_duplicate',
        message: `Dependency "${id}" is declared more than once in this metadata file.`,
        path: `${itemPath}.id`,
        node: moduleId,
      });
    }
    if (id) {
      seen.add(id);
    }

    if (version && !/^\d+$/.test(version)) {
      validationErrors.push({
        code: 'dependency_version_invalid',
        message: 'dependencies[].version must be a numeric major version string.',
        path: `${itemPath}.version`,
        node: moduleId,
      });
    }

    if (required === false) {
      validationErrors.push({
        code: 'optional_dependency_unsupported',
        message: 'Optional dependencies are not supported by the MVP runtime.',
        path: `${itemPath}.required`,
        node: moduleId,
      });
    }

    const normalizedMetadataUrl = metadataUrl
      ? normalizeMetadataUrl(metadataUrl, `${itemPath}.metadataUrl`, validationErrors, moduleId)
      : null;

    if (id && version && required === true && normalizedMetadataUrl) {
      dependencies.push({
        id,
        version,
        required: true,
        metadataUrl: normalizedMetadataUrl,
        ...(connection ? { connection } : {}),
      });
    }
  });

  return dependencies;
}

function validateDependencyConnection(
  value: unknown,
  pathToConnection: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string,
  containerKeys: Set<string> = new Set()
): NormalizedModuleDependencyMetadata['connection'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'dependencies[].connection must be an object.',
      path: pathToConnection,
      node: moduleId,
    });
    return undefined;
  }

  rejectUnknownFields(value, pathToConnection, ['endpoint', 'targets'], validationErrors, moduleId);
  const endpoint = readRequiredString(value, 'endpoint', pathToConnection, validationErrors, moduleId);
  const targets = validateEnvTargets(value.targets, `${pathToConnection}.targets`, containerKeys, validationErrors, moduleId, {
    required: true,
    fieldName: 'dependencies[].connection.targets',
  });

  if (!endpoint || targets.length === 0) {
    return undefined;
  }

  return { endpoint, targets };
}

function validateSettings(
  value: unknown,
  pathToSettings: string,
  validationErrors: InstallPlanValidationError[],
  containerKeys: Set<string>
): NormalizedModuleSettingMetadata[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'settings must be an array.',
      path: pathToSettings,
    });
    return [];
  }

  const seenKeys = new Set<string>();
  const settings: NormalizedModuleSettingMetadata[] = [];

  value.forEach((item, index) => {
    const itemPath = `${pathToSettings}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'settings[] item must be an object.',
        path: itemPath,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['key', 'type', 'required', 'default', 'targets'], validationErrors);
    const key = readRequiredString(item, 'key', itemPath, validationErrors);
    const type = readRequiredString(item, 'type', itemPath, validationErrors);
    const required = readRequiredBoolean(item, 'required', itemPath, validationErrors);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'setting_key_duplicate',
        message: `Setting key "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (key && !isEnvironmentVariableName(key)) {
      validationErrors.push({
        code: 'setting_key_invalid',
        message: 'settings[].key must be a valid environment variable name for the MVP runtime.',
        path: `${itemPath}.key`,
      });
    }

    if (type && !SUPPORTED_SETTING_TYPES.has(type as ModuleSettingType)) {
      validationErrors.push({
        code: 'unsupported_setting_type',
        message: `Setting type "${type}" is not supported.`,
        path: `${itemPath}.type`,
      });
    }

    const targets = validateEnvTargets(item.targets, `${itemPath}.targets`, containerKeys, validationErrors, undefined, {
      required: false,
      fieldName: 'settings[].targets',
    });
    const hasDefault = Object.prototype.hasOwnProperty.call(item, 'default');

    if (type === 'secret' && hasDefault) {
      validationErrors.push({
        code: 'secret_default_unsupported',
        message: 'Secret settings must not include default values.',
        path: `${itemPath}.default`,
      });
    }

    if (hasDefault && type && type !== 'secret') {
      validateSettingDefault(item.default, type, `${itemPath}.default`, validationErrors);
    }

    if (
      key &&
      isEnvironmentVariableName(key) &&
      type &&
      SUPPORTED_SETTING_TYPES.has(type as ModuleSettingType) &&
      required !== undefined &&
      !(type === 'secret' && hasDefault)
    ) {
      settings.push({
        key,
        type: type as ModuleSettingType,
        required,
        ...(hasDefault && type !== 'secret' ? { default: item.default } : {}),
        targets,
      });
    }
  });

  return settings;
}

function validateEnvTargets(
  value: unknown,
  pathToTargets: string,
  containerKeys: Set<string>,
  validationErrors: InstallPlanValidationError[],
  moduleId: string | undefined,
  options: {
    required: boolean;
    fieldName: string;
  }
): ModuleEnvTarget[] {
  if (value === undefined) {
    if (options.required) {
      validationErrors.push({
        code: 'metadata_field_required',
        message: `${options.fieldName} must be a non-empty array.`,
        path: pathToTargets,
        node: moduleId,
      });
    }
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: `${options.fieldName} must be an array.`,
      path: pathToTargets,
      node: moduleId,
    });
    return [];
  }

  if (options.required && value.length === 0) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: `${options.fieldName} must include at least one target.`,
      path: pathToTargets,
      node: moduleId,
    });
  }

  const targets: ModuleEnvTarget[] = [];
  const seenTargets = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToTargets}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: `${options.fieldName}[] item must be an object.`,
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['container', 'type', 'name'], validationErrors, moduleId);
    const container = readRequiredString(item, 'container', itemPath, validationErrors, moduleId);
    const type = readRequiredString(item, 'type', itemPath, validationErrors, moduleId);
    const name = readRequiredString(item, 'name', itemPath, validationErrors, moduleId);

    if (container && !containerKeys.has(container)) {
      validationErrors.push({
        code: 'target_container_missing',
        message: `${options.fieldName}[] references unknown container "${container}".`,
        path: `${itemPath}.container`,
        node: moduleId,
      });
    }

    if (type && type !== 'env') {
      validationErrors.push({
        code: 'unsupported_target_type',
        message: `Target type "${type}" is not supported.`,
        path: `${itemPath}.type`,
        node: moduleId,
      });
    }

    if (name && !isEnvironmentVariableName(name)) {
      validationErrors.push({
        code: 'environment_variable_invalid',
        message: `${options.fieldName}[].name must be a valid environment variable name.`,
        path: `${itemPath}.name`,
        node: moduleId,
      });
    }

    if (container && containerKeys.has(container) && type === 'env' && name && isEnvironmentVariableName(name)) {
      const targetKey = `${container}:${name}`;
      if (seenTargets.has(targetKey)) {
        validationErrors.push({
          code: 'environment_variable_target_duplicate',
          message: `Environment variable target "${name}" is declared more than once for container "${container}".`,
          path: itemPath,
          node: moduleId,
        });
        return;
      }

      seenTargets.add(targetKey);
      targets.push({
        container,
        type: 'env',
        name,
      });
    }
  });

  return targets;
}

function validateSettingDefault(
  value: unknown,
  type: string,
  pathToDefault: string,
  validationErrors: InstallPlanValidationError[]
) {
  if (type === 'string' && typeof value !== 'string') {
    validationErrors.push({
      code: 'setting_default_invalid',
      message: 'String setting defaults must be strings.',
      path: pathToDefault,
    });
  }

  if (type === 'number' && typeof value !== 'number') {
    validationErrors.push({
      code: 'setting_default_invalid',
      message: 'Number setting defaults must be numbers.',
      path: pathToDefault,
    });
  }

  if (type === 'boolean' && typeof value !== 'boolean') {
    validationErrors.push({
      code: 'setting_default_invalid',
      message: 'Boolean setting defaults must be booleans.',
      path: pathToDefault,
    });
  }

  if (type === 'url' && (typeof value !== 'string' || !isUrl(value))) {
    validationErrors.push({
      code: 'setting_default_invalid',
      message: 'URL setting defaults must be valid URL strings.',
      path: pathToDefault,
    });
  }
}

function validateStorage(
  value: unknown,
  pathToStorage: string,
  validationErrors: InstallPlanValidationError[],
  moduleId: string | undefined,
  containerKeys: Set<string>
): NormalizedModuleMetadata['storage'] {
  if (value === undefined) {
    return {
      directories: [],
      mountCollections: [],
    };
  }

  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'storage must be an object.',
      path: pathToStorage,
      node: moduleId,
    });
    return {
      directories: [],
      mountCollections: [],
    };
  }

  rejectUnknownFields(value, pathToStorage, ['directories', 'mountCollections'], validationErrors, moduleId);

  return {
    directories: validateStorageDirectories(value.directories, `${pathToStorage}.directories`, validationErrors, moduleId, containerKeys),
    mountCollections: validateStorageMountCollections(value.mountCollections, `${pathToStorage}.mountCollections`, validationErrors, moduleId, containerKeys),
  };
}

function validateStorageDirectories(
  value: unknown,
  pathToDirectories: string,
  validationErrors: InstallPlanValidationError[],
  moduleId: string | undefined,
  containerKeys: Set<string>
): NormalizedModuleStorageDirectoryMetadata[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'storage.directories must be an array.',
      path: pathToDirectories,
      node: moduleId,
    });
    return [];
  }

  const directories: NormalizedModuleStorageDirectoryMetadata[] = [];
  const seenKeys = new Set<string>();
  const containerPaths = new Map<string, Array<{ path: string; sourcePath: string }>>();

  value.forEach((item, index) => {
    const itemPath = `${pathToDirectories}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'storage.directories[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['key', 'label', 'description', 'purpose', 'required', 'mount', 'targets'], validationErrors, moduleId);

    const key = readRequiredString(item, 'key', itemPath, validationErrors, moduleId);
    const label = readOptionalString(item, 'label', itemPath, validationErrors, moduleId);
    const description = readOptionalString(item, 'description', itemPath, validationErrors, moduleId);
    const purpose = readOptionalString(item, 'purpose', itemPath, validationErrors, moduleId);
    const required = readRequiredBoolean(item, 'required', itemPath, validationErrors, moduleId);
    const mount = validateStorageDirectoryMount(item.mount, `${itemPath}.mount`, key, validationErrors, moduleId);
    const targets = validateStorageTargets(item.targets, `${itemPath}.targets`, containerKeys, validationErrors, moduleId);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'storage_key_duplicate',
        message: `Storage directory key "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    for (const [targetIndex, target] of targets.entries()) {
      const targetPaths = containerPaths.get(target.container) ?? [];
      const overlapping = targetPaths.find(existing => pathsOverlap(existing.path, target.containerPath));
      if (overlapping) {
        validationErrors.push({
          code: 'container_path_overlap',
          message: `Storage container path "${target.containerPath}" overlaps with "${overlapping.path}" in container "${target.container}".`,
          path: `${itemPath}.targets[${targetIndex}].containerPath`,
          node: moduleId,
        });
      }
      targetPaths.push({ path: target.containerPath, sourcePath: `${itemPath}.targets[${targetIndex}].containerPath` });
      containerPaths.set(target.container, targetPaths);
    }

    if (key && required !== undefined && mount && targets.length > 0) {
      directories.push({
        key,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(purpose ? { purpose } : {}),
        required,
        mount,
        targets,
      });
    }
  });

  return directories;
}

function validateStorageTargets(
  value: unknown,
  pathToTargets: string,
  containerKeys: Set<string>,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
) {
  if (!Array.isArray(value) || value.length === 0) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'storage targets must be a non-empty array.',
      path: pathToTargets,
      node: moduleId,
    });
    return [];
  }

  const targets: NormalizedModuleStorageDirectoryMetadata['targets'] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToTargets}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'storage targets[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['container', 'containerPath', 'writable'], validationErrors, moduleId);
    const container = readRequiredString(item, 'container', itemPath, validationErrors, moduleId);
    const containerPath = readRequiredString(item, 'containerPath', itemPath, validationErrors, moduleId);
    const writable = readRequiredBoolean(item, 'writable', itemPath, validationErrors, moduleId);

    if (container && !containerKeys.has(container)) {
      validationErrors.push({
        code: 'storage_target_container_missing',
        message: `Storage target references unknown container "${container}".`,
        path: `${itemPath}.container`,
        node: moduleId,
      });
    }

    if (containerPath && !isSafeAbsoluteUnixPath(containerPath)) {
      validationErrors.push({
        code: 'container_path_invalid',
        message: 'storage targets[].containerPath must be a safe absolute Unix path.',
        path: `${itemPath}.containerPath`,
        node: moduleId,
      });
    }

    if (container && containerKeys.has(container) && containerPath && isSafeAbsoluteUnixPath(containerPath) && writable !== undefined) {
      const targetKey = `${container}:${containerPath}`;
      if (seen.has(targetKey)) {
        validationErrors.push({
          code: 'storage_target_duplicate',
          message: `Storage target "${containerPath}" is declared more than once for container "${container}".`,
          path: itemPath,
          node: moduleId,
        });
        return;
      }

      seen.add(targetKey);
      targets.push({
        container,
        containerPath,
        writable,
      });
    }
  });

  return targets;
}

function validateStorageDirectoryMount(
  value: unknown,
  pathToMount: string,
  storageKey: string | undefined,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleStorageDirectoryMetadata['mount'] | null {
  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'storage.directories[].mount must be an object.',
      path: pathToMount,
      node: moduleId,
    });
    return null;
  }

  rejectUnknownFields(value, pathToMount, ['recommended', 'type', 'modulePath'], validationErrors, moduleId);
  const recommended = readOptionalBoolean(value, 'recommended', pathToMount, validationErrors, moduleId);
  const type = readRequiredString(value, 'type', pathToMount, validationErrors, moduleId);
  const modulePath = readOptionalString(value, 'modulePath', pathToMount, validationErrors, moduleId) ?? storageKey;

  if (type && type !== 'bind') {
    validationErrors.push({
      code: 'unsupported_storage_mount_type',
      message: `Storage mount type "${type}" is not supported.`,
      path: `${pathToMount}.type`,
      node: moduleId,
    });
  }

  if (!modulePath || !isSafeRelativeModulePath(modulePath)) {
    validationErrors.push({
      code: 'module_path_invalid',
      message: 'storage.directories[].mount.modulePath must be a safe relative path inside the module directory.',
      path: `${pathToMount}.modulePath`,
      node: moduleId,
    });
  }

  if (type !== 'bind' || !modulePath || !isSafeRelativeModulePath(modulePath)) {
    return null;
  }

  return {
    ...(recommended === undefined ? {} : { recommended }),
    type: 'bind',
    modulePath,
  };
}

function validateStorageMountCollections(
  value: unknown,
  pathToCollections: string,
  validationErrors: InstallPlanValidationError[],
  moduleId: string | undefined,
  containerKeys: Set<string>
): NormalizedModuleStorageMountCollectionMetadata[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'storage.mountCollections must be an array.',
      path: pathToCollections,
      node: moduleId,
    });
    return [];
  }

  const collections: NormalizedModuleStorageMountCollectionMetadata[] = [];
  const seenKeys = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToCollections}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'storage.mountCollections[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(
      item,
      itemPath,
      ['key', 'label', 'description', 'purpose', 'required', 'minItems', 'maxItems', 'hostPathPolicy', 'targets'],
      validationErrors,
      moduleId
    );

    const key = readRequiredString(item, 'key', itemPath, validationErrors, moduleId);
    const label = readOptionalString(item, 'label', itemPath, validationErrors, moduleId);
    const description = readOptionalString(item, 'description', itemPath, validationErrors, moduleId);
    const purpose = readOptionalString(item, 'purpose', itemPath, validationErrors, moduleId);
    const required = readRequiredBoolean(item, 'required', itemPath, validationErrors, moduleId);
    const minItems = readOptionalNumber(item, 'minItems', itemPath, validationErrors, moduleId) ?? 0;
    const maxItems = readOptionalNullableNumber(item, 'maxItems', itemPath, validationErrors, moduleId);
    const hostPathPolicy = validateHostPathPolicy(item.hostPathPolicy, `${itemPath}.hostPathPolicy`, validationErrors, moduleId);
    const targets = validateStorageMountCollectionTargets(item.targets, `${itemPath}.targets`, containerKeys, validationErrors, moduleId);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'mount_collection_key_duplicate',
        message: `Mount collection key "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (minItems < 0 || !Number.isInteger(minItems)) {
      validationErrors.push({
        code: 'mount_collection_min_items_invalid',
        message: 'storage.mountCollections[].minItems must be a non-negative integer.',
        path: `${itemPath}.minItems`,
        node: moduleId,
      });
    }

    if (maxItems !== null && (maxItems < minItems || !Number.isInteger(maxItems))) {
      validationErrors.push({
        code: 'mount_collection_max_items_invalid',
        message: 'storage.mountCollections[].maxItems must be null or an integer greater than or equal to minItems.',
        path: `${itemPath}.maxItems`,
        node: moduleId,
      });
    }

    if (
      key &&
      required !== undefined &&
      hostPathPolicy &&
      targets.length > 0
    ) {
      collections.push({
        key,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(purpose ? { purpose } : {}),
        required,
        minItems,
        maxItems,
        hostPathPolicy,
        targets,
      });
    }
  });

  return collections;
}

function validateStorageMountCollectionTargets(
  value: unknown,
  pathToTargets: string,
  containerKeys: Set<string>,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
) {
  if (!Array.isArray(value) || value.length === 0) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'storage.mountCollections[].targets must be a non-empty array.',
      path: pathToTargets,
      node: moduleId,
    });
    return [];
  }

  const targets: NormalizedModuleStorageMountCollectionMetadata['targets'] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToTargets}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'storage.mountCollections[].targets[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['container', 'containerPathPrefix', 'itemContainerPathTemplate', 'writable'], validationErrors, moduleId);
    const container = readRequiredString(item, 'container', itemPath, validationErrors, moduleId);
    const containerPathPrefix = readRequiredString(item, 'containerPathPrefix', itemPath, validationErrors, moduleId);
    const itemContainerPathTemplate = readRequiredString(item, 'itemContainerPathTemplate', itemPath, validationErrors, moduleId);
    const writable = readRequiredBoolean(item, 'writable', itemPath, validationErrors, moduleId);

    if (container && !containerKeys.has(container)) {
      validationErrors.push({
        code: 'storage_target_container_missing',
        message: `Mount collection target references unknown container "${container}".`,
        path: `${itemPath}.container`,
        node: moduleId,
      });
    }

    if (containerPathPrefix && !isSafeAbsoluteUnixPath(containerPathPrefix)) {
      validationErrors.push({
        code: 'container_path_invalid',
        message: 'storage.mountCollections[].targets[].containerPathPrefix must be a safe absolute Unix path.',
        path: `${itemPath}.containerPathPrefix`,
        node: moduleId,
      });
    }

    if (itemContainerPathTemplate && !isSafeAbsoluteUnixPath(itemContainerPathTemplate.replace('{key}', 'item'))) {
      validationErrors.push({
        code: 'container_path_invalid',
        message: 'storage.mountCollections[].targets[].itemContainerPathTemplate must produce a safe absolute Unix path.',
        path: `${itemPath}.itemContainerPathTemplate`,
        node: moduleId,
      });
    }

    if (itemContainerPathTemplate && !itemContainerPathTemplate.split('/').includes('{key}')) {
      validationErrors.push({
        code: 'mount_collection_template_invalid',
        message: 'storage.mountCollections[].targets[].itemContainerPathTemplate must contain {key} as a path segment.',
        path: `${itemPath}.itemContainerPathTemplate`,
        node: moduleId,
      });
    }

    if (
      containerPathPrefix &&
      itemContainerPathTemplate &&
      isSafeAbsoluteUnixPath(containerPathPrefix) &&
      isSafeAbsoluteUnixPath(itemContainerPathTemplate.replace('{key}', 'item')) &&
      !path.posix.normalize(itemContainerPathTemplate.replace('{key}', 'item')).startsWith(`${path.posix.normalize(containerPathPrefix)}/`)
    ) {
      validationErrors.push({
        code: 'mount_collection_template_invalid',
        message: 'storage.mountCollections[].targets[].itemContainerPathTemplate must stay under containerPathPrefix.',
        path: `${itemPath}.itemContainerPathTemplate`,
        node: moduleId,
      });
    }

    if (
      container &&
      containerKeys.has(container) &&
      containerPathPrefix &&
      itemContainerPathTemplate &&
      isSafeAbsoluteUnixPath(containerPathPrefix) &&
      isSafeAbsoluteUnixPath(itemContainerPathTemplate.replace('{key}', 'item')) &&
      writable !== undefined
    ) {
      const targetKey = `${container}:${containerPathPrefix}`;
      if (seen.has(targetKey)) {
        validationErrors.push({
          code: 'storage_target_duplicate',
          message: `Mount collection target "${containerPathPrefix}" is declared more than once for container "${container}".`,
          path: itemPath,
          node: moduleId,
        });
        return;
      }

      seen.add(targetKey);
      targets.push({
        container,
        containerPathPrefix,
        itemContainerPathTemplate,
        writable,
      });
    }
  });

  return targets;
}

function validateHostPathPolicy(
  value: unknown,
  pathToPolicy: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): ModuleStorageMountCollectionMetadata['hostPathPolicy'] | null {
  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'storage.mountCollections[].hostPathPolicy must be an object.',
      path: pathToPolicy,
      node: moduleId,
    });
    return null;
  }

  rejectUnknownFields(value, pathToPolicy, ['mode', 'allowExternal'], validationErrors, moduleId);
  const mode = readRequiredString(value, 'mode', pathToPolicy, validationErrors, moduleId);
  const allowExternal = readRequiredBoolean(value, 'allowExternal', pathToPolicy, validationErrors, moduleId);

  if (mode && mode !== 'adminSelected') {
    validationErrors.push({
      code: 'unsupported_host_path_policy',
      message: `hostPathPolicy.mode "${mode}" is not supported.`,
      path: `${pathToPolicy}.mode`,
      node: moduleId,
    });
  }

  if (allowExternal !== true) {
    validationErrors.push({
      code: 'external_mount_policy_invalid',
      message: 'storage.mountCollections[].hostPathPolicy.allowExternal must be true.',
      path: `${pathToPolicy}.allowExternal`,
      node: moduleId,
    });
  }

  return mode === 'adminSelected' && allowExternal === true
    ? { mode: 'adminSelected', allowExternal: true }
    : null;
}

function validateHealthCheck(
  value: unknown,
  pathToHealthCheck: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleContainerMetadata['healthCheck'] | null {
  if (value === undefined) {
    return null;
  }

  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'services[].healthCheck must be an object.',
      path: pathToHealthCheck,
      node: moduleId,
    });
    return null;
  }

  rejectUnknownFields(value, pathToHealthCheck, ['type', 'path', 'intervalSeconds', 'timeoutSeconds', 'successStatus'], validationErrors, moduleId);
  const type = readRequiredString(value, 'type', pathToHealthCheck, validationErrors, moduleId);
  const checkPath = readRequiredString(value, 'path', pathToHealthCheck, validationErrors, moduleId);
  const intervalSeconds = readOptionalNumber(value, 'intervalSeconds', pathToHealthCheck, validationErrors, moduleId);
  const timeoutSeconds = readOptionalNumber(value, 'timeoutSeconds', pathToHealthCheck, validationErrors, moduleId);
  const successStatus = validateSuccessStatus(value.successStatus, `${pathToHealthCheck}.successStatus`, validationErrors, moduleId);

  if (type && type !== 'http') {
    validationErrors.push({
      code: 'health_check_type_unsupported',
      message: `healthCheck.type "${type}" is not supported.`,
      path: `${pathToHealthCheck}.type`,
      node: moduleId,
    });
  }

  if (checkPath && !checkPath.startsWith('/')) {
    validationErrors.push({
      code: 'health_check_path_invalid',
      message: 'healthCheck.path must start with "/".',
      path: `${pathToHealthCheck}.path`,
      node: moduleId,
    });
  }

  if (type !== 'http' || !checkPath || !checkPath.startsWith('/')) {
    return null;
  }

  return {
    type: 'http',
    path: checkPath,
    ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(successStatus ? { successStatus } : {}),
  };
}

function validateSuccessStatus(
  value: unknown,
  pathToSuccessStatus: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
) {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'healthCheck.successStatus must be an array.',
      path: pathToSuccessStatus,
      node: moduleId,
    });
    return undefined;
  }

  const statuses: number[] = [];
  value.forEach((item, index) => {
    if (!Number.isInteger(item) || item < 100 || item > 599) {
      validationErrors.push({
        code: 'health_check_status_invalid',
        message: 'healthCheck.successStatus[] must be an HTTP status code.',
        path: `${pathToSuccessStatus}[${index}]`,
        node: moduleId,
      });
      return;
    }

    statuses.push(item);
  });

  return statuses.length > 0 ? [...new Set(statuses)] : undefined;
}

function validateStringMap(
  value: unknown,
  pathToMap: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
) {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'environment must be an object.',
      path: pathToMap,
      node: moduleId,
    });
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'environment values must be strings.',
        path: `${pathToMap}.${key}`,
        node: moduleId,
      });
      continue;
    }

    result[key] = item;
  }

  return result;
}

function validateRuntime(
  value: unknown,
  pathToRuntime: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleContainerMetadata['runtime'] | null {
  if (value === undefined) {
    return {
      ports: [],
    };
  }

  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'containers[].runtime must be an object.',
      path: pathToRuntime,
      node: moduleId,
    });
    return null;
  }

  rejectUnknownFields(value, pathToRuntime, ['ports', 'healthcheck', 'resources'], validationErrors, moduleId);
  const ports = validateRuntimePorts(value.ports, `${pathToRuntime}.ports`, validationErrors, moduleId);
  const resources = validateRuntimeResources(value.resources, `${pathToRuntime}.resources`, validationErrors, moduleId);

  if (!ports) {
    return null;
  }

  return {
    ports,
    ...(Object.prototype.hasOwnProperty.call(value, 'healthcheck')
      ? { healthcheck: { ignoredByMvpRuntime: true, value: value.healthcheck } }
      : {}),
    ...(resources ? { resources } : {}),
  };
}

function validateRuntimePorts(
  value: unknown,
  pathToPorts: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): ModuleRuntimePortMetadata[] | null {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'containers[].runtime.ports must be an array.',
      path: pathToPorts,
      node: moduleId,
    });
    return null;
  }

  const ports: ModuleRuntimePortMetadata[] = [];
  const seenKeys = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToPorts}[${index}]`;

    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'runtime.ports[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['key', 'containerPort', 'localPort', 'protocol'], validationErrors, moduleId);
    const key = readRequiredString(item, 'key', itemPath, validationErrors, moduleId);
    const containerPort = readRequiredNumber(item, 'containerPort', itemPath, validationErrors, moduleId);
    const localPort = readOptionalNumber(item, 'localPort', itemPath, validationErrors, moduleId);
    const protocol = readRequiredString(item, 'protocol', itemPath, validationErrors, moduleId);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'runtime_port_key_duplicate',
        message: `Runtime port key "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (key && !isSafeContractKey(key)) {
      validationErrors.push({
        code: 'runtime_port_key_invalid',
        message: 'runtime.ports[].key must match ^[a-z][a-z0-9-]{0,62}$.',
        path: `${itemPath}.key`,
        node: moduleId,
      });
    }

    if (containerPort !== undefined && (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535)) {
      validationErrors.push({
        code: 'runtime_port_invalid',
        message: 'runtime.ports[].containerPort must be an integer between 1 and 65535.',
        path: `${itemPath}.containerPort`,
        node: moduleId,
      });
    }

    if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) {
      validationErrors.push({
        code: 'runtime_port_invalid',
        message: 'runtime.ports[].localPort must be an integer between 1 and 65535.',
        path: `${itemPath}.localPort`,
        node: moduleId,
      });
    }

    if (protocol && protocol !== 'http') {
      validationErrors.push({
        code: 'unsupported_port_protocol',
        message: `Runtime port protocol "${protocol}" is not supported by the MVP runtime.`,
        path: `${itemPath}.protocol`,
        node: moduleId,
      });
    }

    if (key && isSafeContractKey(key) && containerPort !== undefined && protocol === 'http') {
      ports.push({
        key,
        containerPort,
        ...(localPort !== undefined ? { localPort } : {}),
        protocol,
      });
    }
  });

  return ports;
}

function validateRuntimeResources(
  value: unknown,
  pathToResources: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): NormalizedModuleContainerMetadata['runtime']['resources'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'runtime.resources must be an object.',
      path: pathToResources,
      node: moduleId,
    });
    return undefined;
  }

  rejectUnknownFields(value, pathToResources, ['cpus', 'memory'], validationErrors, moduleId);
  const cpus = readOptionalNumber(value, 'cpus', pathToResources, validationErrors, moduleId);
  const memory = readOptionalString(value, 'memory', pathToResources, validationErrors, moduleId);
  const resources: NonNullable<NormalizedModuleContainerMetadata['runtime']['resources']> = {};

  if (cpus !== undefined) {
    if (cpus <= 0) {
      validationErrors.push({
        code: 'runtime_resources_invalid',
        message: 'runtime.resources.cpus must be greater than zero.',
        path: `${pathToResources}.cpus`,
        node: moduleId,
      });
    } else {
      resources.cpus = cpus;
    }
  }

  if (memory !== undefined) {
    resources.memory = memory;
  }

  return Object.keys(resources).length > 0 ? resources : undefined;
}

export function validateModuleUiMetadata(
  value: unknown,
  pathToUi: string,
  endpoints: Array<Pick<NormalizedModuleEndpointMetadata, 'key' | 'public'>>,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): ModuleUiMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }

  const initialErrorCount = validationErrors.length;
  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'ui must be an object.',
      path: pathToUi,
      node: moduleId,
    });
    return undefined;
  }

  rejectUnknownFields(value, pathToUi, ['category', 'icon', 'entrypoint', 'navigation'], validationErrors, moduleId);

  const hasCategory = Object.prototype.hasOwnProperty.call(value, 'category');
  const hasIcon = Object.prototype.hasOwnProperty.call(value, 'icon');
  const category = readOptionalString(value, 'category', pathToUi, validationErrors, moduleId);
  const icon = readOptionalString(value, 'icon', pathToUi, validationErrors, moduleId);
  const entrypoint = validateModuleUiEntrypoint(
    value.entrypoint,
    `${pathToUi}.entrypoint`,
    endpoints,
    validationErrors,
    moduleId
  );
  const navigation = validateModuleUiNavigation(
    value.navigation,
    `${pathToUi}.navigation`,
    validationErrors,
    moduleId
  );

  if (hasCategory && category !== 'Apps') {
    validationErrors.push({
      code: 'module_ui_category_invalid',
      message: 'ui.category must be "Apps" when provided.',
      path: `${pathToUi}.category`,
      node: moduleId,
    });
  }

  if (hasIcon && (!icon || !/^[a-z][a-z0-9-]*$/.test(icon) || icon.length > MAX_UI_ICON_LENGTH)) {
    validationErrors.push({
      code: 'module_ui_icon_invalid',
      message: `ui.icon must be a lowercase icon key up to ${MAX_UI_ICON_LENGTH} characters.`,
      path: `${pathToUi}.icon`,
      node: moduleId,
    });
  }

  if (validationErrors.length > initialErrorCount || !entrypoint || !navigation) {
    return undefined;
  }

  return {
    ...(category ? { category: 'Apps' as const } : {}),
    ...(icon ? { icon } : {}),
    entrypoint,
    navigation,
  };
}

function validateModuleUiEntrypoint(
  value: unknown,
  pathToEntrypoint: string,
  endpoints: Array<Pick<NormalizedModuleEndpointMetadata, 'key' | 'public'>>,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): ModuleUiMetadata['entrypoint'] | null {
  if (!isPlainObject(value)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: 'ui.entrypoint must be an object.',
      path: pathToEntrypoint,
      node: moduleId,
    });
    return null;
  }

  rejectUnknownFields(value, pathToEntrypoint, ['portKey', 'path'], validationErrors, moduleId);
  const portKey = readRequiredString(value, 'portKey', pathToEntrypoint, validationErrors, moduleId);
  const entryPath = readRequiredString(value, 'path', pathToEntrypoint, validationErrors, moduleId);

  if (portKey) {
    const endpoint = endpoints.find(candidate => candidate.key === portKey);
    if (!endpoint) {
      validationErrors.push({
        code: 'module_ui_port_not_found',
        message: `ui.entrypoint.portKey "${portKey}" does not reference an endpoint.`,
        path: `${pathToEntrypoint}.portKey`,
        node: moduleId,
      });
    } else if (!endpoint.public) {
      validationErrors.push({
        code: 'module_ui_port_not_public',
        message: `ui.entrypoint.portKey "${portKey}" must reference an endpoint marked public.`,
        path: `${pathToEntrypoint}.portKey`,
        node: moduleId,
      });
    }
  }

  if (entryPath) {
    validateModuleUiPath(entryPath, `${pathToEntrypoint}.path`, validationErrors, moduleId);
  }

  return portKey && entryPath
    ? {
        portKey,
        path: entryPath,
      }
    : null;
}

function validateModuleUiNavigation(
  value: unknown,
  pathToNavigation: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
): ModuleUiMetadata['navigation'] | null {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: 'ui.navigation must be an array.',
      path: pathToNavigation,
      node: moduleId,
    });
    return null;
  }

  const navigation: ModuleUiMetadata['navigation'] = [];
  const navigationPaths = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${pathToNavigation}[${index}]`;
    if (!isPlainObject(item)) {
      validationErrors.push({
        code: 'metadata_field_invalid',
        message: 'ui.navigation[] item must be an object.',
        path: itemPath,
        node: moduleId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['label', 'path'], validationErrors, moduleId);
    const label = readRequiredString(item, 'label', itemPath, validationErrors, moduleId);
    const itemPathValue = readRequiredString(item, 'path', itemPath, validationErrors, moduleId);

    if (label && label.length > MAX_UI_LABEL_LENGTH) {
      validationErrors.push({
        code: 'module_ui_label_invalid',
        message: `ui.navigation[].label must be at most ${MAX_UI_LABEL_LENGTH} characters.`,
        path: `${itemPath}.label`,
        node: moduleId,
      });
    }

    if (itemPathValue) {
      validateModuleUiPath(itemPathValue, `${itemPath}.path`, validationErrors, moduleId);
      if (navigationPaths.has(itemPathValue)) {
        validationErrors.push({
          code: 'module_ui_navigation_duplicate_path',
          message: `ui.navigation[].path "${itemPathValue}" is duplicated.`,
          path: `${itemPath}.path`,
          node: moduleId,
        });
      }
      navigationPaths.add(itemPathValue);
    }

    if (label && itemPathValue) {
      navigation.push({
        label,
        path: itemPathValue,
      });
    }
  });

  return navigation;
}

function validateModuleUiPath(
  value: string,
  pathToField: string,
  validationErrors: InstallPlanValidationError[],
  moduleId?: string
) {
  if (
    value.length > MAX_UI_PATH_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    validationErrors.push({
      code: 'module_ui_path_invalid',
      message: `UI paths must be same-origin absolute paths beginning with "/" and at most ${MAX_UI_PATH_LENGTH} characters.`,
      path: pathToField,
      node: moduleId,
    });
  }
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  pathToObject: string,
  allowedFields: string[],
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  const allowed = new Set(allowedFields);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      validationErrors.push({
        code: 'unknown_field',
        message: `Unknown field "${key}" is not supported by this metadata schema version.`,
        path: `${pathToObject}.${key}`,
        node,
      });
    }
  }
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  const field = value[key];
  if (typeof field !== 'string' || field.trim() === '') {
    validationErrors.push({
      code: 'metadata_field_required',
      message: `${key} must be a non-empty string.`,
      path: `${parentPath}.${key}`,
      node,
    });
    return undefined;
  }

  return field.trim();
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }

  if (typeof field !== 'string') {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: `${key} must be a string.`,
      path: `${parentPath}.${key}`,
      node,
    });
    return undefined;
  }

  return field.trim();
}

function readRequiredBoolean(
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  const field = value[key];
  if (typeof field !== 'boolean') {
    validationErrors.push({
      code: 'metadata_field_required',
      message: `${key} must be a boolean.`,
      path: `${parentPath}.${key}`,
      node,
    });
    return undefined;
  }

  return field;
}

function readOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }

  if (typeof field !== 'boolean') {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: `${key} must be a boolean.`,
      path: `${parentPath}.${key}`,
      node,
    });
    return undefined;
  }

  return field;
}

function readRequiredNumber(
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    validationErrors.push({
      code: 'metadata_field_required',
      message: `${key} must be a finite number.`,
      path: `${parentPath}.${key}`,
      node,
    });
    return undefined;
  }

  return field;
}

function readOptionalNumber(
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }

  if (typeof field !== 'number' || !Number.isFinite(field)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: `${key} must be a finite number.`,
      path: `${parentPath}.${key}`,
      node,
    });
    return undefined;
  }

  return field;
}

function readOptionalNullableNumber(
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  const field = value[key];
  if (field === undefined || field === null) {
    return null;
  }

  if (typeof field !== 'number' || !Number.isFinite(field)) {
    validationErrors.push({
      code: 'metadata_field_invalid',
      message: `${key} must be a finite number or null.`,
      path: `${parentPath}.${key}`,
      node,
    });
    return null;
  }

  return field;
}

function normalizeMetadataUrl(
  value: string,
  pathToUrl: string,
  validationErrors: InstallPlanValidationError[],
  node?: string
) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      validationErrors.push({
        code: 'metadata_url_invalid',
        message: 'metadataUrl must use http or https.',
        path: pathToUrl,
        node,
      });
      return null;
    }

    return url.href;
  } catch {
    validationErrors.push({
      code: 'metadata_url_invalid',
      message: 'metadataUrl must be a valid absolute URL.',
      path: pathToUrl,
      node,
    });
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isEnvironmentVariableName(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isSafeModuleId(value: string) {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);
}

function isSafeContractKey(value: string) {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value);
}

function isSafeRelativeModulePath(value: string) {
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    return false;
  }

  const normalized = path.posix.normalize(value);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !normalized.split('/').includes('..');
}

function isSafeAbsoluteUnixPath(value: string) {
  if (!value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    return false;
  }

  const normalized = path.posix.normalize(value);
  return normalized !== '/' && !normalized.split('/').includes('..');
}

function pathsOverlap(first: string, second: string) {
  const normalizedFirst = path.posix.normalize(first);
  const normalizedSecond = path.posix.normalize(second);

  return (
    normalizedFirst === normalizedSecond ||
    normalizedFirst.startsWith(`${normalizedSecond}/`) ||
    normalizedSecond.startsWith(`${normalizedFirst}/`)
  );
}
