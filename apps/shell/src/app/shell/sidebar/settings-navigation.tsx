"use client";

import Link from "next/link";
import { Settings, UserRound, Server, ShieldCheck, PanelsTopLeft, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HOST_SETTINGS_SECTIONS, getAppSettingsHref, getHostSettingsSection, isNonAdminHostSettingsTab } from "../shell-routes";
import { resolveAssetSrc } from "../app-helpers";
import { AppIcon } from "../app-icon";
import type { CoreApp } from "../types";
import type { AppSurfaceTab } from "../surfaces/app-surface-tabs";

type SettingsNavigationProps = {
  compact: boolean; active: boolean; selected: string; pages: AppSurfaceTab[];
  apps?: { id: string; displayName: string }[]; canManageApps: boolean;
  onSelect(key: string): void;
};

// Settings owns its growing navigation; Shell keeps one stable destination.
export function SettingsNavigation({ compact, active, onSelect }: SettingsNavigationProps) {
  return <Button variant="ghost" size={compact ? "icon" : "default"} aria-label="Settings" title="Settings"
    aria-current={active ? "page" : undefined} onClick={() => onSelect("profile")}
    className={cn(compact ? "size-9" : "w-full justify-start px-2", active && "bg-sidebar-accent text-sidebar-accent-foreground")}>
    <Settings className="size-4 shrink-0" />{!compact && <span>Settings</span>}
  </Button>;
}

const icons = { profile: UserRound, host: Server, security: ShieldCheck, shell: PanelsTopLeft };
export function SettingsPageNavigation({ selected, canManageApps, pages, apps, coreOrigin, onSelect }: {
  selected: string; canManageApps: boolean; pages: AppSurfaceTab[];
  apps: Pick<CoreApp, "id" | "displayName" | "icon" | "iconUrl">[]; coreOrigin: string;
  onSelect(key: string): void;
}) {
  const active = getHostSettingsSection(selected)?.id;
  const appsById = new Map(apps.map(app => [app.id, app]));
  return <nav aria-label="Settings sections" className="settings-page-navigation min-h-0 max-h-full overflow-y-auto">
    <p className="px-3 py-2 text-xs font-medium text-muted-foreground">Settings</p>
    {HOST_SETTINGS_SECTIONS.filter(section => canManageApps || section.tabs.some(tab => isNonAdminHostSettingsTab(tab.id))).map(section => {
      const Icon = icons[section.id as keyof typeof icons];
      return <Button key={section.id} variant="ghost" className={cn("w-full justify-start", active === section.id && "bg-accent text-accent-foreground")}
        aria-current={active === section.id ? "page" : undefined} onClick={() => onSelect(section.tabs.find(tab => canManageApps || isNonAdminHostSettingsTab(tab.id))!.id)}>
        <Icon className="size-4" />{section.label}
      </Button>;
    })}
    {canManageApps && pages.length > 0 && <><p className="px-3 pt-5 pb-2 text-xs font-medium text-muted-foreground">Apps</p>
      {pages.map(page => {
        const app = appsById.get(page.appId);
        const label = app?.displayName?.trim() || page.appLabel || page.label || page.appId;
        const current = selected === page.key || selected === page.appId;
        return <Button asChild key={page.key} variant="ghost"
          className={cn("w-full min-w-0 justify-start max-[1000px]:w-auto", current && "bg-accent text-accent-foreground")}>
          <Link href={getAppSettingsHref(page.appId)} scroll={false} aria-current={current ? "page" : undefined} title={label}>
            <AppIcon src={resolveAssetSrc(coreOrigin, app?.iconUrl)} name={app?.icon ?? page.icon} fallback={Package} className="size-4" />
            <span className="truncate">{label}</span>
          </Link>
        </Button>;
      })}</>}
  </nav>;
}
