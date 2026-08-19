"use client";

import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NotificationBell } from "../notifications/notification-bell";
import { ThemeMenuButton } from "./theme-menu-button";

// The strip that caps the two rails, and owns what belongs to neither: the rail toggles at its ends,
// and between them what is true of the whole window — whose page is on screen, notifications, theme.
//
// Shell chrome, entirely. Apps contribute nothing to it: an app that could write here would be
// writing outside its frame, which is the one thing the embedding contract exists to prevent.
export function ShellTopStrip({
  title,
  subtitle,
  leftRailExpanded,
  onToggleLeftRail,
  rightRailExpanded,
  onToggleRightRail,
  showNotifications,
}: {
  title: string;
  subtitle?: string | null;
  leftRailExpanded: boolean;
  onToggleLeftRail: () => void;
  /** Null when no installed app declares a panel surface — then the rail does not exist to toggle. */
  rightRailExpanded: boolean | null;
  onToggleRightRail: () => void;
  showNotifications: boolean;
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-sidebar px-2 text-sidebar-foreground">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onToggleLeftRail}
        title={leftRailExpanded ? "Collapse the sidebar" : "Expand the sidebar"}
        aria-label={leftRailExpanded ? "Collapse the sidebar" : "Expand the sidebar"}
        aria-pressed={leftRailExpanded}
      >
        <PanelLeft className="h-4 w-4" />
      </Button>

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
      </div>

      <div className="flex items-center gap-1">
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
