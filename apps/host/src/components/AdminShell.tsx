'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { toast } from 'sonner';
import {
  BarChart3,
  Boxes,
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  Circle,
  CircleAlert,
  Gauge,
  Globe2,
  Hammer,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Monitor,
  OctagonX,
  PackagePlus,
  PanelsTopLeft,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Settings,
  Users,
  UserPlus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { notifyHostAppsChanged, useHostApps } from '@/hooks/useHostApps';
import { formatAppStatusReason, formatAppStatusReasonLabel } from '@/lib/host-app-status';
import { cn } from '@/lib/utils';
import type { HostPrincipal } from '@/types/auth';
import type { HostAppEntry } from '@/types/apps';
import type { ModuleActionResult, ModuleOperationError } from '@/types/modules';

interface AdminShellContextValue {
  user: HostPrincipal;
  isDevelopmentRuntime: boolean;
}

const AdminPrincipalContext = createContext<AdminShellContextValue | null>(null);
const SIDEBAR_COMPACT_STORAGE_KEY = 'docker-host.sidebar.compact';
const SIDEBAR_COMPACT_EVENT = 'docker-host-sidebar-compact-change';

export function AdminPrincipalProvider({
  user,
  isDevelopmentRuntime = false,
  children,
}: {
  user: HostPrincipal;
  isDevelopmentRuntime?: boolean;
  children: ReactNode;
}) {
  return (
    <AdminPrincipalContext.Provider value={{ user, isDevelopmentRuntime }}>
      {children}
    </AdminPrincipalContext.Provider>
  );
}

export function useAdminPrincipal() {
  return useAdminShellContext().user;
}

function useAdminShellContext() {
  const context = useContext(AdminPrincipalContext);
  if (!context) {
    throw new Error('useAdminPrincipal must be used within AdminPrincipalProvider.');
  }

  return context;
}

export function HostPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-xl font-semibold leading-7">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {actions}
        </div>
      )}
    </section>
  );
}

export function AdminShell({
  children,
  contentClassName,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}) {
  const { user, isDevelopmentRuntime } = useAdminShellContext();
  const shellHomePath = user.role === 'host.user' ? '/apps' : '/';
  const sidebarCompact = useSyncExternalStore(
    subscribeToSidebarCompactPreference,
    readSidebarCompactPreference,
    () => false
  );
  const appsState = useHostApps();

  function handleSidebarCompactChange(compact: boolean) {
    window.localStorage.setItem(SIDEBAR_COMPACT_STORAGE_KEY, String(compact));
    window.dispatchEvent(new Event(SIDEBAR_COMPACT_EVENT));
  }

  return (
    <div
      className={cn(
        'grid min-h-dvh bg-muted/30 transition-[grid-template-columns] duration-200',
        sidebarCompact
          ? 'grid-cols-[72px_minmax(0,1fr)]'
          : 'grid-cols-[280px_minmax(0,1fr)]'
      )}
    >
      <aside className="sticky top-0 h-dvh border-r bg-sidebar text-sidebar-foreground">
        <AdminSidebar
          appsState={appsState}
          shellHomePath={shellHomePath}
          user={user}
          isDevelopmentRuntime={isDevelopmentRuntime}
          compact={sidebarCompact}
          onCompactChange={handleSidebarCompactChange}
        />
      </aside>

      <div className="h-dvh min-w-0 overflow-y-auto">
        <main className={cn('mx-auto w-full max-w-7xl space-y-8 px-4 py-6 sm:px-6 lg:px-8', contentClassName)}>
          {children}
        </main>
      </div>
    </div>
  );
}

function readSidebarCompactPreference() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(SIDEBAR_COMPACT_STORAGE_KEY) === 'true';
}

function subscribeToSidebarCompactPreference(onStoreChange: () => void) {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const listener = () => onStoreChange();
  window.addEventListener('storage', listener);
  window.addEventListener(SIDEBAR_COMPACT_EVENT, listener);

  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(SIDEBAR_COMPACT_EVENT, listener);
  };
}

