// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Storefront } from "./storefront";
import type { CatalogAppDetailResponse } from "@/lib/catalog-types";

const { catalog, detail, installed, showInstall } = vi.hoisted(() => ({ catalog: vi.fn(), detail: vi.fn(), installed: vi.fn(), showInstall: vi.fn() }));
vi.mock("@/lib/marketplace-api", () => ({
  fetchCatalogApps: catalog, fetchCatalogApp: detail, fetchInstalledAppIds: installed,
  fetchAppUpdateAvailable: vi.fn(), MarketplaceApiError: class extends Error {},
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
