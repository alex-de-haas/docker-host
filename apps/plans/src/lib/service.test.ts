import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { blobSha, DocumentCache } from "./cache";
import { PlansService } from "./service";
import { PlansError } from "./auth";
import type { SourceReader } from "./core-client";
import type { DocumentContent, DocumentListing, SourceRepository, Workspace } from "./types";
const documentPath = "docs/features/test/plan.md";
const text = "---\nstatus: In Progress\ncreated: 2026-10-06\nupdated: 2026-10-07\nsummary: The example plan.\ncomponents: [apps/test]\n---\n# Example\n## Deliverables\n- [ ] D1. Build it\n";
const repository: SourceRepository = { id: "repo", repository: "https://example.org/repo.git", branch: "main", workspaceDerived: false, apps: [{ appId: "app", name: "App", manifestSubpath: "apps/test", paths: [] }], state: "available", error: null, commit: "commit", fetchedAt: null };
const referencePaths = [{ path: "apps/test", exists: true, isDirectory: true }];
function fixture() {
  const listing: DocumentListing = { repositoryId: "repo", version: "target", workspaceId: null, commit: "commit", documents: [{ path: documentPath, sha: blobSha(text), size: Buffer.byteLength(text), referencePaths }], state: "available", error: null };
  const reader: SourceReader = {
    repositories: vi.fn(async () => [repository]),
    listing: vi.fn(async () => listing),
    content: vi.fn(async (_id, path, current, sha): Promise<DocumentContent> => ({ path, sha, content: text, commit: current.commit, version: current.version, workspaceId: current.workspaceId, referencePaths })),
    workspaces: vi.fn(async () => []),
  };
  return { reader, listing };
}
function workspace(id: string, kind = "modified"): Workspace {
  return { id, repositoryId: "repo", repository: repository.repository, targetBranch: "main", branch: `hosty/session/${id}`, state: "active", administratorId: "admin", assistantAppId: "assistant", sessionId: id, sessionUrl: null, sessionUrlError: null, observationAt: null, observationState: "available", pullRequests: [], baseCommit: `base-${id}`, targetCommit: "commit", changes: [{ path: documentPath, kind, modifiedAt: null, targetChanged: true, baseSha: null, targetSha: null, worktreeSha: null }], error: null };
}
function entry(content: string, path = documentPath) {
  return { path, sha: blobSha(content), size: Buffer.byteLength(content), referencePaths };
}
const directories: string[] = [];
async function cache() { const directory = await mkdtemp(path.join(tmpdir(), "hosty-plans-service-")); directories.push(directory); return new DocumentCache(directory); }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
describe("authorized document reads", () => {
  it("asks Core for fresh authorization on every request, including shared cache hits", async () => {
    const { reader } = fixture();
    const shared = await cache();
    const diskRead = vi.spyOn(shared, "read");
    expect((await new PlansService(reader, shared).detail("repo", documentPath)).document?.progress).toEqual({ done: 0, total: 1 });
    await new PlansService(reader, shared).detail("repo", documentPath);
    expect(reader.content).toHaveBeenCalledTimes(1);
    expect(reader.listing).toHaveBeenCalledTimes(2);
    expect(reader.listing).toHaveBeenLastCalledWith("repo", "target", undefined, false, documentPath);
    expect(diskRead).toHaveBeenCalledTimes(1);
    const denied = fixture().reader;
    denied.listing = vi.fn(async () => { throw new PlansError("Private grant is not owned by this administrator.", 403); });
    await expect(new PlansService(denied, shared).detail("repo", documentPath)).rejects.toThrow("not owned");
    expect(denied.content).not.toHaveBeenCalled();
  });
  it("rejects a changed content hash instead of caching it under the listing SHA", async () => {
    const { reader } = fixture();
    reader.content = vi.fn(async (_id, path, listing): Promise<DocumentContent> => ({ path, sha: blobSha("new bytes"), content: "new bytes", version: listing.version, commit: listing.commit, workspaceId: null, referencePaths: [] }));
    await expect(new PlansService(reader, await cache()).detail("repo", documentPath)).rejects.toMatchObject({ status: 409, code: "document_changed" });
  });
  it("reads the new authorized SHA after a target edit instead of reusing old validated progress", async () => {
    const { reader, listing } = fixture();
    const service = new PlansService(reader, await cache());
    expect((await service.detail("repo", documentPath)).document?.progress).toEqual({ done: 0, total: 1 });
    const changed = text.replace("- [ ] D1", "- [x] D1");
    listing.commit = "next-commit";
    listing.documents = [entry(changed)];
    vi.mocked(reader.content).mockImplementation(async (_id, path, current, sha) => ({ path, sha, content: changed, commit: current.commit, version: current.version, workspaceId: current.workspaceId, referencePaths }));
    const next = await service.detail("repo", documentPath);
    expect(next.document?.progress).toEqual({ done: 1, total: 1 });
    expect(next.document?.content).toBe(changed);
    expect(reader.content).toHaveBeenCalledTimes(2);
  });
  it("revalidates reference existence on a cached syntax entry and reports unknown metadata", async () => {
    const { reader, listing } = fixture();
    const service = new PlansService(reader, await cache());
    expect((await service.detail("repo", documentPath)).document?.errors).toEqual([]);
    listing.documents[0].referencePaths = [{ path: "apps/test", exists: false, isDirectory: false }];
    expect((await service.detail("repo", documentPath)).document?.progress).toBeNull();
    expect((await service.detail("repo", documentPath)).document?.errors[0]).toContain("not a directory");
    listing.documents[0].referencePaths = undefined as never;
    expect((await service.detail("repo", documentPath)).document?.errors[0]).toContain("referenced-path validation");
  });
  it("resolves provisional repository IDs before fetching workspaces", async () => {
    const { reader, listing } = fixture();
    const calls: string[] = [];
    reader.listing = vi.fn(async () => { calls.push("listing"); return listing; });
    reader.repositories = vi.fn(async () => { calls.push("repositories"); return [repository]; });
    reader.workspaces = vi.fn(async id => { calls.push(`workspaces:${id}`); return []; });
    const result = await new PlansService(reader, await cache()).repository("provisional");
    expect(result.repository.id).toBe("repo");
    expect(calls.slice(0, 3)).toEqual(["listing", "repositories", "workspaces:repo"]);
  });
  it("keeps two workspace versions and workspace-only and deleted plans distinct", async () => {
    const { reader, listing } = fixture();
    const newPath = "docs/features/new/plan.md";
    const workspace = (id: string, kind = "modified"): Workspace => ({ id, repositoryId: "repo", repository: repository.repository, targetBranch: "main", branch: `hosty/session/${id}`, state: "active", administratorId: "admin", assistantAppId: "assistant", sessionId: id, sessionUrl: null, sessionUrlError: "Reinstalled", observationAt: null, observationState: "available", pullRequests: [], baseCommit: "base", targetCommit: "commit", changes: [{ path: documentPath, kind, modifiedAt: null, targetChanged: true, baseSha: blobSha(text), targetSha: blobSha(text), worktreeSha: kind === "deleted" ? null : blobSha(text) }], error: null });
    const first = workspace("first");
    const second = workspace("second", "deleted");
    second.changes!.push({ ...second.changes![0], path: documentPath.replace("plan.md", "feature.md"), kind: "modified" });
    const third = workspace("third", "added"); third.changes![0].path = newPath;
    reader.workspaces = vi.fn(async () => [first, second, third]);
    reader.listing = vi.fn(async (_id, version = "target", workspaceId) => ({ ...listing, version, workspaceId: workspaceId ?? null, commit: version === "base" ? "base" : "commit", documents: version === "target" ? listing.documents : workspaceId === "third" ? version === "base" ? [] : [{ ...listing.documents[0], path: newPath }] : workspaceId === "second" && version === "worktree" ? [{ ...listing.documents[0], path: documentPath.replace("plan.md", "feature.md"), sha: "updated-feature-sha" }] : listing.documents }));
    const result = await new PlansService(reader, await cache()).repository("repo");
    expect(result.plans).toHaveLength(2);
    const baseline = result.plans.find(item => item.path === documentPath)!;
    expect(baseline.workspaces.map(item => [item.workspace.id, item.label])).toEqual([["first", "changed"], ["second", "completing"]]);
    expect(baseline.workspaces[0].change.targetChanged).toBe(true);
    expect(result.plans.find(item => item.path === newPath)?.document).toBeNull();
    expect(result.plans.find(item => item.path === newPath)?.workspaces[0].label).toBe("new");
  });
  it("keeps full focused detail and each workspace's own base after a lightweight overview", async () => {
    const { reader, listing } = fixture();
    const versions = new Map([
      ["target:", text],
      ["base:first", text.replace("# Example", "# First base")],
      ["worktree:first", text.replace("- [ ] D1", "- [x] D1")],
      ["base:second", text.replace("# Example", "# Second base")],
      ["worktree:second", text + "- [ ] D2. Another item\n"],
    ]);
    reader.workspaces = vi.fn(async () => [workspace("first"), workspace("second")]);
    reader.listing = vi.fn(async (_id, version = "target", workspaceId, _refresh, onlyPath) => {
      if (onlyPath && onlyPath !== documentPath) throw new Error("Unexpected document read.");
      return { ...listing, version, workspaceId: workspaceId ?? null, commit: version === "base" ? `base-${workspaceId}` : version === "worktree" ? null : "commit", documents: [entry(versions.get(`${version}:${workspaceId ?? ""}`)!)] };
    });
    reader.content = vi.fn(async (_id, path, current, sha) => ({ path, sha, content: versions.get(`${current.version}:${current.workspaceId ?? ""}`)!, commit: current.commit, version: current.version, workspaceId: current.workspaceId, referencePaths }));
    const service = new PlansService(reader, await cache());
    const overview = await service.repository("repo");
    expect(overview.plans[0].document).toMatchObject({ content: "", body: "", deliverables: [], progress: { done: 0, total: 1 } });
    expect(overview.plans[0].workspaces.map(item => [item.workspace.id, item.document?.progress, item.base])).toEqual([["first", { done: 1, total: 1 }, null], ["second", { done: 0, total: 2 }, null]]);
    vi.mocked(reader.listing).mockClear();
    vi.mocked(reader.content).mockClear();
    const detail = await service.detail("repo", documentPath);
    expect(detail.document?.content).toBe(text);
    expect(detail.workspaces.map(item => [item.workspace.id, item.document?.content, item.base?.content])).toEqual([
      ["first", versions.get("worktree:first"), versions.get("base:first")],
      ["second", versions.get("worktree:second"), versions.get("base:second")],
    ]);
    expect(vi.mocked(reader.listing).mock.calls.every(call => call[4] === documentPath)).toBe(true);
    expect(reader.listing).toHaveBeenCalledTimes(5);
    expect(reader.content).not.toHaveBeenCalled();
  });
  it.each([{ updated: true, label: "completing" }, { updated: false, label: "removed" }])("labels a focused deletion $label from its own base and worktree feature SHAs", async ({ updated, label }) => {
    const { reader, listing } = fixture();
    const featurePath = documentPath.replace("plan.md", "feature.md");
    const feature = "# Feature\nCurrent behavior.\n";
    const completedFeature = updated ? feature + "Implemented.\n" : feature;
    // The current feature already equals the target, so Core omits it from changes.
    reader.workspaces = vi.fn(async () => [workspace("deleted", "deleted")]);
    reader.listing = vi.fn(async (_id, version = "target", workspaceId, _refresh, onlyPath) => ({
      ...listing, version, workspaceId: workspaceId ?? null, commit: version === "base" ? "base-deleted" : version === "worktree" ? null : "commit",
      documents: onlyPath === featurePath ? [entry(version === "base" ? feature : completedFeature, featurePath)] : version === "worktree" ? [] : listing.documents,
    }));
    const detail = await new PlansService(reader, await cache()).detail("repo", documentPath);
    expect(detail.workspaces[0]).toMatchObject({ label, document: null, error: null });
    expect(detail.workspaces[0].base?.content).toBe(text);
    expect(reader.listing).toHaveBeenCalledWith("repo", "worktree", "deleted", false, featurePath);
    expect(reader.listing).toHaveBeenCalledWith("repo", "base", "deleted", false, featurePath);
    expect(vi.mocked(reader.content).mock.calls.every(call => call[1] === documentPath)).toBe(true);
  });
  it("retains projected completion evidence and the error when a focused feature listing fails", async () => {
    const { reader, listing } = fixture();
    const featurePath = documentPath.replace("plan.md", "feature.md");
    const deleted = workspace("deleted", "deleted");
    deleted.changes!.push({ ...deleted.changes![0], path: featurePath, kind: "modified" });
    reader.workspaces = vi.fn(async () => [deleted]);
    reader.listing = vi.fn(async (_id, version = "target", workspaceId, _refresh, onlyPath) => {
      if (onlyPath === featurePath) throw new PlansError("Feature metadata is temporarily unavailable.");
      return { ...listing, version, workspaceId: workspaceId ?? null, documents: version === "worktree" ? [] : listing.documents };
    });
    const detail = await new PlansService(reader, await cache()).detail("repo", documentPath);
    expect(detail.workspaces[0]).toMatchObject({ label: "completing", error: "Feature metadata is temporarily unavailable." });
  });
  it("opens a workspace-only plan when focused target and base listings are empty", async () => {
    const { reader, listing } = fixture();
    reader.workspaces = vi.fn(async () => [workspace("new", "added")]);
    reader.listing = vi.fn(async (_id, version = "target", workspaceId) => ({ ...listing, version, workspaceId: workspaceId ?? null, commit: version === "worktree" ? null : version === "base" ? "base-new" : "commit", documents: version === "worktree" ? listing.documents : [] }));
    const detail = await new PlansService(reader, await cache()).detail("repo", documentPath);
    expect(detail.document).toBeNull();
    expect(detail.workspaces[0]).toMatchObject({ label: "new", base: null, error: null });
    expect(detail.workspaces[0].document?.content).toBe(text);
    expect(vi.mocked(reader.listing).mock.calls.every(call => call[4] === documentPath)).toBe(true);
    expect(reader.listing).toHaveBeenCalledTimes(3);
    expect(vi.mocked(reader.content).mock.calls[0][2]).toMatchObject({ version: "worktree", workspaceId: "new", commit: null });
  });
  it.each(["modified", "added"])("keeps an authorized %s workspace detail when the target provider is unavailable", async kind => {
    const { reader, listing } = fixture();
    const current = text.replace("- [ ] D1", "- [x] D1");
    let offline = false;
    reader.workspaces = vi.fn(async () => [workspace("private", kind)]);
    reader.listing = vi.fn(async (_id, version = "target", workspaceId) => {
      if (version === "target" && offline) throw new PlansError("The source provider is unavailable.", 503, "source_document_unavailable");
      return { ...listing, version, workspaceId: workspaceId ?? null, commit: version === "base" ? "base-private" : version === "worktree" ? null : "commit", documents: version === "target" ? kind === "added" ? [] : listing.documents : version === "base" ? kind === "added" ? [] : listing.documents : [entry(current)] };
    });
    reader.content = vi.fn(async (_id, path, currentListing, sha) => ({ path, sha, content: currentListing.version === "worktree" ? current : text, commit: currentListing.commit, version: currentListing.version, workspaceId: currentListing.workspaceId, referencePaths }));
    const service = new PlansService(reader, await cache());
    await service.detail("repo", documentPath);
    offline = true;
    vi.mocked(reader.listing).mockClear();
    vi.mocked(reader.content).mockClear();
    const detail = await service.detail("repo", documentPath);
    expect(detail).toMatchObject({ document: null, error: "The source provider is unavailable." });
    expect(detail.workspaces[0].document?.progress).toEqual({ done: 1, total: 1 });
    expect(detail.workspaces[0].base?.content ?? null).toBe(kind === "added" ? null : text);
    expect(detail.workspaces[0].label).toBe(kind === "added" ? "new" : "changed");
    expect(reader.listing).toHaveBeenCalledWith("repo", "worktree", "private", false, documentPath);
    expect(reader.listing).toHaveBeenCalledWith("repo", "base", "private", false, documentPath);
    expect(reader.content).not.toHaveBeenCalled();
    offline = false;
    const recovered = await service.detail("repo", documentPath);
    expect(recovered.error).toBeNull();
    expect(recovered.document?.content ?? null).toBe(kind === "added" ? null : text);
  });
  it("never serves cached workspace bytes when their current listing is denied during a target outage", async () => {
    const { reader, listing } = fixture();
    let denied = false;
    reader.workspaces = vi.fn(async () => [workspace("private")]);
    reader.listing = vi.fn(async (_id, version = "target", workspaceId) => {
      if (denied) throw new PlansError(version === "target" ? "The source provider is unavailable." : "The workspace grant was revoked.", version === "target" ? 503 : 403, version === "target" ? "source_document_unavailable" : "source_document_forbidden");
      return { ...listing, version, workspaceId: workspaceId ?? null };
    });
    const shared = await cache();
    const service = new PlansService(reader, shared);
    await service.detail("repo", documentPath);
    denied = true;
    const cachedRead = vi.spyOn(shared, "readValidated");
    const detail = await service.detail("repo", documentPath);
    expect(detail.document).toBeNull();
    expect(detail.workspaces[0]).toMatchObject({ document: null, base: null, error: "The workspace grant was revoked." });
    expect(cachedRead).not.toHaveBeenCalled();
  });
  it("retains the target failure when no changing workspace can supply the detail", async () => {
    const { reader } = fixture();
    reader.listing = vi.fn(async () => { throw new PlansError("The source provider is unavailable.", 503); });
    await expect(new PlansService(reader, await cache()).detail("repo", documentPath)).rejects.toMatchObject({ status: 503, message: "The source provider is unavailable." });
  });
  it.each([{ status: 401, code: "token_invalid" }, { status: 403, code: "admin_required" }, { status: 403, code: "app_permission_required" }])("refuses $code instead of entering workspace fallback", async ({ status, code }) => {
    const { reader } = fixture();
    reader.workspaces = vi.fn(async () => [workspace("private")]);
    const shared = await cache();
    const service = new PlansService(reader, shared);
    await service.detail("repo", documentPath);
    reader.listing = vi.fn(async () => { throw new PlansError("Current source authority is required.", status, code); });
    vi.mocked(reader.workspaces).mockClear();
    const cachedRead = vi.spyOn(shared, "readValidated");
    await expect(service.detail("repo", documentPath)).rejects.toMatchObject({ status, code });
    expect(reader.workspaces).not.toHaveBeenCalled();
    expect(cachedRead).not.toHaveBeenCalled();
  });
  it.each([{ status: 401, code: "token_invalid" }, { status: 403, code: "admin_required" }, { status: 403, code: "app_permission_required" }])("retains a global $code refusal from the workspace listing during an outage", async ({ status, code }) => {
    const { reader, listing } = fixture();
    reader.workspaces = vi.fn(async () => [workspace("private")]);
    const shared = await cache();
    const service = new PlansService(reader, shared);
    await service.detail("repo", documentPath);
    reader.listing = vi.fn(async (_id, version = "target", workspaceId) => {
      if (version === "target") throw new PlansError("The source provider is unavailable.", 503);
      if (version === "worktree") throw new PlansError("Current source authority is required.", status, code);
      return { ...listing, version, workspaceId: workspaceId ?? null };
    });
    const cachedRead = vi.spyOn(shared, "readValidated");
    await expect(service.detail("repo", documentPath)).rejects.toMatchObject({ status, code });
    expect(cachedRead).not.toHaveBeenCalled();
  });
  it("leaves invalid documents visible with unknown progress", async () => {
    const { reader, listing } = fixture();
    const bad = text.replace("In Progress", "Unknown");
    listing.documents[0].sha = blobSha(bad);
    reader.content = vi.fn(async (_id, path, current, sha) => ({ path, sha, content: bad, commit: current.commit, version: current.version, workspaceId: current.workspaceId, referencePaths }));
    const result = await new PlansService(reader, await cache()).repository("repo");
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].document?.errors).toContain("Unknown plan status.");
    expect(result.plans[0].document?.progress).toBeNull();
  });
});
