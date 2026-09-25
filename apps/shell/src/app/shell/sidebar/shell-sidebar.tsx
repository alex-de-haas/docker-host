"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useCompactMenu } from "./use-compact-menu";
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
  Play,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getAccountInitials, getAppPageLinks, resolveAssetSrc } from "../app-helpers";
import { AppIcon } from "../app-icon";
import { isAppBusy } from "../runtime-states";
import { SettingsNavigation } from "./settings-navigation";
import { resolveLaunchGate, type AppSurfaceTab } from "../surfaces/app-surface-tabs";
import type { AppOpenTarget, AppPageLink, CoreApp, EmbeddedWorkspace, SessionResponse, ShellView } from "../types";

export function ShellSidebar({
  compact,
  activeView,
  workspace,
  coreOrigin,
  activeUser,
  canManageApps,
  uiApps,
  busyAction,
  onNavigate,
  settingsPages,
  selectedSettings,
  onOpenSettings,
  onOpenApps,
  onLaunchApp,
  onStartApp,
  getStandaloneHref,
}: {
  compact: boolean;
  activeView: ShellView;
  workspace: EmbeddedWorkspace | null;
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
  canManageApps: boolean;
  // Every UI-capable app this session may see, ordinary and system alike, minus the Shell itself.
  // Named for what it holds rather than for "runtime apps", which it stopped meaning when the System
  // group went away: Core already filters the list per user and refuses a launch code for a system
  // app to anyone but an administrator, so a second split here would copy an authorization decision.
  uiApps: CoreApp[];
  busyAction: string | null;
  onNavigate: (view: ShellView) => void;
  settingsPages: AppSurfaceTab[];
  selectedSettings: string;
  onOpenSettings(key: string): void;
  onOpenApps: () => void;
  onLaunchApp: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  /**
   * Starts a stopped app from its own row. Undefined for a user who cannot start apps — Core refuses
   * them, so the control would only ever fail; the same rule the right panel's start action follows.
   */
  onStartApp?: (appId: string) => void;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
  // Opens the assistant chat panel. Undefined when no running app declares the ai-gateway interface
  // or the viewer is not an admin — the launcher then simply does not exist.
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-label="Host navigation">
        <div className={cn(compact ? "space-y-4" : "space-y-6")}>
          <NavigationSection title="Host" compact={compact}>
            {canManageApps && <SidebarButton compact={compact} active={activeView === "dashboard" && !workspace} icon={Gauge} label="Dashboard" onClick={() => onNavigate("dashboard")} />}
            <SettingsNavigation compact={compact} active={activeView === "settings" && !workspace} selected={selectedSettings} pages={settingsPages} canManageApps={canManageApps} onSelect={onOpenSettings} />
          </NavigationSection>

          {/* The heading is the overview and the rows are the shortcuts — the same pair the native
              client's Apps tab makes. Collapsed, headings are not rendered at all, so the rail gets
              its own control rather than losing the route. */}
          <NavigationSection
            title="Apps"
            compact={compact}
            onTitleClick={onOpenApps}
            titleActive={activeView === "available-apps" && !workspace}
          >
            {/* Boxes, not the LayoutGrid the app rows fall back to: collapsed, the overview control
                sits directly above those rows, and an icon-less app would be indistinguishable from
                the heading that leads to the page listing it. */}
            {compact && (
              <SidebarButton
                compact
                active={activeView === "available-apps" && !workspace}
                icon={Boxes}
                label="All apps"
                onClick={onOpenApps}
              />
            )}
            {uiApps.length === 0 ? (
              <NavigationPlaceholder compact={compact} icon={LayoutGrid} label="No apps registered" />
            ) : (
              uiApps.map((app) => (
                <AppNavigationItem
                  key={app.id}
                  app={app}
                  coreOrigin={coreOrigin}
                  compact={compact}
                  busyAction={busyAction}
                  workspace={workspace}
                  onLaunch={onLaunchApp}
                  onStartApp={onStartApp}
                  getStandaloneHref={getStandaloneHref}
                />
              ))
            )}
          </NavigationSection>
        </div>
      </nav>

      <div className={cn("shrink-0 p-3", compact ? "space-y-2" : "space-y-3")}>
        <SidebarFooterAccount compact={compact} coreOrigin={coreOrigin} activeUser={activeUser} />
      </div>
    </div>
  );
}


