"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { getAppSettingsHref, getSettingsHref, isNonAdminHostSettingsTab } from "../shell-routes";
import type {
  CoreGlobalMount,
  CoreSettingsState,
  HostSettingsTab,
  SessionResponse,
} from "../types";
import { AppSettingsTabPanel, type AppSettingsTab } from "./settings-app-section";
import { PageHeader } from "../ui";
import { SettingsCoreSection } from "./settings-core-section";
import { SettingsIngressSection } from "./settings-ingress-section";
import { SettingsMountsSection } from "./settings-mounts-section";
import { SettingsTokensSection } from "./settings-tokens-section";
import { UserManagementPanel } from "./user-management-page";

const TABS: { id: HostSettingsTab; label: string }[] = [
  { id: "users", label: "Users" },
  { id: "tokens", label: "Access tokens" },
  { id: "core", label: "Core" },
  { id: "ingress", label: "Ingress" },
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
  appTabs,
  appTabProps,
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
  // A host tab id, or the id of an installed app whose settings page fills the tab.
  activeTab: string;
  // Apps declaring `ui.settings`, in install order. Empty for a non-admin: their tab list is their
  // own access tokens and nothing else.
  appTabs: AppSettingsTab[];
  appTabProps: Omit<React.ComponentProps<typeof AppSettingsTabPanel>, "tab">;
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
  // An ordinary user reaches this page for exactly one tab — their own access tokens — so the rest,
  // which administer the host, are not offered to them.
  const visibleTabs = canManageApps ? TABS : TABS.filter((tab) => isNonAdminHostSettingsTab(tab.id));
  // App tabs sit at the top level beside the host ones rather than nested under an "Apps" area —
  // decided on the mock at three tabs. Regrouping later changes no contract, only this list.
  const visibleAppTabs = canManageApps ? appTabs : [];
  const activeAppTab = visibleAppTabs.find((tab) => tab.appId === activeTab);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={
          canManageApps
            ? "Users, Core behavior, public ingress, and host folders shared with apps."
            : "Credentials for clients that cannot open a browser."
        }
      />

      <div className="flex gap-1 border-b">
        {visibleTabs.map((tab) => (
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
        {visibleAppTabs.map((tab) => (
          <Link
            key={tab.appId}
            href={getAppSettingsHref(tab.appId)}
            aria-current={activeTab === tab.appId ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              activeTab === tab.appId
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
              // A stopped app keeps its tab: hiding it would hide that the settings exist at all.
              // Dimmed rather than removed, and the panel says why.
              tab.embeddedUrl ? "" : "opacity-60",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {activeAppTab && <AppSettingsTabPanel tab={activeAppTab} {...appTabProps} />}

      {activeTab === "tokens" && (
        <SettingsTokensSection coreOrigin={coreOrigin} sendCsrfJson={sendCsrfJson} />
      )}

      {/* Every remaining tab administers the host. Gating them here as well as in the tab strip keeps
          a hand-typed ?tab= from rendering an admin surface for an ordinary user. */}
      {canManageApps && activeTab === "users" && (
        <UserManagementPanel coreOrigin={coreOrigin} activeUser={activeUser} sendCsrfJson={sendCsrfJson} />
      )}

      {canManageApps && activeTab === "core" && (
        <SettingsCoreSection
          settings={coreSettings}
          settingsError={coreSettingsError}
          onSaveSettings={onSaveCoreSettings}
        />
      )}

      {canManageApps && activeTab === "ingress" && (
        <SettingsIngressSection
          settings={coreSettings}
          settingsError={coreSettingsError}
          onSaveSettings={onSaveCoreSettings}
        />
      )}

      {canManageApps && activeTab === "mounts" && (
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
