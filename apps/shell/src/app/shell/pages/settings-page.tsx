"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { getSettingsHref } from "../shell-routes";
import type { CoreGlobalMount, CoreSettingsState, HostSettingsTab, SessionResponse } from "../types";
import { PageHeader } from "../ui";
import { SettingsCoreSection } from "./settings-core-section";
import { SettingsMountsSection } from "./settings-mounts-section";
import { UserManagementPanel } from "./user-management-page";

const TABS: { id: HostSettingsTab; label: string }[] = [
  { id: "users", label: "Users" },
  { id: "core", label: "Core" },
  { id: "mounts", label: "Shared mounts" },
];

// Everything that configures the host, in one place. Before this page, User Management was a route
// while Core settings and shared mounts were dialogs opened from a version block and an app page —
// three surfaces of the same kind reached three different ways, two of which nothing marked as
// navigation.
//
// The active tab comes from the URL rather than local state: the rule for this Shell is that a
// top-level surface survives a refresh and a copied link, and a tab that lives in a component would
// not.
export function SettingsPage({
  activeTab,
  coreOrigin,
  activeUser,
  sendCsrfJson,
  coreSettings,
  coreSettingsError,
  onSaveCoreSettings,
  globalMounts,
  canManageApps,
  onSaveMount,
  onDeleteMount,
}: {
  activeTab: HostSettingsTab;
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>;
  coreSettings: CoreSettingsState | null;
  coreSettingsError: string | null;
  onSaveCoreSettings: (values: Record<string, string>) => Promise<void>;
  globalMounts: CoreGlobalMount[];
  canManageApps: boolean;
  onSaveMount: (input: { name: string; hostPath: string; mode?: string; description?: string | null }) => Promise<void>;
  onDeleteMount: (name: string, force?: boolean) => Promise<void>;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Users, Core behavior, and host folders shared with apps." />

      <div className="flex gap-1 border-b">
        {TABS.map((tab) => (
          <Link
            key={tab.id}
            href={getSettingsHref(tab.id)}
            aria-current={activeTab === tab.id ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              activeTab === tab.id
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {activeTab === "users" && (
        <UserManagementPanel coreOrigin={coreOrigin} activeUser={activeUser} sendCsrfJson={sendCsrfJson} />
      )}

      {activeTab === "core" && (
        <SettingsCoreSection
          settings={coreSettings}
          settingsError={coreSettingsError}
          onSaveSettings={onSaveCoreSettings}
        />
      )}

      {activeTab === "mounts" && (
        <SettingsMountsSection
          globalMounts={globalMounts}
          canManageApps={canManageApps}
          onSave={onSaveMount}
          onDelete={onDeleteMount}
        />
      )}
    </div>
  );
}
