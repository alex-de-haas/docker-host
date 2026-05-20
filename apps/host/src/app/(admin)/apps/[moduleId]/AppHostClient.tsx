'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { AdminShell } from '@/components/AdminShell';
import { Button } from '@/components/ui/button';
import { useHostApps } from '@/hooks/useHostApps';
import type { HostAppEntry, HostAppNavigationItem } from '@/types/apps';

export function AppHostClient({ appId }: { appId: string }) {
  const searchParams = useSearchParams();
  const selectedPath = normalizeSelectedPath(searchParams.get('path'));
  const appsState = useHostApps();
  const [frameWarning, setFrameWarning] = useState<string | null>(null);

  const app = useMemo(
    () => appsState.apps.find(candidate => candidate.id === appId) ?? null,
    [appsState.apps, appId]
  );
  const selectedNavigation = useMemo(
    () => app?.navigation.find(item => item.path === selectedPath) ?? null,
    [app, selectedPath]
  );
  const embeddedUrl = app
    ? getEmbeddedUrl(app, selectedNavigation, selectedPath)
    : null;

  return (
    <AdminShell contentClassName="flex h-full max-w-none flex-col p-0">
      {renderAppHostContent({
        appsState,
        app,
        embeddedUrl,
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
  frameWarning,
  setFrameWarning,
}: {
  appsState: ReturnType<typeof useHostApps>;
  app: HostAppEntry | null;
  embeddedUrl: string | null;
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
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
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
        key={embeddedUrl}
        src={embeddedUrl}
        title={`${app.displayName} module UI`}
        className="min-h-0 flex-1 border-0 bg-white"
        onError={() => {
          setFrameWarning('The module UI could not be embedded. Open it through the Host shell after the module supports iframe embedding.');
        }}
        onLoad={() => {
          setFrameWarning(null);
        }}
      />
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

  if (app.source === 'developer' && app.developerTargetId) {
    return `/api/apps/dev/${encodeURIComponent(app.developerTargetId)}/embed?path=${encodeURIComponent(selectedPath)}`;
  }

  return `/api/apps/${encodeURIComponent(app.moduleId)}/embed?path=${encodeURIComponent(selectedPath)}`;
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
