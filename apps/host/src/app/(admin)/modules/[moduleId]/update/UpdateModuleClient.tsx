'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Database,
  Folder,
  GitBranch,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import { AdminShell, HostPageHeader } from '@/components/AdminShell';
import {
  buildModuleUpdateRequest,
  getUpdateSettingFieldName,
  redactModuleUpdateRequest,
} from '@/lib/module-update-request';
import {
  computeExternalMountContainerPath,
  createExternalMountDraft,
  createExternalMountDrafts,
  validateExternalMountDrafts,
} from '@/lib/module-install-request';
import { notifyHostAppsChanged } from '@/hooks/useHostApps';
import type {
  ExternalMountDraft,
  ExternalMountValidationError,
} from '@/lib/module-install-request';
import type {
  InstallPlanErrorEnvelope,
  InstallPlanMountCollection,
  InstallPlanSettingPrompt,
  ModuleUpdatePlan,
  ModuleUpdatePlanResponse,
  ModuleUpdateRequest,
  ModuleUpdateResponse,
  ModuleUpdateSuccessResponse,
} from '@/types/modules';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function UpdateModuleClient({ moduleId }: { moduleId: string }) {
  const [isPlanning, setIsPlanning] = useState(true);
  const [plan, setPlan] = useState<ModuleUpdatePlan | null>(null);
  const [planError, setPlanError] = useState<InstallPlanErrorEnvelope | null>(null);
  const [externalMountDrafts, setExternalMountDrafts] = useState<ExternalMountDraft[]>([]);
  const [externalMountErrors, setExternalMountErrors] = useState<ExternalMountValidationError[]>([]);
  const [previewRequest, setPreviewRequest] = useState<ModuleUpdateRequest | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<ModuleUpdateSuccessResponse | null>(null);
  const [updateError, setUpdateError] = useState<InstallPlanErrorEnvelope | null>(null);

  const loadPlan = useCallback(async () => {
    setIsPlanning(true);
    setPlan(null);
    setPlanError(null);
    setPreviewRequest(null);
    setUpdateResult(null);
    setUpdateError(null);
    setExternalMountErrors([]);

    try {
      const response = await fetch(`/api/modules/${encodeURIComponent(moduleId)}/update/plan`, {
        method: 'POST',
      });
      const data = await response.json() as ModuleUpdatePlanResponse;

      setPlan(data.plan ?? null);
      setPlanError(data.error ?? null);
      setExternalMountDrafts(data.plan ? createExternalMountDrafts(data.plan) : []);
    } catch (error) {
      setPlanError({
        code: 'update_plan_request_failed',
        message: error instanceof Error ? error.message : 'Unable to request update plan.',
        validationErrors: [],
        conflicts: [],
      });
    } finally {
      setIsPlanning(false);
    }
  }, [moduleId]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  function buildRequestFromForm(form: HTMLFormElement) {
    if (!plan || plan.conflicts.length > 0) {
      return null;
    }

    setUpdateResult(null);
    setUpdateError(null);
    const externalMountValidation = validateExternalMountDrafts(plan, externalMountDrafts);
    setExternalMountErrors(externalMountValidation.errors);

    if (externalMountValidation.errors.length > 0) {
      return null;
    }

    return buildModuleUpdateRequest(
      plan,
      new FormData(form),
      externalMountValidation.selections
    );
  }

  function handlePreviewRequest(form: HTMLFormElement) {
    setUpdateError(null);
    setPreviewRequest(buildRequestFromForm(form));
  }

  async function handleUpdateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan) {
      return;
    }

    const request = buildRequestFromForm(event.currentTarget);
    if (!request) {
      return;
    }

    setIsUpdating(true);
    setPreviewRequest(null);
    setUpdateResult(null);
    setUpdateError(null);

    try {
      const response = await fetch(`/api/modules/${encodeURIComponent(plan.moduleId)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await response.json() as ModuleUpdateResponse;

      if ('error' in data && data.error) {
        setUpdateError(data.error);
        return;
      }

      setUpdateResult(data);
      notifyHostAppsChanged();
    } catch (error) {
      setUpdateError({
        code: 'update_apply_request_failed',
        message: error instanceof Error ? error.message : 'Unable to update module.',
        validationErrors: [],
        conflicts: [],
      });
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <AdminShell contentClassName="space-y-6">
        <HostPageHeader
          title="Update module"
          description={moduleId}
          actions={(
            <div className="flex items-center gap-2">
              {plan && (
                <Badge variant={plan.conflicts.length > 0 ? 'destructive' : 'outline'}>
                  {plan.conflicts.length > 0 ? 'Blocked' : 'Ready'}
                </Badge>
              )}
              <Button variant="outline" size="icon" onClick={() => void loadPlan()} disabled={isPlanning}>
                {isPlanning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
          )}
        />

        {isPlanning && (
          <section className="rounded-lg border bg-card p-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Refreshing module metadata
            </div>
          </section>
        )}

        {planError && <PlanErrorPanel error={planError} />}
        {updateError && <PlanErrorPanel error={updateError} />}
        {updateResult && <UpdateSuccessPanel result={updateResult} />}

        {plan && (
          <form key={plan.updatePlanDigest} onSubmit={handleUpdateSubmit} className="space-y-6">
            <PlanReview
              plan={plan}
              externalMountDrafts={externalMountDrafts}
              externalMountErrors={externalMountErrors}
              onExternalMountDraftsChange={setExternalMountDrafts}
            />

            <section className="rounded-lg border bg-card p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold">Update request</h2>
                  <p className="text-sm text-muted-foreground">
                    {plan.conflicts.length > 0
                      ? 'Resolve plan conflicts before confirmation.'
                      : 'Apply now or inspect the redacted request first.'}
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={plan.conflicts.length > 0 || isUpdating}
                    onClick={event => handlePreviewRequest(event.currentTarget.form as HTMLFormElement)}
                  >
                    <RefreshCw className="h-4 w-4" />
                    Preview request
                  </Button>
                  <Button type="submit" disabled={plan.conflicts.length > 0 || isUpdating}>
                    {isUpdating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Apply update
                  </Button>
                </div>
              </div>

              {previewRequest && (
                <div className="mt-4 space-y-4">
                  <pre className="max-h-80 overflow-auto rounded-md bg-muted p-4 text-xs">
                    {JSON.stringify(redactModuleUpdateRequest(previewRequest), null, 2)}
                  </pre>
                </div>
              )}
            </section>
          </form>
        )}
    </AdminShell>
  );
}

function UpdateSuccessPanel({ result }: { result: ModuleUpdateSuccessResponse }) {
  return (
    <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-5 text-emerald-950 dark:text-emerald-200">
      <div className="mb-3 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4" />
        <h2 className="text-base font-semibold">Module updated</h2>
      </div>
      <DefinitionGrid>
        <Definition label="Module" value={result.module.name} />
        <Definition label="Module ID" value={result.updatedModuleId} />
        <Definition label="Installed dependencies" value={result.installedDependencyIds.join(', ') || '-'} />
        <Definition label="Reused dependencies" value={result.reusedDependencyIds.join(', ') || '-'} />
      </DefinitionGrid>
    </section>
  );
}

function PlanReview({
  plan,
  externalMountDrafts,
  externalMountErrors,
  onExternalMountDraftsChange,
}: {
  plan: ModuleUpdatePlan;
  externalMountDrafts: ExternalMountDraft[];
  externalMountErrors: ExternalMountValidationError[];
  onExternalMountDraftsChange: (drafts: ExternalMountDraft[]) => void;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <ReviewSection title="Module" icon={<Database className="h-4 w-4" />}>
          <DefinitionGrid>
            <Definition label="Name" value={`${plan.module.currentName} -> ${plan.module.proposedName}`} />
            <Definition label="Module ID" value={plan.module.id} />
            <Definition label="Version" value={`${plan.module.currentVersion} -> ${plan.module.proposedVersion}`} />
            <Definition label="Metadata URL" value={plan.metadataUrl} />
            <Definition label="Current digest" value={plan.currentMetadataDigest || '-'} />
            <Definition label="Refreshed digest" value={plan.refreshedMetadataDigest} />
            <Definition label="Update digest" value={plan.updatePlanDigest} />
          </DefinitionGrid>
        </ReviewSection>

        <ReviewSection title="Changes" icon={<RefreshCw className="h-4 w-4" />}>
          <IssueList
            empty="No runtime changes detected"
            issues={plan.changes.map((change, index) => ({
              id: `${change.category}:${change.action}:${index}`,
              title: `${change.category} / ${change.action}`,
              message: change.title,
              detail: change.path,
            }))}
          />
        </ReviewSection>

        <ReviewSection title="Dependencies" icon={<GitBranch className="h-4 w-4" />}>
          <div className="space-y-4">
            <DefinitionGrid>
              <Definition label="Apply order" value={plan.installOrder.join(' -> ')} />
            </DefinitionGrid>
            {plan.dependencies.length === 0 ? (
              <EmptyLine>No dependencies</EmptyLine>
            ) : (
              <TableLike
                columns={['Module', 'Action', 'Metadata URL']}
                rows={plan.dependencies.map(dependency => [
                  dependency.id,
                  dependency.installAction,
                  dependency.metadataUrl,
                ])}
              />
            )}
          </div>
        </ReviewSection>

        <ReviewSection title="Settings" icon={<Settings2 className="h-4 w-4" />}>
          <div className="space-y-4">
            {plan.preservedSettings.length > 0 && (
              <TableLike
                columns={['Module', 'Key', 'Target']}
                rows={plan.preservedSettings.map(setting => [
                  setting.moduleId,
                  setting.key,
                  `${setting.targets.map(target => `${target.container}:${target.name}`).join(', ')}${setting.secret ? ' (secret)' : ''}`,
                ])}
              />
            )}
            <SettingsInputs settings={plan.settings} />
          </div>
        </ReviewSection>

        <ReviewSection title="Storage" icon={<Folder className="h-4 w-4" />}>
          <div className="space-y-5">
            <TableLike
              columns={['Module', 'Key', 'Service', 'Host path', 'Container path']}
              rows={plan.storage.directories.map(directory => [
                directory.moduleId,
                directory.key,
                directory.container,
                directory.hostPath,
                directory.containerPath,
              ])}
              empty="No module-owned storage"
            />
            {plan.storage.preservedExternalMounts.length > 0 && (
              <TableLike
                columns={['Collection', 'Key', 'Host path', 'Access']}
                rows={plan.storage.preservedExternalMounts.map(mount => [
                  mount.collectionKey,
                  mount.key,
                  mount.hostPath,
                  mount.access,
                ])}
              />
            )}
            <ExternalMountCollections
              collections={plan.storage.mountCollections}
              drafts={externalMountDrafts}
              errors={externalMountErrors}
              onDraftsChange={onExternalMountDraftsChange}
            />
          </div>
        </ReviewSection>
      </div>

      <aside className="space-y-6">
        <ReviewSection title="Images" icon={<Database className="h-4 w-4" />}>
          <TableLike
            columns={['Module', 'Service', 'Image', 'Pull policy']}
            rows={plan.images.map(image => [
              image.moduleId,
              image.container,
              image.reference,
              image.pullPolicy,
            ])}
          />
        </ReviewSection>

        <ReviewSection title="Runtime" icon={<HardDrive className="h-4 w-4" />}>
          <TableLike
            columns={['Endpoint', 'Service', 'Port', 'Public']}
            rows={plan.runtime.endpoints.map(endpoint => [
              endpoint.key,
              endpoint.container,
              endpoint.port,
              endpoint.public ? 'yes' : 'no',
            ])}
            empty="No runtime ports"
          />
        </ReviewSection>

        <ReviewSection title="Docker" icon={<Network className="h-4 w-4" />}>
          <DefinitionGrid>
            <Definition label="Network" value={plan.docker.networkName} />
            <Definition label="Containers" value={plan.docker.containers.map(container => `${container.key}: ${container.containerName}`).join(', ')} />
            <Definition label="Aliases" value={plan.docker.containers.map(container => `${container.key}: ${container.networkAlias}`).join(', ')} />
            <Definition label="Replacement" value={plan.docker.replacementRequired ? plan.docker.replacementReasons.join(', ') : 'not required'} />
          </DefinitionGrid>
        </ReviewSection>

        {plan.warnings.length > 0 && (
          <ReviewSection title="Warnings" icon={<CircleAlert className="h-4 w-4" />}>
            <IssueList
              issues={plan.warnings.map((warning, index) => ({
                id: `warning:${index}`,
                title: 'warning',
                message: warning,
              }))}
            />
          </ReviewSection>
        )}

        {plan.conflicts.length > 0 && (
          <ReviewSection title="Conflicts" icon={<CircleAlert className="h-4 w-4" />}>
            <IssueList
              issues={plan.conflicts.map(conflict => ({
                id: `${conflict.code}:${conflict.resourceId}:${conflict.path}`,
                title: conflict.code,
                message: conflict.message,
                detail: conflict.node || conflict.path,
              }))}
            />
          </ReviewSection>
        )}
      </aside>
    </div>
  );
}

function SettingsInputs({ settings }: { settings: InstallPlanSettingPrompt[] }) {
  if (settings.length === 0) {
    return <EmptyLine>No new setting values required</EmptyLine>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {settings.map(setting => (
        <div key={`${setting.moduleId}:${setting.key}`} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={getUpdateSettingFieldName(setting)}>{setting.key}</Label>
            <div className="flex gap-1">
              <Badge variant="outline">{setting.type}</Badge>
              {setting.secret && (
                <Badge variant="secondary">
                  <KeyRound className="h-3 w-3" />
                  write-only
                </Badge>
              )}
            </div>
          </div>
          <SettingInput setting={setting} />
          <p className="break-all text-xs text-muted-foreground">
            {setting.moduleId}
            {' -> '}
            {setting.targets.map(target => `${target.container}:${target.name}`).join(', ') || 'no runtime targets'}
          </p>
        </div>
      ))}
    </div>
  );
}

function SettingInput({ setting }: { setting: InstallPlanSettingPrompt }) {
  const id = getUpdateSettingFieldName(setting);
  const defaultValue = setting.default === undefined ? '' : String(setting.default);

  if (setting.type === 'boolean') {
    return (
      <select
        id={id}
        name={id}
        defaultValue={defaultValue || 'false'}
        required={setting.required}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
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
      required={setting.required}
      autoComplete={setting.secret ? 'new-password' : undefined}
    />
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
    return <EmptyLine>No new external mounts required</EmptyLine>;
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
                  {collection.moduleId}
                  {' -> '}
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

function PlanErrorPanel({ error }: { error: InstallPlanErrorEnvelope }) {
  return (
    <section className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 text-destructive">
      <div className="mb-3 flex items-center gap-2">
        <CircleAlert className="h-4 w-4" />
        <h2 className="text-base font-semibold">{error.message}</h2>
      </div>
      <IssueList
        issues={[
          ...error.validationErrors.map(issue => ({
            id: `${issue.code}:${issue.path}:${issue.node || ''}`,
            title: issue.code,
            message: issue.message,
            detail: issue.node || issue.path,
          })),
          ...error.conflicts.map(issue => ({
            id: `${issue.code}:${issue.resourceId}:${issue.path}`,
            title: issue.code,
            message: issue.message,
            detail: issue.node || issue.path,
          })),
        ]}
      />
    </section>
  );
}

function IssueList({
  issues,
  empty = 'No issue details',
}: {
  issues: Array<{ id: string; title: string; message: string; detail?: string }>;
  empty?: string;
}) {
  if (issues.length === 0) {
    return <EmptyLine>{empty}</EmptyLine>;
  }

  return (
    <div className="space-y-2">
      {issues.map(issue => (
        <div key={issue.id} className="rounded-md border bg-background/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{issue.title}</Badge>
            {issue.detail && <code className="text-xs text-muted-foreground">{issue.detail}</code>}
          </div>
          <p className="mt-2 text-sm">{issue.message}</p>
        </div>
      ))}
    </div>
  );
}

function ReviewSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        {icon}
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function DefinitionGrid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-3 sm:grid-cols-2">{children}</dl>;
}

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-sm text-foreground">{value || '-'}</dd>
    </div>
  );
}

function TableLike({
  columns,
  rows,
  empty = 'No rows',
}: {
  columns: string[];
  rows: string[][];
  empty?: string;
}) {
  if (rows.length === 0) {
    return <EmptyLine>{empty}</EmptyLine>;
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <div
        className="grid border-b bg-muted/60 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
      >
        {columns.map(column => (
          <div key={column} className="px-3 py-2">{column}</div>
        ))}
      </div>
      {rows.map((row, rowIndex) => (
        <div
          key={`${row.join(':')}:${rowIndex}`}
          className="grid border-b last:border-b-0"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
        >
          {row.map((cell, cellIndex) => (
            <div key={`${cell}:${cellIndex}`} className="min-w-0 break-all px-3 py-2 text-sm">
              {cell || '-'}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{children}</p>;
}
