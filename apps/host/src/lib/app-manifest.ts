import type {
  InstallPlanValidationError,
  ModuleMetadata,
  ModuleRuntimePortMetadata,
} from '@/types/modules';

export const APP_MANIFEST_SCHEMA_VERSION = 'app.0.1';

type AppRuntimeType = 'docker' | 'localCommand';
type ModuleServiceMetadata = NonNullable<ModuleMetadata['services']>[number];
type ModuleStorageMetadata = NonNullable<ModuleMetadata['storage']>;
type ModuleStorageDirectoryMetadata = NonNullable<ModuleStorageMetadata['directories']>[number];
type ModuleStorageTargetMetadata = ModuleStorageDirectoryMetadata['targets'];
type AppRuntimePort = ModuleRuntimePortMetadata & { public?: boolean };

interface AppRuntimeProfileDeclaration {
  key: string;
  type: AppRuntimeType;
  path: string;
  isDefault: boolean;
}

interface AppServiceRuntime {
  runtimeKey: string;
  type: AppRuntimeType;
  path: string;
  ports: AppRuntimePort[];
  image?: {
    repository: string;
    tag: string;
    pullPolicy?: string;
  };
  command?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  resources?: Record<string, unknown>;
  healthCheck?: ModuleServiceMetadata['healthCheck'];
}

interface AppSelectedService {
  key: string;
  dependsOn: string[];
  runtime: AppServiceRuntime;
}

export interface AppManifestConversionResult {
  metadata: ModuleMetadata | null;
  selectedRuntime?: string;
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
    'runtimeProfiles',
    'services',
    'runtimes',
    'defaultRuntime',
    'ui',
    'data',
    'storage',
    'settings',
    'dependencies',
    'connections',
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

  if (
    validationErrors.length > 0 ||
    schemaVersion !== APP_MANIFEST_SCHEMA_VERSION ||
    !id ||
    !name ||
    !version
  ) {
    return { metadata: null, validationErrors };
  }

  return value.services !== undefined || value.runtimeProfiles !== undefined
    ? convertServiceManifest(value, nodePath, { id, name, description, version }, validationErrors)
    : convertLegacySingleServiceManifest(value, nodePath, { id, name, description, version }, validationErrors);
}

function convertServiceManifest(
  value: Record<string, unknown>,
  nodePath: string,
  base: {
    id: string;
    name: string;
    description?: string;
    version: string;
  },
  validationErrors: InstallPlanValidationError[]
): AppManifestConversionResult {
  if (value.runtimes !== undefined) {
    validationErrors.push({
      code: 'app_manifest_runtime_field_conflict',
      message: 'Use services[].runtimes with runtimeProfiles; top-level runtimes is a legacy single-service field.',
      path: `${nodePath}.runtimes`,
      node: base.id,
    });
  }

  const runtimeProfiles = readRuntimeProfileDeclarations(
    value.runtimeProfiles,
    `${nodePath}.runtimeProfiles`,
    validationErrors,
    base.id
  );
  const selectedProfile = selectRuntimeProfileDeclaration(
    runtimeProfiles,
    readOptionalString(value, 'defaultRuntime'),
    `${nodePath}.defaultRuntime`,
    validationErrors,
    base.id
  );
  const selectedServices = selectedProfile
    ? readAppServices(value.services, `${nodePath}.services`, runtimeProfiles, selectedProfile, validationErrors, base.id)
    : [];

  if (validationErrors.length > 0 || !selectedProfile || selectedServices.length === 0) {
    return { metadata: null, validationErrors };
  }

  const endpoints = buildServiceEndpoints(value.endpoints, value.ui, selectedServices, `${nodePath}.endpoints`, validationErrors, base.id);
  const ui = buildUi(value.ui, endpoints, `${nodePath}.ui`, validationErrors, base.id);
  const storage = buildStorage(value.storage, value.data, selectedProfile, selectedServices, `${nodePath}.storage`, validationErrors, base.id);
  const dependencies = buildDependencies(value.dependencies, `${nodePath}.dependencies`, validationErrors, base.id);
  const connections = buildConnections(value.connections, `${nodePath}.connections`, validationErrors, base.id);
  const settings = buildSettings(value.settings, `${nodePath}.settings`, validationErrors, base.id);

  if (validationErrors.length > 0) {
    return { metadata: null, validationErrors };
  }

  return {
    metadata: {
      schemaVersion: '0.3',
      id: base.id,
      name: base.name,
      ...(base.description ? { description: base.description } : {}),
      version: base.version,
      containers: [],
      services: selectedServices.map(toModuleService),
      endpoints,
      connections,
      dependencies,
      settings,
      storage,
      ...(ui ? { ui } : {}),
    },
    selectedRuntime: selectedProfile.key,
    validationErrors,
  };
}

