"use client";

import { useSyncExternalStore, useState } from "react";
import { useHostyUiHost, useHostyChrome } from "@hosty-sdk/app/ui/react";
import { PanelLeft, Pin, PanelsTopLeft, Plus, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AppIcon } from "../app-icon";
import { panelKey, type UiPanel } from "@hosty-sdk/app/ui/types";
import type { UiHostSnapshot } from "@hosty-sdk/app/ui/host";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand-mark";
import { NotificationBell } from "../notifications/notification-bell";
import { ThemeMenuButton } from "./theme-menu-button";

import { usePanelPreferences } from "./panel-preferences";
import { useToolActivity, ToolActivityMark, ToolsActivityBadge } from "./tool-activity";
import { PinnedToolButtons } from "./pinned-tool-buttons";

const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};

// The strip aligns navigation and the page title with the workspace. Notifications, theme and
// pinned tools stay at the opposite edge.
//
// Shell chrome, entirely. Apps contribute nothing to it: an app that could write here would be
// writing outside its frame, which is the one thing the embedding contract exists to prevent.
export function ShellTopStrip({
  title,
  subtitle,
  leftRailExpanded,
  navigationWidth,
  onToggleLeftRail,
  rightRailExpanded,
  showNotifications,
  onBrandClick,
}: {
  title: string;
  subtitle?: string | null;
  leftRailExpanded: boolean;
  navigationWidth: 60 | 280;
  onToggleLeftRail: () => void;
  /** Null when no installed app declares a panel surface — then the rail does not exist to toggle. */
  rightRailExpanded: boolean | null;
  showNotifications: boolean;
  /** The mark doubles as the way home, which is what it did in the sidebar header it came from. */
  onBrandClick: () => void;
}) {
  const chrome = useHostyChrome();
  const host = useHostyUiHost();
  const snapshot = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => empty), () => empty);
  const [toolError, setToolError] = useState<string | null>(null);
  const workspace = snapshot.workspaces?.find(item => item.workspaceId === "default");
  const selected = snapshot.tools.find(item => item.presentationId === workspace?.selectedId);
  const preferences = usePanelPreferences();
  const pinned = preferences.ready ? snapshot.catalog.filter(preferences.isPinned) : [];
  function openTool(item: UiPanel, toggle = false) {
    if (toggle && workspace?.expanded && selected?.key === panelKey(item.panel)) { host?.collapseWorkspace("default"); return; }
    void host?.selectPanel(item.panel).then(result => setToolError(result.status === "opened" ? null : `${item.appName}: ${item.available ? "could not open tool" : item.state}.`));
  }
  const activity = useToolActivity();

  const showPanelToggle = chrome.tools.enabled && chrome.tools.launcher !== "hide";
  return (
    <header className="flex h-12 shrink-0 items-center pr-3 text-sidebar-foreground">
      <div className="shrink-0 pl-5" style={{ width: navigationWidth }}>
        <button
          type="button"
          onClick={onBrandClick}
          title="Hosty"
          aria-label="Hosty"
          className="flex shrink-0 items-center gap-2 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0 focus-visible:ring-brand"
        >
          <BrandMark />
          {navigationWidth === 280 && <span className="text-sm font-semibold uppercase">Hosty</span>}
        </button>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onToggleLeftRail}
          title={leftRailExpanded ? "Collapse the sidebar" : "Expand the sidebar"}
          aria-label={leftRailExpanded ? "Collapse the sidebar" : "Expand the sidebar"}
          aria-pressed={leftRailExpanded}
          className={cn(leftRailExpanded && "bg-background text-foreground")}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>

        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {subtitle && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{subtitle}</span>}
        </div>
      </div>

      <div className={cn("flex min-w-0 items-center justify-end gap-1", showPanelToggle && rightRailExpanded !== null ? "min-[600px]:w-3/5" : "shrink-0")}>

        {showPanelToggle && rightRailExpanded !== null && <div className="hidden min-w-0 flex-1 items-center gap-1 min-[600px]:flex">
          <PinnedToolButtons panels={pinned} selectedKey={workspace?.expanded ? selected?.key : undefined} onSelect={item => openTool(item, true)} />
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="shrink-0" aria-label="Tools"><PanelsTopLeft className="size-4" /><span className="hidden sm:inline">Tools</span><ToolsActivityBadge values={snapshot.catalog.map(activity.read)} /><ChevronDown className="size-3" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70dvh] w-64 overflow-y-auto">
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Pin tools to the top bar</p>
              {preferences.error && <p role="status" className="px-2 py-1.5 text-xs text-warning-foreground">{preferences.error}</p>}
              {!snapshot.catalog.length && <p role="status" className="px-2 py-2 text-sm text-muted-foreground">{snapshot.error ? "Tools could not be loaded. Use All tools to retry." : snapshot.bootstrap ? "No tools are available for your account." : "Loading tools…"}</p>}
              {snapshot.catalog.map(item => <div key={panelKey(item.panel)} className="flex items-stretch gap-1">
                <DropdownMenuItem className="min-w-0 flex-1" onSelect={() => openTool(item)}>
                  <AppIcon src={null} name={item.icon} fallback={PanelsTopLeft} className="size-4" /><span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span><span className="block truncate text-xs text-muted-foreground">{item.appName}{!item.available && ` · ${item.state}`}</span></span>
                  <ToolActivityMark activity={activity.read(item)} />
                </DropdownMenuItem>
                <DropdownMenuItem role="menuitemcheckbox" aria-checked={preferences.isPinned(item)} disabled={!preferences.ready}
                  aria-label={`Pin ${item.appName} — ${item.label} to top bar`} title={preferences.isPinned(item) ? "Unpin from top bar" : "Pin to top bar"}
                  className={cn("shrink-0 justify-center px-2", preferences.isPinned(item) && "bg-brand-soft text-brand-foreground")}
                  onSelect={event => { event.preventDefault(); preferences.setPinned(item, !preferences.isPinned(item)); }}>
                  <Pin className={cn("size-4", preferences.isPinned(item) && "fill-current")} />
                </DropdownMenuItem>
              </div>)}
              <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { setToolError(null); void host?.openToolPicker({ requestId: crypto.randomUUID() }); }}><Plus className="size-4" />All tools</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {toolError && <div role="alert" className="absolute top-12 right-3 z-50 max-w-sm rounded-lg border bg-popover p-3 text-sm">{toolError}<Button variant="ghost" size="sm" onClick={() => setToolError(null)}>Dismiss</Button></div>}
        </div>}
        <div className="flex shrink-0 items-center gap-1">{showNotifications && <NotificationBell />}<ThemeMenuButton /></div>
      </div>
    </header>
  );
}
