'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import Link from 'next/link';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { AdminShell, useAdminPrincipal } from '@/components/AdminShell';
import { Button } from '@/components/ui/button';
import { useHostApps } from '@/hooks/useHostApps';
import type { HostAppEntry, HostAppNavigationItem } from '@/types/apps';

const IDENTITY_DELIVERY_RETRY_DELAYS_MS = [250, 1_000, 2_500, 5_000] as const;
const DEFAULT_IDENTITY_REFRESH_DELAY_MS = 4 * 60 * 1_000;
const IDENTITY_REFRESH_SAFETY_MARGIN_MS = 30 * 1_000;
const MIN_IDENTITY_REFRESH_DELAY_MS = 1_000;

type IdentityTokenResponse = Record<string, unknown> & {
  expiresInSeconds?: unknown;
};

export function AppHostClient({ appId }: { appId: string }) {
  const searchParams = useSearchParams();
  const principal = useAdminPrincipal();
  const principalFrameKey = principal ? `${principal.id}:${principal.role}` : '';
  const principalRefreshKey = principal
    ? `${principalFrameKey}:${principal.email ?? ''}:${principal.displayName ?? ''}`
    : '';
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const identityRetryIdsRef = useRef<number[]>([]);
  const identityRefreshTimeoutRef = useRef<number | null>(null);
  const scheduleIdentityRefreshRef = useRef<(delayMs: number) => void>(() => {});
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
  const sendIdentityToken = useCallback(async (): Promise<number | null> => {
    if (!principal || !app?.identityTokenUrl || !app.origin || !frameRef.current?.contentWindow) {
      return null;
    }

    const targetWindow = frameRef.current.contentWindow;
    const appIdForLog = app.id;
    const identityTokenUrl = app.identityTokenUrl;
    const targetOrigin = app.origin;

    try {
      const response = await fetch(identityTokenUrl, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!response.ok) {
        console.error(`Failed to fetch identity token for app ${appIdForLog}: ${response.status}`);
        return null;
      }

      const payload = await response.json() as IdentityTokenResponse;
      if (frameRef.current?.contentWindow !== targetWindow) {
        return null;
      }

      targetWindow.postMessage({
        type: 'docker-host:identity',
        ...payload,
      }, targetOrigin);
      return getIdentityRefreshDelayMs(payload);
    } catch (error) {
      console.error(`Error sending identity token for app ${appIdForLog}:`, error);
      // Token delivery is best-effort; the module can request it again through postMessage.
      return null;
    }
  }, [app, principal]);
  const clearIdentityRetries = useCallback(() => {
    for (const retryId of identityRetryIdsRef.current) {
      window.clearTimeout(retryId);
    }
    identityRetryIdsRef.current = [];
  }, []);
  const clearIdentityRefresh = useCallback(() => {
    if (identityRefreshTimeoutRef.current !== null) {
      window.clearTimeout(identityRefreshTimeoutRef.current);
      identityRefreshTimeoutRef.current = null;
    }
  }, []);
  const clearIdentityTimers = useCallback(() => {
    clearIdentityRetries();
    clearIdentityRefresh();
  }, [clearIdentityRefresh, clearIdentityRetries]);
  const deliverIdentityToken = useCallback(async () => {
    const refreshDelayMs = await sendIdentityToken();
    if (refreshDelayMs !== null) {
      scheduleIdentityRefreshRef.current(refreshDelayMs);
    }
  }, [sendIdentityToken]);
  const scheduleIdentityRefresh = useCallback((delayMs: number) => {
    clearIdentityRefresh();
    identityRefreshTimeoutRef.current = window.setTimeout(() => {
      identityRefreshTimeoutRef.current = null;
      void deliverIdentityToken();
    }, delayMs);
  }, [clearIdentityRefresh, deliverIdentityToken]);
  const scheduleIdentityDelivery = useCallback(() => {
    clearIdentityTimers();
    void deliverIdentityToken();

    for (const delayMs of IDENTITY_DELIVERY_RETRY_DELAYS_MS) {
      const retryId = window.setTimeout(() => {
        void deliverIdentityToken();
      }, delayMs);
      identityRetryIdsRef.current.push(retryId);
    }
  }, [clearIdentityTimers, deliverIdentityToken]);

  useEffect(() => {
    scheduleIdentityRefreshRef.current = scheduleIdentityRefresh;
  }, [scheduleIdentityRefresh]);

  useEffect(() => {
    if (!app?.origin) {
      return undefined;
    }

    function handleMessage(event: MessageEvent) {
      if (
        event.origin !== app?.origin ||
        !isIdentityRequestMessage(event.data)
      ) {
        return;
      }

      void deliverIdentityToken();
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [app?.origin, deliverIdentityToken]);

  useEffect(() => clearIdentityTimers, [clearIdentityTimers, embeddedUrl, principalFrameKey]);

  useEffect(() => {
    scheduleIdentityDelivery();
  }, [principalRefreshKey, scheduleIdentityDelivery]);

  useEffect(() => {
    if (!embeddedUrl) {
      return undefined;
    }

    function refreshActivePageIdentity() {
      void deliverIdentityToken();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        refreshActivePageIdentity();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', refreshActivePageIdentity);
    window.addEventListener('pageshow', refreshActivePageIdentity);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', refreshActivePageIdentity);
      window.removeEventListener('pageshow', refreshActivePageIdentity);
    };
  }, [deliverIdentityToken, embeddedUrl]);

  return (
    <AdminShell contentClassName="flex h-full max-w-none flex-col p-0 sm:px-0 lg:px-0">
      {renderAppHostContent({
        appsState,
        app,
        embeddedUrl,
        frameRef,
        frameWarning,
        frameIdentityKey: principalFrameKey,
        setFrameWarning,
        scheduleIdentityDelivery,
      })}
    </AdminShell>
  );
}

function renderAppHostContent({
  appsState,
  app,
  embeddedUrl,
  frameRef,
  frameWarning,
  frameIdentityKey,
  setFrameWarning,
  scheduleIdentityDelivery,
}: {
  appsState: ReturnType<typeof useHostApps>;
  app: HostAppEntry | null;
  embeddedUrl: string | null;
  frameRef: RefObject<HTMLIFrameElement | null>;
  frameWarning: string | null;
  frameIdentityKey: string;
  setFrameWarning: (message: string | null) => void;
  scheduleIdentityDelivery: () => void;
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
      {/* Module UI runs on its own origin; Host integration is limited to the postMessage identity bridge. */}
      <iframe
        ref={frameRef}
        key={`${embeddedUrl}:${frameIdentityKey}`}
        src={embeddedUrl}
        title={`${app.displayName} module UI`}
        sandbox="allow-clipboard-write allow-downloads allow-forms allow-popups allow-same-origin allow-scripts"
        className="min-h-0 flex-1 border-0 bg-background"
        onError={() => {
          setFrameWarning('The module UI could not be embedded. Open it through the Host shell after the module supports iframe embedding.');
        }}
        onLoad={() => {
          setFrameWarning(null);
          scheduleIdentityDelivery();
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
    return app.origin ? buildDirectClientUrl(app.origin, selectedPath) : null;
  }

  return app.origin ? buildDirectClientUrl(app.origin, selectedPath) : null;
}

function buildDirectClientUrl(origin: string, modulePath: string) {
  return new URL(modulePath, origin.endsWith('/') ? origin : `${origin}/`).toString();
}

function normalizeSelectedPath(path: string | null) {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return '/';
  }

  return path;
}

function isIdentityRequestMessage(value: unknown) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    (
      (value as { type?: unknown }).type === 'docker-host:ready' ||
      (value as { type?: unknown }).type === 'docker-host:request-identity'
    )
  );
}

function getIdentityRefreshDelayMs(payload: IdentityTokenResponse) {
  const ttlSeconds = payload.expiresInSeconds;
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_IDENTITY_REFRESH_DELAY_MS;
  }

  const ttlMs = ttlSeconds * 1_000;
  const delayMs = ttlMs > IDENTITY_REFRESH_SAFETY_MARGIN_MS * 2
    ? ttlMs - IDENTITY_REFRESH_SAFETY_MARGIN_MS
    : ttlMs * 0.8;
  return Math.max(MIN_IDENTITY_REFRESH_DELAY_MS, Math.floor(delayMs));
}

function formatAppStatusReason(reason: HostAppEntry['statusReason']) {
  switch (reason) {
    case 'metadataMissing':
      return 'App metadata is missing.';
    case 'metadataInvalid':
      return 'App metadata is invalid.';
    case 'uiPortMissing':
      return 'App UI needs a published Host port. Open the module update review or reinstall the module.';
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