function convertLegacySingleServiceManifest(
  value: Record<string, unknown>,
  nodePath: string,
  base: {
    id: string;
    name: string;
    description?: string;
    version: string;
  },
  validationErrors: InstallPlanValidationError[]
): AppManifestConversionResult {
  const runtimes = readLegacyRuntimeProfiles(value.runtimes, `${nodePath}.runtimes`, validationErrors, base.id);
  const selectedRuntime = selectLegacyRuntimeProfile(
    runtimes,
    readOptionalString(value, 'defaultRuntime'),
    `${nodePath}.defaultRuntime`,
    validationErrors,
    base.id
  );

  if (validationErrors.length > 0 || !selectedRuntime) {
    return { metadata: null, validationErrors };
  }

  const selectedProfile: AppRuntimeProfileDeclaration = {
    key: selectedRuntime.runtimeKey,
    type: selectedRuntime.type,
    path: selectedRuntime.path,
    isDefault: true,
  };
  const selectedServices: AppSelectedService[] = [{
    key: selectedRuntime.runtimeKey,
    dependsOn: selectedRuntime.dependsOn,
    runtime: selectedRuntime,
  }];
  const endpoints = buildServiceEndpoints(value.endpoints, value.ui, selectedServices, `${nodePath}.endpoints`, validationErrors, base.id);
  const ui = buildUi(value.ui, endpoints, `${nodePath}.ui`, validationErrors, base.id);
  const storage = buildStorage(value.storage, value.data, selectedProfile, selectedServices, `${nodePath}.storage`, validationErrors, base.id);
  const dependencies = buildDependencies(value.dependencies, `${nodePath}.dependencies`, validationErrors, base.id);
  const connections = buildConnections(value.connections, `${nodePath}.connections`, validationErrors, base.id);
  const settings = buildSettings(value.settings, `${nodePath}.settings`, validationErrors, base.id);

  if (validationErrors.length > 0) {
    return { metadata: null, validationErrors };
  }

  return {
    metadata: {
      schemaVersion: '0.3',
      id: base.id,
      name: base.name,
      ...(base.description ? { description: base.description } : {}),
      version: base.version,
      containers: [],
      services: selectedServices.map(toModuleService),
      endpoints,
      connections,
      dependencies,
      settings,
      storage,
      ...(ui ? { ui } : {}),
    },
    selectedRuntime: selectedRuntime.runtimeKey,
    validationErrors,
  };
}

