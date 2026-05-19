'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Boxes,
  ChevronDown,
  Gauge,
  Globe2,
  LayoutGrid,
  LogOut,
  Menu,
  PackagePlus,
  PanelsTopLeft,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { HostPrincipal } from '@/types/auth';

const AdminPrincipalContext = createContext<HostPrincipal | null>(null);

export function AdminPrincipalProvider({
  user,
  children,
}: {
  user: HostPrincipal;
  children: ReactNode;
}) {
  return (
    <AdminPrincipalContext.Provider value={user}>
      {children}
    </AdminPrincipalContext.Provider>
  );
}

export function useAdminPrincipal() {
  const user = useContext(AdminPrincipalContext);
  if (!user) {
    throw new Error('useAdminPrincipal must be used within AdminPrincipalProvider.');
  }

  return user;
}

export function AdminShell({
  title,
  description,
  actions,
  children,
  contentClassName,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}) {
  const user = useAdminPrincipal();
  const accountLabel = user.email || user.displayName || user.id;
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <div className="min-h-dvh bg-muted/30 lg:grid lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh border-r bg-sidebar text-sidebar-foreground lg:block">
        <AdminSidebar onNavigate={() => undefined} />
      </aside>

      <Dialog open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <DialogContent
          className="left-0 top-0 h-dvh w-80 max-w-[85vw] translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-l-0 border-r bg-sidebar p-0 text-sidebar-foreground shadow-xl sm:max-w-80"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Admin navigation</DialogTitle>
          <DialogDescription className="sr-only">
            Navigate between Host tools, module management, apps, and settings.
          </DialogDescription>
          <AdminSidebar
            onNavigate={() => setMobileSidebarOpen(false)}
            closeButton={(
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close navigation"
                onClick={() => setMobileSidebarOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          />
        </DialogContent>
      </Dialog>

      <div className="min-w-0">
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex min-h-16 flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold leading-6">{title}</h1>
              {description && (
                <p className="truncate text-sm text-muted-foreground">{description}</p>
              )}
            </div>
            {actions && (
              <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
                {actions}
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="max-w-[11rem] px-2 sm:max-w-[16rem]">
                  <span className="min-w-0 truncate text-xs sm:text-sm">{accountLabel}</span>
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="space-y-1">
                  <span className="block truncate text-sm">{accountLabel}</span>
                  <Badge variant="outline">{user.role}</Badge>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={event => {
                    event.preventDefault();
                    void handleLogout();
                  }}
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className={cn('mx-auto w-full max-w-7xl space-y-8 px-4 py-6 sm:px-6 lg:px-8', contentClassName)}>
          {children}
        </main>
      </div>
    </div>
  );
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
        label: 'External ingress',
        href: '/ingress',
        icon: Globe2,
        isActive: pathname => pathname === '/ingress',
      },
    ],
  },
  {
    title: 'Modules',
    items: [
      {
        label: 'Installed modules',
        href: '/#installed-modules',
        icon: Boxes,
        isActive: pathname => pathname.startsWith('/modules/') && pathname !== '/modules/install',
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
    items: [
      {
        label: 'No apps registered',
        icon: LayoutGrid,
        disabled: true,
      },
    ],
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
    ],
  },
];

function AdminSidebar({
  onNavigate,
  closeButton,
}: {
  onNavigate: () => void;
  closeButton?: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between border-b px-4">
        <Link href="/" className="flex min-w-0 items-center gap-2" onClick={onNavigate}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <PanelsTopLeft className="h-5 w-5" />
          </span>
          <span className="min-w-0 truncate text-sm font-semibold">Docker Host</span>
        </Link>
        {closeButton}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-label="Admin navigation">
        <div className="space-y-6">
          {navigationSections.map(section => (
            <div key={section.title} className="space-y-2">
              <h2 className="px-2 text-xs font-medium uppercase text-muted-foreground">{section.title}</h2>
              <div className="space-y-1">
                {section.items.map(item => (
                  <NavigationLink
                    key={`${section.title}:${item.label}`}
                    item={item}
                    pathname={pathname}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}

function NavigationLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavigationItem;
  pathname: string;
  onNavigate: () => void;
}) {
  const active = item.isActive?.(pathname) ?? false;
  const Icon = item.icon;
  const className = cn(
    'flex min-h-9 items-center gap-2 rounded-md px-2 text-sm transition-colors',
    active
      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
    item.disabled && 'pointer-events-none text-muted-foreground opacity-60'
  );

  if (!item.href || item.disabled) {
    return (
      <div className={className} aria-disabled="true">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{item.label}</span>
      </div>
    );
  }

  return (
    <Link href={item.href} className={className} onClick={onNavigate}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate">{item.label}</span>
    </Link>
  );
}
