export type ModuleOperationStatus = 'installed' | 'installing' | 'updating' | 'failed';

export type ModuleRuntimeState =
  | 'not_created'
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'exited'
  | 'dead'
  | 'unknown';

export type ModuleImagePullPolicy = 'ifNotPresent' | 'always' | 'manual';

export interface ModuleImage {
  repository: string;
  tag: string;
  reference: string;
  pullPolicy?: ModuleImagePullPolicy | string;
}

export interface ModuleRuntimeStatus {
  state: ModuleRuntimeState;
  containerId: string | null;
  containerName: string;
  startedAt: string | null;
  finishedAt: string | null;
  error?: string;
}

export interface ModuleOperationError {
  operation?: string;
  httpStatus?: number;
  dockerStatusCode?: number;
  dockerMessage?: string;
  message: string;
  nextStep?: string;
  occurredAt?: string;
}

export interface InstalledStorageMapping {
  key: string;
  containerPath: string;
  hostPath: string;
  required?: boolean;
  writable?: boolean;
  readOnly?: boolean;
}

export interface ResolvedDependency {
  id: string;
  endpoint?: string;
  baseUrlEnv?: string;
  resolvedBaseUrl?: string;
}

export interface InstalledModuleRecord {
  id: string;
  metadataUrl: string;
  metadataPath?: string;
  containerName?: string;
  image?: Partial<ModuleImage>;
  operationStatus?: ModuleOperationStatus;
  settings?: Record<string, string>;
  storage?: {
    directories?: InstalledStorageMapping[];
  };
  storageMappings?: Record<string, InstalledStorageMapping> | InstalledStorageMapping[];
  resolvedDependencies?: Record<string, ResolvedDependency> | ResolvedDependency[];
  dependencies?: ResolvedDependency[];
  installedAt?: string;
  updatedAt?: string;
  lastError?: ModuleOperationError | null;
}

export interface ModulesStoreData {
  schemaVersion: '0.1';
  hostSettings: Record<string, unknown>;
  modules: InstalledModuleRecord[];
  updatedAt: string;
}

export interface ModuleMetadata {
  schemaVersion?: string;
  id: string;
  name: string;
  description?: string;
  version: string;
  image: {
    repository: string;
    tag: string;
    pullPolicy?: ModuleImage['pullPolicy'];
  };
  dependencies?: ModuleDependencyMetadata[];
  settings?: ModuleSettingMetadata[];
  storage?: {
    directories?: ModuleStorageDirectoryMetadata[];
    mountCollections?: ModuleStorageMountCollectionMetadata[];
  };
  runtime?: {
    ports?: ModuleRuntimePortMetadata[];
    healthcheck?: unknown;
    resources?: Record<string, unknown>;
  };
}

export interface ModuleDependencyMetadata {
  id: string;
  version: string;
  required: boolean;
  metadataUrl: string;
  connection?: {
    endpoint: string;
    baseUrlEnv: string;
  };
}

export interface ModuleSettingMetadata {
  key: string;
  type: string;
  required: boolean;
  default?: unknown;
  target?: {
    type: string;
    name?: string;
  };
}

export interface ModuleStorageDirectoryMetadata {
  key: string;
  label?: string;
  description?: string;
  containerPath: string;
  purpose?: string;
  required: boolean;
  writable: boolean;
  mount?: {
    recommended?: boolean;
    type: string;
    modulePath?: string;
  };
}

export interface ModuleStorageMountCollectionMetadata {
  key: string;
  label?: string;
  description?: string;
  purpose?: string;
  required: boolean;
  minItems: number;
  maxItems: number | null;
  writable: boolean;
  containerPathPrefix: string;
  itemContainerPathTemplate: string;
  hostPathPolicy: {
    mode: 'adminSelected';
    allowExternal: true;
  };
}

export interface ModuleRuntimePortMetadata {
  key: string;
  containerPort: number;
  protocol: string;
  public: boolean;
}

export interface ModuleSummary {
  id: string;
  name: string;
  description?: string;
  version: string;
  metadataUrl: string;
  image: ModuleImage;
  operationStatus: ModuleOperationStatus;
  runtimeStatus: ModuleRuntimeStatus;
  installedAt?: string;
  updatedAt?: string;
  lastError: ModuleOperationError | null;
}

export interface ModuleDetail extends ModuleSummary {
  settings: Array<ModuleSettingMetadata & { valueSet: boolean }>;
  storage: {
    directories: InstalledStorageMapping[];
  };
  dependencies: ResolvedDependency[];
}

