import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureHostDataRoot, getHostRuntimeConfig } from '@/lib/host-runtime';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import {
  createAndStartModuleContainer,
  ensureModuleContainerStarted,
  ensureModuleNetwork,
  pullModuleImage,
  removeModuleContainerIfExists,
  toModuleOperationError,
} from '@/lib/module-docker';
import { loadMetadataGraph } from '@/lib/module-metadata';
import { createModuleUpdatePlan } from '@/lib/module-update-plan';
import { withModuleMutationLock } from '@/lib/module-mutation-lock';
import {
  readModuleMetadata,
  readModulesStore,
  writeModulesStore,
} from '@/lib/module-store';
import {
  buildModuleServiceEnvironment,
  createModuleServiceToken,
} from '@/lib/module-directory-service';
import {
  getStoredExternalMounts,
  getStoredStorageMappings,
} from '@/lib/module-recovery-model';
import { listInstalledModules } from '@/lib/module-service';
import { isSafeExternalMountKey } from '@/lib/module-install-request';
import type { MetadataGraph, MetadataGraphNode } from '@/lib/module-metadata';
import type {
  InstallPlanConflict,
  InstallPlanContainer,
  InstallPlanErrorEnvelope,
  InstallPlanValidationError,
  InstalledExternalMountMapping,
  InstalledModuleRecord,
  InstalledSettingValue,
  InstalledStorageMapping,
  ModuleActionResult,
  ModuleInstallExternalMountSelection,
  ModuleInstallSettingSelection,
  ModuleInstallSettingValue,
  ModuleOperationError,
  ModuleUpdateFailureResponse,
  ModuleUpdatePlan,
  ModuleUpdateRequest,
  ModuleUpdateSuccessResponse,
  ModulesStoreData,
  NormalizedModuleMetadata,
  ResolvedDependency,
} from '@/types/modules';

type UpdateApplyResult =
  | {
      status: 200;
      body: ModuleUpdateSuccessResponse;
    }
  | {
      status: 404 | 409 | 422 | 500 | 503;
      body: ModuleUpdateFailureResponse;
    };

interface UpdateDecisions {
  settingsByModule: Map<string, Record<string, InstalledSettingValue>>;
  externalMountsByModule: Map<string, InstalledExternalMountMapping[]>;
}

interface UpdateNodeContext {
  id: string;
  metadataUrl: string;
  metadata: NormalizedModuleMetadata;
  graphNode: MetadataGraphNode;
  paths: {
    moduleDirectoryContainer: string;
    metadataPathContainer: string;
  };
  containers: InstallPlanContainer[];
  storageDirectories: InstalledStorageMappingWithContainerPath[];
  settings: Record<string, InstalledSettingValue>;
  externalMounts: InstalledExternalMountMapping[];
  resolvedDependencies: ResolvedDependency[];
}

type InstalledStorageMappingWithContainerPath = InstalledStorageMapping & {
  containerHostPath: string;
};

export async function applyModuleUpdateRequest(
  moduleId: string,
  body: unknown
): Promise<UpdateApplyResult> {
  const requestValidation = parseUpdateRequest(body);
  if (requestValidation.validationErrors.length > 0 || !requestValidation.request) {
    return updateEnvelopeResult(422, {
      code: 'update_request_validation_failed',
      message: 'Update request is invalid.',
      validationErrors: requestValidation.validationErrors,
      conflicts: [],
    });
  }

  const request = requestValidation.request;
  return withModuleMutationLock(() => applyValidatedUpdateRequest(moduleId, request));
}

