"use client";

import { findAssistantGateways } from "../assistant/assistant-client";
import { CoreRequestError } from "../core-api";
import {
  DEFAULT_HOST_SETTINGS_TAB,
  HOST_SETTINGS_SECTIONS,
  isNonAdminHostSettingsTab,
} from "../shell-routes";
import type {
  CoreApp,
  CoreGlobalMount,
  CoreSettingsState,
  SessionResponse,
} from "../types";
import { AppSettingsTabPanel } from "./settings-app-section";
import { resolveSettingsSurface, type AppSurfaceTab } from "../surfaces/app-surface-tabs";
import { SettingsCoreSection } from "./settings-core-section";
import { SettingsIngressSection } from "./settings-ingress-section";
import { SettingsMountsSection } from "./settings-mounts-section";
import { SettingsTokensSection } from "./settings-tokens-section";
import { UserManagementPanel } from "./user-management-page";

// Everything that configures the host, in one place. Before this page, User Management was a route
// while Core settings and shared mounts were dialogs opened from a version block and an app page —
// three surfaces of the same kind reached three different ways, two of which nothing marked as
// navigation.
//
// The active tab comes from the URL rather than local state: the rule for this Shell is that a
// top-level surface survives a refresh and a copied link, and a tab that lives in a component would
// not.
export function SettingsPage({
  assistantSelection, onSelectAssistant,
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
  apps,
  onRefresh,
  canManageApps,
  onSaveMount,
  onDeleteMount,
}: {
  assistantSelection: string | null;
  onSelectAssistant: (id: string) => void;
  // A host tab id, or the id of an installed app whose settings page fills the tab.
  activeTab: string;
  // Apps declaring `ui.settings`, in install order. Empty for a non-admin: their tab list is their
  // own access tokens and nothing else.
  appTabs: AppSurfaceTab[];
  appTabProps: Omit<React.ComponentProps<typeof AppSettingsTabPanel>, "tab">;
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>;
  coreSettings: CoreSettingsState | null;
  coreSettingsError: string | null;
  onSaveCoreSettings: (values: Record<string, string>) => Promise<void>;
  globalMounts: CoreGlobalMount[];
  apps: CoreApp[];
  onRefresh: () => Promise<void>;
  canManageApps: boolean;
  onSaveMount: (input: { name: string; hostPath: string; mode?: string; description?: string | null }) => Promise<void>;
  onDeleteMount: (name: string, force?: boolean) => Promise<void>;
}) {
  // An ordinary user reaches this page for exactly one tab — their own access tokens — so the rest,
  // which administer the host, are not offered to them.
  const assistants = findAssistantGateways(apps);
  const visibleTabs = canManageApps ? HOST_SETTINGS_SECTIONS : HOST_SETTINGS_SECTIONS.filter((tab) => isNonAdminHostSettingsTab(tab.id));
  // Each app has one sidebar entry; this component resolves its settings surface.
  const visibleAppTabs = canManageApps ? appTabs : [];
  const activeAppTab = resolveSettingsSurface(visibleAppTabs, activeTab);
  if (activeAppTab) return <AppSettingsTabPanel key={activeAppTab.key} tab={activeAppTab} {...appTabProps} />;

  // The URL may name a tab that is neither a host one nor an installed app — a stale link, or an app
  // since removed. Resolution lives here rather than in the parser, which has no app list to check
  // against; without the fallback such a link renders a page with no section at all.
  const resolvedTab =
    visibleTabs.some((tab) => tab.id === activeTab) ? activeTab : DEFAULT_HOST_SETTINGS_TAB;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Settings</h1>

      {canManageApps && resolvedTab === "shell" && <section className="space-y-3 max-w-xl">
        <h2 className="text-lg font-medium">Assistant for Shell</h2>
        <p className="text-sm text-muted-foreground">Choose which assistant receives Ask assistant drafts and error investigations. Each assistant also has its own panel tab.</p>
        <label className="block text-sm" htmlFor="shell-assistant">Assistant</label>
        <select id="shell-assistant" className="w-full rounded-md border bg-background p-2" value={assistantSelection ?? ""} onChange={event => onSelectAssistant(event.target.value)}>
          <option value="" disabled>{assistants.length === 1 ? "Use the only available assistant" : "Choose an assistant"}</option>
          {assistantSelection && !assistants.some(app => app.appId === assistantSelection) && <option value={assistantSelection} disabled>Previous assistant unavailable — choose again</option>}
          {assistants.map(assistant => <option key={assistant.appId} value={assistant.appId}>{apps.find(app => app.id === assistant.appId)?.displayName || assistant.appId}{!assistant.running ? " — unavailable" : ""}</option>)}
        </select>
        {!assistants.length && <p className="text-sm text-muted-foreground">Install and confirm an assistant to use these features.</p>}
      </section>}

      {resolvedTab === "tokens" && (
        <SettingsTokensSection coreOrigin={coreOrigin} sendCsrfJson={sendCsrfJson} />
      )}

      {/* Every remaining tab administers the host. Gating them here as well as in the sidebar keeps
          a hand-typed ?tab= from rendering an admin surface for an ordinary user. */}
      {canManageApps && resolvedTab === "users" && (
        <UserManagementPanel coreOrigin={coreOrigin} activeUser={activeUser} sendCsrfJson={sendCsrfJson} />
      )}

      {canManageApps && resolvedTab === "core" && (
        <SettingsCoreSection
          settings={coreSettings}
          settingsError={coreSettingsError}
          onSaveSettings={onSaveCoreSettings}
        />
      )}

      {canManageApps && resolvedTab === "ingress" && (
        <SettingsIngressSection
          settings={coreSettings}
          settingsError={coreSettingsError}
          onSaveSettings={onSaveCoreSettings}
        />
      )}

      {canManageApps && resolvedTab === "mounts" && (
        <SettingsMountsSection
          globalMounts={globalMounts}
          apps={apps}
          onRefresh={onRefresh}
          onSaveBindings={async (name, change) => {
            try {
              await sendCsrfJson(`${coreOrigin}/api/apps/${encodeURIComponent(change.appId)}/mounts/shared/${encodeURIComponent(name)}`, { keys: change.keys, expectedKeys: change.expectedKeys }, "PUT");
            } catch (error) {
              if (error instanceof CoreRequestError && error.status === 404 && !error.code)
                throw new Error("Update Core to 0.100.0 or later to manage shared mount assignments here.");
              throw error;
            }
          }}
          canManageApps={canManageApps}
          onSave={onSaveMount}
          onDelete={onDeleteMount}
        />
      )}
    </div>
  );
}
