import { describe, expect, it } from "vitest";
import { componentApps, deliverableChanges, filterPlans, lineDiff, mapBounded, planLink, readFilters, statusCounts, workspaceLabel, writeFilters } from "./model";
import { parseSourceDocument } from "./parser";
import type { DocumentChange, PlanCard, SourceRepository, Workspace } from "./types";
export const repository: SourceRepository = { id: "repo", repository: "https://github.com/example/repo.git", branch: "main", workspaceDerived: false, apps: [
  { appId: "telemetry", name: "Telemetry", manifestSubpath: "apps/telemetry", paths: ["apps/telemetry-backend", "apps/telemetry-ui"] },
  { appId: "shell", name: "Shell", manifestSubpath: "apps/shell", paths: [] },
], state: "available", error: null, commit: "commit", fetchedAt: null };
export const document = parseSourceDocument("docs/features/example/plan.md", "---\nstatus: In Progress\ncreated: 2026-10-01\nupdated: 2026-10-07\nsummary: Collect traces across services.\ncomponents: [apps/telemetry-ui]\n---\n# Telemetry Traces\n## Deliverables\n- [ ] D1. Record traces\n");
export const change: DocumentChange = { path: document.path, kind: "modified", modifiedAt: null, targetChanged: false, baseSha: null, targetSha: null, worktreeSha: null };
export const workspace: Workspace = { id: "workspace", repositoryId: "repo", repository: repository.repository, targetBranch: "main", branch: "hosty/session/1", state: "active", administratorId: "admin", assistantAppId: "harness", sessionId: "session", sessionUrl: "https://assistant.example/session", sessionUrlError: null, observationAt: null, observationState: "available", pullRequests: [], baseCommit: null, targetCommit: null, changes: [change], error: null };
const card: PlanCard = { repository, path: document.path, document, apps: componentApps(repository, document), workspaces: [] };
describe("plan views", () => {
  it("maps app source subpaths and additional source paths, including a single-app repository", () => {
    expect(componentApps(repository, document).map(app => app.appId)).toEqual(["telemetry"]);
    expect(componentApps({ ...repository, apps: [repository.apps[1]] }, document).map(app => app.appId)).toEqual(["shell"]);
    expect(componentApps(repository, { ...document, components: ["apps"] }).length).toBe(2);
  });
  it("restores current filters from URL and removes retired age filters while preserving the chosen document/workspace", () => {
    const filters = { search: "traces", repository: "repo", app: "telemetry", status: "In Progress" };
    expect(filterPlans([card], readFilters(new URLSearchParams({ age: "older" })))).toEqual([card]);
    const query = writeFilters(new URLSearchParams({ document: document.path, workspace: "chosen", age: "older" }), filters);
    expect(readFilters(query)).toEqual(filters);
    expect(query.has("age")).toBe(false);
    expect(query.get("document")).toBe(document.path);
    expect(query.get("workspace")).toBe("chosen");
    expect(filterPlans([card], filters)).toEqual([card]);
    expect(filterPlans([card], { ...filters, search: "services" })).toEqual([card]);
    expect(filterPlans([card], { ...filters, app: "shell" })).toEqual([]);
    expect(new URL(planLink("repo", document.path, "chosen"), "http://app").searchParams.get("workspace")).toBe("chosen");
  });
  it("keeps parse errors out of status counts and includes new workspace plans", () => {
    expect(statusCounts([card])["In Progress"]).toBe(1);
    expect(statusCounts([{ ...card, document: { ...document, errors: ["bad"], progress: null } }])["In Progress"]).toBe(0);
    const version = { workspace, change: { ...change, kind: "added" }, document, base: null, label: "new" as const, error: null };
    expect(statusCounts([{ ...card, document: null, workspaces: [version] }])["In Progress"]).toBe(1);
  });
  it("uses explicit feature changes to distinguish completing from removed", () => {
    const removed = { ...change, kind: "deleted" };
    expect(workspaceLabel(workspace, removed)).toBe("removed");
    expect(workspaceLabel(workspace, removed, true)).toBe("completing");
    expect(workspaceLabel({ ...workspace, changes: [removed, { ...change, path: change.path.replace("plan.md", "feature.md") }] }, removed)).toBe("completing");
    expect(workspaceLabel({ ...workspace, changes: [removed, { ...change, kind: "deleted", path: change.path.replace("plan.md", "feature.md") }] }, removed)).toBe("removed");
    expect(workspaceLabel(workspace, { ...change, kind: "added" })).toBe("new");
  });
  it("compares deliverable IDs and renders a diff against its own base", () => {
    const current = { ...document, deliverables: [{ id: "D1", text: "Record traces", done: true }, { id: "D9", text: "Read spans", done: false }] };
    expect(deliverableChanges(document, current)?.map(item => [item.id, item.kind])).toEqual([["D1", "completed"], ["D9", "added"]]);
    expect(lineDiff("base\noriginal\nend", "base\nworkspace edit\nend").lines.filter(item => item.kind !== "same")).toEqual([{ kind: "added", text: "workspace edit" }, { kind: "removed", text: "original" }]);
  });
  it("shows removed and text-edited stable IDs, including text edits combined with completion", () => {
    const base = { ...document, deliverables: [{ id: "D1", text: "First wording", done: false }, { id: "D2", text: "Retired item", done: false }, { id: "D3", text: "Old wording", done: false }] };
    const current = { ...document, deliverables: [{ id: "D1", text: "Revised wording", done: true }, { id: "D3", text: "New wording", done: false }] };
    expect(deliverableChanges(base, current)).toEqual([
      { id: "D1", text: "Revised wording", kind: "completed", previousText: "First wording" },
      { id: "D3", text: "New wording", kind: "modified", previousText: "Old wording" },
      { id: "D2", text: "Retired item", kind: "removed" },
    ]);
    expect(deliverableChanges(base, { ...current, errors: ["duplicate ID"] })).toBeNull();
  });
  it("bounds repository concurrency and delivers results in input order", async () => {
    let active = 0, maximum = 0;
    const result = await mapBounded([1, 2, 3, 4, 5], 2, async value => { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return value * 2; });
    expect(maximum).toBe(2); expect(result).toEqual([2, 4, 6, 8, 10]);
  });
});