export interface ModuleActionResult {
  success: boolean;
  module: ModuleSummary | null;
  error: ModuleOperationError | null;
}

export type ModuleSettingType = 'string' | 'number' | 'boolean' | 'url' | 'secret';

export interface NormalizedModuleSettingMetadata extends ModuleSettingMetadata {
  type: ModuleSettingType;
  target: {
    type: 'env';
    name: string;
  };
}

export interface NormalizedModuleDependencyMetadata extends ModuleDependencyMetadata {
  required: true;
}

export interface NormalizedModuleStorageDirectoryMetadata
  extends ModuleStorageDirectoryMetadata {
  mount: {
    recommended?: boolean;
    type: 'bind';
    modulePath: string;
  };
}

export interface NormalizedModuleMetadata {
  schemaVersion: '0.1';
  id: string;
  name: string;
  description?: string;
  version: string;
  image: {
    repository: string;
    tag: string;
    pullPolicy: ModuleImagePullPolicy;
  };
  dependencies: NormalizedModuleDependencyMetadata[];
  settings: NormalizedModuleSettingMetadata[];
  storage: {
    directories: NormalizedModuleStorageDirectoryMetadata[];
    mountCollections: ModuleStorageMountCollectionMetadata[];
  };
  runtime: {
    ports: ModuleRuntimePortMetadata[];
    healthcheck?: {
      ignoredByMvpRuntime: true;
      value: unknown;
    };
    resources?: {
      cpus?: number;
      memory?: string;
    };
  };
}

export interface InstallPlanValidationError {
  code: string;
  message: string;
  path: string;
  node?: string;
}

export interface InstallPlanConflict {
  code: string;
  message: string;
  resourceType: string;
  resourceId: string;
  path: string;
  node?: string;
  existingValue?: unknown;
  proposedValue?: unknown;
}

export interface InstallPlanImage {
  moduleId: string;
  repository: string;
  tag: string;
  reference: string;
  pullPolicy: ModuleImagePullPolicy;
}

export interface InstallPlanStorageDirectory {
  moduleId: string;
  key: string;
  containerPath: string;
  modulePath: string;
  hostPath: string;
  containerHostPath: string;
  required: boolean;
  writable: boolean;
  readOnly: boolean;
}

export interface InstallPlanMountCollection extends ModuleStorageMountCollectionMetadata {
  moduleId: string;
}

export interface InstallPlanSettingPrompt {
  moduleId: string;
  key: string;
  type: ModuleSettingType;
  required: boolean;
  target: {
    type: 'env';
    name: string;
  };
  default?: unknown;
  secret: boolean;
  redacted: boolean;
}

export interface InstallPlanDependencyConnection {
  consumerId: string;
  dependencyId: string;
  endpoint: string;
  baseUrlEnv: string;
  resolvedBaseUrl: string;
}

export interface InstallPlanDependencyNode {
  id: string;
  name: string;
  description?: string;
  version: string;
  metadataUrl: string;
  requiredBy: string[];
  normalizedMetadata: NormalizedModuleMetadata;
  installAction: 'install' | 'reuse';
  docker: {
    containerName: string;
    networkAlias: string;
  };
  paths: {
    moduleDirectoryHost: string;
    moduleDirectoryContainer: string;
    metadataPathHost: string;
    metadataPathContainer: string;
  };
  connections: InstallPlanDependencyConnection[];
}

export interface InstallPlan {
  metadataUrl: string;
  metadataDigest: string;
  planDigest: string;
  module: {
    id: string;
    name: string;
    description?: string;
    version: string;
  };
  normalizedMetadata: NormalizedModuleMetadata;
  dependencies: InstallPlanDependencyNode[];
  installOrder: string[];
  images: InstallPlanImage[];
  settings: InstallPlanSettingPrompt[];
  storage: {
    directories: InstallPlanStorageDirectory[];
    mountCollections: InstallPlanMountCollection[];
  };
  runtime: {
    ports: Array<ModuleRuntimePortMetadata & { hostPublished: false }>;
    resources?: NormalizedModuleMetadata['runtime']['resources'];
  };
  paths: {
    moduleDirectoryHost: string;
    moduleDirectoryContainer: string;
    metadataPathHost: string;
    metadataPathContainer: string;
  };
  docker: {
    networkName: string;
    containerName: string;
    networkAliases: string[];
  };
  conflicts: InstallPlanConflict[];
}

export interface InstallPlanErrorEnvelope {
  code: string;
  message: string;
  validationErrors: InstallPlanValidationError[];
  conflicts: InstallPlanConflict[];
}