function readRuntimeProfileDeclarations(
  value: unknown,
  pathToRuntimeProfiles: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): AppRuntimeProfileDeclaration[] {
  if (!Array.isArray(value) || value.length === 0) {
    validationErrors.push({
      code: 'app_manifest_runtime_profile_required',
      message: 'runtimeProfiles must be a non-empty array when services are declared.',
      path: pathToRuntimeProfiles,
      node: appId,
    });
    return [];
  }

  const profiles: AppRuntimeProfileDeclaration[] = [];
  const seenKeys = new Set<string>();
  let defaultCount = 0;

  value.forEach((item, index) => {
    const itemPath = `${pathToRuntimeProfiles}[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'app_manifest_runtime_profile_invalid',
        message: 'runtimeProfiles[] item must be an object.',
        path: itemPath,
        node: appId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['key', 'label', 'type', 'default'], validationErrors, appId);
    const key = readRequiredString(item, 'key', itemPath, validationErrors, appId);
    const type = readRequiredString(item, 'type', itemPath, validationErrors, appId);
    const isDefault = readOptionalBoolean(item, 'default') ?? false;

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'app_manifest_runtime_profile_duplicate',
        message: `Runtime profile "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: appId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (key && !isSafeContractKey(key)) {
      validationErrors.push({
        code: 'app_manifest_runtime_profile_key_invalid',
        message: 'runtimeProfiles[].key must match ^[a-z][a-z0-9-]{0,62}$.',
        path: `${itemPath}.key`,
        node: appId,
      });
    }

    if (type !== 'docker' && type !== 'localCommand') {
      validationErrors.push({
        code: 'app_manifest_runtime_type_unsupported',
        message: `Runtime profile type "${type}" is not supported by this Hosty build.`,
        path: `${itemPath}.type`,
        node: appId,
      });
    }

    if (isDefault) {
      defaultCount += 1;
    }

    if (key && isSafeContractKey(key) && (type === 'docker' || type === 'localCommand')) {
      profiles.push({
        key,
        type,
        path: itemPath,
        isDefault,
      });
    }
  });

  if (defaultCount > 1) {
    validationErrors.push({
      code: 'app_manifest_runtime_default_duplicate',
      message: 'Only one runtimeProfiles[] item may set default: true.',
      path: pathToRuntimeProfiles,
      node: appId,
    });
  }

  return profiles;
}

