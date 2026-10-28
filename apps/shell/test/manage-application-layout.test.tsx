import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchResources } from "../src/app/shell/resources/resource-stream";
import { AppDetailsDialog } from "../src/app/shell/dialogs/app-details-dialog";
import type { CoreApp } from "../src/app/shell/types";

const resourceStop = vi.hoisted(() => vi.fn());
vi.mock("../src/app/shell/resources/resource-stream", () => ({ watchResources: vi.fn(() => resourceStop) }));
vi.mock("../src/app/shell/dialogs/app-permissions", () => ({ AppPermissions: () => <p>Existing permissions control</p> }));
vi.mock("../src/app/shell/dialogs/private-source-connections", () => ({ PrivateSourceConnections: () => null }));
vi.mock("../src/app/shell/shell-context", () => ({
  useShellState: () => ({ state: { status: { ingressProvider: "none" }, apps: [] } }),
  useShellActions: () => ({ coreOrigin: "https://core.test", refresh: vi.fn(), sendCsrfJson: vi.fn() }),
}));
let root: Root, container: HTMLDivElement, props: ComponentProps<typeof AppDetailsDialog>;
const app: CoreApp = {
  id: "example.media", displayName: "Media", version: "1.0.0", kind: "runtime", system: false,
  source: "manifest", operationStatus: "started", runtimeState: "running", selectedRuntime: "dev", live: true,
  capabilities: ["backup", "logs"], autostart: true, supportsSource: true,
  settings: [{ key: "MODE", type: "string", value: "normal", secret: false }, { key: "HOSTY_PUBLIC_ORIGIN_UI", type: "string", value: "https://media.test", secret: false }],
  mounts: [{ key: "library", mode: "ro", required: false, multiple: false, bindings: [{ source: "local", label: "Library", hostPath: "/media", containerPath: "/external/library" }] }],
  endpoints: [{ key: "ui", service: "web", protocol: "http", public: true, browserOrigin: "https://media.test" }],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ feeds: [] })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(watchResources).mockClear(); resourceStop.mockClear();
  props = { app, page: true, view: "settings", coreOrigin: "https://core.test", globalMounts: [], canManageApps: true, isShell: false, busyAction: null,
    detail: { loading: false, error: null, backups: [], backupCleanupPlan: null, updatePlan: null }, onClose: vi.fn(), onRefreshBackups: vi.fn(), onCreateBackup: vi.fn(),
    onRestoreBackup: vi.fn(), onDeleteBackup: vi.fn(), onPreviewBackupCleanup: vi.fn(), onApplyBackupCleanup: vi.fn(), onConfigure: vi.fn(),
    onConfigureMounts: vi.fn(), onConfigureSource: vi.fn(), onClearSource: vi.fn(), onSetFeed: vi.fn(), onTabChange: vi.fn(),
    onOpenApp: vi.fn(), onManageAction: vi.fn(), onShowLogs: vi.fn(), onShowRemoval: vi.fn(), onAskAssistant: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<AppDetailsDialog {...props} />));
