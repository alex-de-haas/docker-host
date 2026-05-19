'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CircleAlert,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  GatewayExposureOptionModule,
  GatewayExposureOptions,
  GatewayExposureRecord,
  ModuleIdentityMode,
} from '@/types/gateway';
import type { ModuleExposurePolicy } from '@/types/auth';

type GatewayExposureListItem = GatewayExposureRecord & { assignedUserIds?: string[] };

interface GatewayExposureManagementPanelProps {
  onChanged?: () => void;
}

interface ExposureFormState {
  mode: 'create' | 'edit';
  exposureId?: string;
  moduleId: string;
  portKey: string;
  hostnameInput: string;
  exposurePolicy: ModuleExposurePolicy;
  identityMode: ModuleIdentityMode;
  enabled: boolean;
  assignedUserIds: string[];
}

const exposurePolicyLabels: Record<ModuleExposurePolicy, string> = {
  public: 'Public',
  loginRequired: 'Login required',
  assignedUsersOnly: 'Assigned users only',
};

const identityModeLabels: Record<ModuleIdentityMode, string> = {
  none: 'None',
  optional: 'Optional',
  required: 'Required',
};

const selectClassName =
  'border-input h-9 w-full min-w-0 rounded-md border bg-background px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]';

export function GatewayExposureManagementPanel({ onChanged }: GatewayExposureManagementPanelProps) {
  const [exposures, setExposures] = useState<GatewayExposureListItem[]>([]);
  const [options, setOptions] = useState<GatewayExposureOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ExposureFormState | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<GatewayExposureListItem | null>(null);
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);

  const moduleById = useMemo(() => new Map((options?.modules ?? []).map(module => [module.id, module])), [options]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [exposuresResponse, optionsResponse] = await Promise.all([
        fetch('/api/gateway/exposures'),
        fetch('/api/gateway/options'),
      ]);

      if (!exposuresResponse.ok) {
        throw new Error(await getApiErrorMessage(exposuresResponse, 'Failed to load gateway exposures'));
      }

      if (!optionsResponse.ok) {
        throw new Error(await getApiErrorMessage(optionsResponse, 'Failed to load gateway exposure options'));
      }

      const exposuresData: { exposures: GatewayExposureListItem[] } = await exposuresResponse.json();
      const optionsData: { options: GatewayExposureOptions } = await optionsResponse.json();
      setExposures(exposuresData.exposures);
      setOptions(optionsData.options);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown gateway exposure error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreateForm() {
    const firstModule = options?.modules.find(module => getPublicPorts(module).length > 0);
    const firstPort = firstModule ? getPublicPorts(firstModule)[0] : null;
    setForm({
      mode: 'create',
      moduleId: firstModule?.id ?? '',
      portKey: firstPort?.key ?? '',
      hostnameInput: '',
      exposurePolicy: 'loginRequired',
      identityMode: 'required',
      enabled: true,
      assignedUserIds: [],
    });
  }

  function openEditForm(exposure: GatewayExposureListItem) {
    setForm({
      mode: 'edit',
      exposureId: exposure.id,
      moduleId: exposure.moduleId,
      portKey: exposure.portKey,
      hostnameInput: getHostnameInput(exposure.hostname, options?.gatewayBaseDomain ?? null),
      exposurePolicy: exposure.exposurePolicy,
      identityMode: exposure.identityMode,
      enabled: exposure.enabled,
      assignedUserIds: exposure.assignedUserIds ?? [],
    });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !options) {
      return;
    }

    const hostname = buildHostname(form.hostnameInput, options.gatewayBaseDomain);
    if (!form.moduleId || !form.portKey || !hostname) {
      setError('Module, public runtime port, and hostname are required.');
      return;
    }

    if (form.exposurePolicy === 'public' && form.identityMode === 'required') {
      setError('Public exposures can use identity mode "none" or "optional", but not "required".');
      return;
    }

    setPending('save');
    try {
      const endpoint = form.mode === 'edit' && form.exposureId
        ? `/api/gateway/exposures/${encodeURIComponent(form.exposureId)}`
        : '/api/gateway/exposures';
      const response = await fetch(endpoint, {
        method: form.mode === 'edit' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moduleId: form.moduleId,
          hostname,
          portKey: form.portKey,
          exposurePolicy: form.exposurePolicy,
          identityMode: form.identityMode,
          enabled: form.enabled,
        }),
      });

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, 'Failed to save gateway exposure'));
      }

      const data: { exposure: GatewayExposureRecord } = await response.json();
      if (form.exposurePolicy === 'assignedUsersOnly') {
        const assignmentsResponse = await fetch(
          `/api/gateway/exposures/${encodeURIComponent(data.exposure.id)}/assignments`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignedUserIds: form.assignedUserIds }),
          }
        );
        if (!assignmentsResponse.ok) {
          throw new Error(await getApiErrorMessage(assignmentsResponse, 'Failed to save module assignments'));
        }
      }

      setForm(null);
      await load();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown gateway exposure save error');
    } finally {
      setPending(null);
    }
  }

  async function deleteExposure() {
    if (!deleteCandidate) {
      return;
    }

    setPending('delete');
    try {
      const response = await fetch(`/api/gateway/exposures/${encodeURIComponent(deleteCandidate.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, 'Failed to delete gateway exposure'));
      }

      setDeleteCandidate(null);
      await load();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown gateway exposure delete error');
    } finally {
      setPending(null);
    }
  }

  const selectedModule = form ? moduleById.get(form.moduleId) : null;
  const selectedPort = selectedModule?.ports.find(port => port.key === form?.portKey) ?? null;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Gateway exposures</h2>
          <p className="text-sm text-muted-foreground">
            Publish service/API endpoints through Host-owned gateway hostnames.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
          <Button size="sm" onClick={openCreateForm} disabled={!options || options.modules.length === 0}>
            <Plus className="h-4 w-4" />
            New exposure
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card">
        {loading && exposures.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading gateway exposures
          </div>
        ) : exposures.length === 0 ? (
          <div className="grid gap-2 p-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <Globe2 className="h-4 w-4" />
              No service/API exposures configured.
            </div>
            <p>
              Create an exposure when a module needs a dedicated service/API hostname. Module browser UIs remain in
              the Host Apps shell.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[220px]">Hostname</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Policy</TableHead>
                <TableHead>Assignments</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exposures.map(exposure => {
                const exposureModule = moduleById.get(exposure.moduleId);
                const port = exposureModule?.ports.find(candidate => candidate.key === exposure.portKey);
                return (
                  <TableRow key={exposure.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="break-all font-medium">{exposure.hostname}</span>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={exposure.enabled ? 'default' : 'outline'}>
                            {exposure.enabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                          <Badge variant="secondary">Service/API endpoint</Badge>
                          {port?.isUiEntrypoint && (
                            <Badge variant="outline">UI entrypoint port</Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="max-w-[220px] truncate text-sm font-medium">
                          {exposureModule?.name ?? exposure.moduleId}
                        </span>
                        <span className="max-w-[220px] truncate text-xs text-muted-foreground">
                          {exposure.moduleId}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-2 py-1 text-xs">
                        {exposure.portKey}
                        {port ? ` :${port.containerPort}/${port.protocol}` : ''}
                      </code>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline">{exposurePolicyLabels[exposure.exposurePolicy]}</Badge>
                        <Badge variant="outline">{identityModeLabels[exposure.identityMode]}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      {exposure.exposurePolicy === 'assignedUsersOnly' ? (
                        <span className="text-sm">
                          {(exposure.assignedUserIds ?? []).length} user
                          {(exposure.assignedUserIds ?? []).length === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">Not required</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="icon-sm" variant="ghost" title="Edit exposure" onClick={() => openEditForm(exposure)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title="Delete exposure"
                          onClick={() => setDeleteCandidate(exposure)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={Boolean(form)} onOpenChange={open => !open && pending !== 'save' && setForm(null)}>
        {form && options && (
          <DialogContent className="sm:max-w-2xl">
            <form className="grid gap-4" onSubmit={submitForm}>
              <DialogHeader>
                <DialogTitle>{form.mode === 'create' ? 'Create gateway exposure' : 'Edit gateway exposure'}</DialogTitle>
                <DialogDescription>
                  Gateway exposures publish service/API endpoints. They do not create Apps navigation entries.
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="gateway-module">Module</Label>
                  <select
                    id="gateway-module"
                    className={selectClassName}
                    value={form.moduleId}
                    onChange={event => {
                      const nextModule = moduleById.get(event.target.value);
                      const nextPort = nextModule ? getPublicPorts(nextModule)[0] : null;
                      setForm({
                        ...form,
                        moduleId: event.target.value,
                        portKey: nextPort?.key ?? '',
                        assignedUserIds: [],
                      });
                    }}
                  >
                    {options.modules.map(module => (
                      <option key={module.id} value={module.id}>
                        {module.name} ({module.id})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="gateway-port">Public runtime port</Label>
                  <select
                    id="gateway-port"
                    className={selectClassName}
                    value={form.portKey}
                    onChange={event => setForm({ ...form, portKey: event.target.value })}
                  >
                    {selectedModule && getPublicPorts(selectedModule).map(port => (
                      <option key={port.key} value={port.key}>
                        {port.key} :{port.containerPort}/{port.protocol}
                        {port.isUiEntrypoint ? ' - UI entrypoint' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="gateway-hostname">
                  {options.gatewayBaseDomain ? 'Subdomain' : 'Hostname'}
                </Label>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <Input
                    id="gateway-hostname"
                    value={form.hostnameInput}
                    placeholder={options.gatewayBaseDomain ? 'reports-api' : 'reports.example.com'}
                    onChange={event => setForm({ ...form, hostnameInput: event.target.value })}
                  />
                  {options.gatewayBaseDomain && (
                    <code className="min-h-9 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
                      .{options.gatewayBaseDomain}
                    </code>
                  )}
                </div>
                <span className="break-all text-xs text-muted-foreground">
                  Full hostname: {buildHostname(form.hostnameInput, options.gatewayBaseDomain) || 'not set'}
                </span>
              </div>

              {selectedPort?.isUiEntrypoint && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    This port is also the module UI entrypoint. Use gateway exposures for service/API traffic; browser
                    UIs should stay inside the Host Apps shell.
                  </span>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="gateway-policy">Exposure policy</Label>
                  <select
                    id="gateway-policy"
                    className={selectClassName}
                    value={form.exposurePolicy}
                    onChange={event => {
                      const exposurePolicy = event.target.value as ModuleExposurePolicy;
                      setForm({
                        ...form,
                        exposurePolicy,
                        identityMode: getDefaultIdentityMode(exposurePolicy),
                      });
                    }}
                  >
                    {Object.entries(exposurePolicyLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="gateway-identity">Identity mode</Label>
                  <select
                    id="gateway-identity"
                    className={selectClassName}
                    value={form.identityMode}
                    onChange={event => setForm({ ...form, identityMode: event.target.value as ModuleIdentityMode })}
                  >
                    {(Object.keys(identityModeLabels) as ModuleIdentityMode[]).map(value => (
                      <option key={value} value={value} disabled={form.exposurePolicy === 'public' && value === 'required'}>
                        {identityModeLabels[value]}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center gap-2 self-end rounded-md border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={event => setForm({ ...form, enabled: event.target.checked })}
                    className="h-4 w-4 rounded border-input"
                  />
                  Enabled
                </label>
              </div>

              {form.exposurePolicy === 'assignedUsersOnly' && (
                <div className="grid gap-2 rounded-lg border p-3">
                  <div>
                    <Label>Module access assignments</Label>
                    <p className="text-xs text-muted-foreground">
                      Assignments are shared by assigned-only exposures and shell Apps for this module.
                    </p>
                  </div>
                  {options.users.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active Host users are available.</p>
                  ) : (
                    <div className="grid max-h-44 gap-2 overflow-auto pr-1 sm:grid-cols-2">
                      {options.users.map(user => {
                        const checked = form.assignedUserIds.includes(user.id);
                        return (
                          <label key={user.id} className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={event => setForm({
                                ...form,
                                assignedUserIds: event.target.checked
                                  ? [...form.assignedUserIds, user.id].sort()
                                  : form.assignedUserIds.filter(userId => userId !== user.id),
                              })}
                              className="mt-0.5 h-4 w-4 rounded border-input"
                            />
                            <span className="grid min-w-0">
                              <span className="truncate font-medium">
                                {user.displayName ?? user.email ?? user.id}
                              </span>
                              <span className="truncate text-xs text-muted-foreground">
                                {[user.email, user.role].filter(Boolean).join(' · ')}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setForm(null)} disabled={pending === 'save'}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending === 'save'}>
                  {pending === 'save' && <LoaderCircle className="h-4 w-4 animate-spin" />}
                  Save exposure
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={Boolean(deleteCandidate)} onOpenChange={open => !open && pending !== 'delete' && setDeleteCandidate(null)}>
        {deleteCandidate && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete gateway exposure</DialogTitle>
              <DialogDescription>
                This removes the service/API hostname and clears linked external ingress readiness state.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md bg-muted p-3 text-sm">
              <span className="break-all font-medium">{deleteCandidate.hostname}</span>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDeleteCandidate(null)} disabled={pending === 'delete'}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={() => void deleteExposure()} disabled={pending === 'delete'}>
                {pending === 'delete' && <LoaderCircle className="h-4 w-4 animate-spin" />}
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

function getPublicPorts(module: GatewayExposureOptionModule) {
  return module.ports.filter(port => port.public);
}

function getDefaultIdentityMode(exposurePolicy: ModuleExposurePolicy): ModuleIdentityMode {
  return exposurePolicy === 'public' ? 'none' : 'required';
}

function getHostnameInput(hostname: string, gatewayBaseDomain: string | null) {
  if (!gatewayBaseDomain) {
    return hostname;
  }

  const suffix = `.${gatewayBaseDomain}`;
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : hostname;
}

function buildHostname(hostnameInput: string, gatewayBaseDomain: string | null) {
  const normalized = hostnameInput.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!normalized) {
    return '';
  }

  return gatewayBaseDomain ? `${normalized}.${gatewayBaseDomain}` : normalized;
}

async function getApiErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    const details =
      typeof data?.error?.message === 'string'
        ? data.error.message
        : typeof data?.details === 'string'
          ? data.details
          : typeof data?.error === 'string'
            ? data.error
            : null;

    return details ? `${fallback}: ${details}` : fallback;
  } catch {
    return fallback;
  }
}
