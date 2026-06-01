import type {
  InstallPlanValidationError,
  ModuleMetadata,
  ModuleRuntimePortMetadata,
} from '@/types/modules';

export const APP_MANIFEST_SCHEMA_VERSION = 'app.0.1';

type AppRuntimeType = 'docker' | 'localCommand';

interface AppRuntimeProfile {
  key: string;
  type: AppRuntimeType;
  path: string;
  dependsOn: string[];
  ports: Array<ModuleRuntimePortMetadata & { public?: boolean }>;
  image?: {
    repository: string;
    tag: string;
    pullPolicy?: string;
  };
  command?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  resources?: Record<string, unknown>;
}

export interface AppManifestConversionResult {
  metadata: ModuleMetadata | null;
  validationErrors: InstallPlanValidationError[];
}

export function convertAppManifestToModuleMetadata(
  value: unknown,
  nodePath: string
): AppManifestConversionResult {
  const validationErrors: InstallPlanValidationError[] = [];

  if (!isObject(value)) {
    return {
      metadata: null,
      validationErrors: [{
        code: 'app_manifest_schema_invalid',
        message: 'App manifest must be a JSON object.',
        path: nodePath,
      }],
    };
  }

  rejectUnknownFields(value, nodePath, [
    'schemaVersion',
    'id',
    'name',
    'description',
    'version',
    'source',
    'channelsUrl',
    'runtimes',
    'defaultRuntime',
    'ui',
    'data',
    'storage',
    'settings',
    'dependencies',
    'capabilities',
    'access',
    'endpoints',
  ], validationErrors);

  const schemaVersion = readRequiredString(value, 'schemaVersion', nodePath, validationErrors);
  const id = readRequiredString(value, 'id', nodePath, validationErrors);
  const name = readRequiredString(value, 'name', nodePath, validationErrors);
  const description = readOptionalString(value, 'description');
  const version = readRequiredString(value, 'version', nodePath, validationErrors);
  validateOptionalSource(value.source, `${nodePath}.source`, validationErrors, id);
  validateOptionalUrl(value.channelsUrl, `${nodePath}.channelsUrl`, validationErrors, id);

  if (schemaVersion && schemaVersion !== APP_MANIFEST_SCHEMA_VERSION) {
    validationErrors.push({
      code: 'unsupported_app_manifest_schema_version',
      message: `Unsupported app manifest schemaVersion "${schemaVersion}".`,
      path: `${nodePath}.schemaVersion`,
      node: id,
    });
  }

  const runtimes = readRuntimeProfiles(value.runtimes, `${nodePath}.runtimes`, validationErrors, id);
  const selectedRuntime = selectRuntimeProfile(
    runtimes,
    readOptionalString(value, 'defaultRuntime'),
    `${nodePath}.defaultRuntime`,
    validationErrors,
    id
  );

  if (
    validationErrors.length > 0 ||
    schemaVersion !== APP_MANIFEST_SCHEMA_VERSION ||
    !id ||
    !name ||
    !version ||
    !selectedRuntime
  ) {
    return { metadata: null, validationErrors };
  }

  const endpoints = buildEndpoints(value.endpoints, value.ui, selectedRuntime, `${nodePath}.endpoints`, validationErrors, id);
  const ui = buildUi(value.ui, endpoints, `${nodePath}.ui`, validationErrors, id);
  const storage = buildStorage(value.storage, value.data, selectedRuntime, `${nodePath}.storage`, validationErrors, id);
  const dependencies = buildDependencies(value.dependencies);

  if (validationErrors.length > 0) {
    return { metadata: null, validationErrors };
  }

  const services = [toModuleService(selectedRuntime)];
  return {
    metadata: {
      schemaVersion: '0.3',
      id,
      name,
      ...(description ? { description } : {}),
      version,
      containers: [],
      services,
      endpoints,
      dependencies,
      settings: Array.isArray(value.settings) ? value.settings as ModuleMetadata['settings'] : undefined,
      storage,
      ...(ui ? { ui } : {}),
    },
    validationErrors,
  };
}

