import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceVersionCell } from "../src/app/shell/source/source-changes";
import { CoreGitCell, type CoreDevelopment } from "../src/app/shell/core-development";
import type { CoreApp } from "../src/app/shell/types";

const fixture = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("../src/app/shell/shell-context", () => ({
  useShellState: () => ({ canManageApps: true, state: { apps: [] } }),
  useShellActions: () => ({ coreOrigin: "https://core.test" }),
}));
const app: CoreApp = { id: "routine.app", displayName: "Routine app", version: "1.2.3", kind: "app", system: false,
  source: "installed", operationStatus: "started", runtimeState: "running", capabilities: [] };
const status = { appId: app.id, state: "changes", scopePath: "/workspace/apps/routine", branch: "feature/refinement", head: "abc12345",
  fileCount: 7, truncated: true, lineStats: { additions: 12, deletions: 3 }, observedAt: "2026-10-22T12:00:00Z" };
const core: CoreDevelopment = {
  launch: { mode: "dev", projectPath: "/workspace/apps/core/Core.csproj", generationPath: null, processId: 42, startedAt: "2026-10-22T12:00:00Z" },
  instance: "42:start", manageable: true, source: { overridePath: "/workspace", revision: "revision" },
  managedPath: "/managed", sourcePath: "/workspace", selectedProjectPath: "/workspace/apps/core/Core.csproj", restartRequired: false,
  branch: status.branch, commit: status.head, changedFiles: 7, additions: 12, deletions: 3, gitError: null,
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fixture.read.mockReset().mockResolvedValue(Response.json(status));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const escape = () => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

it.each([undefined, { id: "workspace", label: "Hosty redesign" }])("identifies the app workspace or branch by name and a decorative icon", async workspace => {
  await act(async () => root.render(<SourceVersionCell app={app} workspace={workspace} compact />));
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toBe(workspace?.label ?? status.branch);
  const icon = trigger.querySelector(workspace ? ".lucide-hammer" : ".lucide-git-branch");
  expect(icon).not.toBeNull();
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  expect(container.textContent).toContain("7+ files");
  expect(container.querySelector('[role="img"][aria-label="12 lines added, 3 lines deleted"]')).not.toBeNull();
  expect(fixture.read).toHaveBeenCalledTimes(1);
  expect(trigger.getAttribute("aria-label")).toBe(workspace ? "Workspace: Hosty redesign" : "Source details for Routine app");
});

it.each(["unavailable", "missing", "no-git"])("does not invent compact change totals for %s source", async state => {
  fixture.read.mockResolvedValue(Response.json({ ...status, state, fileCount: 0, lineStats: null }));
  await act(async () => root.render(<SourceVersionCell app={app} compact />));
  expect(container.textContent).not.toContain(" files");
  expect(container.querySelector('[role="img"][aria-label*="lines added"]')).toBeNull();
});

it.each(["loading", "failed"])("does not invent compact change totals while source reading is %s", async state => {
  fixture.read.mockImplementation(state === "loading" ? () => new Promise<Response>(() => {}) : async () => { throw new Error("Source read failed"); });
  await act(async () => root.render(<SourceVersionCell app={app} compact />));
  expect(container.textContent).toContain(state === "loading" ? "Reading source…" : "Source status unavailable");
  expect(container.textContent).not.toContain(" files");
});

it.each([{ fileCount: 0, state: "clean" }, { fileCount: 7, state: "changes" }])("shows observed $fileCount files without inventing missing line totals", async values => {
  fixture.read.mockResolvedValue(Response.json({ ...status, ...values, truncated: false, lineStats: null }));
  await act(async () => root.render(<SourceVersionCell app={app} compact />));
  expect(container.textContent).toContain(`${values.fileCount} files`);
  expect(container.querySelector('[role="img"][aria-label*="lines added"]')).toBeNull();
});

it("opens complete app source details on hover without changing the visible label", async () => {
  await act(async () => root.render(<SourceVersionCell app={app} workspace={{ id: "workspace", label: "Hosty redesign" }} compact />));
  const trigger = container.querySelector("button")!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })));
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
  const details = document.querySelector('[role="tooltip"]')!;
  expect(details.textContent).toContain("Branch: feature/refinement");
  expect(details.textContent).toContain("Installed package: 1.2.3");
  expect(details.textContent).toContain("Changed files: 7+ (incomplete list)");
  expect(details.textContent).toContain("Lines: +12 / −3 (HEAD to working tree)");
  expect(trigger.textContent).toBe("Hosty redesign");
});

it("retains app details on keyboard focus and touch/click, with Escape and focus restoration", async () => {
  await act(async () => root.render(<SourceVersionCell app={app} workspace={{ id: "workspace", label: "Hosty redesign" }} compact />));
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => trigger.focus());
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
  await escape();
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => trigger.click());
  const details = document.querySelector('[role="dialog"][aria-label="Source details for Routine app"]')!;
  expect(details.textContent).toContain("Commit: abc12345");
  expect(details.textContent).toContain("Scope: /workspace/apps/routine");
  await escape();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(fixture.read.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it.each([undefined, { id: "workspace", label: "Hosty redesign" }])("keeps Core source identity and complete details accessible by click and Escape", async workspace => {
  await act(async () => root.render(<CoreGitCell state={core} workspace={workspace} />));
  const trigger = container.querySelector<HTMLButtonElement>(workspace ? '[aria-label="Workspace: Hosty redesign"]' : '[aria-label="Source details for Hosty Core"]')!;
  expect(trigger.textContent).toBe(workspace?.label ?? status.branch);
  const icon = trigger.querySelector(workspace ? ".lucide-hammer" : ".lucide-git-branch");
  expect(icon).not.toBeNull();
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  expect(container.textContent).toContain("7 files");
  await act(async () => { trigger.focus(); trigger.click(); });
  const details = document.querySelector('[role="dialog"][aria-label="Source details for Hosty Core"]')!;
  expect(details.textContent).toContain("Branch: feature/refinement");
  expect(details.textContent).toContain("Commit: abc12345");
  expect(details.textContent).toContain("Project: /workspace/apps/core/Core.csproj");
  expect(details.textContent).toContain("Lines: +12 / −3 (HEAD to working tree)");
  await escape();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});
