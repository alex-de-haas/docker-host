import type {
  InstallPlan,
  InstallPlanMountCollection,
  InstallPlanSettingPrompt,
  ModuleInstallExternalMountAccess,
  ModuleInstallExternalMountSelection,
  ModuleInstallRequest,
  ModuleInstallSettingSelection,
  ModuleInstallSettingValue,
} from '../types/modules';

export interface ExternalMountDraft {
  id: string;
  moduleId: string;
  collectionKey: string;
  key: string;
  label: string;
  hostPath: string;
  access: ModuleInstallExternalMountAccess;
}

export interface ExternalMountValidationError {
  draftId?: string;
  moduleId: string;
  collectionKey: string;
  message: string;
}

export interface ExternalMountValidationResult {
  selections: ModuleInstallExternalMountSelection[];
  errors: ExternalMountValidationError[];
}

export function getSettingFieldName(setting: Pick<InstallPlanSettingPrompt, 'moduleId' | 'key'>) {
  return `setting:${setting.moduleId}:${setting.key}`;
}

export function buildModuleInstallRequest(
  plan: InstallPlan,
  formData: FormData,
  externalMounts: ModuleInstallExternalMountSelection[]
): ModuleInstallRequest {
  return {
    metadataUrl: plan.metadataUrl,
    planDigest: plan.planDigest,
    settings: collectSettingSelections(plan.settings, formData),
    externalMounts,
  };
}

export function redactModuleInstallRequest(request: ModuleInstallRequest): ModuleInstallRequest {
  return {
    ...request,
    settings: request.settings.map(setting => ({
      ...setting,
      value: setting.secret ? '<redacted>' : setting.value,
    })),
  };
}

export function validateExternalMountDrafts(
  plan: InstallPlan,
  drafts: ExternalMountDraft[]
): ExternalMountValidationResult {
  const collections = new Map(
    plan.storage.mountCollections.map(collection => [
      mountCollectionKey(collection.moduleId, collection.key),
      collection,
    ])
  );
  const draftsByCollection = new Map<string, ExternalMountDraft[]>();
  const selections: ModuleInstallExternalMountSelection[] = [];
  const errors: ExternalMountValidationError[] = [];

  for (const draft of drafts) {
    const hasAnyValue = Boolean(
      draft.key.trim() || draft.label.trim() || draft.hostPath.trim()
    );

    if (!hasAnyValue) {
      continue;
    }

    const collection = collections.get(mountCollectionKey(draft.moduleId, draft.collectionKey));
    if (!collection) {
      errors.push({
        draftId: draft.id,
        moduleId: draft.moduleId,
        collectionKey: draft.collectionKey,
        message: 'External mount does not match a declared collection.',
      });
      continue;
    }

    const collectionDrafts = draftsByCollection.get(mountCollectionKey(draft.moduleId, draft.collectionKey)) ?? [];
    collectionDrafts.push(draft);
    draftsByCollection.set(mountCollectionKey(draft.moduleId, draft.collectionKey), collectionDrafts);

    const key = draft.key.trim();
    const hostPath = draft.hostPath.trim();

    if (!isSafeExternalMountKey(key)) {
      errors.push({
        draftId: draft.id,
        moduleId: draft.moduleId,
        collectionKey: draft.collectionKey,
        message: 'Item key must be a safe path segment.',
      });
    }

    if (!hostPath) {
      errors.push({
        draftId: draft.id,
        moduleId: draft.moduleId,
        collectionKey: draft.collectionKey,
        message: 'Host path is required.',
      });
    }

    if (key && hostPath && isSafeExternalMountKey(key)) {
      selections.push({
        moduleId: draft.moduleId,
        collectionKey: draft.collectionKey,
        key,
        ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
        hostPath,
        containerPath: computeExternalMountContainerPath(collection, key),
        access: collection.writable ? draft.access : 'readOnly',
      });
    }
  }

  for (const collection of plan.storage.mountCollections) {
    const key = mountCollectionKey(collection.moduleId, collection.key);
    const collectionDrafts = draftsByCollection.get(key) ?? [];
    const requiredCount = collection.required ? collection.minItems : 0;

    if (collectionDrafts.length < requiredCount) {
      errors.push({
        moduleId: collection.moduleId,
        collectionKey: collection.key,
        message: `At least ${requiredCount} item${requiredCount === 1 ? '' : 's'} required.`,
      });
    }

    if (collection.maxItems !== null && collectionDrafts.length > collection.maxItems) {
      errors.push({
        moduleId: collection.moduleId,
        collectionKey: collection.key,
        message: `At most ${collection.maxItems} item${collection.maxItems === 1 ? '' : 's'} allowed.`,
      });
    }

    const seenKeys = new Set<string>();
    for (const draft of collectionDrafts) {
      const itemKey = draft.key.trim();
      if (!itemKey || !isSafeExternalMountKey(itemKey)) {
        continue;
      }

      if (seenKeys.has(itemKey)) {
        errors.push({
          draftId: draft.id,
          moduleId: draft.moduleId,
          collectionKey: draft.collectionKey,
          message: `Item key "${itemKey}" is duplicated.`,
        });
      }

      seenKeys.add(itemKey);
    }
  }

  return { selections, errors };
}

export function createExternalMountDrafts(plan: InstallPlan): ExternalMountDraft[] {
  return plan.storage.mountCollections.flatMap(collection => {
    const requiredCount = collection.required ? collection.minItems : 0;
    return Array.from({ length: requiredCount }, (_, index) =>
      createExternalMountDraft(collection, index)
    );
  });
}

export function createExternalMountDraft(
  collection: Pick<InstallPlanMountCollection, 'moduleId' | 'key' | 'writable'>,
  index: number
): ExternalMountDraft {
  return {
    id: `${collection.moduleId}:${collection.key}:${Date.now()}:${index}`,
    moduleId: collection.moduleId,
    collectionKey: collection.key,
    key: '',
    label: '',
    hostPath: '',
    access: collection.writable ? 'readWrite' : 'readOnly',
  };
}

export function computeExternalMountContainerPath(
  collection: Pick<InstallPlanMountCollection, 'itemContainerPathTemplate'>,
  key: string
) {
  return isSafeExternalMountKey(key)
    ? collection.itemContainerPathTemplate.replace('{key}', key)
    : '';
}

export function isSafeExternalMountKey(value: string) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0');
}

function collectSettingSelections(
  settings: InstallPlanSettingPrompt[],
  formData: FormData
): ModuleInstallSettingSelection[] {
  const selections: ModuleInstallSettingSelection[] = [];

  for (const setting of settings) {
    const value = coerceSettingValue(setting, formData.get(getSettingFieldName(setting)));
    if (value === undefined) {
      continue;
    }

    selections.push({
      moduleId: setting.moduleId,
      key: setting.key,
      value,
      secret: setting.secret,
    });
  }

  return selections;
}

function coerceSettingValue(
  setting: InstallPlanSettingPrompt,
  value: FormDataEntryValue | null
): ModuleInstallSettingValue | undefined {
  if (value === null) {
    return undefined;
  }

  const rawValue = String(value);
  if (rawValue === '' && !setting.required) {
    return undefined;
  }

  if (setting.type === 'number') {
    return Number(rawValue);
  }

  if (setting.type === 'boolean') {
    return rawValue === 'true';
  }

  return rawValue;
}

function mountCollectionKey(moduleId: string, collectionKey: string) {
  return `${moduleId}:${collectionKey}`;
}
