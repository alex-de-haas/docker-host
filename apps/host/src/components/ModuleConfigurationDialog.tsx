'use client';

import { FormEvent, ReactNode, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Eye,
  Folder,
  LoaderCircle,
  Network,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import {
  buildModuleConfigurationRequest,
  getConfigurationSettingFieldName,
  redactModuleConfigurationRequest,
} from '@/lib/module-configuration-request';
import {
  computeExternalMountContainerPath,
  createExternalMountDraft,
  getEndpointHostPortFieldName,
  getEndpointOriginFieldName,
  validateExternalMountDrafts,
} from '@/lib/module-install-request';
import type {
  ExternalMountDraft,
  ExternalMountValidationError,
} from '@/lib/module-install-request';
import type {
  InstallPlanErrorEnvelope,
  InstallPlanMountCollection,
  ModuleConfigurationPlan,
  ModuleConfigurationRequest,
  ModuleConfigurationSettingPrompt,
  ModuleSummary,
} from '@/types/modules';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ModuleConfigurationDialogState {
  module: ModuleSummary;
  plan: ModuleConfigurationPlan | null;
  loading: boolean;
  applying: boolean;
  error: string | null;
}

export function ModuleConfigurationDialog({
  state,
  onOpenChange,
  onApply,
}: {
  state: ModuleConfigurationDialogState | null;
  onOpenChange: (open: boolean) => void;
  onApply: (request: ModuleConfigurationRequest) => Promise<boolean>;
}) {
  const plan = state?.plan ?? null;
  const applying = Boolean(state?.applying);
  const [externalMountDrafts, setExternalMountDrafts] = useState<ExternalMountDraft[]>(() =>
    plan ? createConfigurationExternalMountDrafts(plan) : []
  );
  const [externalMountErrors, setExternalMountErrors] = useState<ExternalMountValidationError[]>([]);
  const [previewRequest, setPreviewRequest] = useState<ModuleConfigurationRequest | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function buildRequest(form: HTMLFormElement) {
    if (!plan) {
      return null;
    }

    const externalMountValidation = validateExternalMountDrafts(
      {
        storage: {
          directories: [],
          mountCollections: plan.storage.mountCollections,
        },
      },
      externalMountDrafts
    );
    setExternalMountErrors(externalMountValidation.errors);
    setSubmitError(null);

    if (externalMountValidation.errors.length > 0) {
      setPreviewRequest(null);
      return null;
    }

    return buildModuleConfigurationRequest(
      plan,
      new FormData(form),
      externalMountValidation.selections
    );
  }

  function handlePreview(form: HTMLFormElement) {
    const request = buildRequest(form);
    setPreviewRequest(request);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = buildRequest(event.currentTarget);
    if (!request) {
      return;
    }

    setPreviewRequest(null);
    const applied = await onApply(request);
    if (!applied) {
      setSubmitError('Module configuration could not be applied.');
    }
  }

  return (
    <Dialog open={Boolean(state)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Configure module</DialogTitle>
          <DialogDescription>{state?.module.name || 'Module'}</DialogDescription>
        </DialogHeader>

        {state?.loading && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading configuration
          </div>
        )}

        {(state?.error || submitError) && (
          <PlanErrorPanel
            error={{
              code: 'module_configuration_dialog_error',
              message: state?.error || submitError || 'Module configuration failed.',
              validationErrors: [],
              conflicts: [],
            }}
          />
        )}

        {plan && (
          <form onSubmit={handleSubmit} className="space-y-5">
            <section className="rounded-lg border p-4">
              <SectionHeader title="Settings" icon={<Settings2 className="h-4 w-4" />} />
              <SettingsInputs settings={plan.settings} />
            </section>

            <section className="rounded-lg border p-4">
              <SectionHeader title="Browser origins" icon={<Network className="h-4 w-4" />} />
              <EndpointOriginInputs plan={plan} />
            </section>

            <section className="rounded-lg border p-4">
              <SectionHeader title="External mounts" icon={<Folder className="h-4 w-4" />} />
              <ExternalMountCollections
                collections={plan.storage.mountCollections}
                drafts={externalMountDrafts}
                errors={externalMountErrors}
                onDraftsChange={setExternalMountDrafts}
              />
            </section>

            {plan.warnings.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <CircleAlert className="h-4 w-4" />
                  Warnings
                </div>
                <ul className="grid gap-1">
                  {plan.warnings.map(warning => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            {previewRequest && (
              <pre className="max-h-72 overflow-auto rounded-md bg-muted p-4 text-xs">
                {JSON.stringify(redactModuleConfigurationRequest(previewRequest), null, 2)}
              </pre>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={applying}
                onClick={event => handlePreview(event.currentTarget.form as HTMLFormElement)}
              >
                <Eye className="h-4 w-4" />
                Preview request
              </Button>
              <Button type="submit" disabled={applying || plan.conflicts.length > 0}>
                {applying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsInputs({ settings }: { settings: ModuleConfigurationSettingPrompt[] }) {
  if (settings.length === 0) {
    return <EmptyLine>No configurable settings</EmptyLine>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {settings.map(setting => (
        <div key={`${setting.moduleId}:${setting.key}`} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={getConfigurationSettingFieldName(setting)}>{setting.key}</Label>
            <div className="flex gap-1">
              <Badge variant="outline">{setting.type}</Badge>
              {setting.secret && <Badge variant="secondary">write-only</Badge>}
            </div>
          </div>
          <SettingInput setting={setting} />
          <p className="break-all text-xs text-muted-foreground">
            {setting.targets.map(target => `${target.container}:${target.name}`).join(', ') || 'no runtime targets'}
          </p>
        </div>
      ))}
    </div>
  );
}

function SettingInput({ setting }: { setting: ModuleConfigurationSettingPrompt }) {
  const id = getConfigurationSettingFieldName(setting);
  const defaultValue = setting.default === undefined ? '' : String(setting.default);

  if (setting.type === 'boolean') {
    return (
      <select
        id={id}
        name={id}
        defaultValue={defaultValue}
        required={setting.required}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {setting.required && defaultValue === '' ? <option value="" disabled>Select...</option> : null}
        {!setting.required ? <option value="">Not set</option> : null}
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  return (
    <Input
      id={id}
      name={id}
      type={setting.secret ? 'password' : setting.type === 'number' ? 'number' : setting.type === 'url' ? 'url' : 'text'}
      defaultValue={setting.secret ? '' : defaultValue}
      required={setting.secret ? setting.required && !setting.valueSet : setting.required}
      autoComplete={setting.secret ? 'new-password' : undefined}
      placeholder={setting.secret && setting.valueSet ? 'Stored value is preserved' : undefined}
    />
  );
}

function EndpointOriginInputs({ plan }: { plan: ModuleConfigurationPlan }) {
  if (plan.runtime.endpointOrigins.length === 0) {
    return <EmptyLine>No browser-facing endpoint origins</EmptyLine>;
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {plan.runtime.endpointOrigins.map(origin => (
        <div key={`${origin.moduleId}:${origin.endpoint}`} className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{origin.endpoint}</span>
            <Badge variant="outline">{origin.requiredForUi ? 'app UI' : 'public endpoint'}</Badge>
          </div>
          <div className="space-y-2">
            <Label htmlFor={getEndpointOriginFieldName(origin)}>Public origin</Label>
            <Input
              id={getEndpointOriginFieldName(origin)}
              name={getEndpointOriginFieldName(origin)}
              type="url"
              placeholder="https://module.example.com"
              defaultValue={origin.publicOrigin ?? ''}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={getEndpointHostPortFieldName(origin)}>Host port</Label>
            <Input
              id={getEndpointHostPortFieldName(origin)}
              name={getEndpointHostPortFieldName(origin)}
              type="number"
              min={1}
              max={65535}
              defaultValue={origin.hostPort}
              required
            />
          </div>
          <p className="break-all text-xs text-muted-foreground">{origin.localOrigin}</p>
        </div>
      ))}
    </div>
  );
}

function ExternalMountCollections({
  collections,
  drafts,
  errors,
  onDraftsChange,
}: {
  collections: InstallPlanMountCollection[];
  drafts: ExternalMountDraft[];
  errors: ExternalMountValidationError[];
  onDraftsChange: (drafts: ExternalMountDraft[]) => void;
}) {
  if (collections.length === 0) {
    return <EmptyLine>No external mounts</EmptyLine>;
  }

  function updateDraft(id: string, patch: Partial<ExternalMountDraft>) {
    onDraftsChange(drafts.map(draft => (draft.id === id ? { ...draft, ...patch } : draft)));
  }

  function removeDraft(id: string) {
    onDraftsChange(drafts.filter(draft => draft.id !== id));
  }

  function addDraft(collection: InstallPlanMountCollection) {
    onDraftsChange([
      ...drafts,
      createExternalMountDraft(collection, drafts.length),
    ]);
  }

  return (
    <div className="space-y-4">
      {collections.map(collection => {
        const collectionDrafts = drafts.filter(
          draft => draft.moduleId === collection.moduleId && draft.collectionKey === collection.key
        );
        const collectionErrors = errors.filter(
          error => error.moduleId === collection.moduleId && error.collectionKey === collection.key
        );

        return (
          <div key={`${collection.moduleId}:${collection.key}`} className="rounded-md border p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{collection.label || collection.key}</span>
                  <Badge variant="outline">{collection.required ? 'required' : 'optional'}</Badge>
                  <Badge variant="outline">{collection.targets.some(target => target.writable) ? 'readWrite' : 'readOnly'}</Badge>
                </div>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {collection.targets.map(target => `${target.container}: ${target.itemContainerPathTemplate}`).join(', ')}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => addDraft(collection)}>
                <Plus className="h-4 w-4" />
                Add mount
              </Button>
            </div>

            {collectionErrors.length > 0 && (
              <div className="mt-3 space-y-1">
                {collectionErrors.map(error => (
                  <p key={`${error.draftId || error.collectionKey}:${error.message}`} className="text-sm text-destructive">
                    {error.message}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-4 space-y-3">
              {collectionDrafts.length === 0 ? (
                <EmptyLine>No selected paths</EmptyLine>
              ) : (
                collectionDrafts.map(draft => (
                  <div key={draft.id} className="grid gap-3 rounded-md bg-muted/40 p-3 lg:grid-cols-[1fr_1fr_1.4fr_120px_auto]">
                    <Input
                      value={draft.key}
                      onChange={event => updateDraft(draft.id, { key: event.target.value })}
                      placeholder="main-media"
                      aria-label="External mount item key"
                    />
                    <Input
                      value={draft.label}
                      onChange={event => updateDraft(draft.id, { label: event.target.value })}
                      placeholder="Label"
                      aria-label="External mount label"
                    />
                    <Input
                      value={draft.hostPath}
                      onChange={event => updateDraft(draft.id, { hostPath: event.target.value })}
                      placeholder="/mnt/media"
                      aria-label="External host path"
                    />
                    <select
                      value={collection.targets.some(target => target.writable) ? draft.access : 'readOnly'}
                      onChange={event => updateDraft(draft.id, {
                        access: event.target.value === 'readOnly' ? 'readOnly' : 'readWrite',
                      })}
                      disabled={!collection.targets.some(target => target.writable)}
                      aria-label="External mount access"
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <option value="readWrite">readWrite</option>
                      <option value="readOnly">readOnly</option>
                    </select>
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeDraft(draft.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <div className="lg:col-span-5">
                      <p className="break-all text-xs text-muted-foreground">
                        {computeExternalMountContainerPath(collection, draft.key) || 'Container path pending valid key'}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function createConfigurationExternalMountDrafts(plan: ModuleConfigurationPlan): ExternalMountDraft[] {
  const collections = new Map(
    plan.storage.mountCollections.map(collection => [
      `${collection.moduleId}:${collection.key}`,
      collection,
    ])
  );
  const drafts = new Map<string, ExternalMountDraft>();

  for (const mount of plan.storage.externalMounts) {
    const collection = collections.get(`${plan.moduleId}:${mount.collectionKey}`);
    if (!collection) {
      continue;
    }

    const id = `${plan.moduleId}:${mount.collectionKey}:${mount.key}:${mount.hostPath}`;
    if (drafts.has(id)) {
      continue;
    }

    drafts.set(id, {
      id,
      moduleId: plan.moduleId,
      collectionKey: mount.collectionKey,
      key: mount.key,
      label: mount.label || '',
      hostPath: mount.hostPath,
      access: collection.targets.some(target => target.writable) ? mount.access : 'readOnly',
    });
  }

  for (const collection of plan.storage.mountCollections) {
    const existingCount = [...drafts.values()].filter(
      draft => draft.collectionKey === collection.key
    ).length;
    const requiredCount = collection.required ? collection.minItems : 0;

    for (let index = existingCount; index < requiredCount; index += 1) {
      const draft = createExternalMountDraft(collection, index);
      drafts.set(draft.id, draft);
    }
  }

  return [...drafts.values()];
}

function PlanErrorPanel({ error }: { error: InstallPlanErrorEnvelope }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <CircleAlert className="h-4 w-4" />
        {error.message}
      </div>
      {[...error.validationErrors, ...error.conflicts].length > 0 && (
        <ul className="grid gap-1">
          {error.validationErrors.map(issue => (
            <li key={`${issue.code}:${issue.path}`}>{issue.message}</li>
          ))}
          {error.conflicts.map(issue => (
            <li key={`${issue.code}:${issue.resourceId}:${issue.path}`}>{issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  icon,
}: {
  title: string;
  icon: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      {icon}
      <h3 className="text-sm font-semibold">{title}</h3>
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{children}</p>;
}