async function tab(label: string) {
  await act(async () => [...container.querySelectorAll('[role="tab"]')].find(item => item.textContent === label)!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
const click = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!.click());

it("keeps Manage actions and approved tab order without changing source or runtime on entry", async () => {
  await render();
  expect([...container.querySelectorAll('[role="tab"]')].map(item => item.textContent)).toEqual(["Launch", "Logs", "Services", "Metrics", "Parameters", "Folders", "Network", "Permissions", "Updates", "Backups"]);
  expect(container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toBe("DashboardMedia");
  expect(container.querySelector('nav[aria-label="Breadcrumb"] a')?.getAttribute("href")).toBe("/dashboard");
  expect(container.querySelector("h1")?.textContent).toBe("Media");
  expect(container.textContent).not.toContain("Workspace");
  expect(props.onConfigure).not.toHaveBeenCalled();
  expect(props.onConfigureSource).not.toHaveBeenCalled();
  await click("Open app"); await click("Restart"); await click("Stop");
  expect(props.onOpenApp).toHaveBeenCalledOnce();
  expect(props.onManageAction).toHaveBeenNthCalledWith(1, "restart");
  expect(props.onManageAction).toHaveBeenNthCalledWith(2, "stop");
});

it("preserves parameter and folder drafts across all presentation tabs and saves only on request", async () => {
  await render(); await tab("Parameters");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>("#setting-MODE")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "quiet");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tab("Folders");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="library host path"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/new-media");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const label of ["Permissions", "Network", "Backups", "Logs", "Services", "Metrics", "Launch", "Parameters"]) await tab(label);
  expect(container.querySelector<HTMLInputElement>("#setting-MODE")!.value).toBe("quiet");
  expect(props.onConfigure).not.toHaveBeenCalled(); expect(props.onConfigureMounts).not.toHaveBeenCalled();
  await click("Save settings");
  expect(props.onConfigure).toHaveBeenCalledExactlyOnceWith(app, { MODE: "quiet" }, undefined);
  expect(props.onManageAction).not.toHaveBeenCalled();
  await tab("Folders");
  expect(container.querySelector<HTMLInputElement>('[aria-label="library host path"]')!.value).toBe("/new-media");
  await click("Save mounts");
  expect(props.onConfigureMounts).toHaveBeenCalledExactlyOnceWith(app, [{ key: "library", label: "Library", hostPath: "/new-media" }]);
  expect(props.onTabChange).toHaveBeenLastCalledWith("mounts");
});

it("keeps backup coverage and running-app interruption explicit", async () => {
  props.settingsTab = "backups"; await render();
  expect(container.querySelector('[aria-label="Backup coverage"]')?.textContent).toContain("primary data directory");
  expect(container.textContent).toContain("briefly stops this running app");
  await click("Create backup"); await click("Preview prune");
  expect(props.onCreateBackup).toHaveBeenCalledExactlyOnceWith(app);
  expect(props.onPreviewBackupCleanup).toHaveBeenCalledExactlyOnceWith(app);
});

it("continues to refuse Manage settings for ordinary users", async () => {
  props.canManageApps = false; await render();
  expect(container.querySelector('nav[aria-label="Breadcrumb"] a')?.getAttribute("href")).toBe("/");
  expect(container.textContent).toContain("You do not have permission to manage this application");
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.querySelector("form")).toBeNull();
});

