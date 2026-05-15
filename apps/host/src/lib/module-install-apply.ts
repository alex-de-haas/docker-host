import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureHostDataRoot, getHostRuntimeConfig } from '@/lib/host-runtime';
import {
  createAndStartModuleContainer,
  ensureModuleContainerStarted,
  ensureModuleNetwork,
  pullModuleImage,
  toModuleOperationError,
} from '@/lib/module-docker';
import { createInstallPlanWithGraph } from '@/lib/module-install-plan';
import { getModuleMetadataMajor } from '@/lib/module-metadata';
import {
  readModuleMetadata,
  readModulesStore,
  writeModulesStore,
} from '@/lib/module-store';
import { listInstalledModules } from '@/lib/module-service';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import type { MetadataGraph, MetadataGraphNode } from '@/lib/module-metadata';
import type {
  InstallPlan,
  InstallPlanConflict,
  InstallPlanDependencyNode,
  InstallPlanImage,
  InstallPlanStorageDirectory,
  InstallPlanValidationError,
  InstalledExternalMountMapping,
  InstalledModuleRecord,
  InstalledSettingValue,
  InstalledStorageMapping,
  ModuleInstallExternalMountSelection,
  ModuleInstallFailureResponse,
  ModuleInstallRequest,
  ModuleInstallSettingSelection,
  ModuleInstallSettingValue,
  ModuleInstallSuccessResponse,
  ModuleOperationError,
  ModulesStoreData,
  NormalizedModuleMetadata,
  ResolvedDependency,
} from '@/types/modules';

type InstallApplyResult =
  | {
      status: 201;
      body: ModuleInstallSuccessResponse;
    }
  | {
      status: 409 | 422 | 500 | 503;
      body: ModuleInstallFailureResponse;
    };

interface InstallDecisions {
  settingsByModule: Map<string, Record<string, InstalledSettingValue>>;
  externalMountsByModule: Map<string, InstalledExternalMountMapping[]>;
}

interface InstallNodeContext {
  id: string;
  metadataUrl: string;
  metadata: NormalizedModuleMetadata;
  graphNode: MetadataGraphNode;
  image: InstallPlanImage;
  paths: {
    moduleDirectoryContainer: string;
    metadataPathContainer: string;
  };
  containerName: string;
  networkAlias: string;
  storageDirectories: InstallPlanStorageDirectory[];
  settings: Record<string, InstalledSettingValue>;
  externalMounts: InstalledExternalMountMapping[];
  resolvedDependencies: ResolvedDependency[];
}

let installMutex: Promise<void> = Promise.resolve();

export async function applyModuleInstallRequest(body: unknown): Promise<InstallApplyResult> {
  const requestValidation = parseInstallRequest(body);
  if (requestValidation.validationErrors.length > 0 || !requestValidation.request) {
    return {
      status: 422,
      body: {
        error: {
          code: 'install_request_validation_failed',
          message: 'Install request is invalid.',
          validationErrors: requestValidation.validationErrors,
          conflicts: [],
        },
      },
    };
  }

  const request = requestValidation.request;
  return withInstallLock(() => applyValidatedInstallRequest(request));
}

