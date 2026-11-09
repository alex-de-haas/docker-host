// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanVersions } from "./workbench";
import { parseSourceDocument } from "@/lib/parser";
import { planLink } from "@/lib/model";
import type { PlanDetail, WorkspacePlan } from "@/lib/types";

const path = "docs/features/example/plan.md";
const content = "---\nstatus: In Progress\ncreated: 2026-10-06\nupdated: 2026-10-08\nsummary: An example plan.\n---\n# Example\n## Deliverables\n- [ ] D1. Build it\n";
const document = parseSourceDocument(path, content);
const change = { path, kind: "modified" as const, modifiedAt: null, targetChanged: false, baseSha: null, targetSha: null, worktreeSha: null };
const version: WorkspacePlan = {
  workspace: { id: "workspace-a", branch: "hosty/session/workspace-a", repositoryId: "repo", repository: "https://example.org/repo.git", targetBranch: "main", state: "active", administratorId: "admin", ownerKind: "external", ownerLabel: "Codex", assistantAppId: null, sessionId: "task", sessionUrl: null, sessionUrlError: null, observationAt: null, observationState: "ok", pullRequests: [], baseCommit: "original", targetCommit: "target", changes: [change], error: null },
  change, label: "changed", base: document, document: parseSourceDocument(path, content.replace("[ ]", "[x]")), error: null,
};
const second = { ...version, workspace: { ...version.workspace, id: "workspace-b", branch: "hosty/session/workspace-b" }, document: parseSourceDocument(path, content.replace("Build it", "Build something else")) };
const detail: PlanDetail = { path, document, workspaces: [version, second], error: null, repository: { id: "repo", repository: "https://example.org/repo.git", branch: "main", workspaceDerived: false, apps: [], state: "available", error: null, commit: "target", fetchedAt: null } };
let root: Root, container: HTMLDivElement;
const navigate = vi.fn();
async function render(workspaceId: string | null = null, current = detail) {
  await act(async () => root.render(createElement(PlanVersions, { detail: current, workspaceId, navigate })));
}
const selected = () => container.querySelector('[role="tab"][aria-selected="true"]');
const panel = () => container.querySelector('[role="tabpanel"][data-state="active"]');
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); navigate.mockReset();
  container = window.document.createElement("div"); window.document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("document version tabs", () => {
  it("opens the tracked branch by default and navigates with explicit workspace links", async () => {
    await render();
    expect(selected()?.textContent).toContain("Tracked branch");
    expect(panel()?.textContent).toContain("0/1");
    expect(panel()?.querySelector(".diff")).toBeNull();
    const tab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(navigate).toHaveBeenLastCalledWith(planLink("repo", path, "workspace-a"));
    await render("workspace-a");
    expect(selected()).toBe(tab);
    expect(panel()?.querySelector(".diff")?.textContent).toContain("[x] D1. Build it");
    expect(panel()?.textContent).toContain("Base: In Progress, 0/1 deliverables");
    expect(panel()?.textContent).toContain("Workspace: In Progress, 1/1 deliverables");
    await render("workspace-b");
    expect(panel()?.querySelector(".diff")?.textContent).toContain("Build something else");
    await render();
    expect(selected()?.textContent).toContain("Tracked branch");
    expect(panel()?.querySelector(".diff")).toBeNull();
  });

  it("keeps the selected workspace view during observation refreshes", async () => {
    await render("workspace-a");
    const toggle = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Workspace document")!;
    await act(async () => toggle.click());
    await render("workspace-a", { ...detail, workspaces: [{ ...version, document: { ...version.document!, updated: "2026-10-09" } }] });
    expect(panel()?.querySelector(".markdown")).not.toBeNull();
    expect(panel()?.querySelector(".diff")).toBeNull();
  });

  it("does not substitute another version for missing workspace links or absent tracked content", async () => {
    await render("missing");
    expect(selected()?.textContent).toBe("Unavailable workspace");
    expect(panel()?.textContent).toContain("no longer changes this document");
    expect(panel()?.querySelector(".markdown, .diff")).toBeNull();
    await render(null, { ...detail, document: null });
    expect(selected()?.textContent).toContain("Tracked branch");
    expect(panel()?.textContent).toContain("Workspace only");
    await render("workspace-a", { ...detail, document: null, error: "Target unavailable" });
    expect(panel()?.querySelector(".diff")).not.toBeNull();
  });
});
