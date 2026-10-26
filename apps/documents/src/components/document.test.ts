import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SourceDocument, TrackedDocument } from "./document";
import { PlanGrid } from "./plan-grid";
import { Progress } from "./plan-metadata";
import { parseSourceDocument } from "@/lib/parser";
import type { DocumentChange, PlanCard, SourceRepository, Workspace, WorkspacePlan } from "@/lib/types";

const path = "docs/features/example/plan.md";
const content = "---\nstatus: In Progress\ncreated: 2026-10-06\nupdated: 2026-10-07\nsummary: An example plan.\n---\n# Example\n## Deliverables\n- [ ] D1. Build it\n";
const repository: SourceRepository = { id: "repo", repository: "https://example.org/repo.git", branch: "main", workspaceDerived: false, apps: [], state: "available", error: null, commit: "commit", fetchedAt: null };
describe("document and overview rendering", () => {
  it("keeps target unavailability distinct from a confirmed workspace-only plan", () => {
    const unavailable = renderToStaticMarkup(createElement(TrackedDocument, { document: null, error: "The source provider is unavailable.", repositoryId: "repo", navigate: vi.fn() }));
    expect(unavailable).toContain("Tracked branch unavailable");
    expect(unavailable).toContain("The source provider is unavailable.");
    expect(unavailable).not.toContain("Workspace only");
    const absent = renderToStaticMarkup(createElement(TrackedDocument, { document: null, error: null, repositoryId: "repo", navigate: vi.fn() }));
    expect(absent).toContain("Workspace only");
    expect(absent).not.toContain("Tracked branch unavailable");
  });
  it("renders invalid documents as visible grid errors with unknown progress", () => {
    const document = parseSourceDocument(path, content.replace("In Progress", "Cancelled"));
    const card: PlanCard = { repository, path, document, apps: [], workspaces: [] };
    const html = renderToStaticMarkup(createElement(PlanGrid, { plans: [card], navigate: vi.fn() }));
    expect(html).toContain("Document error"); expect(html).toContain("Progress unknown"); expect(html).toContain(path);
  });
  it("shows the workspace count behind an accessible grid row expander", () => {
    const document = parseSourceDocument(path, content);
    const change: DocumentChange = { path, kind: "modified", modifiedAt: null, targetChanged: false, baseSha: null, targetSha: null, worktreeSha: null };
    const workspace = (id: string): Workspace => ({ id, repositoryId: "repo", repository: repository.repository, targetBranch: "main", branch: `hosty/session/${id}`, state: "active", administratorId: "admin", assistantAppId: "assistant", sessionId: id, sessionUrl: null, sessionUrlError: null, observationAt: null, observationState: "available", pullRequests: [], baseCommit: "base", targetCommit: "commit", changes: [change], error: null });
    const workspaces: WorkspacePlan[] = ["one", "two"].map(id => ({ workspace: workspace(id), change, label: "changed", document, base: document, error: null }));
    const card: PlanCard = { repository, path, document, apps: [], workspaces };
    const html = renderToStaticMarkup(createElement(PlanGrid, { plans: [card], navigate: vi.fn() }));
    expect(html).toContain("2 workspace versions"); expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Expand workspace versions of Example"); expect(html).toContain("Tracked progress");
  });
  it("does not load relative images or source files and never executes raw HTML", () => {
    const document = parseSourceDocument(path, content + '\n[Feature](../other/feature.md)\n[Source](../../../apps/core/file.cs)\n![Diagram](diagram.png)\n<script>alert(1)</script>\n');
    const html = renderToStaticMarkup(createElement(SourceDocument, { document, repositoryId: "repo", navigate: vi.fn() }));
    expect(html).toContain("document=docs%2Ffeatures%2Fother%2Ffeature.md");
    expect(html).toContain("apps/core/file.cs"); expect(html).toContain("docs/features/example/diagram.png");
    expect(html).not.toContain("<img"); expect(html).not.toContain("<script");
    expect(html).not.toContain('href="../../../apps/core/file.cs"');
  });
  it("reports numeric progress to assistive technology and keeps unknown progress distinct", () => {
    const document = parseSourceDocument(path, content.replace("- [ ] D1.", "- [x] D1."));
    const html = renderToStaticMarkup(createElement(Progress, { document }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Deliverable progress"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("1/1");
    const unknown = renderToStaticMarkup(createElement(Progress, { document: null }));
    expect(unknown).toContain("Progress unknown");
    expect(unknown).not.toContain('role="progressbar"');
  });
});