function selectRuntimeProfileDeclaration(
  profiles: AppRuntimeProfileDeclaration[],
  defaultRuntime: string | undefined,
  pathToDefaultRuntime: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (profiles.length === 0) {
    return null;
  }

  if (defaultRuntime) {
    const selected = profiles.find(profile => profile.key === defaultRuntime);
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

  return profiles.find(profile => profile.isDefault) ?? profiles[0] ?? null;
}

function readAppServices(
  value: unknown,
  pathToServices: string,
  runtimeProfiles: AppRuntimeProfileDeclaration[],
  selectedProfile: AppRuntimeProfileDeclaration,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): AppSelectedService[] {
  if (!Array.isArray(value) || value.length === 0) {
    validationErrors.push({
      code: 'app_manifest_services_required',
      message: 'services must be a non-empty array.',
      path: pathToServices,
      node: appId,
    });
    return [];
  }

  const selectedServices: AppSelectedService[] = [];
  const seenKeys = new Set<string>();
  const profileKeys = new Set(runtimeProfiles.map(profile => profile.key));

  value.forEach((item, index) => {
    const itemPath = `${pathToServices}[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'app_manifest_service_invalid',
        message: 'services[] item must be an object.',
        path: itemPath,
        node: appId,
      });
      return;
    }

    rejectUnknownFields(item, itemPath, ['key', 'label', 'dependsOn', 'runtimes'], validationErrors, appId);
    const key = readRequiredString(item, 'key', itemPath, validationErrors, appId);
    const dependsOn = readStringArray(item.dependsOn, `${itemPath}.dependsOn`, validationErrors, appId);

    if (key && seenKeys.has(key)) {
      validationErrors.push({
        code: 'app_manifest_service_duplicate',
        message: `Service "${key}" is declared more than once.`,
        path: `${itemPath}.key`,
        node: appId,
      });
    }
    if (key) {
      seenKeys.add(key);
    }

    if (!isObject(item.runtimes)) {
      validationErrors.push({
        code: 'app_manifest_service_runtimes_required',
        message: 'services[].runtimes must be an object keyed by runtime profile.',
        path: `${itemPath}.runtimes`,
        node: appId,
      });
      return;
    }

    for (const runtimeKey of Object.keys(item.runtimes)) {
      if (!profileKeys.has(runtimeKey)) {
        validationErrors.push({
          code: 'app_manifest_service_runtime_unknown',
          message: `Service "${key || index}" declares unknown runtime profile "${runtimeKey}".`,
          path: `${itemPath}.runtimes.${runtimeKey}`,
          node: appId,
        });
      }
    }

    let selectedRuntime: AppServiceRuntime | null = null;
    for (const profile of runtimeProfiles) {
      const runtimeValue = item.runtimes[profile.key];
      if (runtimeValue === undefined) {
        validationErrors.push({
          code: 'app_manifest_service_runtime_missing',
          message: `Service "${key || index}" must declare runtime "${profile.key}".`,
          path: `${itemPath}.runtimes.${profile.key}`,
          node: appId,
        });
        continue;
      }

      const runtime = readServiceRuntime(runtimeValue, profile, `${itemPath}.runtimes.${profile.key}`, validationErrors, appId);
      if (profile.key === selectedProfile.key) {
        selectedRuntime = runtime;
      }
    }

    if (key && selectedRuntime) {
      selectedServices.push({
        key,
        dependsOn,
        runtime: selectedRuntime,
      });
    }
  });

  return selectedServices;
}

function readServiceRuntime(
  value: unknown,
  profile: AppRuntimeProfileDeclaration,
  runtimePath: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string,
  additionalAllowedFields: string[] = []
): AppServiceRuntime | null {
  if (!isObject(value)) {
    validationErrors.push({
      code: 'app_manifest_service_runtime_invalid',
      message: 'services[].runtimes entries must be objects.',
      path: runtimePath,
      node: appId,
    });
    return null;
  }

  rejectUnknownFields(value, runtimePath, [
    ...additionalAllowedFields,
    'type',
    'image',
    'command',
    'workingDirectory',
    'environment',
    'ports',
    'port',
    'resources',
    'healthCheck',
  ], validationErrors, appId);

  const type = readOptionalString(value, 'type') ?? profile.type;
  if (type !== 'docker' && type !== 'localCommand') {
    validationErrors.push({
      code: 'app_manifest_runtime_type_unsupported',
      message: `Runtime type "${type}" is not supported by this Hosty build.`,
      path: `${runtimePath}.type`,
      node: appId,
    });
    return null;
  }

  if (type !== profile.type) {
    validationErrors.push({
      code: 'app_manifest_service_runtime_type_mismatch',
      message: `Service runtime type "${type}" must match runtime profile "${profile.key}" type "${profile.type}".`,
      path: `${runtimePath}.type`,
      node: appId,
    });
    return null;
  }

  const ports = readRuntimePorts(value, runtimePath, validationErrors, appId);
  const resources = isObject(value.resources) ? value.resources : undefined;
  const healthCheck = readOptionalHealthCheck(value.healthCheck, `${runtimePath}.healthCheck`, validationErrors, appId);

  if (type === 'docker') {
    const image = readRuntimeImage(value.image, `${runtimePath}.image`, validationErrors, appId);
    return image
      ? {
          runtimeKey: profile.key,
          type,
          path: runtimePath,
          image,
          ports,
          ...(resources ? { resources } : {}),
          ...(healthCheck ? { healthCheck } : {}),
        }
      : null;
  }

  const command = readRequiredString(value, 'command', runtimePath, validationErrors, appId);
  const workingDirectory = readOptionalString(value, 'workingDirectory');
  const environment = readStringMap(value.environment, `${runtimePath}.environment`, validationErrors, appId);

  return command
    ? {
        runtimeKey: profile.key,
        type,
        path: runtimePath,
        command,
        ports,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(environment ? { environment } : {}),
        ...(resources ? { resources } : {}),
        ...(healthCheck ? { healthCheck } : {}),
      }
    : null;
}

function readLegacyRuntimeProfiles(
  value: unknown,
  pathToRuntimes: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): Array<AppServiceRuntime & { dependsOn: string[] }> {
  if (!Array.isArray(value) || value.length === 0) {
    validationErrors.push({
      code: 'app_manifest_runtime_required',
      message: 'runtimes must be a non-empty array.',
      path: pathToRuntimes,
      node: appId,
    });
    return [];
  }

  const runtimes: Array<AppServiceRuntime & { dependsOn: string[] }> = [];
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
      'healthCheck',
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

    const profile: AppRuntimeProfileDeclaration = {
      key: key ?? '',
      type,
      path: itemPath,
      isDefault: false,
    };
    const runtime = readServiceRuntime(item, profile, itemPath, validationErrors, appId, ['key', 'dependsOn']);
    const dependsOn = readStringArray(item.dependsOn, `${itemPath}.dependsOn`, validationErrors, appId);
    if (key && runtime) {
      runtimes.push({
        ...runtime,
        dependsOn,
      });
    }
  });

  return runtimes;
}

function selectLegacyRuntimeProfile(
  runtimes: Array<AppServiceRuntime & { dependsOn: string[] }>,
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

  const selected = runtimes.find(runtime => runtime.runtimeKey === defaultRuntime);
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

function toModuleService(service: AppSelectedService): ModuleServiceMetadata {
  const runtime = service.runtime;
  const baseService = {
    key: service.key,
    dependsOn: service.dependsOn,
    runtime: {
      ports: runtime.ports.map(port => ({
        key: port.key,
        containerPort: port.containerPort,
        ...(port.localPort !== undefined ? { localPort: port.localPort } : {}),
        protocol: port.protocol,
      })),
      ...(runtime.resources ? { resources: runtime.resources } : {}),
    },
    ...(runtime.healthCheck ? { healthCheck: runtime.healthCheck } : {}),
  };

  if (runtime.type === 'docker') {
    return {
      ...baseService,
      source: {
        type: 'image' as const,
        image: runtime.image!,
      },
    };
  }

  return {
    ...baseService,
    source: {
      type: 'process' as const,
      command: runtime.command!,
      ...(runtime.workingDirectory ? { workingDirectory: runtime.workingDirectory } : {}),
      ...(runtime.environment ? { environment: runtime.environment } : {}),
    },
  };
}

function buildServiceEndpoints(
  value: unknown,
  ui: unknown,
  services: AppSelectedService[],
  pathToEndpoints: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): NonNullable<ModuleMetadata['endpoints']> {
  const servicesByKey = new Map(services.map(service => [service.key, service]));

  if (value !== undefined && !Array.isArray(value)) {
    validationErrors.push({
      code: 'app_manifest_endpoints_invalid',
      message: 'endpoints must be an array.',
      path: pathToEndpoints,
      node: appId,
    });
    return [];
  }

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
      const service = readEndpointService(item, itemPath, services, validationErrors, appId);
      const port = readRequiredString(item, 'port', itemPath, validationErrors, appId);
      const isPublic = readOptionalBoolean(item, 'public') ?? false;
      const runtimePort = service && port
        ? servicesByKey.get(service)?.runtime.ports.find(candidate => candidate.key === port)
        : undefined;

      if (service && !runtimePort) {
        validationErrors.push({
          code: 'app_manifest_endpoint_port_missing',
          message: `Endpoint "${key || index}" references unknown port "${port}" on service "${service}".`,
          path: `${itemPath}.port`,
          node: appId,
        });
      }

      return key && service && port && runtimePort
        ? [{ key, service, port, public: isPublic }]
        : [];
    });
  }

  const uiPresent = ui !== undefined;
  let firstPort = true;
  return services.flatMap(service => service.runtime.ports.map(port => {
    const endpoint = {
      key: services.length === 1 ? port.key : `${service.key}-${port.key}`,
      service: service.key,
      port: port.key,
      public: port.public ?? (uiPresent && firstPort),
    };
    firstPort = false;
    return endpoint;
  }));
}

function readEndpointService(
  value: Record<string, unknown>,
  itemPath: string,
  services: AppSelectedService[],
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  const service = readOptionalString(value, 'service');
  const container = readOptionalString(value, 'container');
  if (service && container && service !== container) {
    validationErrors.push({
      code: 'app_manifest_endpoint_target_conflict',
      message: 'endpoints[] must not declare different service and container targets.',
      path: itemPath,
      node: appId,
    });
  }

  const target = service || container;
  if (!target) {
    if (services.length === 1) {
      return services[0]?.key;
    }

    validationErrors.push({
      code: 'app_manifest_endpoint_service_required',
      message: 'endpoints[].service is required when an app declares multiple services.',
      path: `${itemPath}.service`,
      node: appId,
    });
    return undefined;
  }

  if (!services.some(candidate => candidate.key === target)) {
    validationErrors.push({
      code: 'app_manifest_endpoint_service_missing',
      message: `Endpoint references unknown service "${target}".`,
      path: `${itemPath}.service`,
      node: appId,
    });
    return undefined;
  }

  return target;
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

  rejectUnknownFields(value, pathToUi, ['category', 'icon', 'entrypoint', 'navigation', 'path', 'portKey', 'endpoint'], validationErrors, appId);
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
  portKey ??= readOptionalString(value, 'portKey') ?? readOptionalString(value, 'endpoint') ?? publicEndpoint?.key;

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
  selectedProfile: AppRuntimeProfileDeclaration,
  services: AppSelectedService[],
  pathToStorage: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleMetadata['storage'] | undefined {
  const storage = normalizeStorage(storageValue, pathToStorage, validationErrors, appId);

  if (dataValue !== undefined && !isObject(dataValue)) {
    validationErrors.push({
      code: 'app_manifest_data_invalid',
      message: 'data must be an object.',
      path: `${pathToStorage.replace(/\.storage$/, '')}.data`,
      node: appId,
    });
  }

  if (!isObject(dataValue) || readOptionalBoolean(dataValue, 'enabled') === false || selectedProfile.type !== 'docker') {
    return storage;
  }

  const existingDataDirectory = storage.directories?.some(directory =>
    isObject(directory) && directory.key === 'data'
  );
  if (existingDataDirectory) {
    return storage;
  }

  const targets = readAppDataTargets(dataValue, selectedProfile, services, validationErrors, appId);
  if (targets.length === 0) {
    return storage;
  }

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
    targets,
  });

  return storage;
}

function normalizeStorage(
  value: unknown,
  pathToStorage: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleStorageMetadata {
  if (value !== undefined && !isObject(value)) {
    validationErrors.push({
      code: 'app_manifest_storage_invalid',
      message: 'storage must be an object.',
      path: pathToStorage,
      node: appId,
    });
  }

  if (!isObject(value)) {
    return {
      directories: [],
      mountCollections: [],
    };
  }

  return {
    directories: Array.isArray(value.directories)
      ? value.directories.map((item, index) => normalizeStorageTargets(item, `${pathToStorage}.directories[${index}].targets`, validationErrors, appId))
      : [],
    mountCollections: Array.isArray(value.mountCollections)
      ? value.mountCollections.map((item, index) => normalizeStorageTargets(item, `${pathToStorage}.mountCollections[${index}].targets`, validationErrors, appId))
      : [],
  };
}

function normalizeStorageTargets<T>(
  value: T,
  pathToTargets: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (!isObject(value) || !Array.isArray(value.targets)) {
    return value;
  }

  return {
    ...value,
    targets: normalizeServiceTargets(value.targets, pathToTargets, validationErrors, appId),
  } as T;
}

function readAppDataTargets(
  value: Record<string, unknown>,
  selectedProfile: AppRuntimeProfileDeclaration,
  services: AppSelectedService[],
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleStorageTargetMetadata {
  const dockerServices = services.filter(service => service.runtime.type === 'docker');
  const defaultService = dockerServices[0];
  if (!defaultService) {
    return [];
  }

  if (value.targets !== undefined && !Array.isArray(value.targets)) {
    validationErrors.push({
      code: 'app_manifest_data_targets_invalid',
      message: 'data.targets must be an array.',
      path: '$.data.targets',
      node: appId,
    });
    return [];
  }

  if (value.targets === undefined) {
    return [{
      container: defaultService.key,
      containerPath: '/app/data',
      writable: true,
    }];
  }

  const servicesByKey = new Map(services.map(service => [service.key, service]));
  const targets: ModuleStorageTargetMetadata = [];
  const seenServices = new Set<string>();

  value.targets.forEach((item, index) => {
    const itemPath = `$.data.targets[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'app_manifest_data_target_invalid',
        message: 'data.targets[] item must be an object.',
        path: itemPath,
        node: appId,
      });
      return;
    }

    const runtime = readOptionalString(item, 'runtime');
    if (runtime && runtime !== selectedProfile.key && runtime !== selectedProfile.type) {
      return;
    }

    const serviceKey = readOptionalString(item, 'service') ?? readOptionalString(item, 'container') ?? defaultService.key;
    const service = servicesByKey.get(serviceKey);
    if (!service) {
      validationErrors.push({
        code: 'app_manifest_data_service_missing',
        message: `data.targets[] references unknown service "${serviceKey}".`,
        path: `${itemPath}.service`,
        node: appId,
      });
      return;
    }

    if (service.runtime.type !== 'docker') {
      return;
    }

    if (seenServices.has(service.key)) {
      validationErrors.push({
        code: 'app_manifest_data_target_duplicate',
        message: `data.targets[] declares service "${service.key}" more than once for the selected runtime.`,
        path: itemPath,
        node: appId,
      });
      return;
    }

    seenServices.add(service.key);
    targets.push({
      container: service.key,
      containerPath: readOptionalString(item, 'containerPath') ?? '/app/data',
      writable: true,
    });
  });

  return targets;
}

