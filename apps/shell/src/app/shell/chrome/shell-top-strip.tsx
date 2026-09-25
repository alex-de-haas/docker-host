"use client";

import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand-mark";
import { NotificationBell } from "../notifications/notification-bell";
import { ThemeMenuButton } from "./theme-menu-button";

// The strip aligns navigation and the page title with the workspace. Notifications, theme and
// the right-panel toggle stay at the opposite edge.
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
  onToggleRightRail,
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
  onToggleRightRail: () => void;
  showNotifications: boolean;
  /** The mark doubles as the way home, which is what it did in the sidebar header it came from. */
  onBrandClick: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center pr-3 text-sidebar-foreground">
      <div className="shrink-0 pl-5" style={{ width: navigationWidth }}>
        <button
          type="button"
          onClick={onBrandClick}
          title="Hosty"
          aria-label="Hosty"
          className="flex shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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

        {rightRailExpanded !== null && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onToggleRightRail}
            title={rightRailExpanded ? "Hide the panel" : "Show the panel"}
            aria-label={rightRailExpanded ? "Hide the panel" : "Show the panel"}
            aria-pressed={rightRailExpanded}
            className={cn(rightRailExpanded && "bg-background text-foreground")}
          >
            <PanelRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </header>
  );
}
