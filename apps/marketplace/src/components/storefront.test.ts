// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Storefront } from "./storefront";
import { MarketplaceApiError } from "@/lib/marketplace-api";
import type { CatalogAppDetailResponse } from "@/lib/catalog-types";

const { catalog, detail, installed, showInstall } = vi.hoisted(() => ({ catalog: vi.fn(), detail: vi.fn(), installed: vi.fn(), showInstall: vi.fn() }));
vi.mock("@/lib/marketplace-api", () => ({
  fetchCatalogApps: catalog, fetchCatalogApp: detail, fetchInstalledApps: installed,
  fetchAppUpdateAvailable: vi.fn().mockResolvedValue(false), MarketplaceApiError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock("@hosty-sdk/app/install/react", () => ({ InstallDialog: (props: unknown) => { showInstall(props); return null; } }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogBody: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/markdown-description", () => ({ MarkdownDescription: () => null }));

let root: Root;
let container: HTMLDivElement;
const ready = { status: "ready" as const, code: "ready", message: "Ready" };
const app: CatalogAppDetailResponse = {
  id: "example.app", name: "Example", summary: "Example app", category: null, tags: [], icon: null,
  screenshots: [], publisher: null, sourceName: "Test", signerIdentity: null,
  feedsUrl: "https://apps.example/feeds.json",
  feeds: [{ id: "stable", manifestRef: "stable.json", default: false }, { id: "beta", manifestRef: "beta.json", default: true }],
  feedDiagnostic: ready, descriptionUrl: null, description: null, descriptionDiagnostic: ready,
};
function retryableCatalog(apps = [app]) {
  return { apps, source: { name: "Test", url: "https://catalog.example", description: null },
    diagnostic: { status: "unavailable", code: "catalog_source_unavailable", message: "Catalog temporarily unavailable" } };
}
function popup() {
  return { close: vi.fn() } as unknown as Window;
}
function button(text: string) {
  return [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === text)!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  showInstall.mockReset(); catalog.mockReset(); detail.mockReset(); installed.mockReset();
  catalog.mockResolvedValue({ apps: [app], source: { name: "Test", url: "https://catalog.example", description: null }, diagnostic: ready });
  detail.mockResolvedValue(app); installed.mockResolvedValue([]);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reserves a popup before fetching the card's declared default channel", async () => {
  const confirmationWindow = popup(); const open = vi.spyOn(window, "open").mockReturnValue(confirmationWindow);
  let resolve!: (value: CatalogAppDetailResponse) => void;
  detail.mockImplementation(() => {
    expect(open).toHaveBeenCalledOnce();
    return new Promise(done => { resolve = done; });
  });
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => { button("Install").click(); button("Install").click(); });
  expect(detail).toHaveBeenCalledExactlyOnceWith(app.id, false);
  expect(showInstall).not.toHaveBeenCalled();
  await act(async () => resolve(app));
  expect(showInstall.mock.lastCall?.[0]).toMatchObject({
    source: { feedsUrl: app.feedsUrl, feedId: "beta" }, confirmationWindow,
  });
  expect(open).toHaveBeenCalledWith("about:blank", "_blank", "popup,width=640,height=720");
  expect(confirmationWindow.close).not.toHaveBeenCalled();
});
it("passes an explicitly chosen channel before Core confirmation", async () => {
  const confirmationWindow = popup(); const open = vi.spyOn(window, "open").mockReturnValue(confirmationWindow);
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Details").click());
  expect(open).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Choose install feed"]')!.click());
  await act(async () => button("stable").click());
  expect(showInstall.mock.lastCall?.[0]).toMatchObject({
    source: { feedsUrl: app.feedsUrl, feedId: "stable" }, confirmationWindow,
  });
  expect(open).toHaveBeenCalledOnce();
});
it("keeps a blocked-popup result for the shared SDK's confirmation link", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Install").click());
  expect(showInstall.mock.lastCall?.[0]).toMatchObject({ source: { feedId: "beta" }, confirmationWindow: null });
});
it("closes an unused popup after a failed source lookup and permits a fresh click", async () => {
  const confirmationWindow = popup(); const open = vi.spyOn(window, "open").mockReturnValue(confirmationWindow);
  detail.mockRejectedValueOnce(new Error("Feed unavailable"));
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Install").click());
  expect(confirmationWindow.close).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Feed unavailable");
  expect(showInstall).not.toHaveBeenCalled();
  await act(async () => button("Install").click());
  expect(open).toHaveBeenCalledTimes(2);
  expect(showInstall.mock.lastCall?.[0]).toMatchObject({ source: { feedId: "beta" } });
});

it("closes a reserved popup when the storefront unmounts before source lookup finishes", async () => {
  const confirmationWindow = popup(); vi.spyOn(window, "open").mockReturnValue(confirmationWindow);
  let resolve!: (value: CatalogAppDetailResponse) => void;
  detail.mockImplementation(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Install").click());
  await act(async () => root.render(null));
  expect(confirmationWindow.close).toHaveBeenCalledOnce();
  await act(async () => resolve(app));
  expect(showInstall).not.toHaveBeenCalled();
});

it("asks for an explicit channel when several feeds have no declared default", async () => {
  const confirmationWindow = popup(); const open = vi.spyOn(window, "open").mockReturnValue(confirmationWindow);
  detail.mockResolvedValue({ ...app, feeds: app.feeds.map(feed => ({ ...feed, default: false })) });
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Install").click());
  expect(confirmationWindow.close).toHaveBeenCalledOnce();
  expect(showInstall).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Choose a release feed before installing.");
  // The details main button also asks for a channel instead of installing the first array member.
  const installs = [...container.querySelectorAll("button")].filter(node => node.textContent?.trim() === "Install");
  await act(async () => installs.at(-1)!.click());
  expect(open).toHaveBeenCalledTimes(1);
  expect(showInstall).not.toHaveBeenCalled();
  await act(async () => button("beta").click());
  expect(open).toHaveBeenCalledTimes(2);
  expect(showInstall.mock.lastCall?.[0]).toMatchObject({ source: { feedId: "beta" } });
});
it("recognizes a sole feed as the default without requiring a channel selector", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  detail.mockResolvedValue({ ...app, feeds: [{ id: "nightly", manifestRef: "nightly.json", default: false }] });
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Install").click());
  expect(showInstall.mock.lastCall?.[0]).toMatchObject({ source: { feedId: "nightly" } });
});

it("includes installed apps absent from the catalog and keeps Discover separate", async () => {
  installed.mockResolvedValue([app.id, "outside.catalog"].map(id => ({ id, name: id === app.id ? "Example" : "Local notes", version: "1.2.3", source: "Local install", state: "running", runtime: "local", openUrl: "https://core.test/open-notes", manageUrl: "https://core.test/manage-notes", update: { state: "available", availableVersion: "1.2.4" } })));
  await act(async () => root.render(createElement(Storefront)));
  const installedView = [...container.querySelectorAll("button")].find(node => node.getAttribute("aria-pressed") !== null && node.textContent?.startsWith("Installed"))!;
  await act(async () => installedView.click());
  expect(container.querySelector('[aria-label="Installed apps"]')?.textContent).toContain("outside.catalog");
  expect(container.querySelector('[aria-label="Installed apps"]')?.textContent).toContain("Local install");
  expect(container.querySelector('[aria-label="Catalog apps"]')).toBeNull();
  expect(container.querySelector('[aria-label="Installed apps"]')?.textContent).toContain("1.2.3");
  expect(container.querySelector('[aria-label="Installed apps"]')?.textContent).toContain("Update available · 1.2.4");
  expect(container.querySelector('[aria-label="Installed apps"] a')?.getAttribute("href")).toBe("https://core.test/open-notes");
  const discover = [...container.querySelectorAll("button")].find(node => node.textContent?.startsWith("Discover"))!;
  await act(async () => discover.click());
  expect(container.querySelector('[aria-label="Catalog apps"]')?.textContent).toContain("Example");
});

it("searches publisher and category, not only names and tags", async () => {
  catalog.mockResolvedValue({ apps: [{ ...app, publisher: { name: "Tiny Tools" }, category: "Monitoring" }], source: { name: "Test" }, diagnostic: ready });
  await act(async () => root.render(createElement(Storefront)));
  const input = container.querySelector<HTMLInputElement>("#catalog-search")!;
  for (const query of ["Tiny Tools", "Monitoring"]) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Catalog apps"]')?.textContent).toContain("Example");
  }
});

it("retains installed badges on a transient roster failure instead of offering Install", async () => {
  catalog.mockResolvedValueOnce(retryableCatalog());
  installed.mockResolvedValueOnce([{ id: app.id, name: "Example", version: "1", source: "Local install", state: "running" }]);
  await act(async () => root.render(createElement(Storefront)));
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Catalog apps"] button:disabled')?.textContent?.trim()).toBe("Installed");
  installed.mockRejectedValueOnce(new Error("Core unavailable"));
  await act(async () => button("Retry catalog").click());
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Catalog apps"] button:disabled')?.textContent?.trim()).toBe("Installed");
  expect(container.textContent).toContain("Installed badges show the last successful check");
});
it("ignores a post-install roster response superseded by a catalog retry", async () => {
  catalog.mockResolvedValueOnce(retryableCatalog());
  await act(async () => root.render(createElement(Storefront)));
  vi.spyOn(window, "open").mockReturnValue(popup());
  await act(async () => button("Install").click());
  let resolveOld!: (value: unknown[]) => void;
  installed.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await act(async () => showInstall.mock.lastCall?.[0].onInstalled());
  installed.mockResolvedValueOnce([{ id: app.id, name: "Example", version: "2", source: "Local install", state: "running" }]);
  await act(async () => button("Retry catalog").click());
  await act(async () => resolveOld([]));
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Catalog apps"] button:disabled')?.textContent?.trim()).toBe("Installed");
});


it("keeps selection in an in-page pane and preserves details after cancelling installation", async () => {
  vi.spyOn(window, "open").mockReturnValue(popup());
  detail.mockResolvedValue({ ...app, signerIdentity: "key:catalog-declaration", screenshots: ["https://apps.example/screen.png"] });
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Details").click());
  const pane = container.querySelector('aside[aria-label="App details"]')!;
  expect(pane).not.toBeNull();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[aria-label="Catalog apps"]')).not.toBeNull();
  expect(button("Example").getAttribute("aria-pressed")).toBe("true");
  expect(pane.textContent).toContain("Declared signer · key:catalog-declaration");
  expect(pane.textContent).not.toContain("Installed version");
  expect(pane.querySelector('img[alt="Example screenshot 1"]')?.getAttribute("src")).toBe("https://apps.example/screen.png");
  await act(async () => [...pane.querySelectorAll("button")].find(item => item.textContent?.trim() === "Install")!.click());
  await act(async () => showInstall.mock.lastCall?.[0].onClose());
  expect(container.querySelector('aside[aria-label="App details"]')?.textContent).toContain("Release feeds");
});

it("ignores a superseded detail response and aborts its request", async () => {
  const other = { ...app, id: "another.app", name: "Another" };
  catalog.mockResolvedValue({ apps: [app, other], source: { name: "Test" }, diagnostic: ready });
  let resolveOld!: (value: CatalogAppDetailResponse) => void;
  detail.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(other);
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Example").click());
  const oldSignal = detail.mock.calls[0][2] as AbortSignal;
  expect(container.querySelector('aside [role="status"]')?.textContent).toContain("Loading app details…");
  await act(async () => button("Another").click());
  expect(oldSignal.aborted).toBe(true);
  await act(async () => resolveOld(app));
  expect(container.querySelector('aside h2')?.textContent).toBe("Another");
  expect(button("Another").getAttribute("aria-pressed")).toBe("true");
  expect(button("Example").getAttribute("aria-pressed")).toBe("false");
});

it("closing a loading detail pane aborts the request and a late response cannot reopen it", async () => {
  let resolve!: (value: CatalogAppDetailResponse) => void;
  detail.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Details").click());
  const signal = detail.mock.calls[0][2] as AbortSignal;
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close app details"]')!.click());
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(app));
  expect(container.querySelector('aside')).toBeNull();
  expect(button("Example").getAttribute("aria-pressed")).toBe("false");
});

