import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationBell } from "../src/app/shell/notifications/notification-bell";
import type { ShellNotification } from "../src/app/shell/types";

const { read, send, stream } = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), stream: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ coreOrigin: "https://core.example", sendCsrfJson: send }) }));
vi.mock("../src/app/shell/events/core-event-stream", () => ({ CoreEventNames: { notification: "notification" }, subscribeToCoreEvents: stream }));
let root: Root, container: HTMLDivElement, items: ShellNotification[];
function notification(id: string, level: string, link: string | null = null): ShellNotification {
  return { id, level, title: id, link, source: { kind: "app", appId: "app" }, audience: "user", body: "Details", createdAt: "2026-10-21T20:00:00Z", read: false, readAt: null };
}
async function openMenu() {
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
}
function row(title: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes(title))!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  items = [notification("Completed", "success"), notification("Needs attention", "warning"), notification("Failed", "error"), notification("Notice", "info")];
  read.mockImplementation(async () => ({ ok: true, json: async () => ({ notifications: items, unreadCount: items.filter(item => !item.read).length }) }));
  send.mockImplementation(async (_url, body: { ids: string[] | null }) => {
    items = items.map(item => body.ids === null || body.ids.includes(item.id) ? { ...item, read: true } : item);
    return { json: async () => ({ unreadCount: items.filter(item => !item.read).length }) };
  });
  stream.mockImplementation((_origin, options: { onSync: () => void }) => { options.onSync(); return () => {}; });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("announces severity without relying on color and preserves row and bulk mark-read actions", async () => {
  await act(async () => root.render(<NotificationBell />)); await openMenu();
  for (const [title, severity] of [["Completed", "Success"], ["Needs attention", "Warning"], ["Failed", "Error"], ["Notice", "Information"]]) {
    expect(row(title).querySelector(".sr-only")?.textContent).toBe(`${severity}: `);
    expect(row(title).querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  }
  await act(async () => row("Needs attention").click());
  expect(send).toHaveBeenCalledWith("https://core.example/api/notifications/read", { ids: ["Needs attention"] });
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  const all = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Mark all read"))!;
  await act(async () => all.click());
  expect(send).toHaveBeenLastCalledWith("https://core.example/api/notifications/read", { ids: null });
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Notifications");
});
it("keeps unknown severity neutral and preserves safe navigation without executing unsafe links", async () => {
  items = [notification("Unknown", "future", "javascript:alert(1)"), notification("Open details", "info", "/settings")];
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => root.render(<NotificationBell />)); await openMenu();
  expect(row("Unknown").querySelector(".sr-only")?.textContent).toBe("Notification: ");
  await act(async () => row("Unknown").click()); expect(opened).not.toHaveBeenCalled();
  await act(async () => row("Open details").click());
  expect(opened).toHaveBeenCalledExactlyOnceWith(new URL("/settings", window.location.origin).href, "_blank", "noopener,noreferrer");
  expect(send).toHaveBeenCalledWith("https://core.example/api/notifications/read", { ids: ["Open details"] });
});
