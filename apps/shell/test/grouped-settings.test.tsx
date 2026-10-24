import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/app/shell/pages/settings-page";
import { SettingsNavigation } from "../src/app/shell/sidebar/settings-navigation";
import { getAppSettingsTabs, type AppSurfaceTab } from "../src/app/shell/surfaces/app-surface-tabs";
import { getManageAppHref, getSettingsHref } from "../src/app/shell/shell-routes";
import type { CoreApp, CoreSettingItem, CoreStatus } from "../src/app/shell/types";

const { push, copy, toast } = vi.hoisted(() => ({ push: vi.fn(), copy: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../src/app/shell/clipboard", () => ({ copyTextToClipboard: copy }));
vi.mock("../src/components/reui/operation-toast", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../src/app/shell/pages/user-management-page", () => ({ UserManagementPanel: () => <p>User management</p> }));
vi.mock("../src/app/shell/pages/user-profile-page", () => ({ UserProfilePage: () => <p>Personal profile</p> }));
vi.mock("../src/app/shell/pages/settings-access-lists", () => ({ SettingsAccessList: () => null }));
vi.mock("../src/app/shell/pages/settings-tokens-section", () => ({ SettingsTokensSection: () => <p>Token metadata</p> }));
vi.mock("../src/app/shell/pages/settings-permissions-section", () => ({ SettingsPermissionsSection: () => <p>Permission catalogue</p> }));
vi.mock("../src/app/shell/pages/source-providers", () => ({ SourceProviders: () => <p>Source accounts</p> }));
vi.mock("../src/app/shell/pages/settings-app-section", () => ({ AppSettingsTabPanel: ({ tab }: { tab: AppSurfaceTab }) => {
  const [draft, setDraft] = useState("");
  return <div data-testid="app-settings-panel"><p>App settings for {tab.appId}</p><input aria-label="Embedded settings draft" value={draft} onChange={event => setDraft(event.target.value)} /></div>;
} }));
vi.mock("../src/app/shell/pages/ingress-diagnostics", () => ({ IngressDiagnostics: () => null }));

const values: Record<string, string> = {
  HOSTY_AUTH_CORE_SESSION_IDLE_HOURS: "168", HOSTY_AUTH_APP_GRANT_IDLE_HOURS: "168",
  HOSTY_AUTH_SYSTEM_GRANT_IDLE_HOURS: "72", HOSTY_AUTH_ACCESS_TOKEN_IDLE_HOURS: "2160",
  HOSTY_AUTH_CLI_GRANT_HOURS: "12", HOSTY_AUTH_APP_ACTIVITY_HOURS: "1", HOSTY_OAUTH_DCR_ENABLED: "false",
  HOSTY_USERS_DISABLED_RETENTION_DAYS: "10", HOSTY_UPDATE_CHECK_INTERVAL_MINUTES: "60",
  HOSTY_CORE_PORT: "7070", HOSTY_CORE_PUBLIC_ORIGIN: "https://core.test",
  HOSTY_INGRESS_PROVIDER: "none", HOSTY_INGRESS_BASE_DOMAIN: "test.example", FUTURE_SETTING: "old",
};
const settings: CoreSettingItem[] = Object.entries(values).map(([key, value]) => ({
  key, value, default: value, overridden: false, label: key, type: "string",
  group: key.startsWith("HOSTY_INGRESS_") ? "Public ingress" : "Core", description: "",
}));

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof SettingsPage>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  push.mockReset(); copy.mockReset(); copy.mockResolvedValue(undefined); toast.success.mockReset(); toast.error.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = {
    assistantSelection: null, onSelectAssistant: vi.fn(), activeTab: "users", appTabs: [],
    appTabProps: { theme: "light", themePreference: "light", reloadKey: 0, onOpenSurfaceFrame: vi.fn(async () => "") },
    coreOrigin: "https://core.test", activeUser: null, sendCsrfJson: vi.fn(),
    coreSettings: { settings }, coreSettingsError: null, onSaveCoreSettings: vi.fn(async () => {}),
    globalMounts: [], apps: [], onRefresh: vi.fn(), canManageApps: true, onSaveMount: vi.fn(), onDeleteMount: vi.fn(),
  };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (tab: string, canManageApps = true) => act(async () => root.render(<SettingsPage {...props} activeTab={tab} canManageApps={canManageApps} />));
const keys = () => [...container.querySelectorAll<HTMLInputElement>('input[id^="setting-"]')].map(input => input.id.slice(8));
const edit = (key: string, value: string) => act(async () => {
  const input = container.querySelector<HTMLInputElement>(`#setting-${key}`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const save = () => act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Save settings"))!.click());

it("moves maintenance and user retention into separate forms that save only their own changes", async () => {
  await render("general");
  expect(keys()).toEqual(["HOSTY_UPDATE_CHECK_INTERVAL_MINUTES", "FUTURE_SETTING"]);
  await edit("HOSTY_UPDATE_CHECK_INTERVAL_MINUTES", "120"); await save();
  expect(props.onSaveCoreSettings).toHaveBeenLastCalledWith({ HOSTY_UPDATE_CHECK_INTERVAL_MINUTES: "120" });
  await render("policies");
  expect(keys()).toContain("HOSTY_USERS_DISABLED_RETENTION_DAYS");
  await edit("HOSTY_USERS_DISABLED_RETENTION_DAYS", "20"); await save();
  expect(props.onSaveCoreSettings).toHaveBeenLastCalledWith({ HOSTY_USERS_DISABLED_RETENTION_DAYS: "20" });
});

it("groups session, access and privileged-activity settings under Security policies", async () => {
  await render("policies");
  expect(keys().sort()).toEqual(Object.keys(values).filter(key => key.startsWith("HOSTY_AUTH_") || key.startsWith("HOSTY_OAUTH_") || key.startsWith("HOSTY_USERS_")).sort());
  expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Users & security settings");
  expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Policies");
});

it("places app permissions under Security and refuses direct non-admin navigation", async () => {
  await render("permissions");
  expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Users & security settings");
  expect(container.textContent).toContain("Permission catalogue");
  await render("permissions", false);
  expect(container.textContent).not.toContain("Permission catalogue");
  expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(["Profile", "Tokens & devices"]);
});

it("saves Core connection and provider edits together, retains the origin warning and hides inactive provider fields", async () => {
  await render("ingress");
  expect(keys()).toEqual(["HOSTY_CORE_PORT", "HOSTY_CORE_PUBLIC_ORIGIN", "HOSTY_INGRESS_PROVIDER"]);
  await edit("HOSTY_CORE_PUBLIC_ORIGIN", "https://new-core.test");
  await edit("HOSTY_INGRESS_PROVIDER", "cloudflared");
  expect(keys()).toContain("HOSTY_INGRESS_BASE_DOMAIN");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("takes effect in two stages");
  await save();
  expect(props.onSaveCoreSettings).toHaveBeenCalledWith({ HOSTY_CORE_PUBLIC_ORIGIN: "https://new-core.test", HOSTY_INGRESS_PROVIDER: "cloudflared" });
});

it("keeps ordinary users on personal profile and credentials without exposing administrator tabs", async () => {
  await render("tokens", false);
  expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(["Profile", "Tokens & devices"]);
  expect(container.textContent).toContain("Token metadata");
  expect(keys()).toEqual([]);
  await render("profile", false);
  expect(container.textContent).toContain("Personal profile");
});

it("does not create a global assistant-access tab", async () => {
  await render("agents");
  expect(container.textContent).not.toContain("Agent directory");
  expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).not.toContain("Assistant access");
});

it("keeps one Settings entry in Shell for ordinary users", async () => {
  const onSelect = vi.fn();
  await act(async () => root.render(<SettingsNavigation compact={false} active selected="tokens" pages={[]} canManageApps={false} onSelect={onSelect} />));
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map(button => button.textContent)).toEqual(["Settings"]);
  await act(async () => buttons[0].click());
  expect(onSelect).toHaveBeenCalledWith("profile");
});


const factualStatus: CoreStatus = {
  status: "ok", component: "hosty-core", version: "0.151.0", serverTime: "2026-10-22T12:00:00Z",
  dataRoot: "/hosty/operator-data", listenUrl: "http://127.0.0.1:7070",
  corePublicOrigin: "https://core.operator.test", runtimePublicHost: "apps.operator.test",
  ingressProvider: "cloudflare-remote",
};
const coreInformation = () => container.querySelector<HTMLElement>('[aria-labelledby="core-host-information"]');

it("preserves factual Core host information and address copy controls on General without network or configuration writes", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  props.coreStatus = factualStatus;
  await render("general");
  const information = coreInformation()!;
  for (const value of [factualStatus.listenUrl, factualStatus.corePublicOrigin, factualStatus.dataRoot, factualStatus.runtimePublicHost, "Cloudflare"])
    expect(information.textContent).toContain(value);
  expect(information.querySelector("input")).toBeNull();
  expect(information.querySelector("a")).toBeNull();
  const listenCopy = information.querySelector<HTMLButtonElement>('[aria-label="Copy listen address"]')!;
  const originCopy = information.querySelector<HTMLButtonElement>('[aria-label="Copy browser address"]')!;
  await act(async () => listenCopy.click()); await act(async () => originCopy.click());
  expect(copy.mock.calls.map(([value]) => value)).toEqual([factualStatus.listenUrl, factualStatus.corePublicOrigin]);
  expect(toast.success).toHaveBeenLastCalledWith("URL copied", { description: factualStatus.corePublicOrigin });
  expect(fetcher).not.toHaveBeenCalled();
  expect(props.sendCsrfJson).not.toHaveBeenCalled();
  expect(props.onSaveCoreSettings).not.toHaveBeenCalled();
});

it("keeps the existing copy failure visible without editing any Core setting", async () => {
  props.coreStatus = factualStatus; copy.mockRejectedValue(new Error("Clipboard unavailable"));
  await render("general");
  await act(async () => coreInformation()!.querySelector<HTMLButtonElement>('[aria-label="Copy listen address"]')!.click());
  expect(toast.error).toHaveBeenCalledWith("Copy failed", { description: "Clipboard access is unavailable." });
  expect(props.onSaveCoreSettings).not.toHaveBeenCalled();
  expect(props.sendCsrfJson).not.toHaveBeenCalled();
});

it("does not infer a local or disabled ingress configuration from missing Core status", async () => {
  props.coreStatus = null; await render("general");
  const information = coreInformation()!;
  expect(information.textContent).toContain("Unavailable");
  expect(information.textContent).not.toContain("Local");
  expect(information.textContent).not.toContain("None");
  expect(information.textContent).not.toContain("Not configured");
  expect(information.querySelector("button")).toBeNull();
  props.coreStatus = { ...factualStatus, ingressProvider: undefined, corePublicOrigin: null };
  await render("general");
  expect(coreInformation()!.textContent).toContain("Not configured");
  expect(coreInformation()!.textContent).not.toContain("Local");
  props.coreStatus = { ...factualStatus, ingressProvider: "none" };
  await render("general");
  expect(coreInformation()!.textContent).toContain("Local");
});

it("keeps host facts on General and hides them on other sections and direct non-admin URLs", async () => {
  props.coreStatus = factualStatus;
  for (const tab of ["policies", "ingress", "tokens"]) {
    await render(tab);
    expect(coreInformation()).toBeNull();
    expect(container.textContent).not.toContain(factualStatus.dataRoot);
  }
  await render("general", false);
  expect(coreInformation()).toBeNull();
  expect(container.textContent).not.toContain(factualStatus.dataRoot);
  expect(keys()).toEqual([]);
});

it("refreshes factual host details without clearing an unsaved General setting draft", async () => {
  props.coreStatus = factualStatus; await render("general");
  await edit("FUTURE_SETTING", "unsaved operator value");
  props.coreStatus = { ...factualStatus, listenUrl: "http://127.0.0.1:8080", runtimePublicHost: "new-apps.operator.test" };
  await render("general");
  expect(coreInformation()!.textContent).toContain("http://127.0.0.1:8080");
  expect(coreInformation()!.textContent).toContain("new-apps.operator.test");
  expect(container.querySelector<HTMLInputElement>("#setting-FUTURE_SETTING")!.value).toBe("unsaved operator value");
  expect(props.onSaveCoreSettings).not.toHaveBeenCalled();
  await save();
  expect(props.onSaveCoreSettings).toHaveBeenCalledExactlyOnceWith({ FUTURE_SETTING: "unsaved operator value" });
});


const ownSettingsApp = { id: "example.settings", displayName: "Own settings app", iconUrl: "/api/apps/example.settings/assets/icon.svg",
  runtimeState: "running", settingsSurface: { path: "/settings", embeddedUrl: "https://settings-app.test/settings" } } as CoreApp;
const stoppedSettingsApp = { ...ownSettingsApp, id: "example.stopped", displayName: "Stopped settings app", runtimeState: "stopped" };
const appWithoutSettings = { id: "example.plain", displayName: "Plain app", runtimeState: "running" } as CoreApp;
function ownSettingsFixture() {
  props.apps = [ownSettingsApp, appWithoutSettings, stoppedSettingsApp];
  props.appTabs = getAppSettingsTabs(props.apps);
}

it("replaces the duplicate installed-app catalog with individual declared app settings links", async () => {
  ownSettingsFixture(); await render("general");
  const navigation = container.querySelector('nav[aria-label="Settings sections"]')!;
  expect([...navigation.querySelectorAll("a")].map(link => link.textContent)).toEqual(["Own settings app", "Stopped settings app"]);
  expect([...navigation.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["/settings?tab=example.settings", "/settings?tab=example.stopped"]);
  expect(navigation.querySelector("img")?.getAttribute("src")).toBe("/api/core/api/apps/example.settings/assets/icon.svg");
  expect(navigation.textContent).not.toContain("Plain app");
  expect(navigation.textContent).not.toContain("App settings");
  expect(container.querySelector('[aria-label="Installed app settings"]')).toBeNull();
  await render("apps");
  expect(container.querySelector('[aria-label="Installed app settings"]')).toBeNull();
  expect(container.textContent).toContain("Personal profile");
});

it("retains Settings navigation beside an app-owned surface with its active native link and App details exit", async () => {
  ownSettingsFixture(); await render(ownSettingsApp.id);
  const navigation = container.querySelector('nav[aria-label="Settings sections"]')!;
  expect(navigation).not.toBeNull();
  expect(navigation.querySelector('a[aria-current="page"]')?.textContent).toBe("Own settings app");
  expect(container.querySelector('[data-testid="app-settings-panel"]')?.textContent).toContain(ownSettingsApp.id);
  expect(container.querySelector('section[aria-label="Own settings app settings"]')?.className).toContain("min-h-0");
  const details = [...container.querySelectorAll("a")].find(link => link.textContent === "App details")!;
  expect(details.getAttribute("href")).toBe(getManageAppHref(ownSettingsApp.id));
  await act(async () => [...navigation.querySelectorAll("button")].find(button => button.textContent === "Host")!.click());
  expect(push).toHaveBeenCalledExactlyOnceWith(getSettingsHref("general"), { scroll: false });
});

it("keeps an embedded settings draft mounted when its app metadata refreshes", async () => {
  ownSettingsFixture(); await render(ownSettingsApp.id);
  const input = container.querySelector<HTMLInputElement>('[aria-label="Embedded settings draft"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "unsaved app value");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  props.apps = props.apps.map(app => ({ ...app, version: "2.0" }));
  props.appTabs = getAppSettingsTabs(props.apps);
  await render(ownSettingsApp.id);
  expect(container.querySelector('[aria-label="Embedded settings draft"]')).toBe(input);
  expect(input.value).toBe("unsaved app value");
  expect(props.sendCsrfJson).not.toHaveBeenCalled();
});

it("does not expose app-owned settings or app navigation through an ordinary-user URL", async () => {
  ownSettingsFixture(); await render(ownSettingsApp.id, false);
  const navigation = container.querySelector('nav[aria-label="Settings sections"]')!;
  expect(navigation.querySelectorAll("a")).toHaveLength(0);
  expect(navigation.textContent).not.toContain("Own settings app");
  expect(container.querySelector('[data-testid="app-settings-panel"]')).toBeNull();
  expect(container.textContent).toContain("Token metadata");
});

it("omits the Apps navigation group when no installed app declares settings", async () => {
  props.apps = [appWithoutSettings]; props.appTabs = getAppSettingsTabs(props.apps);
  await render("general");
  const navigation = container.querySelector('nav[aria-label="Settings sections"]')!;
  expect(navigation.querySelectorAll("a")).toHaveLength(0);
  expect(navigation.textContent).not.toContain("Apps");
});
