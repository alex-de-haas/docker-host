import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceVersionRow } from "./plan-grid";
import { WorkspaceDocument } from "./workbench";
import { WorkspaceOwner, WorkspaceSessionLink } from "./workspace-owner";
import { parseSourceDocument } from "@/lib/parser";
import type { DocumentChange, PlanCard, SourceRepository, Workspace, WorkspacePlan } from "@/lib/types";

const path = "docs/features/example/plan.md";
const content = "---\nstatus: In Progress\ncreated: 2026-10-06\nupdated: 2026-10-07\nsummary: An example plan.\n---\n# Example\n## Deliverables\n- [ ] D1. Build it\n- [ ] D2. Verify it\n";
const repository: SourceRepository = { id: "repo", repository: "https://example.org/repo.git", branch: "main", workspaceDerived: false, apps: [], state: "available", error: null, commit: "commit", fetchedAt: null };
const change: DocumentChange = { path, kind: "modified", modifiedAt: "2026-10-07T12:00:00Z", targetChanged: true, baseSha: null, targetSha: null, worktreeSha: null };
const workspace: Workspace = { id: "workspace", repositoryId: "repo", repository: repository.repository, targetBranch: "main", branch: "hosty/external/example", state: "active", administratorId: "admin", ownerKind: "external", ownerLabel: "Codex", assistantAppId: null, sessionId: "task", sessionUrl: null, sessionUrlError: null, observationAt: "2026-10-07T12:00:00Z", observationState: "available", pullRequests: [], baseCommit: "base", targetCommit: "commit", changes: [change], error: null };
const base = parseSourceDocument(path, content);
const document = parseSourceDocument(path, content.replace("- [ ] D1.", "- [x] D1."));
const version: WorkspacePlan = { workspace, change, label: "changed", document, base, error: null };
const card: PlanCard = { repository, path, document: base, apps: [], workspaces: [version] };

describe("workspace owner presentation", () => {
  it("renders an external grid row with its own progress and observed evidence", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceVersionRow, { card, version, navigate: vi.fn() }));
    expect(html).toContain("External / Codex");
    expect(html).toContain(workspace.branch);
    expect(html).toContain("1/2");
    expect(html).toContain("active");
    expect(html).toContain("Observed");
    expect(html).toContain("(available)");
    expect(html).toContain("Tracked branch also changed since the workspace base.");
    expect(html).toContain("View workspace document");
    expect(html).toContain("Conversation stays in the external agent.");
    expect(html).not.toContain("Open assistant session");
    expect(html).not.toContain("Session link unavailable");
    expect(html).not.toContain("installation is unavailable");
  });

  it("keeps external detail progress, its base and tracked-branch changes separate", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceDocument, { version, repositoryId: "repo", navigate: vi.fn() }));
    expect(html).toContain("External / Codex");
    expect(html).toContain("Workspace active. Observed");
    expect(html).toContain("Base: In Progress, 0/2 deliverables");
    expect(html).toContain("Workspace: In Progress, 1/2 deliverables");
    expect(html).toContain("Tracked branch changed");
    expect(html).toContain("The diff below shows this workspace’s own changes.");
    expect(html).toContain("checked");
    expect(html).toContain("Conversation stays in the external agent.");
    expect(html).not.toContain("Session link unavailable");
  });

  it("does not offer an assistant link or error for an external owner", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSessionLink, { workspace: { ...workspace, sessionUrl: "https://example.org/incorrect-session", sessionUrlError: "Assistant uninstalled" }, button: true }));
    expect(html).toContain("Conversation stays in the external agent.");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("Assistant uninstalled");
  });

  it("uses a neutral external label when a display label is missing", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceOwner, { workspace: { ...workspace, ownerLabel: " " } }));
    expect(html).toContain("External / Agent");
  });

  it.each([undefined, "assistant"] as const)("preserves assistant links when ownerKind is %s", ownerKind => {
    const assistant: Workspace = { ...workspace, ownerKind, ownerLabel: null, assistantAppId: "harness", sessionUrl: "https://assistant.example/session", sessionUrlError: null };
    const owner = renderToStaticMarkup(createElement(WorkspaceOwner, { workspace: assistant }));
    expect(owner).toBe("");
    for (const button of [false, true]) {
      const html = renderToStaticMarkup(createElement(WorkspaceSessionLink, { workspace: assistant, button }));
      expect(html).toContain('href="https://assistant.example/session"');
      expect(html).toContain("Open assistant session");
      expect(html).not.toContain("external agent");
    }
  });

  it("preserves an unavailable legacy assistant session explanation", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSessionLink, { workspace: { ...workspace, ownerKind: undefined, assistantAppId: "harness", sessionUrlError: "The assistant was reinstalled" } }));
    expect(html).toContain("Session link unavailable: The assistant was reinstalled.");
    expect(html).not.toContain("external agent");
  });
});