export async function retryFailedModuleUpdate(moduleId: string): Promise<{
  status: 200 | 404 | 409 | 422 | 500 | 503;
  body: ModuleActionResult;
}> {
  return withModuleMutationLock(async () => {
    const config = getHostRuntimeConfig();
    const store = await readModulesStore(config);
    const installedModule = store.modules.find(module => module.id === moduleId);

    if (!installedModule) {
      return moduleActionFailure(404, 'module.update.retry', {
        message: `Module "${moduleId}" is not installed.`,
        nextStep: 'Install the module before retrying update.',
      });
    }

    if ((installedModule.operationStatus || 'installed') !== 'failed' ||
      installedModule.lastOperation !== 'update' ||
      !installedModule.updateAttempt) {
      return moduleActionFailure(409, 'module.update.retry', {
        message: `Module "${moduleId}" does not have a retryable failed update.`,
        nextStep: 'Open update review and create a new update plan.',
      });
    }

    const retryResult = await applyValidatedUpdateRequest(moduleId, {
      updatePlanDigest: installedModule.updateAttempt.updatePlanDigest,
      confirmed: true,
      settings: installedModule.updateAttempt.settings,
      externalMounts: installedModule.updateAttempt.externalMounts,
    });

    if (retryResult.status === 200) {
      return {
        status: 200,
        body: {
          success: true,
          module: retryResult.body.module,
          error: null,
        },
      };
    }

    const envelope = retryResult.body.error;
    return {
      status: retryResult.status,
      body: {
        success: false,
        module: null,
        error: {
          operation: 'module.update.retry',
          httpStatus: retryResult.status,
          message: envelope.message,
          nextStep: envelope.code === 'update_plan_digest_mismatch'
            ? 'Open update review again because refreshed metadata changed.'
            : 'Inspect the update error, then retry or review the update again.',
          occurredAt: new Date().toISOString(),
        },
      },
    };
  });
}

