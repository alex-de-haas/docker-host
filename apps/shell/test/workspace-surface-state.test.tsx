import { act, type ContextType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellClient } from "../src/app/shell-client";
import { UiHostContext } from "../../../packages/app-sdk/src/ui-context";
import type { CoreApp, EmbeddedWorkspace } from "../src/app/shell/types";
import type { UiViewDescriptor } from "../../../packages/app-sdk/src/ui-workspaces";

const fixture = vi.hoisted(() => ({
  read: vi.fn(), router: { replace: vi.fn(), push: vi.fn() }, pathname: "/workspace", params: new URLSearchParams(),
  sidebar: null as null | { workspace: EmbeddedWorkspace | null; onLaunchApp: (app: CoreApp, page: { label: string; path: string; redirectUri: string }) => Promise<boolean> },
  toast: { info: vi.fn(), dismiss: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, usePathname: () => fixture.pathname, useSearchParams: () => fixture.params }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", resolvedTheme: "light" }) }));
vi.mock("../src/app/shell/events/core-event-stream", () => ({ CoreEventNames: {}, subscribeToCoreEvents: () => () => {} }));
vi.mock("../src/app/shell/assistant/use-assistant-selection", () => ({ useAssistantSelection: () => ({ assistants: [], selected: null, selectedId: null, select: () => {}, choose: async () => null }) }));
vi.mock("../src/app/shell/update-notifications", () => ({ useAppUpdateNotifications: () => {} }));
vi.mock("../src/components/reui/operation-toast", async () => { const { createContext } = await import("react"); return { toast: fixture.toast, AssistantFeedbackContext: createContext({}), errorReportText: () => "" }; });
vi.mock("../src/components/reui/confirmation", () => ({ useConfirmation: () => ({ confirm: vi.fn(), dialog: null }) }));
vi.mock("../src/app/shell/resources/resource-usage", () => ({ ResourceUsageProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("../src/app/shell/sidebar/shell-sidebar", () => ({ ShellSidebar: (props: NonNullable<typeof fixture.sidebar>) => { fixture.sidebar = props; return null; } }));
vi.mock("../src/app/shell/chrome/shell-mobile-tabs", () => ({ ShellMobileTabs: () => null }));
vi.mock("../src/app/shell/chrome/shell-top-strip", () => ({ ShellTopStrip: () => null }));
vi.mock("@hosty-sdk/app/ui/react", async original => ({ ...await original<object>(), useHostyUiHost: () => null, HostyFeedbackWorkspace: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/app/shell/chrome/shell-panel-workspace", () => ({ ShellPanelWorkspace: ({ children }: { children: ReactNode }) => children }));

let root: Root, container: HTMLDivElement;
let apps: CoreApp[];
const target: CoreApp = { id: "org.example.documents", installationId: "documents-one", displayName: "Documents", version: "1", kind: "app", system: false,
  source: "manifest", operationStatus: "started", runtimeState: "running", capabilities: [], entryEndpoint: "web", entryPath: "/library",
  embeddedUrl: "https://documents.test/deployment/library", navigation: [
    { label: "Library", path: "/library", embeddedUrl: "https://documents.test/deployment/library", endpoint: "web", service: "ui" },
    { label: "Search", path: "/search", embeddedUrl: "https://documents.test/deployment/search", endpoint: "web", service: "ui" },
  ] };
const register = vi.fn<(element: HTMLIFrameElement, surface: unknown, ready: unknown, view: UiViewDescriptor) => () => void>(() => () => {});
const host = { registerFrame: register, getSnapshot: () => ({ bootstrap: null }), setViewChrome: () => {} } as unknown as ContextType<typeof UiHostContext>;
const syncRoute = () => { fixture.pathname = window.location.pathname; fixture.params = new URLSearchParams(window.location.search); };
const render = () => act(async () => root.render(<UiHostContext.Provider value={host}><ShellClient coreOrigin="https://core.test" shellAppId="example.shell"
  initialSidebarCompact={false} initialRightPanelOpen={false} initialRightPanelWidth={360}><p>Home</p></ShellClient></UiHostContext.Provider>));
const report = () => register.mock.calls.at(-1)![3].onSurfaceState!;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  apps = [target];
  window.history.replaceState({}, "", `/workspace?app=${target.id}&path=%2Flibrary&assistantSession=compact-chat#shell-note`); syncRoute();
  for (const method of ["push", "replace"] as const) fixture.router[method].mockImplementation((href: string) => { window.history.replaceState({}, "", href); syncRoute(); });
  fixture.read.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/core/status") return Response.json({ status: "ready", warnings: [] });
    if (path === "/api/auth/session") return Response.json({ authenticated: true, user: { id: "viewer", role: "host.user" } });
    if (path === "/api/auth/csrf") return Response.json({ token: "csrf" });
    if (path === "/api/apps") return Response.json({ apps });
    if (path === "/api/apps/execution-targets") return Response.json({ apps: [] });
    if (path === "/api/global-mounts") return Response.json({ mounts: [] });
    if (path === "/api/development/activation-workspaces") return Response.json({ workspaces: [] });
    if (path === "/api/core-environments") return Response.json({ environments: [] });
    if (path === "/api/core/development") return Response.json({ message: "Unavailable" }, { status: 404 });
    throw new Error("Unexpected request: " + path);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("updates the parent reload route and standalone URL without replacing the frame or its unsent draft", async () => {
  await render();
  const frame = container.querySelector("iframe")!, src = frame.src;
  const child = frame.contentDocument!; child.open(); child.write('<textarea aria-label="Draft">Unsent text</textarea>'); child.close();
  const draft = child.querySelector("textarea")!;
  const next = "/library?document=two#draft";
  await act(async () => report()({ route: `/deployment${next}`, title: "Selected document" }));
  expect(new URLSearchParams(window.location.search).get("path")).toBe(next);
  expect(new URLSearchParams(window.location.search).get("assistantSession")).toBe("compact-chat"); expect(window.location.hash).toBe("#shell-note");
  expect(fixture.sidebar?.workspace).toMatchObject({ path: next, pageLabel: "Selected document", launchPath: "/library" });
  const standalone = new URL(fixture.sidebar!.workspace!.externalUrl);
  const destination = new URL(standalone.searchParams.get("redirectUri")!);
  expect(destination.pathname).toBe("/deployment/library"); expect(destination.searchParams.get("document")).toBe("two"); expect(destination.hash).toBe("#draft");
  expect(destination.searchParams.has("hosty_launch")).toBe(false);
  expect(container.querySelector("iframe")).toBe(frame); expect(frame.src).toBe(src);
  expect(frame.contentDocument?.querySelector("textarea")).toBe(draft); expect(draft.value).toBe("Unsent text");
  await act(async () => report()({ route: "/deployment/library?document=three#latest" }));
  expect(new URLSearchParams(window.location.search).get("path")).toBe("/library?document=three#latest");
  // Let Next's search snapshot catch up after the acknowledged in-place history change.
  syncRoute(); await render(); expect(container.querySelector("iframe")).toBe(frame); expect(frame.src).toBe(src);
  await act(async () => root.unmount()); root = createRoot(container); await render();
  const reloaded = new URL(container.querySelector("iframe")!.src);
  expect(reloaded.pathname).toBe("/deployment/library"); expect(reloaded.searchParams.get("document")).toBe("three"); expect(reloaded.hash).toBe("#latest");
});

it("ignores callbacks from the old frame after explicit same-app navigation", async () => {
  await render(); const previous = report();
  await act(async () => { await fixture.sidebar!.onLaunchApp(target, { label: "Search", path: "/search", redirectUri: "https://documents.test/deployment/search" }); });
  const frame = container.querySelector("iframe")!, src = frame.src, href = window.location.href;
  await act(async () => previous({ route: "/deployment/library?document=old" }));
  expect(window.location.href).toBe(href); expect(frame.src).toBe(src);
  expect(fixture.sidebar?.workspace?.path).toBe("/search");
});

it.each(["//evil.test/page", "https://evil.test/page", "/outside-prefix"])("ignores rejected route %s", async route => {
  await render(); const frame = container.querySelector("iframe")!, href = window.location.href;
  await act(async () => report()({ route }));
  expect(window.location.href).toBe(href); expect(fixture.sidebar?.workspace?.path).toBe("/library"); expect(container.querySelector("iframe")).toBe(frame);
});

it.each(["/settings", "/workspace?app=org.example.other&path=%2Flibrary", `/workspace?app=${target.id}&path=%2Fsearch`])(
  "does not overwrite a newer parent route %s while its frame transition is pending", async path => {
    await render(); const previous = report();
    window.history.replaceState({}, "", path);
    await act(async () => previous({ route: "/deployment/library?document=old" }));
    expect(window.location.pathname + window.location.search).toBe(path);
    expect(fixture.sidebar?.workspace?.path).toBe("/library");
  });
