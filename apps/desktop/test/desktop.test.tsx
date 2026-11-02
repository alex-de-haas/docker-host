import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App, User } from "../src/lib/model";
const api = vi.hoisted(() => ({ readDesktop: vi.fn(), lifecycle: vi.fn() }));
vi.mock("../src/lib/api", () => api);
vi.mock("../src/lib/core-events", () => ({ subscribeToCoreEvents: () => () => {}, CoreEventNames: {} }));
vi.mock("../src/lib/wallpaper", () => ({ readWallpaper: async () => null }));
vi.mock("../src/components/app-content", () => ({ AppContent: ({ app, navigationCompact }: { app: App; navigationCompact?: boolean }) => <iframe title={app?.displayName || "Unavailable"} data-navigation-compact={navigationCompact} /> }));
import { Desktop } from "../src/components/desktop";
const notes: App = { id: "notes", displayName: "Notes", runtimeState: "running", entryEndpoint: "web", embeddedUrl: "https://notes.example/" };
const stopped: App = { ...notes, id: "music", displayName: "Music", runtimeState: "stopped" };
const user: User = { id: "alice", displayName: "Alice", role: "host.admin" };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  localStorage.clear(); api.readDesktop.mockResolvedValue({ user, apps: [notes, stopped] }); api.lifecycle.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() { await act(async () => { root.render(<Desktop appId="hosty.desktop" coreOrigin="https://core.example" />); }); }
async function click(label: string) {
  const target = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label);
  expect(target, `button ${label}`).toBeDefined(); await act(async () => target!.click());
}
async function openDockMenu(label: string) {
  const target = container.querySelector<HTMLButtonElement>(`.dock-item[aria-label="${label}"]`);
  expect(target, `dock button ${label}`).not.toBeNull();
  await act(async () => target!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })));
}
it("keeps the same app document through minimize, focus and theme changes; close does not stop it", async () => {
  await render(); await click("Notes"); expect(container.querySelector('a[target="_blank"]')).toBeNull(); expect(container.querySelector('[aria-label="Notes window menu"]')).toBeNull(); const frame = container.querySelector('iframe[title="Notes"]'); expect(frame).not.toBeNull();
  await click("Minimize Notes"); expect(container.querySelector('iframe[title="Notes"]')).toBe(frame);
  expect((frame!.closest("section") as HTMLElement).style.display).toBe("none");
  await click("Notes"); await click("Toggle theme"); expect(container.querySelector('iframe[title="Notes"]')).toBe(frame);
  await click("Close Notes"); expect(container.querySelector('iframe[title="Notes"]')).toBeNull(); expect(api.lifecycle).not.toHaveBeenCalled();
});
it("opens one waiting window and coalesces repeated starts", async () => {
  let resolve!: () => void; api.lifecycle.mockReturnValue(new Promise<void>(done => { resolve = done; }));
  await render(); await click("Music — click to start"); await click("Music — click to start");
  expect(api.lifecycle).toHaveBeenCalledTimes(1); expect(api.lifecycle).toHaveBeenCalledWith("music", "start");
  expect(container.querySelectorAll('iframe[title="Music"]')).toHaveLength(1);
  await act(async () => resolve());
});
it("hides stopped apps and lifecycle actions for an ordinary user", async () => {
  api.readDesktop.mockResolvedValue({ user: { ...user, role: "host.user" }, apps: [notes, stopped] });
  await render(); expect(container.textContent).not.toContain("Music"); await click("Notes"); await openDockMenu("Notes");
  expect(container.textContent).not.toContain("Stop for everyone"); expect(container.textContent).not.toContain("Restart for everyone");
});
it("requires the explicit shared-runtime action while cancel keeps the app running", async () => {
  await render(); await click("Notes"); await openDockMenu("Notes");
  const stop = [...container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find(button => button.textContent === "Stop for everyone…");
  await act(async () => stop!.click()); expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("everyone");
  expect(api.lifecycle).not.toHaveBeenCalled(); await click("Cancel"); expect(api.lifecycle).not.toHaveBeenCalled();
  await openDockMenu("Notes");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find(button => button.textContent === "Stop for everyone…")!.click());
  await click("Stop for everyone"); expect(api.lifecycle).toHaveBeenCalledWith("notes", "stop");
});

it("compacts navigation per window without replacing the document and restores the user's choice", async () => {
  api.readDesktop.mockResolvedValue({ user, apps: [{ ...notes, navigation: [{ label: "Notes", path: "/" }, { label: "Archive", path: "/archive" }] }, stopped] });
  await render(); await click("Notes");
  const frame = container.querySelector('iframe[title="Notes"]');
  await click("Compact Notes navigation");
  expect(container.querySelector('iframe[title="Notes"]')).toBe(frame);
  expect(frame?.getAttribute("data-navigation-compact")).toBe("true");
  await click("Music — click to start");
  expect(container.querySelector('[aria-label="Compact Music navigation"]')).toBeNull();
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(container.querySelector('iframe[title="Notes"]')?.getAttribute("data-navigation-compact")).toBe("true");
  await click("Expand Notes navigation");
  expect(container.querySelector('iframe[title="Notes"]')?.getAttribute("data-navigation-compact")).toBe("false");
});

it("opens independent instances, lists them in Dock, and preserves a sibling when one closes", async () => {
  await render(); await click("Notes");
  const original = container.querySelector('iframe[title="Notes"]');
  await openDockMenu("Notes"); await click("New window");
  const frames = container.querySelectorAll('iframe[title="Notes"]'); expect(frames).toHaveLength(2);
  const ids = [...frames].map(frame => frame.closest('[data-window-id]')!.getAttribute('data-window-id'));
  expect(new Set(ids).size).toBe(2);
  await openDockMenu("Notes");
  expect(container.querySelector('[role="menu"]')?.textContent).toContain("Notes (1)");
  await click("Notes (1)");
  expect(original?.closest('section')?.classList.contains('active')).toBe(true);
  await act(async () => (original!.closest('section')!.querySelector('[aria-label="Close Notes"]') as HTMLButtonElement).click());
  expect(container.querySelectorAll('iframe[title="Notes"]')).toHaveLength(1);
  expect(api.lifecycle).not.toHaveBeenCalled();
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(container.querySelectorAll('iframe[title="Notes"]')).toHaveLength(1);
});

it("fits maximized and tiled windows to the Desktop container after a root tool resizes it", async () => {
  let measure = () => {};
  let width = 1400, height = 900;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { measure = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    return new DOMRect(40, 20, this.classList.contains("desktop") ? width : 0, this.classList.contains("desktop") ? height : 0);
  });
  await render(); await click("Notes"); await click("Maximize Notes");
  const frame = container.querySelector('iframe[title="Notes"]')!, win = frame.closest('section')!;
  expect(win.style.width).toBe("1376px");
  width = 950; height = 760; await act(async () => measure());
  expect(win.style.width).toBe("926px"); expect(win.style.height).toBe("620px");
  await openDockMenu("Notes"); await click("Tile right");
  expect(parseFloat(win.style.left) + parseFloat(win.style.width)).toBeLessThanOrEqual(width);
  expect(container.querySelector('iframe[title="Notes"]')).toBe(frame);
});