async function applyValidatedUpdateRequest(
  moduleId: string,
  request: ModuleUpdateRequest
): Promise<UpdateApplyResult> {
  const config = getHostRuntimeConfig();
  await ensureHostDataRoot(config);

  const store = await readModulesStore(config);
  const installedModule = store.modules.find(candidate => candidate.id === moduleId);
  if (!installedModule) {
    return updateEnvelopeResult(404, {
      code: 'module_not_found',
      message: `Module "${moduleId}" is not installed.`,
      validationErrors: [],
      conflicts: [],
    });
  }

  const planResult = await createModuleUpdatePlan(moduleId, config);
  if (planResult.status !== 200 || !planResult.body.plan) {
    return {
      status: planResult.status as 404 | 409 | 422 | 500 | 503,
      body: {
        error: planResult.body.error ?? {
          code: 'update_plan_failed',
          message: 'Update plan could not be recomputed for apply.',
          validationErrors: [],
          conflicts: [],
        },
      },
    };
  }

  const plan = planResult.body.plan;
  if (plan.updatePlanDigest !== request.updatePlanDigest) {
    return updateEnvelopeResult(409, {
      code: 'update_plan_digest_mismatch',
      message: 'The update plan changed since review. Create a new plan before applying.',
      validationErrors: [],
      conflicts: [{
        code: 'update_plan_digest_mismatch',
        message: 'The submitted updatePlanDigest does not match the recomputed update plan.',
        resourceType: 'update_plan',
        resourceId: request.updatePlanDigest,
        path: '$.updatePlanDigest',
        existingValue: plan.updatePlanDigest,
        proposedValue: request.updatePlanDigest,
      }],
    });
  }

  const decisionValidation = validateUpdateDecisions(plan, request, installedModule, store);
  if (decisionValidation.validationErrors.length > 0) {
    return updateEnvelopeResult(422, {
      code: 'update_request_validation_failed',
      message: 'Update request decisions are invalid.',
      validationErrors: decisionValidation.validationErrors,
      conflicts: [],
    });
  }

  if (decisionValidation.conflicts.length > 0) {
    return updateEnvelopeResult(409, {
      code: 'update_request_conflict',
      message: 'Update request decisions conflict with current Host state.',
      validationErrors: [],
      conflicts: decisionValidation.conflicts,
    });
  }

  const graphResult = await loadMetadataGraph(installedModule.metadataUrl);
  if (!graphResult.graph || graphResult.validationErrors.length > 0) {
    return updateEnvelopeResult(422, {
      code: 'update_plan_validation_failed',
      message: 'Refreshed metadata is no longer valid.',
      validationErrors: graphResult.validationErrors,
      conflicts: [],
    });
  }

  const network = await ensureModuleNetwork(config);
  if (!network.ready) {
    return updateEnvelopeResult(503, {
      code: 'docker_unavailable',
      message: network.error || `Docker network "${network.name}" is unavailable.`,
      validationErrors: [],
      conflicts: [],
    });
  }

  const installedDependencyIds: string[] = [];
  const reusedDependencyIds: string[] = [];
  const now = new Date().toISOString();

  try {
    await markModuleUpdating(moduleId, request, config, now);

    for (const dependencyId of plan.installOrder.filter(candidate => candidate !== moduleId)) {
      const dependency = plan.dependencies.find(candidate => candidate.id === dependencyId);
      if (!dependency) {
        continue;
      }

      if (dependency.installAction === 'reuse') {
        const latestStore = await readModulesStore(config);
        const installedDependency = latestStore.modules.find(candidate => candidate.id === dependencyId);
        if (!installedDependency) {
          throw new Error(`Reusable dependency "${dependencyId}" is no longer installed.`);
        }
        const dependencyMetadata = await readModuleMetadata(installedDependency, config).catch(() => null);
        await ensureModuleContainerStarted(installedDependency, dependencyMetadata);
        reusedDependencyIds.push(dependencyId);
        continue;
      }

      const context = buildDependencyInstallContext(plan, graphResult.graph, dependencyId, decisionValidation.decisions);
      await persistInstalledDependency(context, plan, config, now);
      await writeModuleFiles(context);
      await createModuleOwnedDirectories(context);
      for (const image of context.containers.map(container => container.image)) {
        await pullModuleImage(image);
      }
      const moduleServiceToken = await createModuleServiceToken({
        moduleId: context.id,
        label: 'Module container directory API token',
      }, undefined, config);
      for (const container of sortPlanContainers(context.containers)) {
        await createAndStartModuleContainer({
          moduleId: context.id,
          containerName: container.containerName,
          networkName: config.moduleNetwork,
          networkAlias: container.networkAlias,
          imageReference: container.image.reference,
          env: buildContainerEnvironment(context, container.key, moduleServiceToken.token, config),
          mounts: buildContainerMounts(context, container.key),
          ports: container.ports,
          ...(container.resources ? { resources: container.resources } : {}),
        });
      }
      await markModuleInstalled(context.id, config, now);
      installedDependencyIds.push(dependencyId);
    }

    const rootContext = buildRootUpdateContext(plan, graphResult.graph, installedModule, decisionValidation.decisions);
    await createModuleOwnedDirectories(rootContext);
    for (const image of rootContext.containers.map(container => container.image)) {
      await pullModuleImage(image);
    }

    if (plan.docker.replacementRequired) {
      await removeModuleContainerIfExists(installedModule);
      const moduleServiceToken = await createModuleServiceToken({
        moduleId: rootContext.id,
        label: 'Module container directory API token',
      }, undefined, config);
      for (const container of sortPlanContainers(rootContext.containers)) {
        await createAndStartModuleContainer({
          moduleId,
          containerName: container.containerName,
          networkName: config.moduleNetwork,
          networkAlias: container.networkAlias,
          imageReference: container.image.reference,
          env: buildContainerEnvironment(rootContext, container.key, moduleServiceToken.token, config),
          mounts: buildContainerMounts(rootContext, container.key),
          ports: container.ports,
          ...(container.resources ? { resources: container.resources } : {}),
        });
      }
    }

    await writeModuleFiles(rootContext);
    await persistUpdatedRoot(rootContext, plan, installedModule, config, now);

    const modules = await listInstalledModules();
    const updatedModule = modules.find(candidate => candidate.id === moduleId);
    if (!updatedModule) {
      throw new Error(`Module "${moduleId}" was updated but could not be read back from modules.json.`);
    }

    return {
      status: 200,
      body: {
        module: updatedModule,
        updatedModuleId: moduleId,
        installedDependencyIds,
        reusedDependencyIds,
        error: null,
      },
    };
  } catch (error) {
    const operationError = toModuleOperationError(
      `module.update.${moduleId}`,
      error,
      `Docker Host could not update module "${moduleId}".`,
      'Inspect the preserved files, Docker images, and containers, then retry update or review a new update plan.'
    );
    await markModuleUpdateFailed(moduleId, operationError, request, config, new Date().toISOString());
    return updateEnvelopeResult(500, {
      code: 'update_apply_failed',
      message: operationError.dockerMessage || operationError.message,
      validationErrors: [],
      conflicts: [],
    });
  }
}

