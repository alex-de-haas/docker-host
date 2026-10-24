import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppDetailsDialog } from "../src/app/shell/dialogs/app-details-dialog";
import type { CoreApp } from "../src/app/shell/types";
vi.mock("../src/app/shell/dialogs/app-permissions", () => ({ AppPermissions: () => null }));
vi.mock("../src/app/shell/dialogs/private-source-connections", () => ({ PrivateSourceConnections: () => null }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellState: () => ({ state: { status: { ingressProvider: "none" }, apps: [] } }),
  useShellActions: () => ({ coreOrigin: "https://core.test", refresh: vi.fn(), sendCsrfJson: vi.fn() }) }));
const app: CoreApp = { id: "example.one", displayName: "One", version: "1", kind: "runtime", system: false, source: "manifest", operationStatus: "started",
  runtimeState: "running", selectedRuntime: "dev", capabilities: [], autostart: true, supportsSource: true, sourceOverridePath: "/saved-source",
  settings: [{ key: "MODE", type: "string", value: "normal", secret: false }, { key: "OTHER", type: "string", value: "old", secret: false },
    { key: "API_KEY", type: "string", value: null, secret: true, hasValue: true }, { key: "HOSTY_PUBLIC_ORIGIN_UI", type: "url", value: "https://old.test", secret: false }],
  mounts: ["library", "cache"].map(key => ({ key, mode: "ro", required: false, multiple: false, bindings: [{ source: "local", label: key, hostPath: `/${key}`, containerPath: `/external/${key}` }] })) };
let root: Root, container: HTMLDivElement, props: ComponentProps<typeof AppDetailsDialog>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ feeds: [] })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = { app, page: true, view: "settings", settingsTab: "parameters", coreOrigin: "https://core.test", globalMounts: [], canManageApps: true, isShell: false,
    busyAction: null, detail: { loading: false, error: null, backups: null, backupCleanupPlan: null, updatePlan: null }, onClose: vi.fn(), onRefreshBackups: vi.fn(),
    onCreateBackup: vi.fn(), onRestoreBackup: vi.fn(), onDeleteBackup: vi.fn(), onPreviewBackupCleanup: vi.fn(), onApplyBackupCleanup: vi.fn(), onConfigure: vi.fn(),
    onConfigureMounts: vi.fn(), onConfigureSource: vi.fn(), onClearSource: vi.fn(), onSetFeed: vi.fn(), onRevealSetting: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const render = () => act(async () => root.render(<AppDetailsDialog {...props} />));
const field = (key: string) => container.querySelector<HTMLInputElement>(`#setting-${key}`)!;
const path = (key: string) => container.querySelector<HTMLInputElement>(`[aria-label="${key} host path"]`)!;
const source = () => container.querySelector<HTMLInputElement>(`[id="${props.app.id}-source-path"]`)!;
const edit = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true }));
});
const click = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!.click());
const savedSettings = (changes: Record<string, string>) => ({ ...props.app, settings: props.app.settings!.map(setting => ({ ...setting, ...(setting.key in changes ? { value: changes[setting.key] } : {}) })) });
const reveal = () => act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Show value"]')!.click());

it("keeps a dirty parameter when an unrelated saved address changes and adopts a pristine parameter", async () => {
  await render(); const input = field("MODE"); await edit(input, "quiet");
  props.app = savedSettings({ OTHER: "refreshed", HOSTY_PUBLIC_ORIGIN_UI: "https://new.test" }); await render();
  expect(field("MODE")).toBe(input); expect(input.value).toBe("quiet"); expect(field("OTHER").value).toBe("refreshed");
  expect(props.onConfigure).not.toHaveBeenCalled(); await click("Save settings");
  expect(props.onConfigure).toHaveBeenCalledExactlyOnceWith(props.app, { MODE: "quiet", OTHER: "refreshed" }, undefined);
});

