"use client";

import { useState } from "react";
import { useCompactMenu } from "./use-compact-menu";
import { ChevronRight, Settings } from "lucide-react";
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
import {
  HOST_SETTINGS_SECTIONS,
  isNonAdminHostSettingsTab,
} from "../shell-routes";
import {
  resolveSettingsSurface,
  type AppSurfaceTab,
} from "../surfaces/app-surface-tabs";

export function SettingsNavigation({
  compact,
  active,
  selected,
  pages,
  canManageApps,
  onSelect,
}: {
  compact: boolean;
  active: boolean;
  selected: string;
  pages: AppSurfaceTab[];
  canManageApps: boolean;
  onSelect(key: string): void;
}) {
  const menu = useCompactMenu();
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? active;
  const hostSections = HOST_SETTINGS_SECTIONS.filter(
    (section) => canManageApps || isNonAdminHostSettingsTab(section.id),
  );
  const appPages = canManageApps ? pages : [];
  const resolved =
    resolveSettingsSurface(appPages, selected)?.key ??
    (hostSections.some((section) => section.id === selected)
      ? selected
      : hostSections[0]?.id);
  const isSelected = (key: string) => active && resolved === key;
  const rowClass = (key: string) =>
    cn(
      "flex min-h-8 w-full items-center rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      isSelected(key) && "bg-sidebar-accent text-sidebar-accent-foreground",
    );

  if (compact)
    return (
      <DropdownMenu {...menu.menuProps}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            title="Settings"
            aria-label="Settings"
            {...menu.triggerProps}
            className={cn(
              "size-9",
              active && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          {...menu.contentProps}
          side="right"
          align="start"
          className="max-h-[80dvh] w-64 overflow-y-auto"
        >
          <DropdownMenuLabel>Settings</DropdownMenuLabel>
          {hostSections.map((section) => (
            <DropdownMenuItem
              key={section.id}
              onSelect={() => onSelect(section.id)}
              aria-current={isSelected(section.id) ? "page" : undefined}
              className={cn(isSelected(section.id) && "bg-accent")}
            >
              {section.label}
            </DropdownMenuItem>
          ))}
          {appPages.length > 0 && <DropdownMenuSeparator />}
          {appPages.map((page) => (
            <DropdownMenuItem
              key={page.key}
              onSelect={() => onSelect(page.key)}
              aria-current={isSelected(page.key) ? "page" : undefined}
              className={cn(isSelected(page.key) && "bg-accent")}
            >
              {page.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpandedOverride(!expanded)}
        aria-expanded={expanded}
        aria-controls="settings-navigation"
        className={cn(
          "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-sidebar-accent",
          active && "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
      >
        <Settings className="h-4 w-4 shrink-0" />
        <span className="flex-1">Settings</span>
        <ChevronRight
          className={cn(
            "h-4 w-4 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div
          id="settings-navigation"
          className="ml-4 mt-1 space-y-1 border-l pl-2"
        >
          {hostSections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelect(section.id)}
              className={rowClass(section.id)}
              aria-current={isSelected(section.id) ? "page" : undefined}
            >
              {section.label}
            </button>
          ))}
          {appPages.map((page) => (
            <button
              key={page.key}
              type="button"
              onClick={() => onSelect(page.key)}
              className={cn(rowClass(page.key), !page.embeddedUrl && "opacity-60")}
              aria-current={isSelected(page.key) ? "page" : undefined}
            >
              {page.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
