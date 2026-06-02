export type ModuleOperationStatus = 'installed' | 'installing' | 'updating' | 'failed' | 'removing';

export type ModuleRuntimeState =
  | 'not_created'
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'exited'
  | 'dead'
  | 'unknown';

export type ModuleAggregateRuntimeState =
  | 'not_created'
  | 'running'
  | 'degraded'
  | 'exited'
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

export interface ModuleAggregateRuntimeStatus {
  state: ModuleAggregateRuntimeState;
  runningContainers: number;
  totalContainers: number;
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
  container: string;
  containerPath: string;
  hostPath: string;
  required?: boolean;
  writable?: boolean;
  readOnly?: boolean;
}

export type InstalledSettingValue = string | number | boolean;

export interface InstalledExternalMountMapping {
  collectionKey: string;
  key: string;
  label?: string;
  hostPath: string;
  container: string;
  containerPath: string;
  access: ModuleInstallExternalMountAccess;
  readOnly: boolean;
}

export interface ModuleEnvTarget {
  container: string;
  type: 'env';
  name: string;
}

export interface ResolvedDependency {
  id: string;
  endpoint?: string;
  targets?: ModuleEnvTarget[];
  resolvedBaseUrl?: string;
}

export interface InstalledModuleContainerRecord {
  key: string;
  containerName: string;
  networkAlias: string;
  image: ModuleImage;
  ports?: InstalledModulePortBinding[];
}

export interface InstalledModulePortBinding {
  key: string;
  endpointKey?: string;
  containerPort: number;
  hostPort: number;
  protocol: string;
  hostPublished: true;
  publicOrigin?: string;
}

export interface InstalledModuleRecord {
  id: string;
  metadataUrl: string;
  manifestUrl?: string;
  metadataPath?: string;
  manifestPath?: string;
  selectedChannel?: string;
  selectedRuntime?: string;
  metadataDigest?: string;
  planDigest?: string;
  containers: InstalledModuleContainerRecord[];
  operationStatus?: ModuleOperationStatus;
  settings?: Record<string, InstalledSettingValue>;
  storage?: {
    directories?: InstalledStorageMapping[];
  };
  storageMappings?: Record<string, InstalledStorageMapping> | InstalledStorageMapping[];
  externalMounts?: InstalledExternalMountMapping[] | Record<string, InstalledExternalMountMapping[]>;
  resolvedDependencies?: Record<string, ResolvedDependency> | ResolvedDependency[];
  dependencies?: ResolvedDependency[];
  installedAt?: string;
  updatedAt?: string;
  lastOperation?: 'install' | 'update' | 'configure' | 'remove' | 'lifecycle';
  updateAttempt?: {
    updatePlanDigest: string;
    settings: ModuleInstallSettingSelection[];
    externalMounts: ModuleInstallExternalMountSelection[];
    attemptedAt: string;
  };
  lastError?: ModuleOperationError | null;
}

export interface ModulesStoreData {
  schemaVersion: '0.2';
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
  containers: ModuleContainerMetadata[];
  services?: ModuleServiceMetadata[];
  endpoints?: ModuleEndpointMetadata[];
  connections?: ModuleConnectionMetadata[];
  dependencies?: ModuleDependencyMetadata[];
  settings?: ModuleSettingMetadata[];
  storage?: {
    directories?: ModuleStorageDirectoryMetadata[];
    mountCollections?: ModuleStorageMountCollectionMetadata[];
  };
  ui?: ModuleUiMetadata;
}

export interface ModuleServiceMetadata {
  key: string;
  dependsOn?: string[];
  source: ModuleServiceSourceMetadata;
  runtime?: {
    ports?: ModuleRuntimePortMetadata[];
    healthcheck?: unknown;
    resources?: Record<string, unknown>;
  };
  healthCheck?: ModuleHealthCheckMetadata;
}

export type ModuleServiceSourceMetadata =
  | {
      type: 'image';
      image: {
        repository: string;
        tag: string;
        pullPolicy?: ModuleImage['pullPolicy'];
      };
    }
  | {
      type: 'process';
      command: string;
      workingDirectory?: string;
      environment?: Record<string, string>;
    };