it("retains a conflicting parameter draft and newer edits when an older submitted value is observed", async () => {
  await render(); await edit(field("MODE"), "submitted"); await click("Save settings"); await edit(field("MODE"), "newer");
  props.app = savedSettings({ MODE: "submitted" }); await render(); expect(field("MODE").value).toBe("newer");
  props.app = savedSettings({ MODE: "another-client" }); await render(); expect(field("MODE").value).toBe("newer");
  expect(props.onConfigure).toHaveBeenCalledOnce(); await click("Discard"); expect(field("MODE").value).toBe("another-client");
});

it("reconciles mount slots independently and never overwrites a dirty slot with a saved snapshot", async () => {
  props.settingsTab = "mounts"; await render(); await edit(path("library"), "/draft-library");
  props.app = { ...props.app, mounts: props.app.mounts!.map(slot => ({ ...slot, bindings: slot.bindings.map(binding => ({ ...binding, hostPath: `/remote-${slot.key}` })) })) };
  await render(); expect(path("library").value).toBe("/draft-library"); expect(path("cache").value).toBe("/remote-cache");
  await click("Save mounts"); expect(props.onConfigureMounts).toHaveBeenCalledExactlyOnceWith(props.app,
    [{ key: "library", label: "library", hostPath: "/draft-library" }, { key: "cache", label: "cache", hostPath: "/remote-cache" }]);
  await edit(path("library"), "/newer-library");
  props.app = { ...props.app, mounts: props.app.mounts!.map(slot => ({ ...slot, bindings: slot.bindings.map(binding => ({ ...binding, hostPath: slot.key === "library" ? "/draft-library" : binding.hostPath })) })) };
  await render(); expect(path("library").value).toBe("/newer-library");
});