it("reports a detail load failure in place and retries without losing the catalog", async () => {
  detail.mockRejectedValueOnce(new Error("Feed server unavailable")).mockResolvedValueOnce(app);
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Details").click());
  expect(container.querySelector('aside')?.textContent).toContain("Feed server unavailable");
  expect(container.querySelector('[aria-label="Catalog apps"]')).not.toBeNull();
  await act(async () => button("Retry app details").click());
  expect(detail.mock.lastCall?.slice(0, 2)).toEqual([app.id, true]);
  expect(container.querySelector('aside h2')?.textContent).toBe("Example");
  expect(container.querySelector('aside')?.textContent).not.toContain("Feed server unavailable");
});

it("disables all feed actions while refreshing and after stale detail recovery fails", async () => {
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Details").click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Choose install feed"]')!.click());
  let reject!: (reason: Error) => void;
  detail.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh app details"]')!.click());
  expect(button("stable").disabled).toBe(true);
  await act(async () => reject(new Error("Refresh unavailable")));
  const pane = container.querySelector('aside')!;
  expect(pane.textContent).toContain("Showing the last loaded details");
  expect([...pane.querySelectorAll("button")].find(item => item.textContent?.trim() === "Install")!.disabled).toBe(true);
  expect(button("stable").disabled).toBe(true);
  await act(async () => button("Retry app details").click());
  expect([...pane.querySelectorAll("button")].find(item => item.textContent?.trim() === "Install")!.disabled).toBe(false);
});

