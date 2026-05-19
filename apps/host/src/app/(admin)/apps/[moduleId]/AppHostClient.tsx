'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { AdminShell } from '@/components/AdminShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useHostApps } from '@/hooks/useHostApps';
import { cn } from '@/lib/utils';
import type { HostAppEntry, HostAppNavigationItem } from '@/types/apps';

export function AppHostClient({ moduleId }: { moduleId: string }) {
  const searchParams = useSearchParams();
  const selectedPath = normalizeSelectedPath(searchParams.get('path'));
  const appsState = useHostApps();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [frameWarning, setFrameWarning] = useState<string | null>(null);

  const app = useMemo(
    () => appsState.apps.find(candidate => candidate.moduleId === moduleId) ?? null,
    [appsState.apps, moduleId]
  );
  const selectedNavigation = useMemo(
    () => app?.navigation.find(item => item.path === selectedPath) ?? null,
    [app, selectedPath]
  );
  const embeddedUrl = app
    ? getEmbeddedUrl(app, selectedNavigation, selectedPath)
    : null;

  const title = app?.displayName ?? 'Opening app';
  const description = app
    ? selectedNavigation?.label ?? app.description ?? 'Embedded module UI'
    : 'Embedded module UI';
  const statusLabel = getStatusLabel(app);

  return (
    <AdminShell
      title={title}
      description={description}
      actions={(
        <>
          {statusLabel && (
            <Badge
              variant="outline"
              className={cn(
                app?.status === 'available'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              )}
            >
              {statusLabel}
            </Badge>
          )}
          {embeddedUrl && app?.status === 'available' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={appsState.refreshState === 'refreshing'}
              onClick={() => {
                setFrameWarning(null);
                setReloadVersion(current => current + 1);
                void appsState.refetch();
              }}
            >
              <RefreshCw className={cn('h-4 w-4', appsState.refreshState === 'refreshing' && 'animate-spin')} />
              Refresh
            </Button>
          )}
        </>
      )}
      contentClassName="flex min-h-[calc(100dvh-4rem)] max-w-none flex-col space-y-4 px-4 py-4 sm:px-6 lg:px-8"
    >
      {renderAppHostContent({
        appsState,
        app,
        embeddedUrl,
        reloadVersion,
        selectedPath,
        frameWarning,
        setFrameWarning,
      })}
    </AdminShell>
  );
}

function renderAppHostContent({
  appsState,
  app,
  embeddedUrl,
  reloadVersion,
  selectedPath,
  frameWarning,
  setFrameWarning,
}: {
  appsState: ReturnType<typeof useHostApps>;
  app: HostAppEntry | null;
  embeddedUrl: string | null;
  reloadVersion: number;
  selectedPath: string;
  frameWarning: string | null;
  setFrameWarning: (message: string | null) => void;
}) {
  if (appsState.loading) {
    return (
      <AppStatePanel
        title="Loading app"
        description="The Host is loading the app registry."
      />
    );
  }

  if (appsState.error) {
    const loginRequired = appsState.errorCode === 'unauthorized';
    return (
      <AppStatePanel
        title={loginRequired ? 'Login required' : 'Apps unavailable'}
        description={loginRequired ? 'Sign in to Docker Host before opening module apps.' : appsState.error}
        action={loginRequired
          ? (
              <Button asChild>
                <Link href="/login">Sign in</Link>
              </Button>
            )
          : (
              <Button type="button" variant="outline" onClick={() => void appsState.refetch()}>
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            )}
      />
    );
  }

  if (!app) {
    return (
      <AppStatePanel
        title="Access denied"
        description="This module app is not assigned to the current Host principal or is no longer available."
        action={(
          <Button asChild variant="outline">
            <Link href="/apps">Back to Apps</Link>
          </Button>
        )}
      />
    );
  }

  if (app.status !== 'available') {
    return (
      <AppStatePanel
        title="App unavailable"
        description={formatAppStatusReason(app.statusReason)}
      />
    );
  }

  if (!embeddedUrl) {
    return (
      <AppStatePanel
        title="App route unavailable"
        description="The selected module UI path could not be resolved."
      />
    );
  }

  return (
    <section className="flex min-h-[560px] flex-1 flex-col overflow-hidden rounded-md border bg-background">
      {frameWarning && (
        <div className="flex items-start gap-3 border-b bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Embedded app warning</p>
            <p>{frameWarning}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-amber-900 hover:bg-amber-100"
            onClick={() => setFrameWarning(null)}
          >
            Dismiss
          </Button>
        </div>
      )}
      <iframe
        key={`${embeddedUrl}:${reloadVersion}`}
        src={embeddedUrl}
        title={`${app.displayName} module UI`}
        className="min-h-[560px] flex-1 border-0 bg-white"
        onError={() => {
          setFrameWarning('The module UI could not be embedded. Open it through the Host shell after the module supports iframe embedding.');
        }}
        onLoad={() => {
          setFrameWarning(null);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">Module path: {selectedPath}</span>
        <span className="inline-flex items-center gap-1">
          <ExternalLink className="h-3.5 w-3.5" />
          Host-owned embedded transport
        </span>
      </div>
    </section>
  );
}

function AppStatePanel({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="flex min-h-[360px] flex-1 items-center justify-center rounded-md border bg-background px-6 py-12">
      <div className="max-w-md space-y-4 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-md bg-muted">
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {action && (
          <div className="flex justify-center">
            {action}
          </div>
        )}
      </div>
    </section>
  );
}

function getEmbeddedUrl(
  app: HostAppEntry,
  selectedNavigation: HostAppNavigationItem | null,
  selectedPath: string
) {
  if (selectedNavigation) {
    return selectedNavigation.embeddedUrl;
  }

  if (selectedPath === '/') {
    return app.embeddedUrl;
  }

  return `/api/apps/${encodeURIComponent(app.moduleId)}/embed?path=${encodeURIComponent(selectedPath)}`;
}

function getStatusLabel(app: HostAppEntry | null) {
  if (!app) {
    return null;
  }

  return app.status === 'available' ? 'Available' : 'Unavailable';
}

function normalizeSelectedPath(path: string | null) {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return '/';
  }

  return path;
}

function formatAppStatusReason(reason: HostAppEntry['statusReason']) {
  switch (reason) {
    case 'metadataMissing':
      return 'App metadata is missing.';
    case 'metadataInvalid':
      return 'App metadata is invalid.';
    case 'uiPortMissing':
      return 'App UI port is missing.';
    case 'uiPortNotPublic':
      return 'App UI port is not marked public.';
    case 'moduleOperationUnavailable':
      return 'Module operation is not ready.';
    case 'runtimeUnavailable':
      return 'Module runtime is not running.';
    case 'available':
      return 'App is available.';
    default:
      return 'The module UI cannot be opened from the Host shell.';
  }
}