export interface ModuleHealthCheckMetadata {
  type: 'http';
  path: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  successStatus?: number[];
}

export interface ModuleContainerMetadata {
  key: string;
  dependsOn?: string[];
  image: {
    repository: string;
    tag: string;
    pullPolicy?: ModuleImage['pullPolicy'];
  };
  runtime?: {
    ports?: ModuleRuntimePortMetadata[];
    healthcheck?: unknown;
    resources?: Record<string, unknown>;
  };
}

export interface ModuleEndpointMetadata {
  key: string;
  container?: string;
  service?: string;
  port: string;
  public: boolean;
}

export interface ModuleConnectionMetadata {
  source: {
    type: 'endpoint';
    key: string;
  };
  targets: ModuleEnvTarget[];
}

export interface ModuleDependencyMetadata {
  id: string;
  version: string;
  required: boolean;
  metadataUrl: string;
  connection?: {
    endpoint: string;
    targets: ModuleEnvTarget[];
  };
}

export interface ModuleSettingMetadata {
  key: string;
  type: string;
  required: boolean;
  default?: unknown;
  targets?: ModuleEnvTarget[];
}

export interface ModuleStorageDirectoryMetadata {
  key: string;
  label?: string;
  description?: string;
  purpose?: string;
  required: boolean;
  mount?: {
    recommended?: boolean;
    type: string;
    modulePath?: string;
  };
  targets: ModuleStorageTarget[];
}

export interface ModuleStorageTarget {
  container: string;
  containerPath: string;
  writable: boolean;
}

export interface ModuleStorageMountCollectionMetadata {
  key: string;
  label?: string;
  description?: string;
  purpose?: string;
  required: boolean;
  minItems: number;
  maxItems: number | null;
  hostPathPolicy: {
    mode: 'adminSelected';
    allowExternal: true;
  };
  targets: ModuleStorageMountCollectionTarget[];
}

export interface ModuleStorageMountCollectionTarget {
  container: string;
  containerPathPrefix: string;
  itemContainerPathTemplate: string;
  writable: boolean;
}

export interface ModuleRuntimePortMetadata {
  key: string;
  containerPort: number;
  localPort?: number;
  protocol: string;
}

export interface ModuleUiNavigationItemMetadata {
  label: string;
  path: string;
}

export interface ModuleUiMetadata {
  category?: 'Apps';
  icon?: string;
  entrypoint: {
    portKey: string;
    path: string;
  };
  navigation: ModuleUiNavigationItemMetadata[];
}

export interface ModuleSummary {
  id: string;
  name: string;
  description?: string;
  version: string;
  metadataUrl: string;
  containers: ModuleContainerSummary[];
  operationStatus: ModuleOperationStatus;
  runtimeStatus: ModuleAggregateRuntimeStatus;
  installedAt?: string;
  updatedAt?: string;
  lastOperation?: InstalledModuleRecord['lastOperation'];
  lastError: ModuleOperationError | null;
}

export interface ModuleContainerSummary {
  key: string;
  image: ModuleImage;
  runtimeStatus: ModuleRuntimeStatus;
  networkAlias: string;
  endpoints: ModuleEndpointMetadata[];
}

export interface ModuleDetail extends ModuleSummary {
  settings: Array<ModuleSettingMetadata & { valueSet: boolean }>;
  storage: {
    directories: InstalledStorageMapping[];
    externalMounts: InstalledExternalMountMapping[];
  };
  dependencies: ResolvedDependency[];
}

export interface ModuleActionResult {
  success: boolean;
  module: ModuleSummary | null;
  error: ModuleOperationError | null;
}

export type ModuleRecoveryAction = 'cleanup' | 'remove';

