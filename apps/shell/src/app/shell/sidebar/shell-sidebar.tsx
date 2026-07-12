"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Gauge,
  Home,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getAccountInitials, getAppPageLinks, resolveAssetSrc } from "../app-helpers";
import { AppIcon } from "../app-icon";
import { NotificationBell } from "../notifications/notification-bell";
import type { AppOpenTarget, AppPageLink, CoreApp, EmbeddedWorkspace, SessionResponse, ShellView } from "../types";

export function ShellSidebar({
  compact,
  activeView,
  workspace,
  coreOrigin,
  coreOnline,
  coreVersion,
  shellVersion,
  activeUser,
  canManageApps,
  runtimeApps,
  systemApps,
  busyAction,
  onCompactChange,
  onNavigate,
  onLaunchApp,
  getStandaloneHref,
  onOpenPlatform,
}: {
  compact: boolean;
  activeView: ShellView;
  workspace: EmbeddedWorkspace | null;
  coreOrigin: string;
  coreOnline: boolean;
  coreVersion: string | null;
  shellVersion: string;
  activeUser: SessionResponse["user"] | null;
  canManageApps: boolean;
  runtimeApps: CoreApp[];
  // UI-capable system apps for the admin-only System group; empty for non-admins and when no
  // installed system app declares UI, in which case the group is hidden entirely.
  systemApps: CoreApp[];
  busyAction: string | null;
  onCompactChange: (compact: boolean) => void;
  onNavigate: (view: ShellView) => void;
  onLaunchApp: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
  // Opens the platform panel (Extensions, docs/ideas/generic-bootstrap.md Phase 3). Undefined for
  // non-admins, which leaves the version block as plain text.
  onOpenPlatform?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("relative flex h-18 shrink-0 items-center border-b px-3", compact ? "justify-center" : "gap-2")}>
        <button
          type="button"
          className={cn("flex min-w-0 items-center gap-3 rounded-md focus-visible:ring-ring/50 focus-visible:ring-[3px]", compact && "justify-center")}
          onClick={() => onNavigate(canManageApps ? "dashboard" : "available-apps")}
          title="Hosty"
        >
          <BrandMark />
          {!compact && (
            <span className="block truncate text-sm font-semibold uppercase">Hosty</span>
          )}
        </button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="absolute right-0 top-1/2 z-20 size-7 -translate-y-1/2 translate-x-1/2 rounded-full bg-background shadow-sm"
          aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
          title={compact ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => onCompactChange(!compact)}
        >
          {compact ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <nav className={cn("min-h-0 flex-1 overflow-y-auto py-4", compact ? "px-2" : "px-3")} aria-label="Host navigation">
        <div className={cn(compact ? "space-y-4" : "space-y-6")}>
          {canManageApps && (
            <NavigationSection title="Host" compact={compact}>
              <SidebarButton compact={compact} active={activeView === "dashboard" && !workspace} icon={Gauge} label="Dashboard" onClick={() => onNavigate("dashboard")} />
              <SidebarButton compact={compact} active={activeView === "installed-apps" && !workspace} icon={Boxes} label="Installed Apps" onClick={() => onNavigate("installed-apps")} />
              <SidebarButton compact={compact} active={activeView === "users"} icon={Users} label="User Management" onClick={() => onNavigate("users")} />
            </NavigationSection>
          )}

          {canManageApps && systemApps.length > 0 && (
            <NavigationSection title="System" compact={compact}>
              {systemApps.map((app) => (
                <AppNavigationItem
                  key={app.id}
                  app={app}
                  coreOrigin={coreOrigin}
                  compact={compact}
                  busyAction={busyAction}
                  workspace={workspace}
                  onLaunch={onLaunchApp}
                  getStandaloneHref={getStandaloneHref}
                />
              ))}
            </NavigationSection>
          )}

          <NavigationSection title="Apps" compact={compact}>
            {runtimeApps.length === 0 ? (
              <NavigationPlaceholder compact={compact} icon={LayoutGrid} label="No apps registered" />
            ) : (
              runtimeApps.map((app) => (
                <AppNavigationItem
                  key={app.id}
                  app={app}
                  coreOrigin={coreOrigin}
                  compact={compact}
                  busyAction={busyAction}
                  workspace={workspace}
                  onLaunch={onLaunchApp}
                  getStandaloneHref={getStandaloneHref}
                />
              ))
            )}
          </NavigationSection>
        </div>
      </nav>

      <div className={cn("shrink-0 border-t", compact ? "space-y-2 px-2 py-3" : "space-y-3 p-3")}>
        <SidebarFooterAccount compact={compact} coreOrigin={coreOrigin} activeUser={activeUser} />
        <SidebarVersionInfo compact={compact} coreOnline={coreOnline} coreVersion={coreVersion} shellVersion={shellVersion} onOpenPlatform={onOpenPlatform} />
      </div>
    </div>
  );
}

