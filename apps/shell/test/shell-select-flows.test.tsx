import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserManagementPanel } from "../src/app/shell/pages/user-management-page";
import { SettingsMountsSection } from "../src/app/shell/pages/settings-mounts-section";
import { PublicOriginControl } from "../src/app/shell/pages/public-origin-control";
import type { CoreApp, CoreEndpoint } from "../src/app/shell/types";

const access = vi.hoisted(() => ({ canManageApps: true, send: vi.fn() }));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
vi.mock("../src/components/reui/operation-toast", () => ({ toast: { success: vi.fn() } }));
vi.mock("../src/app/shell/shell-context", () => ({
  useShellState: () => ({ canManageApps: access.canManageApps, state: { status: { ingressProvider: "none" } } }),
  useShellActions: () => ({ coreOrigin: "https://core.test", sendCsrfJson: access.send, refresh: async () => {}, runAppAction: vi.fn() }),
}));

let root: Root, container: HTMLDivElement;
const apps = [{ id: "example.notes", name: "Notes", version: "1.0.0", operationStatus: "started" }];
const activeUser = { id: "alice", role: "host.admin", email: "alice@example.test", displayName: "Alice", disabled: false };
const user = { ...activeUser, disabled: false, assignedAppIds: [], activeSessionCount: 1, lastSeenAt: null };
const endpoint: CoreEndpoint = { key: "web", protocol: "http", public: true, url: "http://127.0.0.1:3100",
  browserOrigin: "http://media.hosty.localhost:3100", localOrigin: "http://media.hosty.localhost:3100", localName: "media",
  localDefaultOrigin: "http://default.hosty.localhost:3100", localSuffix: "hosty.localhost" };