export interface ModuleRecoveryPlan {
  action: ModuleRecoveryAction;
  moduleId: string;
  moduleName: string;
  operationStatus: ModuleOperationStatus;
  canApply: boolean;
  deleteModuleDataDefault: false;
  deleteModuleData: boolean;
  containers: Array<{
    key: string;
    name: string;
    exists: boolean;
    id: string | null;
    image: string | null;
    willRemove: boolean;
  }>;
  images: Array<{
    container: string;
    reference: string;
    willRemove: false;
  }>;
  metadataFile: {
    path: string;
    exists: boolean;
    willDelete: boolean;
  };
  moduleDirectory: {
    path: string;
    exists: boolean;
    willDelete: boolean;
  };
  storageDirectories: Array<InstalledStorageMapping & {
    exists: boolean;
    willDelete: boolean;
  }>;
  externalMounts: Array<InstalledExternalMountMapping & {
    willDelete: false;
  }>;
  dependents: Array<{
    id: string;
    name?: string;
  }>;
  conflicts: InstallPlanConflict[];
  warnings: string[];
}

export interface ModuleRecoveryPlanResponse {
  plan?: ModuleRecoveryPlan;
  error?: InstallPlanErrorEnvelope;
}

export interface ModuleRecoveryApplyRequest {
  confirmed?: boolean;
  deleteModuleData?: boolean;
}

export interface ModuleRecoveryActionResult {
  success: boolean;
  module: ModuleSummary | null;
  removedModuleId?: string;
  plan?: ModuleRecoveryPlan;
  error: ModuleOperationError | null;
}

export type ModuleSettingType = 'string' | 'number' | 'boolean' | 'url' | 'secret';

export interface NormalizedModuleSettingMetadata extends ModuleSettingMetadata {
  type: ModuleSettingType;
  targets: ModuleEnvTarget[];
}

export interface NormalizedModuleDependencyMetadata extends ModuleDependencyMetadata {
  required: true;
  connection?: {
    endpoint: string;
    targets: ModuleEnvTarget[];
  };
}

export interface NormalizedModuleStorageDirectoryMetadata
  extends ModuleStorageDirectoryMetadata {
  mount: {
    recommended?: boolean;
    type: 'bind';
    modulePath: string;
  };
  targets: ModuleStorageTarget[];
}

export interface NormalizedModuleStorageMountCollectionMetadata
  extends ModuleStorageMountCollectionMetadata {
  targets: ModuleStorageMountCollectionTarget[];
}

export interface NormalizedModuleContainerMetadata extends ModuleContainerMetadata {
  source: {
    type: 'image' | 'process';
    command?: string;
    workingDirectory?: string;
    environment?: Record<string, string>;
  };
  image: {
    repository: string;
    tag: string;
    pullPolicy: ModuleImagePullPolicy;
  };
  dependsOn: string[];
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
  healthCheck?: ModuleHealthCheckMetadata;
}

export interface NormalizedModuleEndpointMetadata extends ModuleEndpointMetadata {
  container: string;
  service: string;
  public: boolean;
}

export interface NormalizedModuleConnectionMetadata extends ModuleConnectionMetadata {
  source: {
    type: 'endpoint';
    key: string;
  };
  targets: ModuleEnvTarget[];
}

export interface NormalizedModuleMetadata {
  schemaVersion: '0.2' | '0.3';
  /**
   * Compatibility marker for records that were parsed from a newer app manifest
   * and then mapped to the legacy Docker module runtime model.
   */
  sourceSchemaVersion?: 'app.0.1';
  /**
   * Active app-level runtime profile selected while converting an app manifest.
   * For multi-service app manifests this is distinct from service/container keys.
   */
  selectedRuntime?: string;
  id: string;
  name: string;
  description?: string;
  version: string;
  containers: NormalizedModuleContainerMetadata[];
  services: NormalizedModuleContainerMetadata[];
  endpoints: NormalizedModuleEndpointMetadata[];
  connections: NormalizedModuleConnectionMetadata[];
  dependencies: NormalizedModuleDependencyMetadata[];
  settings: NormalizedModuleSettingMetadata[];
  storage: {
    directories: NormalizedModuleStorageDirectoryMetadata[];
    mountCollections: NormalizedModuleStorageMountCollectionMetadata[];
  };
  ui?: ModuleUiMetadata;
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
  container: string;
  repository: string;
  tag: string;
  reference: string;
  pullPolicy: ModuleImagePullPolicy;
}