function SidebarVersionInfo({
  compact,
  coreOnline,
  coreVersion,
  shellVersion,
  onOpenPlatform,
}: {
  compact: boolean;
  coreOnline: boolean;
  coreVersion: string | null;
  shellVersion: string;
  onOpenPlatform?: () => void;
}) {
  // A reachable Core that predates the version field reports no version, so only call it
  // "offline" when Core is genuinely unreachable; otherwise the version is just unknown.
  const platformLabel = coreVersion
    ? `Core/CLI v${coreVersion}`
    : coreOnline
      ? "Core/CLI version unknown"
      : "Core/CLI offline";
  const shellLabel = shellVersion ? `Shell v${shellVersion}` : null;
  const title = shellLabel ? `${platformLabel} · ${shellLabel}` : platformLabel;

  const body = compact ? (
    <p className="text-center text-[10px] leading-tight" title={title}>
      {coreVersion ? `v${coreVersion}` : "—"}
    </p>
  ) : (
    <div className="text-[11px] leading-tight" title={title}>
      <p className="truncate">{platformLabel}</p>
      {shellLabel && <p className="truncate">{shellLabel}</p>}
    </div>
  );

  // Admins get the platform panel behind the version block (generic-bootstrap Phase 3); everyone
  // else keeps the plain read-only text.
  if (!onOpenPlatform) {
    return <div className={cn("text-muted-foreground", compact ? "" : "px-2")}>{body}</div>;
  }

  return (
    <button
      type="button"
      className={cn(
        "block w-full rounded-md text-left text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        compact ? "px-0 py-1 text-center" : "px-2 py-1",
      )}
      onClick={onOpenPlatform}
      title={`${title} — open platform settings`}
    >
      {body}
    </button>
  );
}

function BrandMark() {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center text-sidebar-foreground">
      <svg
        viewBox="0 0 100 100"
        aria-hidden
        className="size-9"
        fill="none"
        stroke="currentColor"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M25 36 V64 M75 36 V64 M25 50 H39 M61 50 H75" />
        <rect x="17" y="17" width="16" height="16" rx="4.5" />
        <rect x="67" y="17" width="16" height="16" rx="4.5" />
        <rect x="17" y="67" width="16" height="16" rx="4.5" />
        <rect x="67" y="67" width="16" height="16" rx="4.5" />
        <rect x="42" y="42" width="16" height="16" rx="4.5" />
      </svg>
    </span>
  );
}