function readRuntimeProfiles(
  value: unknown,
  pathToRuntimes: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): AppRuntimeProfile[] {
  if (!Array.isArray(value) || value.length === 0) {
    validationErrors.push({
      code: 'app_manifest_runtime_required',
      message: 'runtimes must be a non-empty array.',
      path: pathToRuntimes,
      node: appId,
    });
    return [];
  }

  const runtimes: AppRuntimeProfile[] = [];
  const seenKeys = new Set<string>();

  value.forEach((item, index) => {
    const itemPath = `${pathToRuntimes}[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'app_manifest_runtime_invalid',
        message: 'runtimes[] item must be an object.',
        path: itemPath,
        node: appId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, [
      'key',
      'type',
      'image',
      'command',
      'workingDirectory',
      'environment',
      'ports',
      'port',
      'dependsOn',
      'resources',
    ], validationErrors, appId);

    const key = readRequiredString(item, 'key', itemPath, validationErrors, appId);
    const type = readRequiredString(item, 'type', itemPath, validationErrors, appId);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'app_manifest_runtime_duplicate',
        message: `Runtime profile "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: appId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (type !== 'docker' && type !== 'localCommand') {
      validationErrors.push({
        code: 'app_manifest_runtime_type_unsupported',
        message: `Runtime profile type "${type}" is not supported by this Hosty build.`,
        path: `${itemPath}.type`,
        node: appId,
      });
      return;
    }

    const dependsOn = readStringArray(item.dependsOn, `${itemPath}.dependsOn`, validationErrors, appId);
    const ports = readRuntimePorts(item, itemPath, validationErrors, appId);
    const resources = isObject(item.resources) ? item.resources : undefined;

    if (type === 'docker') {
      const image = readRuntimeImage(item.image, `${itemPath}.image`, validationErrors, appId);
      if (key && image) {
        runtimes.push({
          key,
          type,
          path: itemPath,
          image,
          dependsOn,
          ports,
          ...(resources ? { resources } : {}),
        });
      }
      return;
    }

    const command = readRequiredString(item, 'command', itemPath, validationErrors, appId);
    const workingDirectory = readOptionalString(item, 'workingDirectory');
    const environment = readStringMap(item.environment, `${itemPath}.environment`, validationErrors, appId);

    if (key && command) {
      runtimes.push({
        key,
        type,
        path: itemPath,
        command,
        dependsOn,
        ports,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(environment ? { environment } : {}),
        ...(resources ? { resources } : {}),
      });
    }
  });

  return runtimes;
}

function selectRuntimeProfile(
  runtimes: AppRuntimeProfile[],
  defaultRuntime: string | undefined,
  pathToDefaultRuntime: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (runtimes.length === 0) {
    return null;
  }

  if (!defaultRuntime) {
    return runtimes[0] ?? null;
  }

  const selected = runtimes.find(runtime => runtime.key === defaultRuntime);
  if (!selected) {
    validationErrors.push({
      code: 'app_manifest_default_runtime_missing',
      message: `defaultRuntime "${defaultRuntime}" does not reference a runtime profile.`,
      path: pathToDefaultRuntime,
      node: appId,
    });
    return null;
  }

  return selected;
}

function toModuleService(runtime: AppRuntimeProfile): NonNullable<ModuleMetadata['services']>[number] {
  const service = {
    key: runtime.key,
    dependsOn: runtime.dependsOn,
    runtime: {
      ports: runtime.ports.map(port => ({
        key: port.key,
        containerPort: port.containerPort,
        ...(port.localPort !== undefined ? { localPort: port.localPort } : {}),
        protocol: port.protocol,
      })),
      ...(runtime.resources ? { resources: runtime.resources } : {}),
    },
  };

  if (runtime.type === 'docker') {
    return {
      ...service,
      source: {
        type: 'image' as const,
        image: runtime.image!,
      },
    };
  }

  return {
    ...service,
    source: {
      type: 'process' as const,
      command: runtime.command!,
      ...(runtime.workingDirectory ? { workingDirectory: runtime.workingDirectory } : {}),
      ...(runtime.environment ? { environment: runtime.environment } : {}),
    },
  };
}

