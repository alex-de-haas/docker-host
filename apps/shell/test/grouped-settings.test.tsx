import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/app/shell/pages/settings-page";
import { SettingsNavigation } from "../src/app/shell/sidebar/settings-navigation";
import type { CoreSettingItem } from "../src/app/shell/types";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../src/app/shell/pages/user-management-page", () => ({ UserManagementPanel: () => <p>User management</p> }));
vi.mock("../src/app/shell/pages/user-profile-page", () => ({ UserProfilePage: () => <p>Personal profile</p> }));
vi.mock("../src/app/shell/pages/settings-agents-section", () => ({ SettingsAgentsSection: () => <p>Agent directory</p> }));
vi.mock("../src/app/shell/pages/source-providers", () => ({ SourceProviders: () => <p>Source accounts</p> }));
vi.mock("../src/app/shell/pages/settings-app-section", () => ({ AppSettingsTabPanel: () => <p>App settings</p> }));
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
  push.mockReset();
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
  await render("users");
  expect(keys()).toEqual(["HOSTY_USERS_DISABLED_RETENTION_DAYS"]);
  expect(container.textContent).toContain("User management");
  await edit("HOSTY_USERS_DISABLED_RETENTION_DAYS", "20"); await save();
  expect(props.onSaveCoreSettings).toHaveBeenLastCalledWith({ HOSTY_USERS_DISABLED_RETENTION_DAYS: "20" });
});

it("groups session, access and privileged-activity settings under Security policies", async () => {
  await render("policies");
  expect(keys().sort()).toEqual(Object.keys(values).filter(key => key.startsWith("HOSTY_AUTH_") || key.startsWith("HOSTY_OAUTH_")).sort());
  expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Security settings");
  expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Policies");
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
  expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(["Access tokens"]);
  expect(container.textContent).toContain("Open tokens in Core");
  expect(keys()).toEqual([]);
  await render("profile", false);
  expect(container.textContent).toContain("Personal profile");
});

it("navigates between Harness tabs with a shareable URL", async () => {
  await render("agents");
  expect(container.textContent).toContain("Agent directory");
  const tab = [...container.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === "Shell")!;
  await act(async () => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
  expect(push).toHaveBeenCalledWith("/settings?tab=harness&section=shell", { scroll: false });
});

it("shows one Security sidebar destination for non-admin users and opens their credentials", async () => {
  const onSelect = vi.fn();
  await act(async () => root.render(<SettingsNavigation compact={false} active selected="tokens" pages={[]} canManageApps={false} onSelect={onSelect} />));
  expect([...container.querySelectorAll("#settings-navigation button")].map(button => button.textContent)).toEqual(["Your profile", "Security"]);
  const security = [...container.querySelectorAll("button")].find(button => button.textContent === "Security")!;
  expect(security.getAttribute("aria-current")).toBe("page");
  await act(async () => security.click());
  expect(onSelect).toHaveBeenCalledWith("tokens");
});
