import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoreGitCell, type CoreDevelopment } from "../src/app/shell/core-development";

const project = "/managed/workspace/apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj";
const branch = "hosty/session/opaque-technical-branch";
const commit = "1234567890abcdef1234567890abcdef12345678";
const state: CoreDevelopment = {
  launch: { mode: "dev", projectPath: project, generationPath: "/managed/generation", processId: 42, startedAt: "2026-10-20T13:00:00Z" },
  instance: "42:start", manageable: true, source: { overridePath: null, revision: "source-revision" },
  managedPath: "/managed/source", sourcePath: "/pending/source", selectedProjectPath: "/pending/source/Core.csproj",
  restartRequired: true, branch, commit, changedFiles: 7, additions: 12, deletions: 3, gitError: null,
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("shows only the workspace name while retaining changed files and source details", async () => {
  await act(async () => root.render(<CoreGitCell state={state} workspace={{ id: "workspace", label: "Runtime switching" }} />));
  expect(container.textContent).toContain("Runtime switching");
  expect(container.textContent).not.toContain(branch);
  expect(container.textContent).not.toContain(commit);
  expect(container.textContent).toContain("7 files");
  expect(container.querySelector('[aria-label="Workspace: Runtime switching"]')).not.toBeNull();
  expect(container.querySelector(".lucide-boxes")).toBeNull();
});

it("exposes the factual project, branch, commit and Git warning in the keyboard tooltip", async () => {
  await act(async () => root.render(<CoreGitCell state={{ ...state, gitError: "Git metadata is temporarily unavailable" }} workspace={{ id: "workspace", label: "Runtime switching" }} />));
  const trigger = container.querySelector<HTMLElement>('[aria-label="Workspace: Runtime switching"]')!;
  expect(trigger.tabIndex).toBe(0);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => trigger.focus());
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
  const tooltip = document.querySelector('[role="tooltip"]')!;
  expect(tooltip.textContent).toContain(branch);
  expect(tooltip.textContent).toContain(commit);
  expect(tooltip.textContent).toContain(project);
  expect(tooltip.textContent).toContain("Git metadata is temporarily unavailable");
  expect(tooltip.textContent).not.toContain(state.selectedProjectPath);
});

it.each([
  { label: "branch", value: state, expected: branch },
  { label: "short commit", value: { ...state, branch: null }, expected: commit.slice(0, 10) },
  { label: "unavailable source", value: null, expected: "Source unavailable" },
])("falls back to $label when no registered workspace matches", async ({ value, expected }) => {
  await act(async () => root.render(<CoreGitCell state={value} />));
  expect(container.textContent).toContain(expected);
  expect(container.querySelector('[aria-label^="Workspace:"]')).toBeNull();
  expect(container.querySelector(".lucide-boxes")).toBeNull();
});

it("clears the workspace label when the factual Core launch no longer belongs to it", async () => {
  await act(async () => root.render(<CoreGitCell state={state} workspace={{ id: "workspace", label: "Runtime switching" }} />));
  await act(async () => root.render(<CoreGitCell state={state} />));
  expect(container.textContent).toContain(branch);
  expect(container.textContent).not.toContain("Runtime switching");
});

it("puts added and deleted line totals before the changed-file count", async () => {
  await act(async () => root.render(<CoreGitCell state={{ ...state, gitTruncated: true }} />));
  const totals = container.querySelector<HTMLElement>('[role="img"][aria-label="12 lines added, 3 lines deleted"]')!;
  expect(totals).not.toBeNull();
  expect(totals.textContent).toBe("+12−3");
  const files = [...container.querySelectorAll<HTMLElement>("span")].find(span => span.textContent === "7+ files")!;
  expect(files).toBeDefined();
  expect(totals.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(totals.parentElement).toBe(files.parentElement);
});
it("keeps the changed-file count without inventing unavailable line totals", async () => {
  await act(async () => root.render(<CoreGitCell state={{ ...state, changedFiles: 0, additions: null, deletions: null }} />));
  expect(container.textContent).toContain("0 files");
  expect(container.querySelector('[role="img"][aria-label*="lines added"]')).toBeNull();
});