async function applyValidatedInstallRequest(
  request: ModuleInstallRequest
): Promise<InstallApplyResult> {
  const config = getHostRuntimeConfig();
  await ensureHostDataRoot(config);

  const { result, graph } = await createInstallPlanWithGraph(request.metadataUrl);
  if (result.status !== 200) {
    return {
      status: result.status,
      body: {
        error: result.body.error,
      },
    };
  }

  if (!graph || !('plan' in result.body)) {
    return applyFailureResult({
      operation: 'module.install.plan',
      httpStatus: 500,
      message: 'Install plan could not be recomputed for apply.',
      nextStep: 'Create a new install plan and retry.',
      occurredAt: new Date().toISOString(),
    });
  }

  const plan = result.body.plan;

  if (plan.planDigest !== request.planDigest) {
    return conflictResult(
      'install_plan_digest_mismatch',
      'The install plan changed since review. Create a new plan before installing.',
      [
        {
          code: 'install_plan_digest_mismatch',
          message: 'The submitted planDigest does not match the recomputed install plan.',
          resourceType: 'install_plan',
          resourceId: request.planDigest,
          path: '$.planDigest',
          existingValue: plan.planDigest,
          proposedValue: request.planDigest,
        },
      ]
    );
  }

  const store = await readModulesStore(config);
  const reusableDependencyConflicts = await collectReusableDependencyConflicts(plan, store, config);
  if (reusableDependencyConflicts.length > 0) {
    return conflictResult(
      'install_dependency_conflict',
      'One or more reusable dependencies are not compatible with this install.',
      reusableDependencyConflicts
    );
  }

  const decisionValidation = validateInstallDecisions(plan, request, store);
  if (decisionValidation.validationErrors.length > 0) {
    return {
      status: 422,
      body: {
        error: {
          code: 'install_request_validation_failed',
          message: 'Install request decisions are invalid.',
          validationErrors: decisionValidation.validationErrors,
          conflicts: [],
        },
      },
    };
  }

  if (decisionValidation.conflicts.length > 0) {
    return conflictResult(
      'install_request_conflict',
      'Install request decisions conflict with current Host state.',
      decisionValidation.conflicts
    );
  }

  const network = await ensureModuleNetwork(config);
  if (!network.ready) {
    return {
      status: 503,
      body: {
        error: {
          code: 'docker_unavailable',
          message: network.error || `Docker network "${network.name}" is unavailable.`,
          validationErrors: [],
          conflicts: [],
        },
      },
    };
  }

  const installedModuleIds: string[] = [];
  const reusedModuleIds: string[] = [];

  for (const moduleId of plan.installOrder) {
    const dependency = plan.dependencies.find(candidate => candidate.id === moduleId);
    const isReusableDependency = dependency?.installAction === 'reuse';

    if (isReusableDependency) {
      const reused = await startReusableDependency(moduleId, config);
      if (reused.error) {
        await markModuleFailed(moduleId, reused.error, config);
        return applyFailureResult(reused.error);
      }

      reusedModuleIds.push(moduleId);
      continue;
    }

    const context = buildInstallNodeContext(plan, graph, moduleId, decisionValidation.decisions);

    try {
      await persistInstallingState(context, plan, config);
      await writeModuleFiles(context);
      await createModuleOwnedDirectories(context);
      await pullModuleImage(context.image);
      await createAndStartModuleContainer({
        moduleId: context.id,
        containerName: context.containerName,
        networkName: plan.docker.networkName,
        networkAlias: context.networkAlias,
        imageReference: context.image.reference,
        env: buildContainerEnvironment(context),
        mounts: buildContainerMounts(context),
        ports: context.metadata.runtime.ports,
        ...(context.metadata.runtime.resources ? { resources: context.metadata.runtime.resources } : {}),
      });
      await markModuleInstalled(context.id, config);
      installedModuleIds.push(context.id);
    } catch (error) {
      const operationError = toModuleOperationError(
        `module.install.${context.id}`,
        error,
        `Docker Host could not install module "${context.id}".`,
        'Inspect the preserved files, Docker images, and containers, then retry or run cleanup when recovery actions are available.'
      );
      await markModuleFailed(context.id, operationError, config);
      return applyFailureResult(operationError);
    }
  }

  const modules = await listInstalledModules();
  const rootModule = modules.find(module => module.id === plan.module.id);

  if (!rootModule) {
    return applyFailureResult({
      operation: 'module.install.summary',
      httpStatus: 500,
      message: `Module "${plan.module.id}" was installed but could not be read back from modules.json.`,
      nextStep: 'Refresh the dashboard and inspect modules.json.',
      occurredAt: new Date().toISOString(),
    });
  }

  return {
    status: 201,
    body: {
      module: rootModule,
      installedModuleIds,
      reusedModuleIds,
      error: null,
    },
  };
}

async function withInstallLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = installMutex;
  let release: () => void = () => undefined;
  installMutex = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

function parseInstallRequest(body: unknown): {
  request: ModuleInstallRequest | null;
  validationErrors: InstallPlanValidationError[];
} {
  const validationErrors: InstallPlanValidationError[] = [];

  if (!isObject(body)) {
    return {
      request: null,
      validationErrors: [
        {
          code: 'install_request_invalid',
          message: 'Request body must be an object.',
          path: '$',
        },
      ],
    };
  }

  const metadataUrl = readString(body, 'metadataUrl', '$.metadataUrl', validationErrors);
  const planDigest = readString(body, 'planDigest', '$.planDigest', validationErrors);
  const settings = readSettingSelections(body.settings, validationErrors);
  const externalMounts = readExternalMountSelections(body.externalMounts, validationErrors);

  if (validationErrors.length > 0 || !metadataUrl || !planDigest) {
    return { request: null, validationErrors };
  }

  return {
    request: {
      metadataUrl,
      planDigest,
      settings,
      externalMounts,
    },
    validationErrors,
  };
}