function NavigationSection({
  title,
  compact,
  onTitleClick,
  titleActive,
  children,
}: {
  title: string;
  compact: boolean;
  onTitleClick?: () => void;
  titleActive?: boolean;
  children: ReactNode;
}) {
  const headingClass = cn("px-2 text-xs font-medium uppercase text-muted-foreground", compact && "sr-only");

  return (
    <div className="space-y-2">
      {onTitleClick ? (
        <h2 className={compact ? "sr-only" : undefined}>
          <button
            type="button"
            onClick={onTitleClick}
            className={cn(
              headingClass,
              "w-full rounded-md py-0.5 text-left transition-colors hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px]",
              titleActive && "text-foreground",
            )}
          >
            {title}
          </button>
        </h2>
      ) : (
        <h2 className={headingClass}>{title}</h2>
      )}
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
        "px-2",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
      title={compact ? label : undefined}
      // Compact rows render no text, so the accessible name has to come from aria-label: a title
      // attribute is a tooltip, not a name assistive tech can be relied on to announce.
      aria-label={compact ? label : undefined}
      onClick={onClick}
    >
      <Icon className="h-5 w-5 shrink-0" />
      {!compact && <span className="truncate">{label}</span>}
    </button>
  );
}

function NavigationPlaceholder({ compact, icon: Icon, label }: { compact: boolean; icon: LucideIcon; label: string }) {
  return (
    <div className="flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground" title={label}>
      <Icon className="h-5 w-5 shrink-0" />
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
  onStartApp,
  getStandaloneHref,
}: {
  app: CoreApp;
  coreOrigin: string;
  compact: boolean;
  busyAction: string | null;
  workspace: EmbeddedWorkspace | null;
  onLaunch: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  onStartApp?: (appId: string) => void;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const pages = getAppPageLinks(app);
  const primaryPage = pages[0] ?? null;
  const running = app.runtimeState === "running";
  const active = workspace?.appId === app.id;
  // Opens by the readiness of the service that serves the primary page, not by the app's state: a
  // page whose service is still inside its readiness budget would render a connection error, and a
  // page whose service is alive stays openable through a sibling's outage (app-readiness).
  const gate = primaryPage ? resolveLaunchGate(app, primaryPage.service) : null;
  const canOpen = gate?.allowed ?? false;
  // This tab's own click, not the app's server-side state: the row settles when Core reports the app
  // running, and until then the spinner says the request left.
  const starting = busyAction === `${app.id}:start`;
  // Server-side state, so it is true for every administrator in every tab: "not running" also admits
  // an app that is mid-start or still shutting down, and a Start sent then races the verb already in
  // flight. Same predicate the Dashboard's lifecycle controls disable on.
  const transitioning = isAppBusy(app.runtimeState);
  const canOpenStandalone = canOpen;
  // Tooltip text, and — collapsed, where the row is only its icon — its accessible name too.
  const rowLabel = canOpen
    ? app.displayName
    : gate?.up
      ? `${app.displayName} is starting`
      : `${app.displayName} is ${app.runtimeState || app.operationStatus}`;

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

  if (compact && canOpen && primaryPage && pages.length > 1) {
    return (
      <CompactAppMenu
        app={app}
        coreOrigin={coreOrigin}
        pages={pages}
        active={active}
        busyAction={busyAction}
        workspace={workspace}
        onLaunch={onLaunch}
        getStandaloneHref={getStandaloneHref}
      />
    );
  }

  return (
    <div className="space-y-1">
      <div className="group flex items-center gap-1">
        <button
          type="button"
          className={cn(
            "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-sm transition-colors",
            "px-2",
            active
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : canOpen
                ? "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                : "cursor-not-allowed text-muted-foreground opacity-70",
          )}
          disabled={!canOpen}
          title={rowLabel}
          aria-label={compact ? rowLabel : undefined}
          onClick={() => {
            if (primaryPage) {
              void onLaunch(app, primaryPage, "workspace");
            }
          }}
        >
          <AppIcon src={resolveAssetSrc(coreOrigin, app.iconUrl)} name={app.icon} fallback={LayoutGrid} className="h-5 w-5 shrink-0 rounded-sm" alt="" />
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
        {/* A stopped app's pages lead nowhere, so the slot that expands them carries the one action
            that does: start it. Offered only to a user who can — Core refuses everyone else — and
            the row itself stays disabled, since the app is still not open-able until it answers.
            While a verb is already in flight the control reports it instead: an app mid-start is not
            running either, and offering Start there would race the start already under way. */}
        {!compact && !running && onStartApp && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0"
            disabled={starting || transitioning}
            aria-label={transitioning ? rowLabel : `Start ${app.displayName}`}
            title={transitioning ? rowLabel : `Start ${app.displayName}`}
            onClick={() => onStartApp(app.id)}
          >
            {starting || transitioning ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
        )}
        {!compact && running && pages.length > 1 && (
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
      {/* Gated on `running` as well as on `expanded`: an app stopped while its pages were open would
          otherwise leave a list of launch buttons behind, each one a request Core cannot serve. */}
      {!compact && running && expanded && pages.length > 1 && (
        <div className="ml-[18px] space-y-1 border-l pl-2">
          {pages.map((page) => (
            <button
              key={`${app.id}:${page.path}`}
              type="button"
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                workspace?.appId === app.id && workspace.path === page.path && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              disabled={busyAction === `${app.id}:open` || !resolveLaunchGate(app, page.service).allowed}
              onClick={() => void onLaunch(app, page, "workspace")}
            >
              {busyAction === `${app.id}:open` ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <AppIcon src={resolveAssetSrc(coreOrigin, page.iconUrl)} fallback={Home} className="h-4 w-4 rounded-sm" alt="" />
              )}
              <span className="truncate">{page.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact-rail item for a running app with more than one page: the icon triggers a flyout instead
// of launching directly, because the rail has no room for the page list or the standalone-open
// control. The flyout opens on click (Radix's own path — also keyboard and touch) and on hover
// after a delay as a mouse-only accelerator.
function CompactAppMenu({
  app,
  coreOrigin,
  pages,
  active,
  busyAction,
  workspace,
  onLaunch,
  getStandaloneHref,
}: {
  app: CoreApp;
  coreOrigin: string;
  pages: AppPageLink[];
  active: boolean;
  busyAction: string | null;
  workspace: EmbeddedWorkspace | null;
  onLaunch: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
}) {
  const menu = useCompactMenu();

  return (
    <DropdownMenu {...menu.menuProps}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-h-9 w-full min-w-0 items-center rounded-md px-2 text-sm transition-colors",
            active
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
          title={app.displayName}
          aria-label={app.displayName}
          {...menu.triggerProps}
        >
          <AppIcon src={resolveAssetSrc(coreOrigin, app.iconUrl)} name={app.icon} fallback={LayoutGrid} className="h-5 w-5 shrink-0 rounded-sm" alt="" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="w-56"
        {...menu.contentProps}
      >
        <DropdownMenuLabel className="truncate">{app.displayName}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {pages.map((page) => {
          const busy = busyAction === `${app.id}:open`;
          const activePage = workspace?.appId === app.id && workspace.path === page.path;
          return (
            <DropdownMenuItem
              key={`${app.id}:${page.path}`}
              disabled={busy}
              className={cn(activePage && "bg-accent text-accent-foreground")}
              onSelect={() => void onLaunch(app, page, "workspace")}
            >
              {busy ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <AppIcon src={resolveAssetSrc(coreOrigin, page.iconUrl)} fallback={Home} className="h-4 w-4 rounded-sm" alt="" />
              )}
              <span className="truncate">{page.label}</span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={getStandaloneHref(app, pages[0])} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
            Open standalone
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Logs out via the CSRF-protected POST /api/auth/logout (C-L2), then navigates to Core's login page.
// The CSRF token is a cookie+header double-submit pair; a concurrent CSRF-protected operation elsewhere
// in the Shell can refresh (overwrite) the cookie between our token fetch and the POST, so a single 403
// is retried once with a fresh token before giving up. The redirect runs regardless of the outcome —
// the destination is the same and leaving the user on a half-logged-out sidebar is worse.
async function logout(coreOrigin: string) {
  const postLogout = async () => {
    const csrfResponse = await fetch(`${coreOrigin}/api/auth/csrf`, { credentials: "include" });
    const { token } = (await csrfResponse.json()) as { token: string };
    return fetch(`${coreOrigin}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "X-Hosty-CSRF": token },
    });
  };

  try {
    let response = await postLogout();
    if (response.status === 403) {
      response = await postLogout();
    }
  } catch {
    // Ignore — navigate to login regardless below.
  } finally {
    window.location.href = `${coreOrigin}/login`;
  }
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
        <Button asChild variant={compact ? "ghost" : "outline"} size={compact ? "icon" : "default"} className={cn(compact ? "mx-auto flex size-9" : "w-full justify-start")}>
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={compact ? "ghost" : "outline"}
            size={compact ? "icon" : "default"}
            className={cn(compact ? "mx-auto flex size-9 rounded-md" : "h-auto w-full justify-start px-3 py-2 text-left")}
            title={compact ? accountLabel : undefined}
          >
            <span className={cn("flex shrink-0 items-center justify-center rounded-md bg-rose-600 font-semibold text-white", compact ? "size-7 text-[10px]" : "size-9 text-xs")}>
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
          <DropdownMenuItem
            onSelect={(event) => {
              // Logout is a state change, so it goes through the CSRF-protected POST rather than a GET
              // link (C-L2): fetch a token, POST it, then land on Core's login page regardless of the
              // POST's outcome (an already-expired session logs out to the same place).
              event.preventDefault();
              void logout(coreOrigin);
            }}
          >
            <LogOut className="h-4 w-4" />
            Logout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