function buildSettings(
  value: unknown,
  pathToSettings: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleMetadata['settings'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'app_manifest_settings_invalid',
      message: 'settings must be an array.',
      path: pathToSettings,
      node: appId,
    });
    return undefined;
  }

  return value.map((item, index) => {
    if (!isObject(item)) {
      return item as NonNullable<ModuleMetadata['settings']>[number];
    }

    return {
      ...item,
      targets: normalizeServiceTargets(item.targets, `${pathToSettings}[${index}].targets`, validationErrors, appId),
    } as NonNullable<ModuleMetadata['settings']>[number];
  });
}

function buildConnections(
  value: unknown,
  pathToConnections: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleMetadata['connections'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'app_manifest_connections_invalid',
      message: 'connections must be an array.',
      path: pathToConnections,
      node: appId,
    });
    return undefined;
  }

  return value.map((item, index) => {
    if (!isObject(item)) {
      return item as NonNullable<ModuleMetadata['connections']>[number];
    }

    return {
      ...item,
      targets: normalizeServiceTargets(item.targets, `${pathToConnections}[${index}].targets`, validationErrors, appId),
    } as NonNullable<ModuleMetadata['connections']>[number];
  });
}

function buildDependencies(
  value: unknown,
  pathToDependencies: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleMetadata['dependencies'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'app_manifest_dependencies_invalid',
      message: 'dependencies must be an array.',
      path: pathToDependencies,
      node: appId,
    });
    return undefined;
  }

  return value.flatMap((item, index) => {
    if (!isObject(item)) {
      return [item as unknown as NonNullable<ModuleMetadata['dependencies']>[number]];
    }

    const metadataUrl = readOptionalString(item, 'metadataUrl') ?? readOptionalString(item, 'manifestUrl');
    const rest = { ...item };
    delete rest.manifestUrl;
    if (metadataUrl) {
      rest.metadataUrl = metadataUrl;
    }

    if (isObject(rest.connection)) {
      rest.connection = {
        ...rest.connection,
        targets: normalizeServiceTargets(
          rest.connection.targets,
          `${pathToDependencies}[${index}].connection.targets`,
          validationErrors,
          appId
        ),
      };
    }

    return [rest as unknown as NonNullable<ModuleMetadata['dependencies']>[number]];
  });
}

function normalizeServiceTargets(
  value: unknown,
  pathToTargets: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
) {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((item, index) => {
    if (!isObject(item)) {
      return item;
    }

    const service = readOptionalString(item, 'service');
    const container = readOptionalString(item, 'container');
    if (service && container && service !== container) {
      validationErrors.push({
        code: 'app_manifest_target_conflict',
        message: 'Target must not declare different service and container values.',
        path: `${pathToTargets}[${index}]`,
        node: appId,
      });
    }

    const result = { ...item };
    delete result.service;
    if (service && !container) {
      result.container = service;
    }

    return result;
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
      message: 'Runtime ports must be an array.',
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
        message: 'Runtime ports entries must be objects.',
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

function readOptionalHealthCheck(
  value: unknown,
  pathToHealthCheck: string,
  validationErrors: InstallPlanValidationError[],
  appId?: string
): ModuleServiceMetadata['healthCheck'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    validationErrors.push({
      code: 'app_manifest_health_check_invalid',
      message: 'healthCheck must be an object.',
      path: pathToHealthCheck,
      node: appId,
    });
    return undefined;
  }

  return value as unknown as ModuleServiceMetadata['healthCheck'];
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

function isSafeContractKey(value: string) {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value);
}