function readSettingSelections(
  value: unknown,
  validationErrors: InstallPlanValidationError[]
): ModuleInstallSettingSelection[] {
  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'install_request_invalid',
      message: 'settings must be an array.',
      path: '$.settings',
    });
    return [];
  }

  return value.flatMap((item, index) => {
    const itemPath = `$.settings[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'install_request_invalid',
        message: 'settings[] item must be an object.',
        path: itemPath,
      });
      return [];
    }

    const moduleId = readString(item, 'moduleId', `${itemPath}.moduleId`, validationErrors);
    const key = readString(item, 'key', `${itemPath}.key`, validationErrors);
    const secret = readBoolean(item, 'secret', `${itemPath}.secret`, validationErrors);
    const settingValue = item.value;

    if (
      settingValue !== undefined &&
      typeof settingValue !== 'string' &&
      typeof settingValue !== 'number' &&
      typeof settingValue !== 'boolean'
    ) {
      validationErrors.push({
        code: 'install_request_invalid',
        message: 'settings[].value must be a string, number, or boolean.',
        path: `${itemPath}.value`,
      });
    }

    if (!moduleId || !key || secret === undefined || settingValue === undefined) {
      return [];
    }

    return [{
      moduleId,
      key,
      value: settingValue as ModuleInstallSettingValue,
      secret,
    }];
  });
}

function readExternalMountSelections(
  value: unknown,
  validationErrors: InstallPlanValidationError[]
): ModuleInstallExternalMountSelection[] {
  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'install_request_invalid',
      message: 'externalMounts must be an array.',
      path: '$.externalMounts',
    });
    return [];
  }

  return value.flatMap((item, index) => {
    const itemPath = `$.externalMounts[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'install_request_invalid',
        message: 'externalMounts[] item must be an object.',
        path: itemPath,
      });
      return [];
    }

    const moduleId = readString(item, 'moduleId', `${itemPath}.moduleId`, validationErrors);
    const collectionKey = readString(item, 'collectionKey', `${itemPath}.collectionKey`, validationErrors);
    const key = readString(item, 'key', `${itemPath}.key`, validationErrors);
    const hostPath = readString(item, 'hostPath', `${itemPath}.hostPath`, validationErrors);
    const containerPath = readString(item, 'containerPath', `${itemPath}.containerPath`, validationErrors);
    const access = readString(item, 'access', `${itemPath}.access`, validationErrors);
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined;

    if (!moduleId || !collectionKey || !key || !hostPath || !containerPath || !access) {
      return [];
    }

    if (access !== 'readOnly' && access !== 'readWrite') {
      validationErrors.push({
        code: 'install_request_invalid',
        message: 'externalMounts[].access must be readOnly or readWrite.',
        path: `${itemPath}.access`,
      });
      return [];
    }

    return [{
      moduleId,
      collectionKey,
      key,
      ...(label ? { label } : {}),
      hostPath,
      containerPath,
      access,
    }];
  });
}

function validateInstallDecisions(
  plan: InstallPlan,
  request: ModuleInstallRequest,
  store: ModulesStoreData
): {
  decisions: InstallDecisions;
  validationErrors: InstallPlanValidationError[];
  conflicts: InstallPlanConflict[];
} {
  const settingValidation = validateSettingSelections(plan, request.settings);
  const externalMountValidation = validateExternalMountSelections(plan, request.externalMounts, store);

  return {
    decisions: {
      settingsByModule: settingValidation.settingsByModule,
      externalMountsByModule: externalMountValidation.externalMountsByModule,
    },
    validationErrors: [
      ...settingValidation.validationErrors,
      ...externalMountValidation.validationErrors,
    ],
    conflicts: externalMountValidation.conflicts,
  };
}

