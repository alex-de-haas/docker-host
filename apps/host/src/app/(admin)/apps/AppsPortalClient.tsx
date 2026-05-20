'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ArrowRight,
  CircleAlert,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import { AdminShell, useAdminPrincipal } from '@/components/AdminShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useHostApps } from '@/hooks/useHostApps';
import { cn } from '@/lib/utils';
import type { HostAppEntry } from '@/types/apps';

export function AppsPortalClient() {
  const user = useAdminPrincipal();
  const appsState = useHostApps();
  const isRefreshing = appsState.refreshState !== 'idle';

  return (
    <AdminShell
      title="Apps"
      description={user.role === 'host.admin'
        ? 'Shell apps available through Docker Host'
        : 'Assigned apps available to your account'}
      actions={(
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isRefreshing}
          onClick={() => void appsState.refetch()}
        >
          <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
          Refresh
        </Button>
      )}
    >
      {renderPortalContent({ appsState, isUser: user.role === 'host.user' })}
    </AdminShell>
  );
}

function renderPortalContent({
  appsState,
  isUser,
}: {
  appsState: ReturnType<typeof useHostApps>;
  isUser: boolean;
}) {
  if (appsState.loading) {
    return (
      <PortalStatePanel
        icon={LoaderCircle}
        iconClassName="animate-spin"
        title="Loading apps"
        description="Docker Host is loading the app registry."
      />
    );
  }

  if (appsState.error) {
    const loginRequired = appsState.errorCode === 'unauthorized';
    return (
      <PortalStatePanel
        icon={loginRequired ? LockKeyhole : CircleAlert}
        title={loginRequired ? 'Login required' : 'Apps unavailable'}
        description={loginRequired
          ? 'Sign in to Docker Host before opening assigned apps.'
          : appsState.error}
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

  if (appsState.apps.length === 0) {
    return (
      <PortalStatePanel
        icon={LayoutGrid}
        title={isUser ? 'No assigned apps' : 'No apps registered'}
        description={isUser
          ? 'Your account does not have any available module apps assigned yet.'
          : 'Installed modules need valid UI metadata before they appear in the Apps portal.'}
      />
    );
  }

  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {appsState.apps.map(app => (
          <AppPortalEntry key={app.id} app={app} />
        ))}
      </div>
    </section>
  );
}

function AppPortalEntry({ app }: { app: HostAppEntry }) {
  const available = app.status === 'available';
  const content = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-base font-semibold">{app.displayName}</h2>
          <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
            {app.description || 'Module app'}
          </p>
        </div>
        <Badge variant={available ? 'outline' : 'secondary'}>
          {available ? 'Available' : 'Unavailable'}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {app.source === 'developer' && (
          <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">
            Dev
          </Badge>
        )}
        <Badge variant="secondary">
          {app.accessMode === 'assignedUsersOnly' ? 'Assigned' : 'All users'}
        </Badge>
        {app.navigation.length > 0 && (
          <span>{app.navigation.length} section{app.navigation.length === 1 ? '' : 's'}</span>
        )}
      </div>
      <div className="flex items-center justify-between border-t pt-3 text-sm">
        <span className="text-muted-foreground">{app.version}</span>
        <span className="inline-flex items-center gap-1 font-medium text-primary">
          Open
          <ArrowRight className="h-4 w-4" />
        </span>
      </div>
    </>
  );

  if (!available) {
    return (
      <article className="flex min-h-44 flex-col justify-between rounded-md border bg-background p-4 opacity-70">
        {content}
      </article>
    );
  }

  return (
    <Link
      href={app.entryPath}
      className="flex min-h-44 flex-col justify-between rounded-md border bg-background p-4 transition-colors hover:border-primary/40 hover:bg-muted/30"
    >
      {content}
    </Link>
  );
}

function PortalStatePanel({
  icon: Icon,
  title,
  description,
  action,
  iconClassName,
}: {
  icon: typeof LayoutGrid;
  title: string;
  description: string;
  action?: ReactNode;
  iconClassName?: string;
}) {
  return (
    <section className="flex min-h-[420px] items-center justify-center rounded-md border bg-background px-6 py-12">
      <div className="max-w-md space-y-4 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
          <Icon className={cn('h-6 w-6 text-muted-foreground', iconClassName)} />
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
