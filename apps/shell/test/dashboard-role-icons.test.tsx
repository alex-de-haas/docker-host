import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardRoleIcons } from "../src/app/shell/pages/dashboard-role-icons";
import type { CoreApp } from "../src/app/shell/types";

let root: Root, container: HTMLDivElement;
const interfaces = (...roles: string[]): NonNullable<CoreApp["interfaces"]> => Object.fromEntries(
  roles.map(role => [role, [{ key: "default", path: `/api/${role}/v1`, version: 1, url: null }]]),
);
const app = (overrides: Partial<CoreApp> = {}): CoreApp => ({
  id: "unrelated.publisher.provider", displayName: "Unrelated application", version: "1.0.0",
  kind: "app", system: false, source: "package", operationStatus: "idle", runtimeState: "stopped",
  capabilities: [], ...overrides,
});
async function render(value: CoreApp, isShell = false) {
  await act(async () => root.render(<DashboardRoleIcons app={value} isShell={isShell} />));
}
const labels = () => [...container.querySelectorAll('[role="img"]')].map(element => element.getAttribute("aria-label"));
async function tooltip(label: string) {
  const icon = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  await act(async () => icon.focus());
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
  return document.querySelector('[role="tooltip"]')!.textContent;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("shows all reviewed roles for an unrelated app, independent of its stopped state", async () => {
  await render(app({ confirmedRoles: ["translation", "assistant", "agent", "speech-to-text"], interfaces: interfaces("agent", "assistant", "speech-to-text", "translation") }));
  expect(labels()).toEqual(["Agent provider", "Assistant provider", "Speech-to-text provider", "Translation provider"]);
  for (const icon of ["brain", "bot", "audio-lines", "languages"]) {
    expect(container.querySelector(`svg.lucide-${icon}[aria-hidden="true"]`)).not.toBeNull();
  }
  expect(await tooltip("Agent provider")).toContain("Runs agent sessions through a reviewed provider interface.");
});

it("does not infer roles from a familiar ID, system classification, branding or settings UI", async () => {
  await render(app({ id: "hosty.desktop", displayName: "Codex Claude Ollama Shell", system: true,
    icon: "PanelsTopLeft", capabilities: ["agent", "assistant"],
    settingsSurface: { path: "/settings" }, entryPath: "/", embeddedUrl: "https://app.test/" }));
  expect(labels()).toEqual([]);
  await render(app({ id: "hosty.shell", confirmedRoles: ["conversation-history", "agent-sessions", "unknown-role"] }));
  expect(labels()).toEqual([]);
});

it("deduplicates tasks and executor marks while describing both reviewed interfaces", async () => {
  await render(app({ confirmedRoles: ["tasks", "task-executor", "tasks", "task-executor", "agent", "agent"], interfaces: interfaces("agent", "tasks", "task-executor") }));
  expect(labels()).toEqual(["Agent provider", "Tasks and task executor"]);
  expect(container.querySelectorAll("svg.lucide-clipboard-check")).toHaveLength(1);
  expect(await tooltip("Tasks and task executor")).toContain("Provides task storage and executes task attempts");
});

it.each([
  ["tasks", "Tasks provider", "Stores and exposes tasks"],
  ["task-executor", "Task executor", "Executes task attempts"],
])("describes %s without claiming the other task role", async (role, label, description) => {
  await render(app({ confirmedRoles: [role], interfaces: interfaces(role) }));
  expect(labels()).toEqual([label]);
  expect(await tooltip(label)).toContain(description);
});

it("marks only the explicitly selected Shell and retains its other reviewed roles", async () => {
  await render(app({ id: "third-party.navigation", confirmedRoles: ["assistant"], interfaces: interfaces("assistant") }), true);
  expect(labels()).toEqual(["Assistant provider", "Shell interface"]);
  expect(container.querySelector("svg.lucide-panels-top-left")).not.toBeNull();
  expect(await tooltip("Shell interface")).toContain("selected Hosty web interface");
  await render(app({ id: "third-party.navigation", confirmedRoles: ["assistant"], interfaces: interfaces("assistant") }), false);
  expect(labels()).toEqual(["Assistant provider"]);
});


it("hides historical translation grants once only the agent interface remains declared", async () => {
  const current = app({ confirmedRoles: ["agent", "translation"], interfaces: interfaces("agent") });
  await render(current);
  expect(labels()).toEqual(["Agent provider"]);
  expect(container.querySelector("svg.lucide-languages")).toBeNull();
  await render({ ...current, interfaces: { ...current.interfaces, translation: [] }, runtimeState: "failed" });
  expect(labels()).toEqual(["Agent provider"]);
});

it("requires both review and a current declaration, without gating on the provider URL", async () => {
  await render(app({ confirmedRoles: ["agent"], interfaces: interfaces("translation") }));
  expect(labels()).toEqual([]);
  await render(app({ confirmedRoles: ["agent"] }));
  expect(labels()).toEqual([]);
  await render(app({ confirmedRoles: ["agent"], interfaces: interfaces("agent"), runtimeState: "stopped" }));
  expect(labels()).toEqual(["Agent provider"]);
  await render(app(), true);
  expect(labels()).toEqual(["Shell interface"]);
});

it("does not claim execution when a historical task-executor grant has no current declaration", async () => {
  await render(app({ confirmedRoles: ["tasks", "task-executor"], interfaces: interfaces("tasks") }));
  expect(labels()).toEqual(["Tasks provider"]);
  expect(await tooltip("Tasks provider")).toContain("Stores and exposes tasks");
  expect(document.querySelector('[role="tooltip"]')!.textContent).not.toContain("executes task attempts");
});