function buildEndpoints(
  value: unknown,
  ui: unknown,
  runtime: AppRuntimeProfile,
  pathToEndpoints: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): NonNullable<ModuleMetadata['endpoints']> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const itemPath = `${pathToEndpoints}[${index}]`;
      if (!isObject(item)) {
        validationErrors.push({
          code: 'app_manifest_endpoint_invalid',
          message: 'endpoints[] item must be an object.',
          path: itemPath,
          node: appId,
        });
        return [];
      }

      rejectUnknownFields(item, itemPath, ['key', 'service', 'container', 'port', 'public'], validationErrors, appId);
      const key = readRequiredString(item, 'key', itemPath, validationErrors, appId);
      const service = readOptionalString(item, 'service') ?? readOptionalString(item, 'container') ?? runtime.key;
      const port = readRequiredString(item, 'port', itemPath, validationErrors, appId);
      const isPublic = readOptionalBoolean(item, 'public') ?? false;
      return key && port ? [{ key, service, port, public: isPublic }] : [];
    });
  }

  const uiPresent = ui !== undefined;
  return runtime.ports.map((port, index) => ({
    key: port.key,
    service: runtime.key,
    port: port.key,
    public: port.public ?? (uiPresent && index === 0),
  }));
}

function buildUi(
  value: unknown,
  endpoints: NonNullable<ModuleMetadata['endpoints']>,
  pathToUi: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleMetadata['ui'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    validationErrors.push({
      code: 'app_manifest_ui_invalid',
      message: 'ui must be an object.',
      path: pathToUi,
      node: appId,
    });
    return undefined;
  }

  rejectUnknownFields(value, pathToUi, ['category', 'icon', 'entrypoint', 'navigation', 'path', 'portKey'], validationErrors, appId);
  const publicEndpoint = endpoints.find(endpoint => endpoint.public) ?? endpoints[0];
  const icon = readOptionalString(value, 'icon');
  const navigation = Array.isArray(value.navigation) ? value.navigation as NonNullable<ModuleMetadata['ui']>['navigation'] : [];
  let entryPath: string | undefined;
  let portKey: string | undefined;

  if (typeof value.entrypoint === 'string') {
    entryPath = value.entrypoint.trim();
  } else if (isObject(value.entrypoint)) {
    entryPath = readOptionalString(value.entrypoint, 'path');
    portKey = readOptionalString(value.entrypoint, 'portKey') ?? readOptionalString(value.entrypoint, 'endpoint');
  }

  entryPath ??= readOptionalString(value, 'path') ?? '/';
  portKey ??= readOptionalString(value, 'portKey') ?? publicEndpoint?.key;

  if (!portKey) {
    validationErrors.push({
      code: 'app_manifest_ui_endpoint_missing',
      message: 'ui requires at least one runtime port or endpoint.',
      path: `${pathToUi}.entrypoint`,
      node: appId,
    });
    return undefined;
  }

  return {
    category: 'Apps',
    ...(icon ? { icon } : {}),
    entrypoint: {
      portKey,
      path: entryPath,
    },
    navigation,
  };
}