export interface InstallPlanStorageDirectory {
  moduleId: string;
  key: string;
  container: string;
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
  targets: ModuleEnvTarget[];
  default?: unknown;
  secret: boolean;
  redacted: boolean;
}

export interface InstallPlanDependencyConnection {
  consumerId: string;
  dependencyId: string;
  endpoint: string;
  targets: ModuleEnvTarget[];
  resolvedBaseUrl: string;
}

export interface InstallPlanEndpointOrigin {
  moduleId: string;
  endpoint: string;
  container: string;
  portKey: string;
  containerPort: number;
  hostPort: number;
  protocol: string;
  localOrigin: string;
  publicOrigin: string | null;
  requiredForUi: boolean;
}

export interface InstallPlanContainer {
  moduleId: string;
  key: string;
  containerName: string;
  networkAlias: string;
  image: InstallPlanImage;
  dependsOn: string[];
  ports: Array<ModuleRuntimePortMetadata & {
    hostPublished: boolean;
    hostPort?: number;
    endpointKey?: string;
    localOrigin?: string;
    publicOrigin?: string | null;
  }>;
  resources?: NormalizedModuleContainerMetadata['runtime']['resources'];
  endpoints: NormalizedModuleEndpointMetadata[];
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
  containers: InstallPlanContainer[];
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
    endpoints: NormalizedModuleEndpointMetadata[];
    endpointOrigins: InstallPlanEndpointOrigin[];
  };
  paths: {
    moduleDirectoryHost: string;
    moduleDirectoryContainer: string;
    metadataPathHost: string;
    metadataPathContainer: string;
  };
  docker: {
    networkName: string;
    containers: InstallPlanContainer[];
  };
  conflicts: InstallPlanConflict[];
}

export interface InstallPlanErrorEnvelope {
  code: string;
  message: string;
  validationErrors: InstallPlanValidationError[];
  conflicts: InstallPlanConflict[];
}

export interface InstallPlanResponse {
  mode?: 'install' | 'update';
  plan?: InstallPlan;
  updatePlan?: ModuleUpdatePlan;
  existingModuleId?: string;
  error?: InstallPlanErrorEnvelope;
}

export type ModuleInstallSettingValue = string | number | boolean;

export interface ModuleInstallSettingSelection {
  moduleId: string;
  key: string;
  value: ModuleInstallSettingValue;
  secret: boolean;
}

export type ModuleInstallExternalMountAccess = 'readWrite' | 'readOnly';

export interface ModuleInstallExternalMountSelection {
  moduleId: string;
  collectionKey: string;
  key: string;
  label?: string;
  hostPath: string;
  containerPath: string;
  access: ModuleInstallExternalMountAccess;
}

export interface ModuleInstallEndpointOriginSelection {
  moduleId: string;
  endpoint: string;
  hostPort?: number;
  publicOrigin?: string;
}

export interface ModuleInstallRequest {
  metadataUrl: string;
  planDigest: string;
  settings: ModuleInstallSettingSelection[];
  externalMounts: ModuleInstallExternalMountSelection[];
  endpointOrigins?: ModuleInstallEndpointOriginSelection[];
}

export interface ModuleInstallSuccessResponse {
  module: ModuleSummary;
  installedModuleIds: string[];
  reusedModuleIds: string[];
  error: null;
}

export interface ModuleInstallFailureResponse {
  error: InstallPlanErrorEnvelope;
}

export type ModuleInstallResponse = ModuleInstallSuccessResponse | ModuleInstallFailureResponse;

export type ModuleUpdateChangeCategory =
  | 'metadata'
  | 'image'
  | 'settings'
  | 'storage'
  | 'externalMounts'
  | 'dependencies'
  | 'runtime'
  | 'docker';

export type ModuleUpdateChangeAction =
  | 'added'
  | 'changed'
  | 'removed'
  | 'preserved'
  | 'unchanged'
  | 'install'
  | 'reuse'
  | 'replace';

