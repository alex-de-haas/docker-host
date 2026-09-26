import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ShellRightPanel } from "../src/app/shell/surfaces/shell-right-panel";
import type { AppSurfaceTab } from "../src/app/shell/surfaces/app-surface-tabs";

// Keep the real launch hook, readiness gate, rail and DOM lifecycle. The embedded app
// is represented by an iframe: losing that node is precisely what loses its local draft.
vi.mock("../src/app/shell/embedding/embedded-app-frame", () => ({
  EmbeddedAppFrame: ({ src, title }: { src: string; title: string }) => <iframe src={src} title={title} />,
}));

const tabs: AppSurfaceTab[] = [
  { appId: "tools", appLabel: "Tools", key: "tools#0", label: "Assistant", icon: "bot", embeddedUrl: "/assistant", running: true, transitioning: false, runtimeState: "running", readiness: "ready" },
  { appId: "tools", appLabel: "Tools", key: "tools#1", label: "Session", icon: "contact-round", embeddedUrl: "/session", running: true, transitioning: false, runtimeState: "running", readiness: "ready" },
];
let host: HTMLDivElement;
let root: Root;
const launch = vi.fn<(app: string, url: string) => Promise<string>>(async () => "about:blank");
const select = vi.fn();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout observer; tooltips use it only to measure their arrow.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  launch.mockClear();
  select.mockClear();
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render(expanded: boolean, activeTab: AppSurfaceTab | null = tabs[0], choices = tabs, reloadKey = 0) {
  await act(async () => {
    root.render(<ShellRightPanel tabs={choices} activeTab={activeTab} expanded={expanded}
      theme="light" themePreference="system" onSelectTab={select} onOpenSurfaceFrame={launch}
      attention={{ tools: 2 }} reloadKey={reloadKey} />);
  });
}

test("a fresh collapsed rail launches nothing; opening and collapsing retain the same frame", async () => {
  await render(false);
  expect(launch).not.toHaveBeenCalled();
  expect(host.querySelector("iframe")).toBeNull();
  await render(true);
  const frame = host.querySelector("iframe");
  expect(frame).not.toBeNull();
  expect(launch).toHaveBeenCalledTimes(1);
  await render(false);
  expect(host.querySelector("iframe")).toBe(frame);
  expect(host.querySelector("section")?.hasAttribute("hidden")).toBe(true);
  expect(host.querySelector("section")?.hasAttribute("inert")).toBe(true);
  await render(true);
  expect(host.querySelector("iframe")).toBe(frame);
  expect(launch).toHaveBeenCalledTimes(1);
});

test("only selected tools launch, and hidden bodies still obey auth recovery and removal", async () => {
  await render(true);
  await render(true, tabs[1]);
  expect(launch.mock.calls.map(call => call[1])).toEqual(["/assistant", "/session"]);
  expect(host.querySelectorAll("iframe")).toHaveLength(1);
  await render(false, tabs[1], tabs, 1);
  expect(launch).toHaveBeenCalledTimes(3);
  await render(false, null, []);
  expect(host.querySelector("iframe")).toBeNull();
  // A new fallback selection while collapsed must not launch another tool.
  await render(false, tabs[0], [tabs[0]]);
  expect(launch).toHaveBeenCalledTimes(3);
});

test("stopped tools and many legacy/unknown icons remain accessible without opening frames", async () => {
  const choices = Array.from({ length: 40 }, (_, index) => ({
    ...tabs[0], key: `tools#${index}`, label: `Tool ${index}`, icon: index % 2 ? "not-a-lucide-icon" : null,
    embeddedUrl: null, running: false, runtimeState: "stopped",
  }));
  await render(false, choices[0], choices);
  const buttons = host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button');
  expect(buttons).toHaveLength(40);
  expect([...buttons].every(button => button.querySelector("svg") !== null)).toBe(true);
  expect(buttons[0].getAttribute("aria-label")).toContain("Tools · Tool 0 (not running) · 2 waiting for you");
  await act(() => { buttons[0].focus(); buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  expect(document.activeElement).toBe(buttons[39]);
  expect(select).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  await act(() => buttons[39].click());
  expect(select).toHaveBeenCalledWith("tools#39");
  await render(true, choices[39], choices);
  expect(host.textContent).toContain("isn't running");
  expect(host.textContent).not.toContain("Start"); // No administrative start capability supplied.
});

test("readiness degradation preserves an opened body but a stopped runtime removes it", async () => {
  await render(true);
  const frame = host.querySelector("iframe");
  await render(false, { ...tabs[0], readiness: "degraded" });
  expect(host.querySelector("iframe")).toBe(frame);
  await render(false, { ...tabs[0], embeddedUrl: null, running: false, runtimeState: "stopped" });
  expect(host.querySelector("iframe")).toBeNull();
});