function buildStorage(
  storageValue: unknown,
  dataValue: unknown,
  runtime: AppRuntimeProfile,
  pathToStorage: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleMetadata['storage'] | undefined {
  const storage = isObject(storageValue)
    ? {
        directories: Array.isArray(storageValue.directories)
          ? [...storageValue.directories] as NonNullable<ModuleMetadata['storage']>['directories']
          : [],
        mountCollections: Array.isArray(storageValue.mountCollections)
          ? storageValue.mountCollections as NonNullable<ModuleMetadata['storage']>['mountCollections']
          : [],
      }
    : {
        directories: [],
        mountCollections: [],
      };

  if (storageValue !== undefined && !isObject(storageValue)) {
    validationErrors.push({
      code: 'app_manifest_storage_invalid',
      message: 'storage must be an object.',
      path: pathToStorage,
      node: appId,
    });
  }

  if (!isObject(dataValue) || readOptionalBoolean(dataValue, 'enabled') === false || runtime.type !== 'docker') {
    return storage;
  }

  const existingDataDirectory = storage.directories?.some(directory =>
    isObject(directory) && directory.key === 'data'
  );
  if (existingDataDirectory) {
    return storage;
  }

  const containerPath = readAppDataContainerPath(dataValue, runtime.key) ?? '/app/data';
  storage.directories ??= [];
  storage.directories.push({
    key: 'data',
    label: 'Data',
    purpose: 'primary-app-data',
    required: true,
    mount: {
      type: 'bind',
      modulePath: 'data',
    },
    targets: [{
      container: runtime.key,
      containerPath,
      writable: true,
    }],
  });

  return storage;
}

function readAppDataContainerPath(dataValue: Record<string, unknown>, runtimeKey: string) {
  const targets = dataValue.targets;
  if (!Array.isArray(targets)) {
    return null;
  }

  for (const target of targets) {
    if (!isObject(target)) {
      continue;
    }
    const runtime = readOptionalString(target, 'runtime');
    if (runtime && runtime !== runtimeKey && runtime !== 'docker') {
      continue;
    }
    const containerPath = readOptionalString(target, 'containerPath');
    if (containerPath) {
      return containerPath;
    }
  }

  return null;
}

function buildDependencies(value: unknown): ModuleMetadata['dependencies'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap(item => {
    if (!isObject(item)) {
      return [];
    }

    const metadataUrl = readOptionalString(item, 'metadataUrl') ?? readOptionalString(item, 'manifestUrl');
    if (!metadataUrl) {
      return [item as unknown as NonNullable<ModuleMetadata['dependencies']>[number]];
    }

    const rest = { ...item };
    delete rest.manifestUrl;
    return [{
      ...rest,
      metadataUrl,
    } as unknown as NonNullable<ModuleMetadata['dependencies']>[number]];
  });
}

function readRuntimePorts(
  runtime: Record<string, unknown>,
  runtimePath: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (typeof runtime.port === 'number') {
    return [{
      key: 'http',
      containerPort: runtime.port,
      protocol: 'http',
      public: true,
    }];
  }

  if (runtime.ports === undefined) {
    return [];
  }

  if (!Array.isArray(runtime.ports)) {
    validationErrors.push({
      code: 'app_manifest_runtime_ports_invalid',
      message: 'runtimes[].ports must be an array.',
      path: `${runtimePath}.ports`,
      node: appId,
    });
    return [];
  }

  return runtime.ports.flatMap((item, index) => {
    const itemPath = `${runtimePath}.ports[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'app_manifest_runtime_port_invalid',
        message: 'runtimes[].ports[] item must be an object.',
        path: itemPath,
        node: appId,
      });
      return [];
    }

    rejectUnknownFields(item, itemPath, ['key', 'containerPort', 'localPort', 'protocol', 'public'], validationErrors, appId);
    const key = readRequiredString(item, 'key', itemPath, validationErrors, appId);
    const containerPort = readRequiredNumber(item, 'containerPort', itemPath, validationErrors, appId);
    const protocol = readOptionalString(item, 'protocol') ?? 'http';
    const localPort = readOptionalNumber(item, 'localPort');
    const isPublic = readOptionalBoolean(item, 'public');

    if (!key || containerPort === undefined) {
      return [];
    }

    return [{
      key,
      containerPort,
      ...(localPort !== undefined ? { localPort } : {}),
      protocol,
      ...(isPublic !== undefined ? { public: isPublic } : {}),
    }];
  });
}

function readRuntimeImage(
  value: unknown,
  pathToImage: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (typeof value === 'string' && value.trim()) {
    return parseImageReference(value.trim());
  }

  if (!isObject(value)) {
    validationErrors.push({
      code: 'app_manifest_runtime_image_required',
      message: 'Docker runtime profiles must declare an image string or object.',
      path: pathToImage,
      node: appId,
    });
    return null;
  }

  rejectUnknownFields(value, pathToImage, ['repository', 'tag', 'pullPolicy'], validationErrors, appId);
  const repository = readRequiredString(value, 'repository', pathToImage, validationErrors, appId);
  const tag = readRequiredString(value, 'tag', pathToImage, validationErrors, appId);
  const pullPolicy = readOptionalString(value, 'pullPolicy');

  return repository && tag
    ? {
        repository,
        tag,
        ...(pullPolicy ? { pullPolicy } : {}),
      }
    : null;
}

function parseImageReference(reference: string) {
  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');

  if (lastColon > lastSlash) {
    return {
      repository: reference.slice(0, lastColon),
      tag: reference.slice(lastColon + 1),
    };
  }

  return {
    repository: reference,
    tag: 'latest',
  };
}

function validateOptionalSource(
  value: unknown,
  pathToSource: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (value === undefined) {
    return;
  }

  if (!isObject(value)) {
    validationErrors.push({
      code: 'app_manifest_source_invalid',
      message: 'source must be an object when provided.',
      path: pathToSource,
      node: appId,
    });
    return;
  }

  rejectUnknownFields(value, pathToSource, ['type', 'repository', 'ref', 'commit'], validationErrors, appId);
  const type = readRequiredString(value, 'type', pathToSource, validationErrors, appId);
  if (type && type !== 'git') {
    validationErrors.push({
      code: 'app_manifest_source_type_unsupported',
      message: `source.type "${type}" is not supported.`,
      path: `${pathToSource}.type`,
      node: appId,
    });
  }
}

function validateOptionalUrl(
  value: unknown,
  pathToUrl: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'string' || !value.trim()) {
    validationErrors.push({
      code: 'app_manifest_url_invalid',
      message: 'URL fields must be non-empty strings.',
      path: pathToUrl,
      node: appId,
    });
  }
}

function readStringArray(
  value: unknown,
  pathToArray: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'app_manifest_string_array_invalid',
      message: 'Field must be an array of strings.',
      path: pathToArray,
      node: appId,
    });
    return [];
  }

  return value.flatMap((item, index) => {
    if (typeof item === 'string' && item.trim()) {
      return [item.trim()];
    }

    validationErrors.push({
      code: 'app_manifest_string_array_invalid',
      message: 'Field must be an array of strings.',
      path: `${pathToArray}[${index}]`,
      node: appId,
    });
    return [];
  });
}

function readStringMap(
  value: unknown,
  pathToMap: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    validationErrors.push({
      code: 'app_manifest_string_map_invalid',
      message: 'Field must be an object with string values.',
      path: pathToMap,
      node: appId,
    });
    return undefined;
  }

  const map: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      map[key] = item;
      continue;
    }

    validationErrors.push({
      code: 'app_manifest_string_map_invalid',
      message: 'Field must be an object with string values.',
      path: `${pathToMap}.${key}`,
      node: appId,
    });
  }

  return map;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  pathToValue: string,
  allowedFields: string[],
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      validationErrors.push({
        code: 'app_manifest_field_unknown',
        message: `Unknown field "${field}".`,
        path: `${pathToValue}.${field}`,
        node: appId,
      });
    }
  }
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  pathToObject: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  const result = readOptionalString(value, key);
  if (!result) {
    validationErrors.push({
      code: 'app_manifest_field_required',
      message: `${key} must be a non-empty string.`,
      path: `${pathToObject}.${key}`,
      node: appId,
    });
  }

  return result;
}

function readOptionalString(value: Record<string, unknown>, key: string) {
  const item = value[key];
  return typeof item === 'string' && item.trim() ? item.trim() : undefined;
}

function readRequiredNumber(
  value: Record<string, unknown>,
  key: string,
  pathToObject: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  const result = readOptionalNumber(value, key);
  if (result === undefined) {
    validationErrors.push({
      code: 'app_manifest_field_required',
      message: `${key} must be a number.`,
      path: `${pathToObject}.${key}`,
      node: appId,
    });
  }

  return result;
}

function readOptionalNumber(value: Record<string, unknown>, key: string) {
  const item = value[key];
  return typeof item === 'number' ? item : undefined;
}

function readOptionalBoolean(value: Record<string, unknown>, key: string) {
  const item = value[key];
  return typeof item === 'boolean' ? item : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