it("retries the selected detail with the catalog and rejects a mismatched app response", async () => {
  catalog.mockResolvedValueOnce(retryableCatalog());
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Details").click());
  detail.mockResolvedValueOnce({ ...app, id: "wrong.app", name: "Wrong app" });
  await act(async () => button("Retry catalog").click());
  expect(detail.mock.lastCall?.slice(0, 2)).toEqual([app.id, true]);
  expect(container.querySelector('aside')?.textContent).toContain("The catalog returned another app");
  expect(container.querySelector('aside h2')?.textContent).toBe("Example");
  expect(showInstall).not.toHaveBeenCalled();
});

it("dismisses the feed disclosure with Escape while retaining the selected detail", async () => {
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Details").click());
  const chooser = container.querySelector<HTMLButtonElement>('[aria-label="Choose install feed"]')!;
  await act(async () => chooser.click());
  await act(async () => button("stable").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(chooser.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('aside h2')?.textContent).toBe("Example");
  expect(document.activeElement).toBe(chooser);
  await act(async () => chooser.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('aside')).toBeNull();
});

it("discards protected catalog, detail and roster after access is revoked and ignores late reads", async () => {
  catalog.mockResolvedValueOnce(retryableCatalog());
  installed.mockResolvedValueOnce([{ id: app.id, name: "Example", version: "1", source: "Local install", state: "running" }]);
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Details").click());
  let resolveCatalog!: (value: unknown) => void;
  catalog.mockImplementationOnce(() => new Promise(resolve => { resolveCatalog = resolve; }));
  installed.mockRejectedValueOnce(new MarketplaceApiError("Administrator access required", 403));
  await act(async () => button("Retry catalog").click());
  const catalogSignal = catalog.mock.lastCall?.[1] as AbortSignal;
  expect(catalogSignal.aborted).toBe(true);
  expect(container.querySelector('aside')).toBeNull();
  expect(container.querySelector('[aria-label="Catalog apps"]')).toBeNull();
  await act(async () => resolveCatalog({ apps: [app], source: { name: "Test" }, diagnostic: ready }));
  expect(container.querySelector('[aria-label="Catalog apps"]')).toBeNull();
  expect(container.textContent).toContain("Administrator access required");
});

it("keeps an unavailable source diagnostic distinct from a successful empty catalog", async () => {
  catalog.mockResolvedValueOnce({ apps: [], source: { name: "Test" }, diagnostic: { status: "unavailable", code: "source_unavailable", message: "Catalog fetch failed" } });
  await act(async () => root.render(createElement(Storefront)));
  expect(container.textContent).toContain("Catalog fetch failed");
  expect(container.textContent).not.toContain("Catalog is empty");
  catalog.mockResolvedValueOnce({ apps: [], source: { name: "Test" }, diagnostic: ready });
  await act(async () => button("Retry catalog").click());
  expect(container.textContent).toContain("Catalog is empty");
  expect(container.textContent).not.toContain("Catalog fetch failed");
});


it("shows a visible catalog loading label without claiming a known installed count", async () => {
  catalog.mockImplementationOnce(() => new Promise(() => {}));
  installed.mockImplementationOnce(() => new Promise(() => {}));
  await act(async () => root.render(createElement(Storefront)));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading catalog…");
  const views = container.querySelector('[aria-label="Marketplace views"]')!;
  expect(views.textContent).toBe("DiscoverInstalled");
  expect(container.textContent).not.toContain("0 apps");
  expect(container.querySelector('a[href="/settings"]')?.textContent).toBe("Settings");
  expect(container.querySelector('[aria-label="Catalog source"]')?.textContent).not.toContain("No source configured");
});

it("keeps cached installed Open and Manage available during transient refresh failure", async () => {
  catalog.mockResolvedValueOnce(retryableCatalog());
  installed.mockResolvedValueOnce([{ id: "outside.catalog", name: "Local notes", version: "1.2.3", source: "Local install", state: "running", openUrl: "https://core.test/open-notes", manageUrl: "https://core.test/manage-notes" }]);
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => [...container.querySelectorAll("button")].find(item => item.textContent?.startsWith("Installed"))!.click());
  installed.mockRejectedValueOnce(new Error("Core unavailable"));
  await act(async () => button("Retry catalog").click());
  const list = container.querySelector('[aria-label="Installed apps"]')!;
  expect(list.textContent).toContain("Core unavailable");
  expect(list.textContent).toContain("Showing the last successful installed-app check.");
  expect(list.querySelector('a[href="https://core.test/open-notes"]')).not.toBeNull();
  expect(list.querySelector('a[href="https://core.test/manage-notes"]')).not.toBeNull();
  expect(list.textContent).not.toContain("No installed apps found");
});

