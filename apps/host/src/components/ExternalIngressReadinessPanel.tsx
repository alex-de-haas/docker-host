'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ExternalIngressStatus, ExternalIngressStatusItem } from '@/types/ingress';

const statusLabels: Record<ExternalIngressStatus, string> = {
  unmanaged: 'Unmanaged',
  planned: 'Planned',
  manualReady: 'Manual ready',
  validated: 'Validated',
  drifted: 'Drifted',
  failed: 'Failed',
  unknown: 'Unknown',
};

const statusVariants: Record<ExternalIngressStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  unmanaged: 'outline',
  planned: 'secondary',
  manualReady: 'secondary',
  validated: 'default',
  drifted: 'destructive',
  failed: 'destructive',
  unknown: 'outline',
};

const completeChecklist = {
  dnsConfigured: true,
  reverseProxyConfigured: true,
  tlsConfigured: true,
  websocketForwarding: true,
  authProviderConfigured: true,
  directOriginProtected: true,
};

export function ExternalIngressReadinessPanel({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [items, setItems] = useState<ExternalIngressStatusItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingExposureId, setPendingExposureId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/ingress/exposures');
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, 'Failed to load external ingress readiness'));
      }

      const data: { exposures: ExternalIngressStatusItem[] } = await response.json();
      setItems(data.exposures);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown external ingress error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  async function saveIntent(item: ExternalIngressStatusItem, markReady = false) {
    setPendingExposureId(item.exposure.id);
    try {
      const response = await fetch('/api/ingress/exposures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gatewayExposureId: item.exposure.id,
          checklist: markReady ? completeChecklist : item.record?.checklist,
          markReady,
        }),
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, 'Failed to update external ingress readiness'));
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown external ingress error');
    } finally {
      setPendingExposureId(null);
    }
  }

  async function refresh(item: ExternalIngressStatusItem) {
    setPendingExposureId(item.exposure.id);
    try {
      const response = await fetch(`/api/ingress/exposures/${encodeURIComponent(item.exposure.id)}/refresh`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, 'Failed to refresh external ingress readiness'));
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown external ingress error');
    } finally {
      setPendingExposureId(null);
    }
  }

  async function unlink(item: ExternalIngressStatusItem) {
    setPendingExposureId(item.exposure.id);
    try {
      const response = await fetch(`/api/ingress/exposures/${encodeURIComponent(item.exposure.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, 'Failed to unlink external ingress readiness'));
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown external ingress error');
    } finally {
      setPendingExposureId(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">External ingress readiness</h2>
          <p className="text-sm text-muted-foreground">
            Manual publish state for gateway exposure hostnames.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card">
        {loading && items.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading ingress readiness
          </div>
        ) : items.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No gateway exposures configured.
          </div>
        ) : (
          <ul className="divide-y">
            {items.map(item => (
              <IngressReadinessItem
                key={item.exposure.id}
                item={item}
                pending={pendingExposureId === item.exposure.id}
                onPlan={() => void saveIntent(item)}
                onMarkReady={() => void saveIntent(item, true)}
                onRefresh={() => void refresh(item)}
                onUnlink={() => void unlink(item)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function IngressReadinessItem({
  item,
  pending,
  onPlan,
  onMarkReady,
  onRefresh,
  onUnlink,
}: {
  item: ExternalIngressStatusItem;
  pending: boolean;
  onPlan: () => void;
  onMarkReady: () => void;
  onRefresh: () => void;
  onUnlink: () => void;
}) {
  return (
    <li className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all text-sm font-medium">{item.exposure.hostname}</span>
          <Badge variant={statusVariants[item.status]}>{statusLabels[item.status]}</Badge>
          <Badge variant="outline">{item.exposure.exposurePolicy}</Badge>
          <Badge variant="outline">{item.exposure.identityMode}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{item.nextStep}</p>
        {item.validation && (
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            {item.validation.checks.slice(0, 4).map(check => (
              <div key={check.code} className="flex min-w-0 items-start gap-2">
                {check.status === 'pass'
                  ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />}
                <span className="break-words">{check.label}: {check.message}</span>
              </div>
            ))}
          </div>
        )}
        <details className="rounded-md border bg-muted/30 p-3">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <ClipboardList className="h-4 w-4" />
            Setup instructions
          </summary>
          <div className="mt-3 grid gap-3 text-sm">
            {item.instructions.map(instruction => (
              <div key={instruction.title} className="grid gap-1">
                <span className="font-medium">{instruction.title}</span>
                <span className="text-muted-foreground">{instruction.body}</span>
                {instruction.value && (
                  <code className="w-fit max-w-full break-all rounded bg-background px-2 py-1 text-xs">
                    {instruction.value}
                  </code>
                )}
              </div>
            ))}
          </div>
        </details>
      </div>

      <div className="flex flex-wrap items-start gap-2 lg:justify-end">
        {!item.record && (
          <Button size="sm" variant="outline" onClick={onPlan} disabled={pending}>
            {pending && <LoaderCircle className="h-4 w-4 animate-spin" />}
            Plan
          </Button>
        )}
        {item.record && item.status !== 'validated' && (
          <Button size="sm" variant="outline" onClick={onMarkReady} disabled={pending}>
            {pending && <LoaderCircle className="h-4 w-4 animate-spin" />}
            Mark ready
          </Button>
        )}
        {item.record && (
          <>
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={pending}>
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Validate
            </Button>
            <Button size="icon" variant="ghost" title="Unlink readiness record" onClick={onUnlink} disabled={pending}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

async function getApiErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    const details =
      typeof data?.error?.message === 'string'
        ? data.error.message
        : typeof data?.details === 'string'
          ? data.details
          : null;

    return details ? `${fallback}: ${details}` : fallback;
  } catch {
    return fallback;
  }
}