function NavigationSection({ title, compact, children }: { title: string; compact: boolean; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className={cn("px-2 text-xs font-medium uppercase text-muted-foreground", compact && "sr-only")}>{title}</h2>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function SidebarButton({
  compact,
  active,
  icon: Icon,
  label,
  onClick,
}: {
  compact: boolean;
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md text-sm transition-colors",
        compact ? "justify-center px-0" : "px-2",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
      title={compact ? label : undefined}
      onClick={onClick}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!compact && <span className="truncate">{label}</span>}
    </button>
  );
}

function NavigationPlaceholder({ compact, icon: Icon, label }: { compact: boolean; icon: LucideIcon; label: string }) {
  return (
    <div className={cn("flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground", compact && "justify-center px-0")} title={label}>
      <Icon className="h-4 w-4 shrink-0" />
      {!compact && <span className="truncate">{label}</span>}
    </div>
  );
}

// Shared by the Apps and System sidebar groups: the page-link, launch, and disabled-state behavior
// is identical for both app kinds — only which list an app appears in differs.
function AppNavigationItem({
  app,
  coreOrigin,
  compact,
  busyAction,
  workspace,
  onLaunch,
  getStandaloneHref,
}: {
  app: CoreApp;
  coreOrigin: string;
  compact: boolean;
  busyAction: string | null;
  workspace: EmbeddedWorkspace | null;
  onLaunch: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const pages = getAppPageLinks(app);
  const primaryPage = pages[0] ?? null;
  const running = app.runtimeState === "running";
  const active = workspace?.appId === app.id;
  const canOpen = running && primaryPage !== null;
  const canOpenStandalone = canOpen;

  // Auto-expand the active app's page list when it becomes active, while still
  // letting the user collapse it. Adjust during render instead of in an effect.
  // https://react.dev/learn/you-might-not-need-an-effect
  const autoExpandSignature = `${active}:${compact}:${pages.length}`;
  const [prevAutoExpandSignature, setPrevAutoExpandSignature] = useState<string | null>(null);
  if (prevAutoExpandSignature !== autoExpandSignature) {
    setPrevAutoExpandSignature(autoExpandSignature);
    if (active && !compact && pages.length > 1) {
      setExpanded(true);
    }
  }

  return (
    <div className="space-y-1">
      <div className="group flex items-center gap-1">
        <button
          type="button"
          className={cn(
            "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-sm transition-colors",
            compact ? "justify-center px-0" : "px-2",
            active
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : canOpen
                ? "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                : "cursor-not-allowed text-muted-foreground opacity-70",
          )}
          disabled={!canOpen}
          title={canOpen ? app.displayName : `${app.displayName} is ${app.runtimeState || app.operationStatus}`}
          onClick={() => {
            if (primaryPage) {
              void onLaunch(app, primaryPage, "workspace");
            }
          }}
        >
          <AppIcon src={resolveAssetSrc(coreOrigin, app.iconUrl)} fallback={LayoutGrid} className="h-4 w-4 rounded-sm" alt="" />
          {!compact && (
            <span className="min-w-0 flex-1 truncate text-left">{app.displayName}</span>
          )}
        </button>
        {!compact && canOpenStandalone && primaryPage && (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 focus-visible:opacity-100"
          >
            <a
              href={getStandaloneHref(app, primaryPage)}
              target="_blank"
              rel="noreferrer"
              title={`Open ${app.displayName} standalone`}
              aria-label={`Open ${app.displayName} standalone`}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        )}
        {!compact && pages.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${app.displayName} pages`}
            aria-expanded={expanded}
            title={`${expanded ? "Collapse" : "Expand"} ${app.displayName} pages`}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronRight className={cn("h-4 w-4 transition-transform", expanded && "rotate-90")} />
          </Button>
        )}
      </div>
      {!compact && expanded && pages.length > 1 && (
        <div className="ml-6 space-y-1 border-l pl-2">
          {pages.map((page) => (
            <button
              key={`${app.id}:${page.path}`}
              type="button"
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                workspace?.appId === app.id && workspace.path === page.path && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              disabled={busyAction === `${app.id}:open`}
              onClick={() => void onLaunch(app, page, "workspace")}
            >
              {busyAction === `${app.id}:open` ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <AppIcon src={resolveAssetSrc(coreOrigin, page.iconUrl)} fallback={Home} className="h-3.5 w-3.5 rounded-sm" alt="" />
              )}
              <span className="truncate">{page.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarFooterAccount({
  compact,
  coreOrigin,
  activeUser,
}: {
  compact: boolean;
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
}) {
  const accountLabel = activeUser?.displayName || activeUser?.email || "Anonymous";
  const accountDescription = activeUser?.email && activeUser.email !== accountLabel ? activeUser.email : activeUser?.role || "No active session";

  if (!activeUser) {
    return (
      <div className="space-y-2">
        <ThemeMenuButton compact={compact} />
        <Button asChild variant={compact ? "ghost" : "outline"} size={compact ? "icon-lg" : "default"} className={cn(!compact && "w-full justify-start")}>
          <a href={`${coreOrigin}/login`} title="Login">
            <LogIn className="h-4 w-4" />
            {!compact && "Login"}
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <NotificationBell compact={compact} />
      <ThemeMenuButton compact={compact} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={compact ? "ghost" : "outline"}
            size={compact ? "icon-lg" : "default"}
            className={cn(compact ? "mx-auto flex size-11 rounded-md" : "h-auto w-full justify-start px-3 py-2 text-left")}
            title={compact ? accountLabel : undefined}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-rose-600 text-xs font-semibold text-white">
              {getAccountInitials(activeUser)}
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
            <span className="block truncate text-xs font-normal text-muted-foreground">{accountDescription}</span>
            <Badge variant="outline">{activeUser.role}</Badge>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a href={`${coreOrigin}/logout`}>
              <LogOut className="h-4 w-4" />
              Logout
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ThemeMenuButton({ compact }: { compact: boolean }) {
  const { theme, setTheme } = useTheme();
  const selectedTheme = theme || "system";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon-lg" : "default"}
          className={cn(compact ? "mx-auto flex size-11" : "w-full justify-start")}
          title="Theme"
        >
          <Monitor className="h-4 w-4" />
          {!compact && <span>Theme</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-44">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={selectedTheme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun className="h-4 w-4" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="h-4 w-4" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="h-4 w-4" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