async function chooseFeed(optionText: string) {
  await act(async () => container.querySelector('[aria-label="Update feed"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === optionText)!;
  await act(async () => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
it("keeps selected feed and custom source drafts across tabs without applying either on navigation", async () => {
  props.app = { ...app, followedFeedId: "stable" };
  vi.mocked(fetch).mockImplementation(async () => Response.json({ followedFeedId: "stable", feeds: [{ id: "stable", default: true }, { id: "edge", default: false }] }));
  await render();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/feeds"))).toBe(false);
  await tab("Updates"); await chooseFeed("edge");
  await act(async () => {
    container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1].click();
    const input = container.querySelector<HTMLInputElement>('[id="example.media-source-path"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/work/unsaved");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tab("Permissions"); await tab("Parameters"); await tab("Updates");
  expect(container.querySelector('[aria-label="Update feed"]')?.textContent).toBe("edge");
  expect(container.querySelector<HTMLInputElement>('[id="example.media-source-path"]')!.value).toBe("/work/unsaved");
  expect(props.onSetFeed).not.toHaveBeenCalled(); expect(props.onConfigureSource).not.toHaveBeenCalled();
  await click("Follow feed"); expect(props.onSetFeed).toHaveBeenCalledExactlyOnceWith(props.app, "edge");
  await act(async () => container.querySelector('[id="example.media-source-path"]')!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(props.onConfigureSource).toHaveBeenCalledExactlyOnceWith(props.app, "/work/unsaved");
});
it("shows an update-feed read failure with retry while retaining other source controls", async () => {
  props.settingsTab = "source";
  vi.mocked(fetch).mockRejectedValueOnce(new Error("Feed read unavailable"));
  await render(); expect(container.textContent).toContain("Feed read unavailable");
  expect(container.textContent).toContain("Custom source folder");
  await click("Retry feeds");
  expect(container.textContent).not.toContain("Feed read unavailable");
  expect(container.textContent).toContain("No update feeds are declared");
  expect(props.onSetFeed).not.toHaveBeenCalled();
});

it("preserves a dirty feed choice when another client follows a different feed and rebases only on confirmation", async () => {
  let followed = "stable";
  props.app = { ...app, followedFeedId: followed }; props.settingsTab = "source";
  vi.mocked(fetch).mockImplementation(async () => Response.json({ followedFeedId: followed, feeds: ["stable", "edge", "beta"].map(id => ({ id, default: id === "stable" })) }));
  await render(); await chooseFeed("edge");
  followed = "beta"; props.app = { ...props.app, followedFeedId: followed }; await render();
  expect(container.querySelector('[aria-label="Update feed"]')?.textContent).toBe("edge");
  expect(container.textContent).toContain("Confirmed feed: beta"); expect(container.textContent).toContain("Your unsaved selection is retained");
  expect(props.onSetFeed).not.toHaveBeenCalled();
  await click("Follow feed"); expect(props.onSetFeed).toHaveBeenCalledExactlyOnceWith(props.app, "edge");
  followed = "edge"; props.app = { ...props.app, followedFeedId: followed }; await render();
  expect(container.querySelector('[aria-label="Update feed"]')?.textContent).toBe("edge");
  expect(container.textContent).not.toContain("Your unsaved selection is retained");
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Follow feed")!.disabled).toBe(true);
});
it("freezes a retained feed choice during revalidation and after a revoked read until retry succeeds", async () => {
  props.app = { ...app, followedFeedId: "stable" }; props.settingsTab = "source";
  const response = () => Response.json({ followedFeedId: "stable", feeds: ["stable", "edge"].map(id => ({ id, default: id === "stable" })) });
  vi.mocked(fetch).mockImplementation(async () => response());
  await render(); await chooseFeed("edge"); await tab("Parameters");
  let complete!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
  await tab("Updates");
  const follow = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Follow feed")!;
  expect(follow().disabled).toBe(true); expect(container.querySelector<HTMLButtonElement>('[aria-label="Update feed"]')!.disabled).toBe(true);
  await act(async () => complete(Response.json({ message: "Feed access revoked" }, { status: 403 })));
  expect(container.textContent).toContain("Feed access revoked"); expect(follow().disabled).toBe(true);
  expect(container.querySelector('[aria-label="Update feed"]')?.textContent).toBe("edge");
  await click("Retry feeds"); expect(follow().disabled).toBe(false);
  expect(props.onSetFeed).not.toHaveBeenCalled();
});

it("reveals the selected Manage tab on selection and width changes without scrolling the page or remounting drafts", async () => {
  let resized!: () => void;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} unobserve() {} disconnect() {} });
  const pageScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  await render();
  const strip = container.querySelector<HTMLElement>('[data-slot="manage-tab-strip"]')!;
  let width = 260;
  strip.getBoundingClientRect = () => ({ left: 0, right: width, width } as DOMRect);
  [...strip.querySelectorAll<HTMLElement>('[role="tab"]')].forEach((trigger, index) => {
    trigger.getBoundingClientRect = () => ({ left: index * 100 - strip.scrollLeft, right: (index + 1) * 100 - strip.scrollLeft, width: 100 } as DOMRect);
  });
  await tab("Updates"); expect(strip.scrollLeft).toBe(640);
  width = 180; await act(async () => resized()); expect(strip.scrollLeft).toBe(720);
  await tab("Launch"); expect(strip.scrollLeft).toBe(0); expect(pageScroll).not.toHaveBeenCalled();
  pageScroll.mockRestore();
});


it("explains Dashboard readiness warnings in Manage and retains the console action", async () => {
  props.app = { ...app, health: { status: "degraded", observedAt: "2026-10-22T09:00:00Z",
    services: [{ service: "api", status: "running", health: "unhealthy" }] } };
  await render();
  expect(container.textContent).toContain("App is running, but not ready");
  expect(container.textContent).toContain("api: unhealthy");
  await click("Open console logs");
  expect(props.onShowLogs).toHaveBeenCalledOnce();
});

it("retains recorded operation and update-check problems above Manage tabs", async () => {
  props.app = { ...app, lastError: "Last start failed", updateCheck: { updateAvailable: false, requiresReview: false,
    checkedAt: "2026-10-22T09:00:00Z", error: "Feed is unreachable" } };
  await render();
  expect(container.textContent).toContain("Last start failed");
  expect(container.textContent).toContain("Feed is unreachable");
  expect(container.querySelector('[role="tablist"]')).not.toBeNull();
});


it("keeps log reads dormant on other tabs and loads on entry without losing settings drafts", async () => {
  await render();
  const requests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/logs?tail=200"));
  expect(requests()).toHaveLength(0);
  await tab("Logs");
  expect(requests()).toHaveLength(1);
  expect(container.querySelector('[aria-label="Console logs"]')).not.toBeNull();
  expect(props.onTabChange).toHaveBeenLastCalledWith("logs");
  const signal = requests()[0][1]?.signal;
  await tab("Parameters");
  expect(signal?.aborted).toBe(true);
  expect(container.querySelector('[aria-label="Console logs"]')).toBeNull();
});

it("hides the Logs tab for apps without the capability, including stale deep links", async () => {
  props.app = { ...app, capabilities: ["backup"] }; props.settingsTab = "logs";
  await render();
  expect([...container.querySelectorAll('[role="tab"]')].some(item => item.textContent === "Logs")).toBe(false);
  expect(container.querySelector('[aria-label="Console logs"]')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/logs"))).toBe(false);
});


it("falls back from Logs when the capability is withdrawn, aborting its read and keeping form drafts", async () => {
  let complete!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/logs?")
    ? new Promise<Response>(resolve => { complete = resolve; }) : Response.json({ feeds: [] }));
  await render(); await tab("Parameters");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>("#setting-MODE")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "quiet");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tab("Logs");
  const signal = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("/logs?"))![1]?.signal;
  props.app = { ...props.app, capabilities: ["backup"] }; await render();
  expect(signal?.aborted).toBe(true);
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Launch");
  await act(async () => complete(Response.json({ text: "Late output" })));
  expect(container.textContent).not.toContain("Late output");
  await tab("Parameters");
  expect(container.querySelector<HTMLInputElement>("#setting-MODE")!.value).toBe("quiet");
  expect(props.onConfigure).not.toHaveBeenCalled();
});

it("limits metrics subscriptions and service reads to their selected tabs", async () => {
  await render();
  const serviceReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => /\/(health|update-status)$/.test(String(url)));
  expect(serviceReads()).toHaveLength(0);
  expect(watchResources).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Core API activity"]')).toBeNull();
  await tab("Metrics");
  expect(watchResources).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="Core API activity"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Service resources"]')).not.toBeNull();
  expect(serviceReads()).toHaveLength(0);
  expect(props.onTabChange).toHaveBeenLastCalledWith("metrics");
  await tab("Services");
  expect(resourceStop).toHaveBeenCalledOnce();
  expect(serviceReads()).toHaveLength(2);
  expect(container.querySelector('[aria-label="Core API activity"]')).toBeNull();
  expect(container.querySelector('[aria-labelledby="app-services-example.media"]')).not.toBeNull();
  const signals = serviceReads().map(([, options]) => options?.signal);
  await tab("Launch");
  expect(signals.every(signal => signal?.aborted)).toBe(true);
  expect(container.querySelector('[aria-labelledby="app-services-example.media"]')).toBeNull();
});

it.each(["services", "metrics"] as const)("opens %s directly and retains section changes from browser navigation", async settingsTab => {
  props.settingsTab = settingsTab; await render();
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.toLowerCase()).toBe(settingsTab);
  props.settingsTab = "app"; await render();
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Launch");
});