it("does not turn an initial installed read failure into an empty or successful roster", async () => {
  installed.mockRejectedValueOnce(new Error("Core unavailable"));
  await act(async () => root.render(createElement(Storefront)));
  expect(container.textContent).toContain("Installed status is unavailable.");
  expect(container.textContent).not.toContain("Installed badges show the last successful check.");
  await act(async () => button("Installed").click());
  const list = container.querySelector('[aria-label="Installed apps"]')!;
  expect(list.textContent).toContain("Core unavailable");
  expect(list.textContent).not.toContain("No installed apps found");
  installed.mockResolvedValueOnce([]);
  await act(async () => button("Retry installed apps").click());
  expect(list.textContent).toContain("No installed apps found");
});

it("retains the same catalog snapshot on source unavailability, but not after source changes", async () => {
  catalog.mockResolvedValueOnce(retryableCatalog());
  await act(async () => root.render(createElement(Storefront)));
  const unavailable = { status: "unavailable", code: "catalog_source_unavailable", message: "Catalog temporarily unavailable" };
  catalog.mockResolvedValueOnce({ apps: [], source: { name: "Test", url: "https://catalog.example" }, diagnostic: unavailable });
  await act(async () => button("Retry catalog").click());
  expect(container.querySelector('[aria-label="Catalog apps"]')?.textContent).toContain("Example");
  expect(container.textContent).toContain("Showing the last loaded catalog");
  expect(container.textContent).not.toContain("Catalog is empty");
  catalog.mockResolvedValueOnce({ apps: [], source: { name: "Other", url: "https://other-catalog.example" }, diagnostic: unavailable });
  await act(async () => button("Retry catalog").click());
  expect(container.querySelector('[aria-label="Catalog apps"]')).toBeNull();
  expect(container.textContent).not.toContain("Showing the last loaded catalog");
});

