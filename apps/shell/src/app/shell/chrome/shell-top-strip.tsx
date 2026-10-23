"use client";

import { useSyncExternalStore, useState } from "react";
import { useHostyUiHost, useHostyChrome } from "@hosty-sdk/app/ui/react";
import { PanelLeft, Sparkles, PanelsTopLeft, Plus, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AppIcon } from "../app-icon";
import { panelKey } from "@hosty-sdk/app/ui/types";
import type { UiHostSnapshot } from "@hosty-sdk/app/ui/host";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand-mark";
import { NotificationBell } from "../notifications/notification-bell";
import { ThemeMenuButton } from "./theme-menu-button";

const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};

// The strip aligns navigation and the page title with the workspace. Notifications, theme and
// the right-panel toggle stay at the opposite edge.
//
// Shell chrome, entirely. Apps contribute nothing to it: an app that could write here would be
// writing outside its frame, which is the one thing the embedding contract exists to prevent.
export function ShellTopStrip({
  title,
  assistantAppId,
  subtitle,
  leftRailExpanded,
  navigationWidth,
  onToggleLeftRail,
  rightRailExpanded,
  onToggleRightRail,
  showNotifications,
  onBrandClick,
}: {
  title: string;
  assistantAppId?: string | null;
  subtitle?: string | null;
  leftRailExpanded: boolean;
  navigationWidth: 60 | 280;
  onToggleLeftRail: () => void;
  /** Null when no installed app declares a panel surface — then the rail does not exist to toggle. */
  rightRailExpanded: boolean | null;
  onToggleRightRail: () => void;
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
  const assistant = snapshot.catalog.find(item => item.panel.appId === assistantAppId);
  const attention = snapshot.tools.filter(item => item.workspaceId === "default").reduce((sum, item) => sum + item.attention, 0);

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

      <div className="flex shrink-0 items-center gap-1">
        {showNotifications && <NotificationBell />}
        <ThemeMenuButton />

        {showPanelToggle && rightRailExpanded !== null && <div className="hidden min-[600px]:flex">
          <Button type="button" variant="ghost" size="sm" onClick={assistant ? () => {
            if (workspace?.expanded && selected?.key === panelKey(assistant.panel)) host?.collapseWorkspace("default");
            else void host?.selectPanel(assistant.panel).then(result => setToolError(result.status === "opened" ? null : "Could not open the assistant. Use Tools to check its status."));
          } : onToggleRightRail} aria-label={rightRailExpanded ? "Hide the panel" : "Show the panel"} aria-pressed={rightRailExpanded}>
            <Sparkles className="size-4" /><span className="hidden sm:inline">Assistant</span>
          </Button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Tools"><PanelsTopLeft className="size-4" /><span className="hidden sm:inline">Tools</span>{attention > 0 && <span className="rounded-full bg-warning-soft px-1.5 text-xs text-warning-foreground">{attention}</span>}<ChevronDown className="size-3" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70dvh] w-64 overflow-y-auto">
              {snapshot.catalog.map(item => <DropdownMenuItem key={panelKey(item.panel)} onSelect={() => void host?.selectPanel(item.panel).then(result => setToolError(result.status === "opened" ? null : `${item.appName}: ${item.available ? "could not open tool" : item.state}.`))}>
                <AppIcon src={null} name={item.icon} fallback={PanelsTopLeft} className="size-4" /><span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span><span className="block truncate text-xs text-muted-foreground">{item.appName}{!item.available && ` · ${item.state}`}</span></span>
                {snapshot.tools.some(tool => tool.key === panelKey(item.panel) && tool.attention > 0) && <span className="text-warning-foreground" aria-label="Needs attention">!</span>}
              </DropdownMenuItem>)}
              <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { setToolError(null); void host?.openToolPicker({ requestId: crypto.randomUUID() }); }}><Plus className="size-4" />All tools</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {toolError && <div role="alert" className="absolute top-12 right-3 z-50 max-w-sm rounded-lg border bg-popover p-3 text-sm">{toolError}<Button variant="ghost" size="sm" onClick={() => setToolError(null)}>Dismiss</Button></div>}
        </div>}

      </div>
    </header>
  );
}