function validateSettingSelections(
  plan: InstallPlan,
  settings: ModuleInstallSettingSelection[]
): {
  settingsByModule: Map<string, Record<string, InstalledSettingValue>>;
  validationErrors: InstallPlanValidationError[];
} {
  const validationErrors: InstallPlanValidationError[] = [];
  const prompts = new Map(plan.settings.map(prompt => [settingKey(prompt.moduleId, prompt.key), prompt]));
  const selected = new Map<string, ModuleInstallSettingSelection>();

  for (const selection of settings) {
    const key = settingKey(selection.moduleId, selection.key);
    const prompt = prompts.get(key);

    if (!prompt) {
      validationErrors.push({
        code: 'install_setting_unknown',
        message: `Setting "${selection.key}" is not required by the reviewed plan for module "${selection.moduleId}".`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    if (selected.has(key)) {
      validationErrors.push({
        code: 'install_setting_duplicate',
        message: `Setting "${selection.key}" is submitted more than once for module "${selection.moduleId}".`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    if (selection.secret !== prompt.secret) {
      validationErrors.push({
        code: 'install_setting_secret_mismatch',
        message: `Setting "${selection.key}" secret marker does not match the reviewed plan.`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    const valueValidation = validateSettingValue(prompt.type, selection.value, prompt.required);
    if (valueValidation) {
      validationErrors.push({
        code: 'install_setting_value_invalid',
        message: valueValidation,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    selected.set(key, selection);
  }

  const settingsByModule = new Map<string, Record<string, InstalledSettingValue>>();

  for (const prompt of plan.settings) {
    const selectedSetting = selected.get(settingKey(prompt.moduleId, prompt.key));
    let value: InstalledSettingValue | undefined;

    if (selectedSetting) {
      value = selectedSetting.value;
    } else if (!prompt.secret && Object.prototype.hasOwnProperty.call(prompt, 'default')) {
      value = prompt.default as InstalledSettingValue;
    } else if (prompt.required) {
      validationErrors.push({
        code: 'install_setting_required',
        message: `Required setting "${prompt.key}" is missing for module "${prompt.moduleId}".`,
        path: '$.settings',
        node: prompt.moduleId,
      });
    }

    if (value !== undefined) {
      const moduleSettings = settingsByModule.get(prompt.moduleId) ?? {};
      moduleSettings[prompt.key] = value;
      settingsByModule.set(prompt.moduleId, moduleSettings);
    }
  }

  return { settingsByModule, validationErrors };
}

function validateExternalMountSelections(
  plan: InstallPlan,
  selections: ModuleInstallExternalMountSelection[],
  store: ModulesStoreData
): {
  externalMountsByModule: Map<string, InstalledExternalMountMapping[]>;
  validationErrors: InstallPlanValidationError[];
  conflicts: InstallPlanConflict[];
} {
  const validationErrors: InstallPlanValidationError[] = [];
  const conflicts: InstallPlanConflict[] = [];
  const collections = new Map(
    plan.storage.mountCollections.map(collection => [
      settingKey(collection.moduleId, collection.key),
      collection,
    ])
  );
  const selectionsByCollection = new Map<string, ModuleInstallExternalMountSelection[]>();
  const externalMountsByModule = new Map<string, InstalledExternalMountMapping[]>();
  const selectedHostPaths = new Map<string, ModuleInstallExternalMountSelection>();

  for (const selection of selections) {
    const collection = collections.get(settingKey(selection.moduleId, selection.collectionKey));
    if (!collection) {
      validationErrors.push({
        code: 'install_external_mount_unknown',
        message: `External mount collection "${selection.collectionKey}" is not required by the reviewed plan for module "${selection.moduleId}".`,
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    const collectionKeyValue = settingKey(selection.moduleId, selection.collectionKey);
    const collectionSelections = selectionsByCollection.get(collectionKeyValue) ?? [];
    collectionSelections.push(selection);
    selectionsByCollection.set(collectionKeyValue, collectionSelections);

    if (!isSafeExternalMountKey(selection.key)) {
      validationErrors.push({
        code: 'install_external_mount_key_invalid',
        message: 'External mount key must be a safe path segment.',
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    if (selection.hostPath.includes('\0')) {
      validationErrors.push({
        code: 'install_external_mount_path_invalid',
        message: 'External mount hostPath must not contain null bytes.',
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    const expectedContainerPath = collection.itemContainerPathTemplate.replace('{key}', selection.key);
    if (selection.containerPath !== expectedContainerPath) {
      validationErrors.push({
        code: 'install_external_mount_container_path_mismatch',
        message: `External mount containerPath must be "${expectedContainerPath}".`,
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    if (!collection.writable && selection.access !== 'readOnly') {
      validationErrors.push({
        code: 'install_external_mount_access_invalid',
        message: 'Read-only external mount collections cannot submit readWrite access.',
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    const normalizedHostPath = normalizeHostPath(selection.hostPath);
    const existingSelection = selectedHostPaths.get(normalizedHostPath);
    if (existingSelection) {
      conflicts.push({
        code: 'external_mount_path_conflict',
        message: `External host path "${selection.hostPath}" is selected more than once.`,
        resourceType: 'storage_mapping',
        resourceId: selection.hostPath,
        path: '$.externalMounts',
        node: selection.moduleId,
        existingValue: existingSelection.moduleId,
        proposedValue: selection.moduleId,
      });
    }
    selectedHostPaths.set(normalizedHostPath, selection);

    const moduleMounts = externalMountsByModule.get(selection.moduleId) ?? [];
    moduleMounts.push({
      collectionKey: selection.collectionKey,
      key: selection.key,
      ...(selection.label ? { label: selection.label } : {}),
      hostPath: selection.hostPath,
      containerPath: selection.containerPath,
      access: selection.access,
      readOnly: selection.access === 'readOnly',
    });
    externalMountsByModule.set(selection.moduleId, moduleMounts);
  }

  for (const collection of plan.storage.mountCollections) {
    const collectionSelections =
      selectionsByCollection.get(settingKey(collection.moduleId, collection.key)) ?? [];
    const requiredCount = collection.required ? collection.minItems : 0;

    if (collectionSelections.length < requiredCount) {
      validationErrors.push({
        code: 'install_external_mount_required',
        message: `External mount collection "${collection.key}" requires at least ${requiredCount} item${requiredCount === 1 ? '' : 's'}.`,
        path: '$.externalMounts',
        node: collection.moduleId,
      });
    }

    if (collection.maxItems !== null && collectionSelections.length > collection.maxItems) {
      validationErrors.push({
        code: 'install_external_mount_too_many',
        message: `External mount collection "${collection.key}" allows at most ${collection.maxItems} item${collection.maxItems === 1 ? '' : 's'}.`,
        path: '$.externalMounts',
        node: collection.moduleId,
      });
    }

    const seenKeys = new Set<string>();
    for (const selection of collectionSelections) {
      if (seenKeys.has(selection.key)) {
        validationErrors.push({
          code: 'install_external_mount_duplicate',
          message: `External mount key "${selection.key}" is duplicated in collection "${collection.key}".`,
          path: '$.externalMounts',
          node: collection.moduleId,
        });
      }
      seenKeys.add(selection.key);
    }
  }

  for (const conflict of collectExternalStorageConflicts(plan, selections, store)) {
    conflicts.push(conflict);
  }

  return { externalMountsByModule, validationErrors, conflicts };
}

function validateSettingValue(
  type: string,
  value: ModuleInstallSettingValue,
  required: boolean
) {
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? null
      : 'Number settings must submit a finite number.';
  }

  if (type === 'boolean') {
    return typeof value === 'boolean' ? null : 'Boolean settings must submit a boolean.';
  }

  if (type === 'url') {
    if (typeof value !== 'string') {
      return 'URL settings must submit a string.';
    }

    if (required && !value.trim()) {
      return 'Required URL settings must not be empty.';
    }

    try {
      new URL(value);
      return null;
    } catch {
      return 'URL settings must submit a valid URL.';
    }
  }

  if (typeof value !== 'string') {
    return 'String and secret settings must submit a string.';
  }

  if (required && !value.trim()) {
    return 'Required string and secret settings must not be empty.';
  }

  return null;
}

async function collectReusableDependencyConflicts(
  plan: InstallPlan,
  store: ModulesStoreData,
  config: HostRuntimeConfig
) {
  const conflicts: InstallPlanConflict[] = [];
  const existingById = new Map(store.modules.map(module => [module.id, module]));

  for (const dependency of plan.dependencies.filter(candidate => candidate.installAction === 'reuse')) {
    const installed = existingById.get(dependency.id);

    if (!installed) {
      conflicts.push(reusableDependencyConflict(dependency, 'Dependency is no longer installed.', null));
      continue;
    }

    if ((installed.operationStatus || 'installed') !== 'installed') {
      conflicts.push(reusableDependencyConflict(
        dependency,
        `Dependency has operationStatus "${installed.operationStatus}".`,
        installed.operationStatus
      ));
      continue;
    }

    const metadata = await readModuleMetadata(installed, config);
    if (!metadata) {
      conflicts.push(reusableDependencyConflict(dependency, 'Dependency local metadata.json is missing.', null));
      continue;
    }

    const installedMajor = getModuleMetadataMajor(metadata.version);
    const plannedMajor = getModuleMetadataMajor(dependency.version);
    if (installedMajor !== plannedMajor) {
      conflicts.push(reusableDependencyConflict(
        dependency,
        `Dependency local metadata major "${installedMajor}" does not match planned major "${plannedMajor}".`,
        metadata.version
      ));
    }
  }

  return conflicts;
}

function reusableDependencyConflict(
  dependency: InstallPlanDependencyNode,
  message: string,
  existingValue: unknown
): InstallPlanConflict {
  return {
    code: 'reusable_dependency_conflict',
    message: `Reusable dependency "${dependency.id}" cannot be used. ${message}`,
    resourceType: 'installed_module',
    resourceId: dependency.id,
    path: '$.dependencies',
    node: dependency.id,
    existingValue,
    proposedValue: dependency.metadataUrl,
  };
}

async function startReusableDependency(moduleId: string, config: HostRuntimeConfig): Promise<{
  error: ModuleOperationError | null;
}> {
  const store = await readModulesStore(config);
  const installed = store.modules.find(module => module.id === moduleId);

  if (!installed) {
    return {
      error: {
        operation: 'module.install.reuseDependency',
        httpStatus: 409,
        message: `Reusable dependency "${moduleId}" is no longer installed.`,
        nextStep: 'Create a new install plan and retry.',
        occurredAt: new Date().toISOString(),
      },
    };
  }

  try {
    await ensureModuleContainerStarted(installed);
    return { error: null };
  } catch (error) {
    return {
      error: toModuleOperationError(
        `module.install.reuseDependency.${moduleId}`,
        error,
        `Docker Host could not start reusable dependency "${moduleId}".`,
        'Recover or reinstall the dependency before installing this module.'
      ),
    };
  }
}

function buildInstallNodeContext(
  plan: InstallPlan,
  graph: MetadataGraph,
  moduleId: string,
  decisions: InstallDecisions
): InstallNodeContext {
  const graphNode = graph.nodes.get(moduleId);
  const image = plan.images.find(candidate => candidate.moduleId === moduleId);

  if (!graphNode || !image) {
    throw new Error(`Install plan invariant failed for module "${moduleId}".`);
  }

  const dependency = plan.dependencies.find(candidate => candidate.id === moduleId);
  const metadata = moduleId === plan.module.id ? plan.normalizedMetadata : dependency?.normalizedMetadata;
  const paths = moduleId === plan.module.id ? plan.paths : dependency?.paths;
  const containerName = moduleId === plan.module.id ? plan.docker.containerName : dependency?.docker.containerName;
  const networkAlias = moduleId === plan.module.id ? plan.docker.networkAliases[0] : dependency?.docker.networkAlias;

  if (!metadata || !paths || !containerName || !networkAlias) {
    throw new Error(`Install plan node details are missing for module "${moduleId}".`);
  }

  return {
    id: moduleId,
    metadataUrl: graphNode.metadataUrl,
    metadata,
    graphNode,
    image,
    paths: {
      moduleDirectoryContainer: paths.moduleDirectoryContainer,
      metadataPathContainer: paths.metadataPathContainer,
    },
    containerName,
    networkAlias,
    storageDirectories: plan.storage.directories.filter(directory => directory.moduleId === moduleId),
    settings: decisions.settingsByModule.get(moduleId) ?? {},
    externalMounts: decisions.externalMountsByModule.get(moduleId) ?? [],
    resolvedDependencies: getResolvedDependenciesForConsumer(plan, moduleId),
  };
}

async function persistInstallingState(
  context: InstallNodeContext,
  plan: InstallPlan,
  config: HostRuntimeConfig
) {
  await upsertModuleRecord(context.id, config, existing => ({
    ...existing,
    ...buildInstalledModuleRecord(context, plan, existing),
    operationStatus: 'installing',
    lastError: null,
    updatedAt: new Date().toISOString(),
  }));
}

function buildInstalledModuleRecord(
  context: InstallNodeContext,
  plan: InstallPlan,
  existing: InstalledModuleRecord | null
): InstalledModuleRecord {
  return {
    id: context.id,
    metadataUrl: context.metadataUrl,
    metadataPath: path.posix.join('modules', context.id, 'metadata.json'),
    metadataDigest: metadataDigest(context.graphNode),
    planDigest: plan.planDigest,
    containerName: context.containerName,
    image: {
      repository: context.image.repository,
      tag: context.image.tag,
      reference: context.image.reference,
      pullPolicy: context.image.pullPolicy,
    },
    operationStatus: existing?.operationStatus || 'installing',
    settings: context.settings,
    storageMappings: Object.fromEntries(
      context.storageDirectories.map(directory => [
        directory.key,
        toInstalledStorageMapping(directory),
      ])
    ),
    externalMounts: context.externalMounts,
    resolvedDependencies: context.resolvedDependencies,
    installedAt: existing?.installedAt,
    updatedAt: existing?.updatedAt,
    lastError: existing?.lastError ?? null,
  };
}

async function writeModuleFiles(context: InstallNodeContext) {
  await fs.mkdir(context.paths.moduleDirectoryContainer, { recursive: true });
  await fs.writeFile(context.paths.metadataPathContainer, context.graphNode.rawBytes);
}

async function createModuleOwnedDirectories(context: InstallNodeContext) {
  await Promise.all(
    context.storageDirectories.map(directory =>
      fs.mkdir(directory.containerHostPath, { recursive: true })
    )
  );
}

function buildContainerEnvironment(context: InstallNodeContext) {
  const env: Record<string, string> = {};

  for (const setting of context.metadata.settings) {
    const value = context.settings[setting.key];
    if (value !== undefined) {
      env[setting.target.name] = stringifySettingValue(value);
    }
  }

  for (const dependency of context.resolvedDependencies) {
    if (dependency.baseUrlEnv && dependency.resolvedBaseUrl) {
      env[dependency.baseUrlEnv] = dependency.resolvedBaseUrl;
    }
  }

  return env;
}

function buildContainerMounts(context: InstallNodeContext) {
  return [
    ...context.storageDirectories.map(directory => ({
      hostPath: directory.hostPath,
      containerPath: directory.containerPath,
      readOnly: directory.readOnly,
    })),
    ...context.externalMounts.map(mount => ({
      hostPath: mount.hostPath,
      containerPath: mount.containerPath,
      readOnly: mount.readOnly,
    })),
  ];
}

async function markModuleInstalled(moduleId: string, config: HostRuntimeConfig) {
  await upsertModuleRecord(moduleId, config, existing => {
    if (!existing) {
      throw new Error(`Module "${moduleId}" cannot be marked installed before an install record exists.`);
    }

    const now = new Date().toISOString();
    return {
      ...existing,
      operationStatus: 'installed',
      installedAt: existing.installedAt || now,
      updatedAt: now,
      lastError: null,
    };
  });
}

async function markModuleFailed(
  moduleId: string,
  error: ModuleOperationError,
  config: HostRuntimeConfig
) {
  await upsertModuleRecord(moduleId, config, existing => {
    if (!existing) {
      return {
        id: moduleId,
        metadataUrl: '',
        operationStatus: 'failed',
        updatedAt: new Date().toISOString(),
        lastError: error,
      };
    }

    return {
      ...existing,
      operationStatus: 'failed',
      updatedAt: new Date().toISOString(),
      lastError: error,
    };
  });
}

async function upsertModuleRecord(
  moduleId: string,
  config: HostRuntimeConfig,
  updater: (existing: InstalledModuleRecord | null) => InstalledModuleRecord
) {
  const store = await readModulesStore(config);
  const existingIndex = store.modules.findIndex(module => module.id === moduleId);
  const existing = existingIndex >= 0 ? store.modules[existingIndex] : null;
  const nextRecord = updater(existing);
  const nextModules =
    existingIndex >= 0
      ? store.modules.map((module, index) => (index === existingIndex ? nextRecord : module))
      : [...store.modules, nextRecord];

  await writeModulesStore(
    {
      ...store,
      modules: nextModules,
    },
    config
  );
}

function getResolvedDependenciesForConsumer(plan: InstallPlan, consumerId: string): ResolvedDependency[] {
  return plan.dependencies.flatMap(dependency =>
    dependency.connections
      .filter(connection => connection.consumerId === consumerId)
      .map(connection => ({
        id: connection.dependencyId,
        endpoint: connection.endpoint,
        baseUrlEnv: connection.baseUrlEnv,
        resolvedBaseUrl: connection.resolvedBaseUrl,
      }))
  );
}

function collectExternalStorageConflicts(
  plan: InstallPlan,
  selections: ModuleInstallExternalMountSelection[],
  store: ModulesStoreData
) {
  const conflicts: InstallPlanConflict[] = [];
  const plannedModuleOwnedPaths = new Map(
    plan.storage.directories.map(directory => [normalizeHostPath(directory.hostPath), directory])
  );

  for (const selection of selections) {
    const moduleOwned = plannedModuleOwnedPaths.get(normalizeHostPath(selection.hostPath));
    if (moduleOwned) {
      conflicts.push({
        code: 'external_mount_path_conflict',
        message: `External host path "${selection.hostPath}" conflicts with planned module-owned storage.`,
        resourceType: 'storage_mapping',
        resourceId: selection.hostPath,
        path: '$.externalMounts',
        node: selection.moduleId,
        existingValue: moduleOwned.moduleId,
        proposedValue: selection.moduleId,
      });
    }
  }

  const plannedModuleIds = new Set(plan.installOrder);
  const selectedPaths = new Map(
    selections.map(selection => [normalizeHostPath(selection.hostPath), selection])
  );

  for (const installedModule of store.modules) {
    if (plannedModuleIds.has(installedModule.id)) {
      continue;
    }

    for (const installedPath of getInstalledStorageHostPaths(installedModule)) {
      const selection = selectedPaths.get(normalizeHostPath(installedPath));
      if (!selection) {
        continue;
      }

      conflicts.push({
        code: 'external_mount_path_conflict',
        message: `External host path "${selection.hostPath}" conflicts with installed module "${installedModule.id}".`,
        resourceType: 'storage_mapping',
        resourceId: selection.hostPath,
        path: '$.externalMounts',
        node: selection.moduleId,
        existingValue: installedModule.id,
        proposedValue: selection.moduleId,
      });
    }
  }

  return conflicts;
}

function getInstalledStorageHostPaths(module: InstalledModuleRecord) {
  return [
    ...getInstalledStorageMappings(module).map(mapping => mapping.hostPath),
    ...getInstalledExternalMounts(module).map(mount => mount.hostPath),
  ];
}

function getInstalledStorageMappings(module: InstalledModuleRecord): InstalledStorageMapping[] {
  const mappings = module.storageMappings || module.storage?.directories || [];
  return Array.isArray(mappings) ? mappings : Object.values(mappings);
}

function getInstalledExternalMounts(module: InstalledModuleRecord): InstalledExternalMountMapping[] {
  const mounts = module.externalMounts || [];
  return Array.isArray(mounts) ? mounts : Object.values(mounts).flat();
}

function toInstalledStorageMapping(directory: InstallPlanStorageDirectory): InstalledStorageMapping {
  return {
    key: directory.key,
    containerPath: directory.containerPath,
    hostPath: directory.hostPath,
    required: directory.required,
    writable: directory.writable,
    readOnly: directory.readOnly,
  };
}

function applyFailureResult(error: ModuleOperationError): InstallApplyResult {
  return {
    status: error.httpStatus === 409 ? 409 : 500,
    body: {
      error: {
        code: 'install_apply_failed',
        message: error.message,
        validationErrors: [],
        conflicts: [],
      },
    },
  };
}

function conflictResult(
  code: string,
  message: string,
  conflicts: InstallPlanConflict[]
): InstallApplyResult {
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

function readString(
  object: Record<string, unknown>,
  key: string,
  pathToValue: string,
  validationErrors: InstallPlanValidationError[]
) {
  const value = object[key];

  if (typeof value !== 'string' || !value.trim()) {
    validationErrors.push({
      code: 'install_request_invalid',
      message: `${key} must be a non-empty string.`,
      path: pathToValue,
    });
    return null;
  }

  return value.trim();
}

function readBoolean(
  object: Record<string, unknown>,
  key: string,
  pathToValue: string,
  validationErrors: InstallPlanValidationError[]
) {
  const value = object[key];

  if (typeof value !== 'boolean') {
    validationErrors.push({
      code: 'install_request_invalid',
      message: `${key} must be a boolean.`,
      path: pathToValue,
    });
    return undefined;
  }

  return value;
}

function metadataDigest(node: MetadataGraphNode) {
  return `sha256:${createHash('sha256').update(node.rawBytes).digest('hex')}`;
}

function stringifySettingValue(value: InstalledSettingValue) {
  return typeof value === 'boolean' ? String(value) : String(value);
}

function settingKey(moduleId: string, key: string) {
  return `${moduleId}:${key}`;
}

function normalizeHostPath(value: string) {
  return path.resolve(value);
}

function isSafeExternalMountKey(value: string) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