function parseUpdateRequest(body: unknown): {
  request: ModuleUpdateRequest | null;
  validationErrors: InstallPlanValidationError[];
} {
  const validationErrors: InstallPlanValidationError[] = [];
  if (!isObject(body)) {
    return {
      request: null,
      validationErrors: [{
        code: 'update_request_invalid',
        message: 'Request body must be an object.',
        path: '$',
      }],
    };
  }

  const updatePlanDigest = readString(body, 'updatePlanDigest', '$.updatePlanDigest', validationErrors);
  const confirmed = body.confirmed === true;
  if (!confirmed) {
    validationErrors.push({
      code: 'update_request_confirmation_required',
      message: 'Update apply requires confirmed=true.',
      path: '$.confirmed',
    });
  }
  const settings = readSettingSelections(body.settings, validationErrors);
  const externalMounts = readExternalMountSelections(body.externalMounts, validationErrors);

  if (!updatePlanDigest || validationErrors.length > 0) {
    return { request: null, validationErrors };
  }

  return {
    request: {
      updatePlanDigest,
      confirmed,
      settings,
      externalMounts,
    },
    validationErrors,
  };
}

function validateUpdateDecisions(
  plan: ModuleUpdatePlan,
  request: ModuleUpdateRequest,
  installedModule: InstalledModuleRecord,
  store: ModulesStoreData
): {
  decisions: UpdateDecisions;
  validationErrors: InstallPlanValidationError[];
  conflicts: InstallPlanConflict[];
} {
  const settingValidation = validateSettingSelections(plan, request.settings, installedModule);
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
  plan: ModuleUpdatePlan,
  settings: ModuleInstallSettingSelection[],
  installedModule: InstalledModuleRecord
) {
  const validationErrors: InstallPlanValidationError[] = [];
  const prompts = new Map(plan.settings.map(prompt => [settingKey(prompt.moduleId, prompt.key), prompt]));
  const selected = new Map<string, ModuleInstallSettingSelection>();
  const settingsByModule = new Map<string, Record<string, InstalledSettingValue>>();

  for (const preserved of plan.preservedSettings) {
    const value = installedModule.settings?.[preserved.key];
    if (value !== undefined) {
      const moduleSettings = settingsByModule.get(preserved.moduleId) ?? {};
      moduleSettings[preserved.key] = value;
      settingsByModule.set(preserved.moduleId, moduleSettings);
    }
  }

  for (const selection of settings) {
    const key = settingKey(selection.moduleId, selection.key);
    const prompt = prompts.get(key);
    if (!prompt) {
      validationErrors.push({
        code: 'update_setting_unknown',
        message: `Setting "${selection.key}" is not required by the reviewed update plan for module "${selection.moduleId}".`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    if (selected.has(key)) {
      validationErrors.push({
        code: 'update_setting_duplicate',
        message: `Setting "${selection.key}" is submitted more than once for module "${selection.moduleId}".`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    if (selection.secret !== prompt.secret) {
      validationErrors.push({
        code: 'update_setting_secret_mismatch',
        message: `Setting "${selection.key}" secret marker does not match the reviewed update plan.`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    const valueValidation = validateSettingValue(prompt.type, selection.value, prompt.required);
    if (valueValidation) {
      validationErrors.push({
        code: 'update_setting_value_invalid',
        message: valueValidation,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    selected.set(key, selection);
  }

  for (const prompt of plan.settings) {
    const selectedSetting = selected.get(settingKey(prompt.moduleId, prompt.key));
    let value: InstalledSettingValue | undefined;

    if (selectedSetting) {
      value = selectedSetting.value;
    } else if (!prompt.secret && Object.prototype.hasOwnProperty.call(prompt, 'default')) {
      value = prompt.default as InstalledSettingValue;
    } else if (prompt.required) {
      validationErrors.push({
        code: 'update_setting_required',
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
  plan: ModuleUpdatePlan,
  selections: ModuleInstallExternalMountSelection[],
  store: ModulesStoreData
) {
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

  for (const mount of plan.storage.preservedExternalMounts) {
    const moduleMounts = externalMountsByModule.get(plan.moduleId) ?? [];
    moduleMounts.push(mount);
    externalMountsByModule.set(plan.moduleId, moduleMounts);
  }

  for (const selection of selections) {
    const collection = collections.get(settingKey(selection.moduleId, selection.collectionKey));
    if (!collection) {
      validationErrors.push({
        code: 'update_external_mount_unknown',
        message: `External mount collection "${selection.collectionKey}" is not required by the reviewed update plan for module "${selection.moduleId}".`,
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
        code: 'update_external_mount_key_invalid',
        message: 'External mount key must be a safe path segment.',
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    const primaryTarget = collection.targets[0];
    const expectedContainerPath = primaryTarget?.itemContainerPathTemplate.replace('{key}', selection.key);
    if (selection.containerPath !== expectedContainerPath) {
      validationErrors.push({
        code: 'update_external_mount_container_path_mismatch',
        message: `External mount containerPath must be "${expectedContainerPath}".`,
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    if (!collection.targets.some(target => target.writable) && selection.access !== 'readOnly') {
      validationErrors.push({
        code: 'update_external_mount_access_invalid',
        message: 'Read-only external mount collection targets cannot submit readWrite access.',
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    const moduleMounts = externalMountsByModule.get(selection.moduleId) ?? [];
    moduleMounts.push(...collection.targets.map(target => ({
      collectionKey: selection.collectionKey,
      key: selection.key,
      ...(selection.label ? { label: selection.label } : {}),
      hostPath: selection.hostPath,
      container: target.container,
      containerPath: target.itemContainerPathTemplate.replace('{key}', selection.key),
      access: selection.access,
      readOnly: selection.access === 'readOnly' || !target.writable,
    })));
    externalMountsByModule.set(selection.moduleId, moduleMounts);
  }

  for (const collection of plan.storage.mountCollections) {
    const collectionSelections =
      selectionsByCollection.get(settingKey(collection.moduleId, collection.key)) ?? [];
    const requiredCount = collection.required ? collection.minItems : 0;

    if (collectionSelections.length < requiredCount) {
      validationErrors.push({
        code: 'update_external_mount_required',
        message: `External mount collection "${collection.key}" requires at least ${requiredCount} item${requiredCount === 1 ? '' : 's'}.`,
        path: '$.externalMounts',
        node: collection.moduleId,
      });
    }

    if (collection.maxItems !== null && collectionSelections.length > collection.maxItems) {
      validationErrors.push({
        code: 'update_external_mount_too_many',
        message: `External mount collection "${collection.key}" allows at most ${collection.maxItems} item${collection.maxItems === 1 ? '' : 's'}.`,
        path: '$.externalMounts',
        node: collection.moduleId,
      });
    }
  }

  for (const conflict of collectExternalStorageConflicts(plan, selections, store)) {
    conflicts.push(conflict);
  }

  return { externalMountsByModule, validationErrors, conflicts };
}

function sortPlanContainers(containers: InstallPlanContainer[]) {
  const ordered: InstallPlanContainer[] = [];
  const remaining = new Map(containers.map(container => [container.key, container]));

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(container =>
      container.dependsOn.every(dependencyKey => !remaining.has(dependencyKey))
    );

    if (ready.length === 0) {
      return containers;
    }

    for (const container of ready) {
      ordered.push(container);
      remaining.delete(container.key);
    }
  }

  return ordered;
}

function buildDependencyInstallContext(
  plan: ModuleUpdatePlan,
  graph: MetadataGraph,
  moduleId: string,
  decisions: UpdateDecisions
): UpdateNodeContext {
  const node = graph.nodes.get(moduleId);
  const dependency = plan.dependencies.find(candidate => candidate.id === moduleId);

  if (!node || !dependency) {
    throw new Error(`Update plan dependency details are missing for module "${moduleId}".`);
  }

  return {
    id: moduleId,
    metadataUrl: node.metadataUrl,
    metadata: node.metadata,
    graphNode: node,
    paths: {
      moduleDirectoryContainer: dependency.paths.moduleDirectoryContainer,
      metadataPathContainer: dependency.paths.metadataPathContainer,
    },
    containers: dependency.containers,
    storageDirectories: plan.storage.directories
      .filter(directory => directory.moduleId === moduleId)
      .map(directory => ({ ...directory })),
    settings: decisions.settingsByModule.get(moduleId) ?? {},
    externalMounts: decisions.externalMountsByModule.get(moduleId) ?? [],
    resolvedDependencies: getResolvedDependenciesForConsumer(plan, moduleId),
  };
}

function buildRootUpdateContext(
  plan: ModuleUpdatePlan,
  graph: MetadataGraph,
  installedModule: InstalledModuleRecord,
  decisions: UpdateDecisions
): UpdateNodeContext {
  const node = graph.nodes.get(plan.moduleId);

  if (!node) {
    throw new Error(`Update plan root details are missing for module "${plan.moduleId}".`);
  }

  return {
    id: plan.moduleId,
    metadataUrl: node.metadataUrl,
    metadata: node.metadata,
    graphNode: node,
    paths: {
      moduleDirectoryContainer: plan.paths.moduleDirectoryContainer,
      metadataPathContainer: plan.paths.metadataPathContainer,
    },
    containers: plan.docker.containers,
    storageDirectories: plan.storage.directories
      .filter(directory => directory.moduleId === plan.moduleId)
      .map(directory => ({ ...directory })),
    settings: decisions.settingsByModule.get(plan.moduleId) ?? {},
    externalMounts: decisions.externalMountsByModule.get(plan.moduleId) ?? [],
    resolvedDependencies: getResolvedDependenciesForConsumer(plan, plan.moduleId),
  };
}

async function persistInstalledDependency(
  context: UpdateNodeContext,
  plan: ModuleUpdatePlan,
  config: HostRuntimeConfig,
  now: string
) {
  await upsertModuleRecord(context.id, config, existing => ({
    ...existing,
    ...buildInstalledModuleRecord(context, plan.updatePlanDigest, existing),
    operationStatus: 'installing',
    lastOperation: 'install',
    updatedAt: now,
    lastError: null,
  }));
}

async function persistUpdatedRoot(
  context: UpdateNodeContext,
  plan: ModuleUpdatePlan,
  existing: InstalledModuleRecord,
  config: HostRuntimeConfig,
  now: string
) {
  await upsertModuleRecord(context.id, config, current => ({
    ...current,
    ...buildInstalledModuleRecord(context, plan.updatePlanDigest, existing),
    operationStatus: 'installed',
    installedAt: existing.installedAt || now,
    updatedAt: now,
    lastOperation: 'update',
    updateAttempt: undefined,
    lastError: null,
  }));
}

function buildInstalledModuleRecord(
  context: UpdateNodeContext,
  planDigest: string,
  existing: InstalledModuleRecord | null
): InstalledModuleRecord {
  return {
    id: context.id,
    metadataUrl: context.metadataUrl,
    metadataPath: path.posix.join('modules', context.id, 'metadata.json'),
    metadataDigest: `sha256:${createHash('sha256').update(context.graphNode.rawBytes).digest('hex')}`,
    planDigest,
    containers: context.containers.map(container => ({
      key: container.key,
      containerName: container.containerName,
      networkAlias: container.networkAlias,
      image: {
        repository: container.image.repository,
        tag: container.image.tag,
        reference: container.image.reference,
        pullPolicy: container.image.pullPolicy,
      },
    })),
    operationStatus: existing?.operationStatus || 'installing',
    settings: context.settings,
    storageMappings: context.storageDirectories.map(directory => toInstalledStorageMapping(directory)),
    externalMounts: context.externalMounts,
    resolvedDependencies: context.resolvedDependencies,
    installedAt: existing?.installedAt,
    updatedAt: existing?.updatedAt,
    lastOperation: existing?.lastOperation,
    lastError: existing?.lastError ?? null,
  };
}

async function writeModuleFiles(context: UpdateNodeContext) {
  await fs.mkdir(context.paths.moduleDirectoryContainer, { recursive: true });
  await fs.writeFile(context.paths.metadataPathContainer, context.graphNode.rawBytes);
}

async function createModuleOwnedDirectories(context: UpdateNodeContext) {
  await Promise.all(
    context.storageDirectories.map(directory =>
      fs.mkdir(directory.containerHostPath, { recursive: true })
    )
  );
}

function buildContainerEnvironment(
  context: UpdateNodeContext,
  containerKey: string,
  moduleServiceToken: string,
  config: HostRuntimeConfig
) {
  const env: Record<string, string> = buildModuleServiceEnvironment({
    moduleId: context.id,
    serviceToken: moduleServiceToken,
    hostInternalOrigin: config.hostInternalOrigin,
  });

  for (const setting of context.metadata.settings) {
    const value = context.settings[setting.key];
    if (value !== undefined) {
      for (const target of setting.targets.filter(target => target.container === containerKey)) {
        env[target.name] = stringifySettingValue(value);
      }
    }
  }

  for (const dependency of context.resolvedDependencies) {
    if (dependency.resolvedBaseUrl) {
      for (const target of (dependency.targets ?? []).filter(target => target.container === containerKey)) {
        env[target.name] = dependency.resolvedBaseUrl;
      }
    }
  }

  for (const connection of context.metadata.connections) {
    const endpoint = context.metadata.endpoints.find(candidate => candidate.key === connection.source.key);
    const container = context.containers.find(candidate => candidate.key === endpoint?.container);
    const port = container?.ports.find(candidate => candidate.key === endpoint?.port);
    if (!endpoint || !container || !port) {
      continue;
    }

    for (const target of connection.targets.filter(target => target.container === containerKey)) {
      env[target.name] = `http://${container.networkAlias}:${port.containerPort}`;
    }
  }

  return env;
}

function buildContainerMounts(context: UpdateNodeContext, containerKey: string) {
  return [
    ...context.storageDirectories.filter(directory => directory.container === containerKey).map(directory => ({
      hostPath: directory.hostPath,
      containerPath: directory.containerPath,
      readOnly: directory.readOnly ?? !directory.writable,
    })),
    ...context.externalMounts.filter(mount => mount.container === containerKey).map(mount => ({
      hostPath: mount.hostPath,
      containerPath: mount.containerPath,
      readOnly: mount.readOnly,
    })),
  ];
}

async function markModuleUpdating(
  moduleId: string,
  request: ModuleUpdateRequest,
  config: HostRuntimeConfig,
  now: string
) {
  await upsertModuleRecord(moduleId, config, existing => {
    if (!existing) {
      throw new Error(`Module "${moduleId}" cannot be marked updating because it is not installed.`);
    }

    return {
      ...existing,
      operationStatus: 'updating',
      updatedAt: now,
      lastOperation: 'update',
      updateAttempt: {
        updatePlanDigest: request.updatePlanDigest,
        settings: request.settings,
        externalMounts: request.externalMounts,
        attemptedAt: now,
      },
      lastError: null,
    };
  });
}

async function markModuleInstalled(moduleId: string, config: HostRuntimeConfig, now: string) {
  await upsertModuleRecord(moduleId, config, existing => {
    if (!existing) {
      throw new Error(`Module "${moduleId}" cannot be marked installed before a record exists.`);
    }

    return {
      ...existing,
      operationStatus: 'installed',
      installedAt: existing.installedAt || now,
      updatedAt: now,
      lastOperation: 'install',
      lastError: null,
    };
  });
}

async function markModuleUpdateFailed(
  moduleId: string,
  error: ModuleOperationError,
  request: ModuleUpdateRequest,
  config: HostRuntimeConfig,
  now: string
) {
  await upsertModuleRecord(moduleId, config, existing => {
    if (!existing) {
      return {
        id: moduleId,
        metadataUrl: '',
        containers: [],
        operationStatus: 'failed',
        lastOperation: 'update',
        updateAttempt: {
          updatePlanDigest: request.updatePlanDigest,
          settings: request.settings,
          externalMounts: request.externalMounts,
          attemptedAt: now,
        },
        updatedAt: now,
        lastError: error,
      };
    }

    return {
      ...existing,
      operationStatus: 'failed',
      lastOperation: 'update',
      updateAttempt: {
        updatePlanDigest: request.updatePlanDigest,
        settings: request.settings,
        externalMounts: request.externalMounts,
        attemptedAt: now,
      },
      updatedAt: now,
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

function getResolvedDependenciesForConsumer(
  plan: ModuleUpdatePlan,
  consumerId: string
): ResolvedDependency[] {
  return plan.dependencies.flatMap(dependency =>
    dependency.connections
      .filter(connection => connection.consumerId === consumerId)
      .map(connection => ({
        id: connection.dependencyId,
        endpoint: connection.endpoint,
        targets: connection.targets,
        resolvedBaseUrl: connection.resolvedBaseUrl,
      }))
  );
}

function collectExternalStorageConflicts(
  plan: ModuleUpdatePlan,
  selections: ModuleInstallExternalMountSelection[],
  store: ModulesStoreData
) {
  const conflicts: InstallPlanConflict[] = [];
  const plannedModuleOwnedPaths = new Map(
    plan.storage.directories.map(directory => [path.resolve(directory.hostPath), directory])
  );

  for (const selection of selections) {
    const moduleOwned = plannedModuleOwnedPaths.get(path.resolve(selection.hostPath));
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
    selections.map(selection => [path.resolve(selection.hostPath), selection])
  );

  for (const installedModule of store.modules) {
    if (plannedModuleIds.has(installedModule.id)) {
      continue;
    }

    for (const installedPath of [
      ...getStoredStorageMappings(installedModule).map(mapping => mapping.hostPath),
      ...getStoredExternalMounts(installedModule).map(mount => mount.hostPath),
    ]) {
      const selection = selectedPaths.get(path.resolve(installedPath));
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

function readSettingSelections(
  value: unknown,
  validationErrors: InstallPlanValidationError[]
): ModuleInstallSettingSelection[] {
  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'update_request_invalid',
      message: 'settings must be an array.',
      path: '$.settings',
    });
    return [];
  }

  return value.flatMap((item, index) => {
    const itemPath = `$.settings[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'update_request_invalid',
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
        code: 'update_request_invalid',
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
      code: 'update_request_invalid',
      message: 'externalMounts must be an array.',
      path: '$.externalMounts',
    });
    return [];
  }

  return value.flatMap((item, index) => {
    const itemPath = `$.externalMounts[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'update_request_invalid',
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
        code: 'update_request_invalid',
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

function toInstalledStorageMapping(
  directory: InstalledStorageMappingWithContainerPath
): InstalledStorageMapping {
  return {
    key: directory.key,
    container: directory.container,
    containerPath: directory.containerPath,
    hostPath: directory.hostPath,
    required: directory.required,
    writable: directory.writable,
    readOnly: directory.readOnly,
  };
}

function stringifySettingValue(value: InstalledSettingValue) {
  return typeof value === 'string' ? value : String(value);
}

function settingKey(moduleId: string, key: string) {
  return `${moduleId}:${key}`;
}

function readString(
  object: Record<string, unknown>,
  key: string,
  targetPath: string,
  validationErrors: InstallPlanValidationError[]
) {
  const value = object[key];
  if (typeof value !== 'string' || !value.trim()) {
    validationErrors.push({
      code: 'update_request_invalid',
      message: `${targetPath} must be a non-empty string.`,
      path: targetPath,
    });
    return null;
  }

  return value.trim();
}

function readBoolean(
  object: Record<string, unknown>,
  key: string,
  targetPath: string,
  validationErrors: InstallPlanValidationError[]
) {
  const value = object[key];
  if (typeof value !== 'boolean') {
    validationErrors.push({
      code: 'update_request_invalid',
      message: `${targetPath} must be a boolean.`,
      path: targetPath,
    });
    return undefined;
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function updateEnvelopeResult<TStatus extends UpdateApplyResult['status']>(
  status: TStatus,
  error: InstallPlanErrorEnvelope
): Extract<UpdateApplyResult, { status: TStatus }> {
  return {
    status,
    body: { error },
  } as Extract<UpdateApplyResult, { status: TStatus }>;
}

function moduleActionFailure(
  status: 404 | 409 | 422 | 500 | 503,
  operation: string,
  details: {
    message: string;
    nextStep: string;
  }
) {
  return {
    status,
    body: {
      success: false,
      module: null,
      error: {
        operation,
        httpStatus: status,
        message: details.message,
        nextStep: details.nextStep,
        occurredAt: new Date().toISOString(),
      },
    },
  };
}