const app = { id: "example.media", displayName: "Media", settings: [{ key: "HOSTY_PUBLIC_ORIGIN_WEB", value: "https://proxy.test:9443" }] } as CoreApp;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  access.canManageApps = true;
  access.send.mockResolvedValue(Response.json({ setupUrl: "https://core.test/setup/example", token: "example" }));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ users: [user], invitations: [], apps,
    inviteTtlOptions: [{ label: "Short custom lifetime", ttlMs: 43210 }, { label: "Long custom lifetime", ttlMs: 87654321 }] })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.body.innerHTML = "";
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals();
});
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label)!;
async function click(label: string) { expect(button(label), label).toBeDefined(); await act(async () => button(label).click()); }
async function fill(id: string, value: string) {
  await act(async () => {
    const input = document.getElementById(id) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(trigger: HTMLElement, label: string) {
  expect(trigger.getAttribute("role")).toBe("combobox");
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === label)!;
  expect(option, label).toBeDefined();
  await act(async () => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
async function submitFrom(label: string) {
  const submit = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === label)!;
  await act(async () => submit.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function invite() {
  await act(async () => root.render(<UserManagementPanel coreOrigin="https://core.test" activeUser={activeUser} sendCsrfJson={access.send} />));
  await click("Invite User");
}
const appCheckbox = () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!;

it("sends the selected invitation lifetime as a number and shared-checkbox app assignments only on submit", async () => {
  await invite(); await fill("inviteEmail", "guest@example.test");
  expect(document.querySelector('label[for="inviteRole"]')?.textContent).toBe("Role");
  expect(document.querySelector('label[for="inviteTtl"]')?.textContent).toBe("Expires");
  await choose(document.getElementById("inviteTtl")!, "Short custom lifetime");
  await act(async () => appCheckbox().closest("label")!.click());
  expect(appCheckbox().getAttribute("aria-checked")).toBe("true");
  expect(access.send).not.toHaveBeenCalled();
  await submitFrom("Generate link");
  expect(access.send).toHaveBeenCalledExactlyOnceWith("https://core.test/api/auth/invitations", {
    email: "guest@example.test", displayName: null, role: "host.user", ttlMs: 43210, assignedAppIds: ["example.notes"],
  });
});

it("clears app grants on switching an invitation to admin and does not revive them on switching back", async () => {
  await invite(); await fill("inviteEmail", "admin@example.test");
  await act(async () => appCheckbox().click());
  await choose(document.getElementById("inviteRole")!, "Admin");
  expect(document.querySelector('[role="checkbox"]')).toBeNull();
  await choose(document.getElementById("inviteRole")!, "User");
  expect(appCheckbox().getAttribute("aria-checked")).toBe("false");
  await choose(document.getElementById("inviteRole")!, "Admin");
  await submitFrom("Generate link");
  expect(access.send).toHaveBeenCalledExactlyOnceWith("https://core.test/api/auth/invitations", {
    email: "admin@example.test", displayName: null, role: "host.admin", ttlMs: 87654321, assignedAppIds: [],
  });
});

it("retains the no-app state and self-admin role guards", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ users: [user], invitations: [], apps: [] }));
  await act(async () => root.render(<UserManagementPanel coreOrigin="https://core.test" activeUser={activeUser} sendCsrfJson={access.send} />));
  await act(async () => button("User actions").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  expect(items.find(node => node.textContent === "Make user")?.getAttribute("aria-disabled")).toBe("true");
  expect(items.find(node => node.textContent === "Disable")?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await click("Invite User");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("No runtime apps");
  expect(document.querySelector('[role="checkbox"]')).toBeNull();
  expect(access.send).not.toHaveBeenCalled();
});

const mountProps = (): ComponentProps<typeof SettingsMountsSection> => ({ globalMounts: [], apps: [], canManageApps: true,
  onSaveBindings: vi.fn(), onRefresh: vi.fn(), onSave: vi.fn(), onDelete: vi.fn() });
it("preserves rw default and submits an explicitly chosen ro mount without submitting on selection", async () => {
  const props = mountProps(); await act(async () => root.render(<SettingsMountsSection {...props} />));
  await click("Add mount");
  expect(document.getElementById("shared-mount-mode")?.textContent).toBe("rw");
  await fill("shared-mount-name", "archive"); await fill("shared-mount-path", "/srv/archive");
  await choose(document.getElementById("shared-mount-mode")!, "ro");
  expect(props.onSave).not.toHaveBeenCalled();
  await submitFrom("Add mount");
  expect(props.onSave).toHaveBeenCalledExactlyOnceWith({ name: "archive", hostPath: "/srv/archive", mode: "ro", description: null });
});
it("does not expose the mount editor to users without app-management authority", async () => {
  const props = { ...mountProps(), canManageApps: false }; await act(async () => root.render(<SettingsMountsSection {...props} />));
  expect(button("Add mount").disabled).toBe(true); await click("Add mount");
  expect(document.getElementById("shared-mount-mode")).toBeNull(); expect(props.onSave).not.toHaveBeenCalled();
});

it("switches between manual and local addresses with the original drafts and stale-address precondition", async () => {
  await act(async () => root.render(<PublicOriginControl app={app} endpoint={endpoint} />));
  await click("Configure browser address");
  expect((document.getElementById("public-origin-url") as HTMLInputElement).value).toBe("https://proxy.test:9443");
  await fill("public-origin-url", "https://unsaved.test");
  await choose(button("Address provider"), "Local · this computer only");
  expect((document.getElementById("local-browser-name") as HTMLInputElement).value).toBe("media");
  await choose(button("Address provider"), "Custom proxy address (advanced)");
  expect((document.getElementById("public-origin-url") as HTMLInputElement).value).toBe("https://proxy.test:9443");
  expect(access.send).not.toHaveBeenCalled();
  await click("Save");
  expect(access.send).toHaveBeenCalledExactlyOnceWith("https://core.test/api/apps/example.media/configure", {
    settings: { HOSTY_PUBLIC_ORIGIN_WEB: "https://proxy.test:9443" },
  });
  await click("Configure browser address");
  await choose(button("Address provider"), "Local · this computer only");
  await click("Save");
  expect(access.send).toHaveBeenNthCalledWith(2, "https://core.test/api/apps/example.media/configure", {
    settings: { HOSTY_LOCAL_NAME_WEB: "media", HOSTY_PUBLIC_ORIGIN_WEB: null }, expectedBrowserOrigins: { web: endpoint.browserOrigin },
  });
});
it("keeps browser address configuration unavailable without management authority or a public endpoint", async () => {
  access.canManageApps = false; await act(async () => root.render(<PublicOriginControl app={app} endpoint={endpoint} />));
  expect(button("Configure browser address")).toBeUndefined();
  access.canManageApps = true; await act(async () => root.render(<PublicOriginControl app={app} endpoint={{ ...endpoint, public: false }} />));
  expect(button("Configure browser address")).toBeUndefined(); expect(access.send).not.toHaveBeenCalled();
});