type NavigationItem = {
  label: string;
  href?: string;
  icon: LucideIcon;
  disabled?: boolean;
  isActive?: (pathname: string) => boolean;
};

type NavigationSection = {
  title: string;
  items: NavigationItem[];
};

type AppsState = ReturnType<typeof useHostApps>;

type AppMenuLifecycleAction = 'start' | 'restart' | 'retry' | 'update-retry';

interface AppMenuActionConfig {
  action: AppMenuLifecycleAction;
  label: string;
  title: string;
  icon: LucideIcon;
}

type BrowserAccountSummary = HostPrincipal & {
  authProvider?: string;
  addedAt: string;
  lastUsedAt: string;
  active: boolean;
};

type BrowserAccountsResponse = {
  activeUser: HostPrincipal | null;
  accounts: BrowserAccountSummary[];
};

type AccountSwitchResponse = {
  redirectTo?: string;
  error?: {
    message?: string;
  };
};

async function readJsonResponse<T>(response: Response): Promise<T | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

const navigationSections: NavigationSection[] = [
  {
    title: 'Host',
    items: [
      {
        label: 'Dashboard',
        href: '/',
        icon: Gauge,
        isActive: pathname => pathname === '/',
      },
      {
        label: 'Gateway exposures',
        href: '/ingress',
        icon: Globe2,
        isActive: pathname => pathname === '/ingress',
      },
      {
        label: 'Installed modules',
        href: '/modules',
        icon: Boxes,
        isActive: pathname => pathname === '/modules' ||
          (pathname.startsWith('/modules/') && pathname !== '/modules/install'),
      },
      {
        label: 'Install module',
        href: '/modules/install',
        icon: PackagePlus,
        isActive: pathname => pathname === '/modules/install',
      },
    ],
  },
  {
    title: 'Apps',
    items: [],
  },
  {
    title: 'Settings',
    items: [
      {
        label: 'Security',
        href: '/settings/security',
        icon: ShieldCheck,
        isActive: pathname => pathname === '/settings/security',
      },
      {
        label: 'User Management',
        href: '/settings/users',
        icon: Users,
        isActive: pathname => pathname === '/settings/users',
      },
    ],
  },
];

function getNavigationSections(user: HostPrincipal): NavigationSection[] {
  if (user.role === 'host.user') {
    return navigationSections.filter(section => section.title === 'Apps');
  }

  return navigationSections;
}

