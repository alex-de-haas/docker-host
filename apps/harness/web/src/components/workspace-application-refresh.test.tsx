// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceActivation } from "./workspace-activation";
import { developmentRequest } from "@/lib/development-api";
import { subscribeWorkspaceEvents } from "@/lib/workspace-events";
import type { WorkspaceApplication } from "@/lib/workspace-applications";

vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
vi.mock("@/lib/workspace-events", () => ({ subscribeWorkspaceEvents: vi.fn() }));
let root: Root, container: HTMLDivElement, sync: () => Promise<void | boolean>;
const target = { kind: "workspace", workspaceId: "workspace", worktreeId: "a".repeat(64), name: "Current work", runtime: "dev" };
const row = (current: boolean): WorkspaceApplication => ({ appId: "notes", name: "Notes", runtimeState: "running", canSwitch: true,
  current: current ? target : { kind: "package", runtime: "docker" }, target });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(subscribeWorkspaceEvents).mockImplementation((_url, callback) => { sync = callback; return vi.fn(); });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it.each([false, true])("keeps group and per-app controls stable through SSE refresh while current=%s", async current => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ apps: [row(current)] });
  await act(async () => root.render(<WorkspaceActivation workspaceId="workspace" apps={[{ appId: "notes", name: "Notes" }]} refresh={vi.fn()} />));
  await act(async () => { await sync(); });
  const shown = current ? "Return to packages" : "Use workspace";
  const hidden = current ? "Use workspace" : "Return to packages";
  const group = button(shown)!;
  const perApp = container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]');
  group.focus(); expect(button(hidden)).toBeUndefined();
  if (!current) expect(perApp?.disabled).toBe(false);
  for (let index = 0; index < 3; index++) {
    const next = deferred<{ apps: WorkspaceApplication[] }>();
    vi.mocked(developmentRequest).mockReturnValueOnce(next.promise);
    await act(async () => { void sync(); });
    expect(button(shown)).toBe(group); expect(group.disabled).toBe(false); expect(button(hidden)).toBeUndefined();
    expect(document.activeElement).toBe(group);
    expect(container.querySelector('[aria-label="Use this workspace for Notes"]')).toBe(perApp);
    if (perApp) expect(perApp.disabled).toBe(false);
    await act(async () => next.resolve({ apps: [row(current)] }));
    expect(button(shown)).toBe(group); expect(button(hidden)).toBeUndefined();
  }
  vi.mocked(developmentRequest).mockResolvedValueOnce({ apps: [row(!current)] });
  await act(async () => { await sync(); });
  expect(button(shown)).toBeUndefined(); expect(button(hidden)).toBeDefined();
});
