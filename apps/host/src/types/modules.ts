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

export interface ModuleImage {
  repository: string;
  tag: string;
  reference: string;
  pullPolicy?: 'ifNotPresent' | 'always' | 'manual' | string;
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
    mountCollections?: unknown[];
  };
  runtime?: {
    ports?: ModuleRuntimePortMetadata[];
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
