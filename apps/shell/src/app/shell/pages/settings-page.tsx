"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { SettingsPageNavigation } from "../sidebar/settings-navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { getManageAppHref } from "../shell-routes";
import { CoreSourceSettings } from "../core-development";
import { useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { findAssistantGateways } from "../assistant/assistant-client";
import { CoreRequestError } from "../core-api";
import {
  DEFAULT_HOST_SETTINGS_TAB,
  getHostSettingsSection,
  getSettingsHref,
  isHostSettingsTab,
  readSettingsTabParam,
  isNonAdminHostSettingsTab,
} from "../shell-routes";
import type {
  CoreApp,
  CoreGlobalMount,
  CoreSettingsState,
  CoreStatus,
  SessionResponse,
} from "../types";
import { AppSettingsTabPanel } from "./settings-app-section";
import { resolveSettingsSurface, type AppSurfaceTab } from "../surfaces/app-surface-tabs";
import { SettingsCoreSection } from "./settings-core-section";
import { SettingsIngressSection } from "./settings-ingress-section";
import { SettingsMountsSection } from "./settings-mounts-section";
import { SettingsAccessList } from "./settings-access-lists";
import { SettingsTokensSection } from "./settings-tokens-section";
import { SettingsPermissionsSection } from "./settings-permissions-section";
import { SandboxLaunchPermissions } from "./settings-sandbox-permissions";
import { SourceProviders } from "./source-providers";
import { UserProfilePage } from "./user-profile-page";
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
  coreStatus,
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
  // Apps declaring `ui.settings`, in install order. Empty for a non-admin, who can access only
  // their own profile and access tokens.
  appTabs: AppSurfaceTab[];
  appTabProps: Omit<React.ComponentProps<typeof AppSettingsTabPanel>, "tab">;
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>;
  coreSettings: CoreSettingsState | null;
  coreSettingsError: string | null;
  coreStatus?: CoreStatus | null;
  onSaveCoreSettings: (values: Record<string, string>) => Promise<void>;
  globalMounts: CoreGlobalMount[];
  apps: CoreApp[];
  onRefresh: () => Promise<void>;
  canManageApps: boolean;
  onSaveMount: (input: { name: string; hostPath: string; mode?: string; description?: string | null }) => Promise<void>;
  onDeleteMount: (name: string, force?: boolean) => Promise<void>;
}) {
  // Ordinary users reach their own profile and access tokens, so the rest,
  // which administer the host, are not offered to them.
  const router = useRouter();
  const assistants = findAssistantGateways(apps);
  // Each app has one sidebar entry; this component resolves its settings surface.
  const visibleAppTabs = canManageApps ? appTabs : [];
  const activeAppTab = resolveSettingsSurface(visibleAppTabs, activeTab);

  // The URL may name a tab that is neither a host one nor an installed app — a stale link, or an app
  // since removed. Resolution lives here rather than in the parser, which has no app list to check
  // against; without the fallback such a link renders a page with no section at all.
  const requestedTab = readSettingsTabParam(activeTab);
  const resolvedTab = isHostSettingsTab(requestedTab) && (canManageApps || isNonAdminHostSettingsTab(requestedTab))
    ? requestedTab : canManageApps ? DEFAULT_HOST_SETTINGS_TAB : "tokens";
  const section = getHostSettingsSection(resolvedTab);
  const sectionTabs = section?.tabs.filter(tab => canManageApps || isNonAdminHostSettingsTab(tab.id)) ?? [];

  const content = (
    <>
      {resolvedTab === "profile" && <UserProfilePage coreOrigin={coreOrigin} sendCsrfJson={sendCsrfJson} onSaved={onRefresh} />}

      {canManageApps && resolvedTab === "shell" && <section className="overflow-hidden rounded-xl border bg-card">
        <header className="border-b bg-muted/25 px-4 py-3"><h2 className="text-sm font-medium">Assistant for Shell</h2></header>
        <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"><div><label className="text-sm font-medium" htmlFor="shell-assistant">Assistant</label><p className="mt-1 text-xs text-muted-foreground">Choose which assistant receives prompts and error investigations; its own setting decides whether to prepare a draft or start immediately. Each assistant also has its own panel tab.</p></div><div className="min-w-0 space-y-2">
        <Select value={assistantSelection ?? ""} onValueChange={onSelectAssistant}>
          <SelectTrigger id="shell-assistant" className="w-full"><SelectValue placeholder={assistants.length === 1 ? "Use the only eligible assistant" : "Choose an assistant"} /></SelectTrigger>
          <SelectContent>
            {assistantSelection && !assistants.some(app => app.appId === assistantSelection) && <SelectItem value={assistantSelection} disabled>Previous assistant unavailable — choose again</SelectItem>}
            {assistants.map(assistant => <SelectItem key={assistant.appId} value={assistant.appId} disabled={!!assistant.problem}>{apps.find(app => app.id === assistant.appId)?.displayName || assistant.appId}{assistant.problem ? " — requires assistant interface v1" : !assistant.running ? " — unavailable" : ""}</SelectItem>)}
          </SelectContent>
        </Select>
        {assistants.filter(item => item.appId === assistantSelection || (!assistantSelection && assistants.length === 1)).map(item =>
          <p key={item.appId} className="text-sm text-muted-foreground">{item.problem ?? (!item.capabilities?.includes("attachments") ? "File and screenshot handoffs are unavailable: this assistant does not declare attachments." : "Text, application context and attachments are supported.")}</p>)}
        {!assistants.length && <p className="text-sm text-muted-foreground">Install and confirm an assistant to use these features.</p>}</div></div>
      </section>}

      {canManageApps && resolvedTab === "source" && <CoreSourceSettings coreOrigin={coreOrigin} />}

      {canManageApps && resolvedTab === "connections" && <SourceProviders coreOrigin={coreOrigin} sendCsrfJson={sendCsrfJson} />}


      {canManageApps && resolvedTab === "permissions" && <div className="flex flex-col gap-8">
        <SettingsPermissionsSection coreOrigin={coreOrigin} apps={apps} />
        <SandboxLaunchPermissions coreOrigin={coreOrigin} apps={apps} sendCsrfJson={sendCsrfJson} />
      </div>}

      {resolvedTab === "tokens" && (
        <div className="flex flex-col gap-8"><SettingsTokensSection coreOrigin={coreOrigin} sendCsrfJson={sendCsrfJson} />{canManageApps && <SettingsAccessList kind="background" coreOrigin={coreOrigin} sendCsrfJson={sendCsrfJson} />}</div>
      )}

      {/* Every remaining tab administers the host. Gating them here as well as in the sidebar keeps
          a hand-typed ?tab= from rendering an admin surface for an ordinary user. */}
      {canManageApps && resolvedTab === "users" && (
        <div className="flex flex-col gap-6">
          <UserManagementPanel coreOrigin={coreOrigin} activeUser={activeUser} sendCsrfJson={sendCsrfJson} />
        </div>
      )}

      {canManageApps && (resolvedTab === "general" || resolvedTab === "policies") && (
        <SettingsCoreSection
          section={resolvedTab}
          settings={coreSettings}
          settingsError={coreSettingsError}
          coreStatus={coreStatus}
          onSaveSettings={onSaveCoreSettings}
        />
      )}

      {canManageApps && resolvedTab === "policies" && <SettingsAccessList kind="oauth" coreOrigin={coreOrigin} sendCsrfJson={sendCsrfJson} />}

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
    </>
  );

  return (
    <div className={cn("settings-page-layout", activeAppTab && "h-full min-h-0 grid-rows-[minmax(0,1fr)] px-4 py-6 sm:px-6 lg:px-8 max-[1000px]:grid-rows-[auto_minmax(0,1fr)]")}>
      <SettingsPageNavigation selected={activeAppTab?.key ?? resolvedTab} canManageApps={canManageApps}
        pages={visibleAppTabs} apps={apps} coreOrigin={coreOrigin}
        onSelect={tab => router.push(getSettingsHref(tab), { scroll: false })} />
      {activeAppTab ? <section className="flex h-full min-h-0 min-w-0 flex-col gap-4" aria-label={`${activeAppTab.label} settings`}>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">{activeAppTab.label}</h1>
          <Button asChild variant="outline" size="sm"><Link href={getManageAppHref(activeAppTab.appId)}>App details</Link></Button>
        </header>
        <div className="min-h-0 flex-1"><AppSettingsTabPanel key={activeAppTab.key} tab={activeAppTab} {...appTabProps} /></div>
      </section> : <div className="min-w-0 space-y-6">
        <header className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">{section?.label ?? "Settings"}</h1>
          <p className="text-sm text-muted-foreground">{section?.id === "profile" ? "Your account, connections and devices." : section?.id === "host" ? "Updates, network and shared resources for this host." : section?.id === "security" ? "Manage people, permissions and host policies." : "Make Shell work the way you do."}</p>
        </header>
        {section && section.tabs.length > 1 ? (
          <Tabs value={resolvedTab} onValueChange={tab => router.push(getSettingsHref(tab), { scroll: false })} className="min-w-0 gap-6">
            <div className="max-w-full overflow-x-auto pb-1">
              <TabsList variant="line" aria-label={`${section.label} settings`}>
                {sectionTabs.map(tab => <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>)}
              </TabsList>
            </div>
            <TabsContent key={resolvedTab} value={resolvedTab}>{content}</TabsContent>
          </Tabs>
        ) : content}
      </div>}
    </div>
  );
}