it("keeps a source draft on another client's saved change but follows confirmed state while pristine", async () => {
  props.settingsTab = "source"; await render(); await edit(source(), "/draft-source");
  props.app = { ...props.app, sourceOverridePath: "/remote-source" }; await render(); expect(source().value).toBe("/draft-source");
  await act(async () => source().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(props.onConfigureSource).toHaveBeenCalledExactlyOnceWith(props.app, "/draft-source");
  props.app = { ...props.app, sourceOverridePath: "/draft-source" }; await render(); expect(source().value).toBe("/draft-source");
  props.app = { ...props.app, sourceOverridePath: "/next-source" }; await render(); expect(source().value).toBe("/next-source");
});

it("resets app-scoped drafts and revealed secret state when another app has the same setting keys", async () => {
  vi.mocked(props.onRevealSetting!).mockResolvedValue("fake-one-secret"); await render(); await edit(field("MODE"), "one-draft"); await reveal();
  expect(field("API_KEY").value).toBe("fake-one-secret"); expect(field("API_KEY").type).toBe("text");
  props.app = { ...app, id: "example.two", displayName: "Two" }; await render();
  expect(field("MODE").value).toBe("normal"); expect(field("API_KEY").value).toBe(""); expect(field("API_KEY").type).toBe("password");
  expect(props.onRevealSetting).toHaveBeenCalledExactlyOnceWith(app, "API_KEY");
});

it("discards a late reveal after Hide and fetches again on the next explicit reveal", async () => {
  let complete!: (value: string) => void;
  vi.mocked(props.onRevealSetting!).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValueOnce("fake-fresh-secret");
  await render(); await reveal(); await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Hide value"]')!.click());
  await act(async () => complete("fake-stale-secret")); expect(field("API_KEY").value).toBe(""); expect(field("API_KEY").type).toBe("password");
  await reveal(); expect(props.onRevealSetting).toHaveBeenCalledTimes(2); expect(field("API_KEY").value).toBe("fake-fresh-secret");
});

it.each(["resolve", "reject"])("ignores a late previous-app reveal %s after the next app reveals its value", async outcome => {
  let complete!: (value: string) => void, reject!: (cause: Error) => void;
  vi.mocked(props.onRevealSetting!).mockImplementationOnce(() => new Promise((resolve, fail) => { complete = resolve; reject = fail; })).mockResolvedValueOnce("fake-two-secret");
  await render(); await reveal(); props.app = { ...app, id: "example.two", displayName: "Two" }; await render(); await reveal();
  await act(async () => outcome === "resolve" ? complete("fake-one-secret") : reject(new Error("Old app read failed")));
  expect(field("API_KEY").value).toBe("fake-two-secret"); expect(field("API_KEY").type).toBe("text");
  expect(container.textContent).not.toContain("Couldn’t load the stored value");
});

it.each([true, false, undefined])("retires a submitted secret only after explicit accepted receipt (%s)", async accepted => {
  props.onConfigure = vi.fn().mockResolvedValue(accepted); await render(); await edit(field("API_KEY"), "fake-submitted-secret"); await click("Save settings");
  expect(field("API_KEY").value).toBe(accepted === true ? "" : "fake-submitted-secret");
  expect(props.onConfigure).toHaveBeenCalledExactlyOnceWith(app, { MODE: "normal", OTHER: "old", API_KEY: "fake-submitted-secret" }, undefined);
});

it("retains a newer secret edit even if it returns to the submitted value before acknowledgement", async () => {
  let complete!: (accepted: boolean) => void; props.onConfigure = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
  await render(); await edit(field("API_KEY"), "fake-submitted-secret"); await click("Save settings");
  await edit(field("API_KEY"), "fake-newer-secret"); await edit(field("API_KEY"), "fake-submitted-secret");
  await act(async () => complete(true)); expect(field("API_KEY").value).toBe("fake-submitted-secret");
});

it("does not apply a previous app's accepted save to a new app with an identical secret draft", async () => {
  let complete!: (accepted: boolean) => void; props.onConfigure = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
  await render(); await edit(field("API_KEY"), "fake-identical-secret"); await click("Save settings");
  props.app = { ...app, id: "example.two", displayName: "Two" }; await render(); await edit(field("API_KEY"), "fake-identical-secret");
  await act(async () => complete(true)); expect(field("API_KEY").value).toBe("fake-identical-secret");
});

it.each(["reject", "throw"])("retains the secret draft and reports a %s save failure", async failure => {
  props.onConfigure = failure === "reject" ? vi.fn().mockRejectedValue(new Error("Save unavailable")) : vi.fn(() => { throw new Error("Save unavailable"); });
  await render(); await edit(field("API_KEY"), "fake-unsaved-secret"); await click("Save settings");
  expect(field("API_KEY").value).toBe("fake-unsaved-secret"); expect(container.textContent).toContain("Save unavailable");
});

it("does not resurrect a late stored value after a replacement secret is accepted", async () => {
  let complete!: (value: string) => void; vi.mocked(props.onRevealSetting!).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  props.onConfigure = vi.fn().mockResolvedValue(true);
  await render(); await reveal(); await edit(field("API_KEY"), "fake-replacement-secret"); await click("Save settings");
  await act(async () => complete("fake-previous-secret")); expect(field("API_KEY").value).toBe(""); expect(field("API_KEY").type).toBe("password");
});

it("shows the authoritative saved public origin without endpoint metadata while keeping parameter drafts", async () => {
  await render(); await edit(field("MODE"), "quiet"); props.settingsTab = "publicOrigins"; await render();
  expect(field("HOSTY_PUBLIC_ORIGIN_UI").disabled).toBe(true); expect(field("HOSTY_PUBLIC_ORIGIN_UI").value).toBe("https://old.test");
  props.app = savedSettings({ HOSTY_PUBLIC_ORIGIN_UI: "https://current.test" }); await render();
  expect(field("HOSTY_PUBLIC_ORIGIN_UI").value).toBe("https://current.test");
  props.settingsTab = "parameters"; await render(); expect(field("MODE").value).toBe("quiet"); expect(props.onConfigure).not.toHaveBeenCalled();
});