export interface ModuleUpdateChange {
  category: ModuleUpdateChangeCategory;
  action: ModuleUpdateChangeAction;
  title: string;
  moduleId: string;
  path: string;
  currentValue?: unknown;
  proposedValue?: unknown;
}

export interface ModuleUpdatePlan {
  moduleId: string;
  metadataUrl: string;
  currentMetadataDigest: string | null;
  refreshedMetadataDigest: string;
  updatePlanDigest: string;
  module: {
    id: string;
    currentName: string;
    proposedName: string;
    currentVersion: string;
    proposedVersion: string;
    currentDescription?: string;
    proposedDescription?: string;
  };
  normalizedMetadata: NormalizedModuleMetadata;
  dependencies: InstallPlanDependencyNode[];
  installOrder: string[];
  images: InstallPlanImage[];
  settings: InstallPlanSettingPrompt[];
  preservedSettings: Array<{
    moduleId: string;
    key: string;
    secret: boolean;
    targets: ModuleEnvTarget[];
  }>;
  storage: {
    directories: InstallPlanStorageDirectory[];
    mountCollections: InstallPlanMountCollection[];
    preservedExternalMounts: InstalledExternalMountMapping[];
    removedExternalMounts: InstalledExternalMountMapping[];
  };
  runtime: {
    endpoints: NormalizedModuleEndpointMetadata[];
    endpointOrigins: InstallPlanEndpointOrigin[];
  };
  paths: {
    moduleDirectoryHost: string;
    moduleDirectoryContainer: string;
    metadataPathHost: string;
    metadataPathContainer: string;
  };
  docker: {
    networkName: string;
    containers: InstallPlanContainer[];
    replacementRequired: boolean;
    replacementReasons: string[];
  };
  changes: ModuleUpdateChange[];
  warnings: string[];
  conflicts: InstallPlanConflict[];
}

export interface ModuleUpdatePlanResponse {
  plan?: ModuleUpdatePlan;
  error?: InstallPlanErrorEnvelope;
}

export interface ModuleUpdateRequest {
  updatePlanDigest: string;
  confirmed?: boolean;
  settings: ModuleInstallSettingSelection[];
  externalMounts: ModuleInstallExternalMountSelection[];
}

export interface ModuleUpdateSuccessResponse {
  module: ModuleSummary;
  updatedModuleId: string;
  installedDependencyIds: string[];
  reusedDependencyIds: string[];
  error: null;
}

export interface ModuleUpdateFailureResponse {
  error: InstallPlanErrorEnvelope;
}

export type ModuleUpdateResponse = ModuleUpdateSuccessResponse | ModuleUpdateFailureResponse;

export interface ModuleConfigurationSettingPrompt extends InstallPlanSettingPrompt {
  valueSet: boolean;
}

export interface ModuleConfigurationPlan {
  moduleId: string;
  moduleName: string;
  moduleVersion: string;
  metadataUrl: string;
  configurationDigest: string;
  settings: ModuleConfigurationSettingPrompt[];
  runtime: {
    endpoints: NormalizedModuleEndpointMetadata[];
    endpointOrigins: InstallPlanEndpointOrigin[];
  };
  storage: {
    mountCollections: InstallPlanMountCollection[];
    externalMounts: InstalledExternalMountMapping[];
  };
  conflicts: InstallPlanConflict[];
  warnings: string[];
}

export interface ModuleConfigurationPlanResponse {
  plan?: ModuleConfigurationPlan;
  error?: InstallPlanErrorEnvelope;
}

export interface ModuleConfigurationRequest {
  configurationDigest: string;
  settings: ModuleInstallSettingSelection[];
  externalMounts: ModuleInstallExternalMountSelection[];
  endpointOrigins: ModuleInstallEndpointOriginSelection[];
}

export interface ModuleConfigurationSuccessResponse {
  module: ModuleSummary;
  recreatedContainers: boolean;
  error: null;
}

export interface ModuleConfigurationFailureResponse {
  error: InstallPlanErrorEnvelope;
}

export type ModuleConfigurationResponse =
  | ModuleConfigurationSuccessResponse
  | ModuleConfigurationFailureResponse;