function AdminSidebar({
  appsState,
  shellHomePath,
  user,
  isDevelopmentRuntime,
  compact,
  onCompactChange,
}: {
  appsState: AppsState;
  shellHomePath: string;
  user: HostPrincipal;
  isDevelopmentRuntime: boolean;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedAppPath = normalizeSelectedAppPath(searchParams.get('path'));
  const sections = getNavigationSections(user);
  const accountLabel = user.displayName || user.email || user.id;
  const accountDescription = user.email && user.email !== accountLabel ? user.email : user.role;
  const accountAvatarStyle = getAccountAvatarStyle(accountLabel);
  const [accounts, setAccounts] = useState<BrowserAccountSummary[]>([]);
  const [accountActionUserId, setAccountActionUserId] = useState<string | null>(null);
  const [accountActionError, setAccountActionError] = useState<string | null>(null);
  const search = searchParams.toString();
  const currentPath = `${pathname}${search ? `?${search}` : ''}`;

  useEffect(() => {
    let cancelled = false;

    async function loadAccounts() {
      try {
        const response = await fetch('/api/auth/accounts', { cache: 'no-store' });
        if (!response.ok) {
          return;
        }
        const data = await response.json() as BrowserAccountsResponse;
        if (!cancelled) {
          setAccounts(data.accounts);
        }
      } catch {
        if (!cancelled) {
          setAccounts([]);
        }
      }
    }

    void loadAccounts();

    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const accountMenuItems = accounts.length > 0
    ? accounts
    : [{
        ...user,
        authProvider: undefined,
        addedAt: '',
        lastUsedAt: '',
        active: true,
      }];

  async function handleSwitchAccount(userId: string) {
    if (userId === user.id) {
      return;
    }

    setAccountActionUserId(userId);
    setAccountActionError(null);
    try {
      const response = await fetch('/api/auth/accounts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await readJsonResponse<AccountSwitchResponse>(response);
      if (response.ok) {
        window.location.href = data?.redirectTo || '/';
        return;
      }
      setAccountActionError(data?.error?.message || 'Unable to switch account.');
    } catch {
      setAccountActionError('Unable to switch account.');
    } finally {
      setAccountActionUserId(null);
    }
  }

  function handleAddAccount() {
    const url = new URL('/login', window.location.origin);
    url.searchParams.set('mode', 'add-account');
    url.searchParams.set('redirectTo', currentPath);
    window.location.href = url.toString();
  }

  async function handleLogoutCurrent() {
    const response = await fetch(`/api/auth/accounts/${encodeURIComponent(user.id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      await fetch('/api/auth/logout', { method: 'POST' });
    }
    window.location.href = '/login';
  }

  async function handleLogoutAll() {
    await fetch('/api/auth/accounts', { method: 'DELETE' });
    window.location.href = '/login';
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('relative flex h-18 shrink-0 items-center border-b px-3', compact ? 'justify-center' : 'gap-2')}>
        <Link
          href={shellHomePath}
          className={cn(
            'flex min-w-0 items-center gap-3 rounded-md focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            compact && 'justify-center'
          )}
          title="Docker Host"
        >
          <span className="relative flex size-10 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
            <PanelsTopLeft className="h-5 w-5" />
            {compact && isDevelopmentRuntime && (
              <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-amber-500 ring-2 ring-sidebar" aria-hidden="true" />
            )}
          </span>
          {!compact && (
            <span className="flex min-w-0 items-center gap-2">
              <span className="block truncate text-sm font-semibold">DOCKER HOST</span>
              {isDevelopmentRuntime && (
                <Badge
                  variant="outline"
                  className="border-amber-300 bg-amber-100 px-2 py-0 text-[10px] font-semibold leading-4 text-amber-900"
                >
                  DEV
                </Badge>
              )}
            </span>
          )}
        </Link>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="absolute right-0 top-1/2 z-20 size-7 -translate-y-1/2 translate-x-1/2 rounded-full bg-background shadow-sm"
          aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'}
          title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => onCompactChange(!compact)}
        >
          {compact ? (
            <ChevronsRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronsLeft className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <nav className={cn('min-h-0 flex-1 overflow-y-auto py-4', compact ? 'px-2' : 'px-3')} aria-label="Host navigation">
        <div className={cn(compact ? 'space-y-4' : 'space-y-6')}>
          {sections.map(section => (
            <div key={section.title} className="space-y-2">
              <h2 className={cn('px-2 text-xs font-medium uppercase text-muted-foreground', compact && 'sr-only')}>
                {section.title}
              </h2>
              <div className="space-y-1">
                {section.title === 'Apps'
                  ? (
                      <AppNavigationSection
                        appsState={appsState}
                        pathname={pathname}
                        selectedAppPath={selectedAppPath}
                        user={user}
                        compact={compact}
                      />
                    )
                  : section.items.map(item => (
                      <NavigationLink
                        key={`${section.title}:${item.label}`}
                        item={item}
                        pathname={pathname}
                        compact={compact}
                      />
                    ))}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className={cn('shrink-0 border-t', compact ? 'space-y-2 px-2 py-3' : 'space-y-3 p-3')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={compact ? 'ghost' : 'outline'}
              size={compact ? 'icon-lg' : 'default'}
              className={cn(
                compact
                  ? 'mx-auto flex size-11 rounded-md'
                  : 'h-auto w-full justify-start px-3 py-2 text-left'
              )}
              title={compact ? accountLabel : undefined}
            >
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold"
                style={accountAvatarStyle}
              >
                {getAccountInitials(user)}
              </span>
              {!compact && (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{accountLabel}</span>
                    <span className="block truncate text-xs text-muted-foreground">{accountDescription}</span>
                  </span>
                  <ChevronDown className="h-4 w-4" />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-72">
            <DropdownMenuLabel className="space-y-1">
              <span className="block truncate text-sm">{accountLabel}</span>
              {user.email && user.email !== accountLabel && (
                <span className="block truncate text-xs font-normal text-muted-foreground">{user.email}</span>
              )}
              <Badge variant="outline">{user.role}</Badge>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {accountActionError && (
              <>
                <DropdownMenuLabel className="flex items-start gap-2 whitespace-normal text-xs font-normal text-destructive">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{accountActionError}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            )}
            {accountMenuItems.map(account => {
              const label = account.displayName || account.email || account.id;
              const description = account.email && account.email !== label ? account.email : account.role;
              return (
                <DropdownMenuItem
                  key={account.id}
                  disabled={account.active || accountActionUserId === account.id}
                  onSelect={event => {
                    event.preventDefault();
                    void handleSwitchAccount(account.id);
                  }}
                >
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold"
                    style={getAccountAvatarStyle(label)}
                  >
                    {getAccountInitials(account)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{description}</span>
                  </span>
                  {account.active && <Check className="h-4 w-4" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={event => {
                event.preventDefault();
                handleAddAccount();
              }}
            >
              <UserPlus className="h-4 w-4" />
              Add another user
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={event => {
                event.preventDefault();
                void handleLogoutCurrent();
              }}
            >
              <LogOut className="h-4 w-4" />
              Log out current account
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={event => {
                event.preventDefault();
                void handleLogoutAll();
              }}
            >
              <LogOut className="h-4 w-4" />
              Log out all accounts
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

      </div>
    </div>
  );
}

function AppNavigationSection({
  appsState,
  pathname,
  selectedAppPath,
  user,
  compact,
}: {
  appsState: AppsState;
  pathname: string;
  selectedAppPath: string;
  user: HostPrincipal;
  compact: boolean;
}) {
  const [expandedAppIds, setExpandedAppIds] = useState<Set<string>>(() => new Set());
  const [collapsedActiveAppIds, setCollapsedActiveAppIds] = useState<Set<string>>(() => new Set());
  const [pendingAppAction, setPendingAppAction] = useState<{
    appId: string;
    action: AppMenuLifecycleAction;
  } | null>(null);

  async function handleAppMenuAction(app: HostAppEntry, action: AppMenuLifecycleAction) {
    if (app.source !== 'installed' || pendingAppAction) {
      return;
    }

    setPendingAppAction({ appId: app.id, action });

    try {
      const response = await fetch(
        `/api/modules/${encodeURIComponent(app.moduleId)}/${getAppMenuActionPath(action)}`,
        { method: 'POST' }
      );
      const result = await readJsonResponse<ModuleActionResult>(response);
      if (!response.ok || !result?.success) {
        throw new Error(formatAppMenuActionError(
          result?.error ?? null,
          `Failed to ${formatAppMenuActionVerb(action)} module.`
        ));
      }

      notifyHostAppsChanged();
      toast.success(formatAppMenuSuccessMessage(action, app.displayName));
    } catch (error) {
      toast.error(formatAppMenuFailureMessage(action, app.displayName), {
        description: error instanceof Error ? error.message : 'Module action failed.',
      });
    } finally {
      setPendingAppAction(null);
    }
  }

  if (appsState.loading) {
    return (
      <NavigationPlaceholder
        icon={RefreshCw}
        label="Loading apps"
        className="animate-pulse"
        compact={compact}
      />
    );
  }

  if (appsState.error) {
    const loginRequired = appsState.errorCode === 'unauthorized';
    return (
      <NavigationPlaceholder
        icon={loginRequired ? ShieldCheck : CircleAlert}
        label={loginRequired ? 'Login required' : 'Apps unavailable'}
        title={appsState.error}
        compact={compact}
      />
    );
  }

  if (appsState.apps.length === 0) {
    return (
      <NavigationPlaceholder
        icon={LayoutGrid}
        label={user.role === 'host.user' ? 'No assigned apps' : 'No apps registered'}
        compact={compact}
      />
    );
  }

  return (
    <>
      {appsState.apps.map(app => {
        const appPathname = app.entryPath.split('?')[0] || app.entryPath;
        const canNavigate = app.status === 'available';
        const isActive = canNavigate && pathname === appPathname;
        const expanded = canNavigate && (
          expandedAppIds.has(app.id) || (isActive && !collapsedActiveAppIds.has(app.id))
        );
        const Icon = getAppNavigationIcon(app);
        const action = getAppMenuAction(app);
        const pending = pendingAppAction?.appId === app.id && pendingAppAction.action === action?.action;
        const ActionIcon = action?.icon;
        const itemClassName = cn(
          'relative flex min-w-0 flex-1 items-center gap-2 rounded-md text-sm transition-colors',
          'min-h-9',
          compact ? 'justify-center px-0' : 'px-2',
          canNavigate
            ? (
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              )
            : 'cursor-not-allowed text-muted-foreground opacity-70'
        );
        const itemTitle = canNavigate
          ? app.displayName
          : `${app.displayName}: ${formatAppStatusReason(app.statusReason)}`;
        const itemContent = (
          <>
            <Icon className="h-4 w-4 shrink-0" />
            {!compact && (
              <>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{app.displayName}</span>
                    {app.source === 'developer' && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-sky-200 bg-sky-50 px-1.5 py-0 text-[10px] leading-4 text-sky-700"
                      >
                        Dev
                      </Badge>
                    )}
                    {!canNavigate && (
                      <AppUnavailableBadge reason={app.statusReason} />
                    )}
                  </span>
                </span>
              </>
            )}
            {compact && (
              <AppCompactMarkers app={app} />
            )}
          </>
        );

        return (
          <div key={app.id} className="space-y-1">
            <div className="flex items-center gap-1">
              {canNavigate ? (
                <Link
                  href={app.entryPath}
                  className={itemClassName}
                  title={itemTitle}
                >
                  {itemContent}
                </Link>
              ) : (
                <div
                  className={itemClassName}
                  aria-disabled="true"
                  title={itemTitle}
                >
                  {itemContent}
                </div>
              )}
              {action && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-8 shrink-0"
                  aria-label={`${action.label} ${app.displayName}`}
                  title={action.title}
                  disabled={Boolean(pendingAppAction)}
                  onClick={() => void handleAppMenuAction(app, action.action)}
                >
                  {pending ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : ActionIcon ? (
                    <ActionIcon className="h-4 w-4" />
                  ) : (
                    null
                  )}
                </Button>
              )}
              {!compact && canNavigate && app.navigation.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-8 shrink-0"
                  aria-label={expanded ? `Collapse ${app.displayName} navigation` : `Expand ${app.displayName} navigation`}
                  aria-expanded={expanded}
                  onClick={() => {
                    setExpandedAppIds(current => {
                      const next = new Set(current);
                      if (expanded) {
                        next.delete(app.id);
                      } else {
                        next.add(app.id);
                      }
                      return next;
                    });
                    setCollapsedActiveAppIds(current => {
                      const next = new Set(current);
                      if (expanded && isActive) {
                        next.add(app.id);
                      } else {
                        next.delete(app.id);
                      }
                      return next;
                    });
                  }}
                >
                  <ChevronRight
                    className={cn(
                      'h-4 w-4 transition-transform',
                      expanded && 'rotate-90'
                    )}
                  />
                </Button>
              )}
            </div>
            {!compact && canNavigate && expanded && app.navigation.length > 0 && (
              <div className="ml-6 space-y-1 border-l border-sidebar-border pl-2">
                {app.navigation.map(item => {
                  const childActive = isActive && selectedAppPath === item.path;
                  return (
                    <Link
                      key={`${app.id}:${item.path}`}
                      href={item.entryPath}
                      className={cn(
                        'flex min-h-8 items-center gap-2 rounded-md px-2 text-xs transition-colors',
                        childActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )}
                    >
                      <Circle className="h-2 w-2 shrink-0 fill-current" />
                      <span className="min-w-0 truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function NavigationPlaceholder({
  icon: Icon,
  label,
  className,
  title,
  compact,
}: {
  icon: LucideIcon;
  label: string;
  className?: string;
  title?: string;
  compact: boolean;
}) {
  return (
    <div
      className={cn(
        'flex min-h-9 items-center gap-2 rounded-md text-sm text-muted-foreground opacity-70',
        compact ? 'justify-center px-0' : 'px-2',
        className
      )}
      aria-disabled="true"
      title={title ?? (compact ? label : undefined)}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className={cn('min-w-0 truncate', compact && 'sr-only')}>{label}</span>
    </div>
  );
}

function NavigationLink({
  item,
  pathname,
  compact,
}: {
  item: NavigationItem;
  pathname: string;
  compact: boolean;
}) {
  const active = item.isActive?.(pathname) ?? false;
  const Icon = item.icon;
  const className = cn(
    'flex min-h-9 items-center gap-2 rounded-md text-sm transition-colors',
    compact ? 'justify-center px-0' : 'px-2',
    active
      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
    item.disabled && 'pointer-events-none text-muted-foreground opacity-60'
  );

  if (!item.href || item.disabled) {
    return (
      <div className={className} aria-disabled="true" title={compact ? item.label : undefined}>
        <Icon className="h-4 w-4 shrink-0" />
        <span className={cn('min-w-0 truncate', compact && 'sr-only')}>{item.label}</span>
      </div>
    );
  }

  return (
    <Link href={item.href} className={className} title={compact ? item.label : undefined}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className={cn('min-w-0 truncate', compact && 'sr-only')}>{item.label}</span>
    </Link>
  );
}

function AppUnavailableBadge({ reason }: { reason: HostAppEntry['statusReason'] }) {
  const Icon = reason === 'localOriginUnavailable' ? Monitor : CircleAlert;

  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-amber-200 bg-amber-50 text-amber-700"
      aria-label={formatAppStatusReasonLabel(reason)}
      title={formatAppStatusReason(reason)}
    >
      <Icon className="h-3 w-3" />
    </span>
  );
}

function AppCompactMarkers({ app }: { app: HostAppEntry }) {
  if (app.source !== 'developer' && app.status === 'available') {
    return null;
  }

  return (
    <span className="absolute right-1 top-1 flex gap-0.5" aria-hidden="true">
      {app.source === 'developer' && (
        <span className="size-1.5 rounded-full bg-sky-500" />
      )}
      {app.status !== 'available' && (
        <span className="size-1.5 rounded-full bg-amber-500" />
      )}
    </span>
  );
}

function getAppMenuAction(app: HostAppEntry): AppMenuActionConfig | null {
  if (app.source !== 'installed' || app.status === 'available') {
    return null;
  }

  if (app.operationStatus === 'failed') {
    if (app.lastOperation === 'update') {
      return {
        action: 'update-retry',
        label: 'Retry update',
        title: 'Retry failed module update',
        icon: RefreshCw,
      };
    }

    return {
      action: 'retry',
      label: 'Retry install',
      title: 'Retry failed module install',
      icon: RefreshCw,
    };
  }

  if (app.operationStatus && app.operationStatus !== 'installed') {
    return null;
  }

  if (app.statusReason !== 'runtimeUnavailable') {
    return null;
  }

  switch (app.runtimeState) {
    case 'created':
    case 'exited':
      return {
        action: 'start',
        label: 'Start',
        title: 'Start stopped module',
        icon: Play,
      };
    case 'dead':
    case 'paused':
    case 'restarting':
    case 'unknown':
      return {
        action: 'restart',
        label: 'Restart',
        title: 'Restart module runtime',
        icon: RotateCcw,
      };
    default:
      return null;
  }
}

function getAppNavigationIcon(app: HostAppEntry): LucideIcon {
  if (app.source === 'developer') {
    return Hammer;
  }

  if (app.operationStatus === 'failed') {
    return OctagonX;
  }

  return getAppIcon(app.icon);
}

function getAppMenuActionPath(action: AppMenuLifecycleAction) {
  return action === 'update-retry' ? 'update/retry' : action;
}

function formatAppMenuActionVerb(action: AppMenuLifecycleAction) {
  switch (action) {
    case 'update-retry':
      return 'retry update for';
    case 'retry':
      return 'retry install for';
    default:
      return action;
  }
}

function formatAppMenuSuccessMessage(action: AppMenuLifecycleAction, displayName: string) {
  switch (action) {
    case 'start':
      return `${displayName} started.`;
    case 'restart':
      return `${displayName} restarted.`;
    case 'retry':
      return `${displayName} install retry started.`;
    case 'update-retry':
      return `${displayName} update retry started.`;
  }
}

function formatAppMenuFailureMessage(action: AppMenuLifecycleAction, displayName: string) {
  switch (action) {
    case 'start':
      return `Could not start ${displayName}.`;
    case 'restart':
      return `Could not restart ${displayName}.`;
    case 'retry':
      return `Could not retry ${displayName} install.`;
    case 'update-retry':
      return `Could not retry ${displayName} update.`;
  }
}

function formatAppMenuActionError(error: ModuleOperationError | null, fallback: string) {
  if (!error) {
    return fallback;
  }

  return [
    error.message,
    error.dockerMessage,
    error.nextStep,
  ].filter(Boolean).join(' ') || fallback;
}

function getAccountInitials(user: HostPrincipal) {
  const source = user.displayName || user.email || user.id;
  const parts = source
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return 'U';
  }

  return parts
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('');
}

function getAccountAvatarStyle(source: string): CSSProperties {
  const backgroundColor = stringToAvatarHexColor(source);

  return {
    backgroundColor,
    color: getReadableTextColor(backgroundColor),
  };
}

function stringToAvatarHexColor(source: string) {
  let hash = 0;

  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }

  const hue = Math.abs(hash) % 360;

  return hslToHex(hue, 64, 42);
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const normalizedSaturation = saturation / 100;
  const normalizedLightness = lightness / 100;
  const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
  const huePrime = hue / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const m = normalizedLightness - chroma / 2;
  const [red, green, blue] = huePrime < 1
    ? [chroma, x, 0]
    : huePrime < 2
      ? [x, chroma, 0]
      : huePrime < 3
        ? [0, chroma, x]
        : huePrime < 4
          ? [0, x, chroma]
          : huePrime < 5
            ? [x, 0, chroma]
            : [chroma, 0, x];

  return `#${[red, green, blue]
    .map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function getReadableTextColor(hexColor: string) {
  const red = parseInt(hexColor.slice(1, 3), 16);
  const green = parseInt(hexColor.slice(3, 5), 16);
  const blue = parseInt(hexColor.slice(5, 7), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

  return luminance > 0.55 ? '#111827' : '#ffffff';
}

function getAppIcon(iconKey?: string): LucideIcon {
  switch (iconKey) {
    case 'bar-chart':
    case 'chart':
    case 'reports':
      return BarChart3;
    case 'boxes':
    case 'modules':
      return Boxes;
    case 'settings':
      return Settings;
    case 'users':
    case 'people':
      return Users;
    case 'document':
    case 'docs':
      return ScrollText;
    default:
      return LayoutGrid;
  }
}

function normalizeSelectedAppPath(path: string | null) {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return '/';
  }

  return path;
}