it("offers clear filters after no matches and restores keyboard focus to search", async () => {
  catalog.mockResolvedValueOnce({ apps: [{ ...app, category: "Development" }], source: { name: "Test", url: "https://catalog.example" }, diagnostic: ready });
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => button("Development").click());
  const input = container.querySelector<HTMLInputElement>("#catalog-search")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "missing");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("No matching apps");
  await act(async () => button("Clear filters").click());
  expect(input.value).toBe("");
  expect(button("All").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[aria-label="Catalog apps"]')?.textContent).toContain("Example");
  expect(document.activeElement).toBe(input);
});

it("returns keyboard focus to the original details control after closing", async () => {
  await act(async () => root.render(createElement(Storefront)));
  const opener = button("Details");
  await act(async () => { opener.focus(); opener.click(); });
  expect(document.activeElement).toBe(container.querySelector('aside'));
  await act(async () => button("Back to catalog").click());
  expect(document.activeElement).toBe(opener);
});

it("renders catalog-declared icons for first-party apps in both the grid and details", async () => {
  const declared = { ...app, id: "hosty.harness", icon: "https://catalog.example/assets/current-harness.svg" };
  catalog.mockResolvedValue({ apps: [declared], source: { name: "Test", url: "https://catalog.example" }, diagnostic: ready });
  detail.mockResolvedValue(declared);
  await act(async () => root.render(createElement(Storefront)));
  expect(container.querySelector('[aria-label="Catalog apps"] img')?.getAttribute("src")).toBe(declared.icon);
  await act(async () => button("Details").click());
  expect(container.querySelector('aside img')?.getAttribute("src")).toBe(declared.icon);
});

it("falls back after a catalog icon fails and attempts its replacement URL after catalog recovery", async () => {
  const declared = { ...app, id: "hosty.marketplace", icon: "https://catalog.example/assets/old.svg" };
  catalog.mockResolvedValueOnce(retryableCatalog([declared]));
  await act(async () => root.render(createElement(Storefront)));
  await act(async () => container.querySelector('[aria-label="Catalog apps"] img')!.dispatchEvent(new Event("error")));
  expect(container.querySelector('[aria-label="Catalog apps"] img')).toBeNull();
  expect(container.querySelector('[aria-label="Catalog apps"] svg.lucide-package')).not.toBeNull();
  const replacement = { ...declared, icon: "https://catalog.example/assets/current.svg" };
  catalog.mockResolvedValueOnce({ apps: [replacement], source: { name: "Test", url: "https://catalog.example" }, diagnostic: ready });
  await act(async () => button("Retry catalog").click());
  expect(container.querySelector('[aria-label="Catalog apps"] img')?.getAttribute("src")).toBe(replacement.icon);
});
