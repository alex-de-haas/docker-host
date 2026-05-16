'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Database,
  ExternalLink,
  Folder,
  GitBranch,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Network,
  Plus,
  Server,
  Settings2,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  buildModuleInstallRequest,
  computeExternalMountContainerPath,
  createExternalMountDraft,
  createExternalMountDrafts,
  getSettingFieldName,
  redactModuleInstallRequest,
  validateExternalMountDrafts,
} from '@/lib/module-install-request';
import type {
  ExternalMountDraft,
  ExternalMountValidationError,
} from '@/lib/module-install-request';
import type {
  InstallPlan,
  InstallPlanErrorEnvelope,
  InstallPlanMountCollection,
  InstallPlanResponse,
  InstallPlanSettingPrompt,
  ModuleInstallResponse,
  ModuleInstallRequest,
  ModuleInstallSuccessResponse,
} from '@/types/modules';

export default function InstallModulePage() {
  const [metadataUrl, setMetadataUrl] = useState('');
  const [isPlanning, setIsPlanning] = useState(false);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [planError, setPlanError] = useState<InstallPlanErrorEnvelope | null>(null);
  const [externalMountDrafts, setExternalMountDrafts] = useState<ExternalMountDraft[]>([]);
  const [externalMountErrors, setExternalMountErrors] = useState<ExternalMountValidationError[]>([]);
  const [preparedRequest, setPreparedRequest] = useState<ModuleInstallRequest | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<ModuleInstallSuccessResponse | null>(null);
  const [installError, setInstallError] = useState<InstallPlanErrorEnvelope | null>(null);

  async function handlePlanSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsPlanning(true);
    setPlan(null);
    setPlanError(null);
    setPreparedRequest(null);
    setInstallResult(null);
    setInstallError(null);
    setExternalMountErrors([]);

    try {
      const response = await fetch('/api/modules/install/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadataUrl }),
      });
      const data = await response.json() as InstallPlanResponse;

      setPlan(data.plan ?? null);
      setPlanError(data.error ?? null);
      setExternalMountDrafts(data.plan ? createExternalMountDrafts(data.plan) : []);
    } catch (error) {
      setPlanError({
        code: 'install_plan_request_failed',
        message: error instanceof Error ? error.message : 'Unable to request install plan.',
        validationErrors: [],
        conflicts: [],
      });
    } finally {
      setIsPlanning(false);
    }
  }

  function handleUseFixture() {
    const origin = window.location.origin;
    setMetadataUrl(`${origin}/fixtures/modules/sample-reports`);
  }

  function handlePrepareRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan || plan.conflicts.length > 0) {
      return;
    }

    setInstallResult(null);
    setInstallError(null);
    const externalMountValidation = validateExternalMountDrafts(plan, externalMountDrafts);
    setExternalMountErrors(externalMountValidation.errors);

    if (externalMountValidation.errors.length > 0) {
      return;
    }

    const payload = buildModuleInstallRequest(
      plan,
      new FormData(event.currentTarget),
      externalMountValidation.selections
    );
    setPreparedRequest(payload);
  }

  async function handleInstallPrepared() {
    if (!preparedRequest) {
      return;
    }

    setIsInstalling(true);
    setInstallResult(null);
    setInstallError(null);

    try {
      const response = await fetch('/api/modules/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preparedRequest),
      });
      const data = await response.json() as ModuleInstallResponse;

      if ('error' in data && data.error) {
        setInstallError(data.error);
        return;
      }

      setInstallResult(data);
    } catch (error) {
      setInstallError({
        code: 'install_apply_request_failed',
        message: error instanceof Error ? error.message : 'Unable to install module.',
        validationErrors: [],
        conflicts: [],
      });
    } finally {
      setIsInstalling(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon">
              <Link href="/" aria-label="Back to dashboard">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <div>
              <h1 className="text-xl font-semibold">Install module</h1>
              <p className="text-sm text-muted-foreground">Review metadata plan</p>
            </div>
          </div>
          {plan && (
            <Badge variant={plan.conflicts.length > 0 ? 'destructive' : 'outline'}>
              {plan.conflicts.length > 0 ? 'Blocked' : 'Ready'}
            </Badge>
          )}
        </div>
      </header>

      <main className="container space-y-6 px-4 py-8">
        <section className="rounded-lg border bg-card p-5">
          <form onSubmit={handlePlanSubmit} className="grid gap-4 lg:grid-cols-[1fr_auto_auto] lg:items-end">
            <div className="space-y-2">
              <Label htmlFor="metadata-url">Metadata URL</Label>
              <Input
                id="metadata-url"
                type="url"
                value={metadataUrl}
                onChange={event => setMetadataUrl(event.target.value)}
                placeholder="https://modules.example.com/reports.json"
                required
              />
            </div>
            <Button type="button" variant="outline" onClick={handleUseFixture}>
              <Database className="h-4 w-4" />
              Local fixture
            </Button>
            <Button type="submit" disabled={isPlanning}>
              {isPlanning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
              Create plan
            </Button>
          </form>
        </section>

        {planError && <PlanErrorPanel error={planError} />}
        {installError && <PlanErrorPanel error={installError} />}
        {installResult && <InstallSuccessPanel result={installResult} />}

        {plan && (
          <form key={plan.planDigest} onSubmit={handlePrepareRequest} className="space-y-6">
            <PlanReview
              plan={plan}
              externalMountDrafts={externalMountDrafts}
              externalMountErrors={externalMountErrors}
              onExternalMountDraftsChange={setExternalMountDrafts}
            />

            <section className="rounded-lg border bg-card p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold">Install request</h2>
                  <p className="text-sm text-muted-foreground">
                    {plan.conflicts.length > 0
                      ? 'Resolve plan conflicts before confirmation.'
                      : 'Payload preview is redacted for write-only settings.'}
                  </p>
                </div>
                <Button type="submit" disabled={plan.conflicts.length > 0}>
                  Prepare request
                </Button>
              </div>

              {preparedRequest && (
                <div className="mt-4 space-y-4">
                  <pre className="max-h-80 overflow-auto rounded-md bg-muted p-4 text-xs">
                    {JSON.stringify(redactModuleInstallRequest(preparedRequest), null, 2)}
                  </pre>
                  <div className="flex justify-end">
                    <Button type="button" onClick={handleInstallPrepared} disabled={isInstalling}>
                      {isInstalling ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      Install module
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </form>
        )}
      </main>
    </div>
  );
}

function InstallSuccessPanel({ result }: { result: ModuleInstallSuccessResponse }) {
  return (
    <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-5 text-emerald-950 dark:text-emerald-200">
      <div className="mb-3 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4" />
        <h2 className="text-base font-semibold">Module installed</h2>
      </div>
      <DefinitionGrid>
        <Definition label="Module" value={result.module.name} />
        <Definition label="Module ID" value={result.module.id} />
        <Definition label="Installed" value={result.installedModuleIds.join(', ') || '-'} />
        <Definition label="Reused" value={result.reusedModuleIds.join(', ') || '-'} />
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
  plan: InstallPlan;
  externalMountDrafts: ExternalMountDraft[];
  externalMountErrors: ExternalMountValidationError[];
  onExternalMountDraftsChange: (drafts: ExternalMountDraft[]) => void;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <ReviewSection title="Module" icon={<Server className="h-4 w-4" />}>
          <DefinitionGrid>
            <Definition label="Name" value={plan.module.name} />
            <Definition label="Module ID" value={plan.module.id} />
            <Definition label="Version" value={plan.module.version} />
            <Definition label="Metadata URL" value={plan.metadataUrl} />
            <Definition label="Metadata digest" value={plan.metadataDigest} />
            <Definition label="Plan digest" value={plan.planDigest} />
          </DefinitionGrid>
        </ReviewSection>

        <ReviewSection title="Images" icon={<Database className="h-4 w-4" />}>
          <TableLike
            columns={['Module', 'Image', 'Pull policy']}
            rows={plan.images.map(image => [
              image.moduleId,
              image.reference,
              image.pullPolicy,
            ])}
          />
        </ReviewSection>

        <ReviewSection title="Dependencies" icon={<GitBranch className="h-4 w-4" />}>
          <div className="space-y-4">
            <DefinitionGrid>
              <Definition label="Install order" value={plan.installOrder.join(' -> ')} />
            </DefinitionGrid>
            {plan.dependencies.length === 0 ? (
              <EmptyLine>No dependencies</EmptyLine>
            ) : (
              <div className="space-y-3">
                {plan.dependencies.map(dependency => (
                  <div key={dependency.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{dependency.name}</span>
                      <Badge variant="outline">{dependency.installAction}</Badge>
                      <code className="text-xs text-muted-foreground">{dependency.id}</code>
                    </div>
                    {dependency.connections.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {dependency.connections.map(connection => (
                          <DefinitionGrid key={`${connection.consumerId}:${connection.endpoint}`}>
                            <Definition label="Consumer" value={connection.consumerId} />
                            <Definition label="Endpoint" value={connection.endpoint} />
                            <Definition label="Environment" value={connection.baseUrlEnv} />
                            <Definition label="Resolved URL" value={connection.resolvedBaseUrl} />
                          </DefinitionGrid>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </ReviewSection>

        <ReviewSection title="Settings" icon={<Settings2 className="h-4 w-4" />}>
          <SettingsInputs settings={plan.settings} />
        </ReviewSection>

        <ReviewSection title="Storage" icon={<Folder className="h-4 w-4" />}>
          <div className="space-y-5">
            <div>
              <h3 className="mb-2 text-sm font-medium">Module-owned mappings</h3>
              <TableLike
                columns={['Module', 'Key', 'Host path', 'Container path']}
                rows={plan.storage.directories.map(directory => [
                  directory.moduleId,
                  directory.key,
                  directory.hostPath,
                  directory.containerPath,
                ])}
                empty="No module-owned storage"
              />
            </div>
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
        <ReviewSection title="Runtime" icon={<HardDrive className="h-4 w-4" />}>
          <div className="space-y-4">
            <TableLike
              columns={['Key', 'Port', 'Protocol', 'Public']}
              rows={plan.runtime.ports.map(port => [
                port.key,
                String(port.containerPort),
                port.protocol,
                port.public ? 'yes' : 'no',
              ])}
              empty="No runtime ports"
            />
            {plan.runtime.resources && (
              <DefinitionGrid>
                {plan.runtime.resources.cpus !== undefined && (
                  <Definition label="CPUs" value={String(plan.runtime.resources.cpus)} />
                )}
                {plan.runtime.resources.memory && (
                  <Definition label="Memory" value={plan.runtime.resources.memory} />
                )}
              </DefinitionGrid>
            )}
          </div>
        </ReviewSection>

        <ReviewSection title="Docker" icon={<Network className="h-4 w-4" />}>
          <DefinitionGrid>
            <Definition label="Network" value={plan.docker.networkName} />
            <Definition label="Container" value={plan.docker.containerName} />
            <Definition label="Aliases" value={plan.docker.networkAliases.join(', ')} />
            <Definition label="Module path" value={plan.paths.moduleDirectoryHost} />
          </DefinitionGrid>
        </ReviewSection>

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
    return <EmptyLine>No settings required</EmptyLine>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {settings.map(setting => (
        <div key={`${setting.moduleId}:${setting.key}`} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={getSettingFieldName(setting)}>{setting.key}</Label>
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
            {setting.target.name}
          </p>
        </div>
      ))}
    </div>
  );
}

function SettingInput({ setting }: { setting: InstallPlanSettingPrompt }) {
  const id = getSettingFieldName(setting);
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
    return (
      <div>
        <h3 className="mb-2 text-sm font-medium">External mounts</h3>
        <EmptyLine>No external mounts</EmptyLine>
      </div>
    );
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
      <h3 className="text-sm font-medium">External mounts</h3>
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
                  <Badge variant="outline">{collection.writable ? 'readWrite' : 'readOnly'}</Badge>
                </div>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {collection.moduleId}
                  {' -> '}
                  {collection.itemContainerPathTemplate}
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
                      value={collection.writable ? draft.access : 'readOnly'}
                      onChange={event => updateDraft(draft.id, {
                        access: event.target.value === 'readOnly' ? 'readOnly' : 'readWrite',
                      })}
                      disabled={!collection.writable}
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
}: {
  issues: Array<{ id: string; title: string; message: string; detail?: string }>;
}) {
  if (issues.length === 0) {
    return <EmptyLine>No issue details</EmptyLine>;
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
