import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionStore, type SessionRecord } from "./store.js";
import { SettingsStore, validRetention } from "../settings/store.js";
import { DEFAULT_WORKFLOW_PROMPT } from "../settings/workflow.js";
import { SessionManager } from "./manager.js";
import { DevelopmentClient, type RetentionSnapshot } from "./development.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";
let dir: string, settings: SettingsStore, store: SessionStore, manager: SessionManager, core: DevelopmentClient;
const now = new Date("2030-01-10T00:00:00Z");
const completed: RetentionSnapshot = { kind: "workspace", workflow: { state: "completed", revision: 3, completedAt: "2030-01-03T00:00:00Z" }, resourcesFinished: true };
const build = () => new SessionManager(store, new FakeHarnessAdapter(), new AuditReporter(null, null, "hosty.harness"), dir, settings, null, null, null, null, null, null, core);
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "harness-retention-"));
  settings = new SettingsStore(dir); store = new SessionStore(dir, path.join(dir, "cache"));
  core = new DevelopmentClient("http://core.invalid", "hosty.harness", "service");
  vi.spyOn(core, "retention").mockResolvedValue({ kind: "chat", workflow: null, resourcesFinished: true });
  await settings.update({ retention: { ordinaryDays: 2, completedWorkspaceDays: 7 } });
  manager = build();
});
afterEach(async () => { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function old(patch: Partial<SessionRecord> = {}) {
  const record = await manager.createSession({ createdBy: "admin" });
  Object.assign(record, { updatedAt: "2000-01-01T00:00:00Z" }, patch); await store.saveRecord(record); return record;
}
it("expires at the boundary, removes cache and informs a subscribed conversation", async () => {
  const record = await old({ updatedAt: "2030-01-08T00:00:00Z" });
  const cache = await store.ensureWorkspace(record.id); await writeFile(path.join(cache!, "draft"), "test");
  expect(await manager.sweepRetention(new Date(now.getTime() - 1))).toEqual([]);
  expect(await manager.sweepRetention(now)).toEqual([record.id]);
  await expect(readFile(path.join(cache!, "draft"))).rejects.toThrow();
  expect(await manager.getSession(record.id)).toBeNull();
});
it("starts from completion, extends for conversation activity and uses independent Off policies", async () => {
  const record = await old(); vi.mocked(core.retention).mockResolvedValue(completed);
  expect((await manager.sessionRetention(record.id, now)).dueAt).toBe(now.toISOString());
  record.updatedAt = "2030-01-09T00:00:00Z";
  expect((await manager.sessionRetention(record.id, now)).dueAt).toBe("2030-01-16T00:00:00.000Z");
  await settings.update({ retention: { ordinaryDays: 2, completedWorkspaceDays: null } });
  expect(await manager.sweepRetention(now)).toEqual([]);
  expect((await manager.sessionRetention(record.id, now)).state).toBe("off");
  await settings.update({ retention: { ordinaryDays: null, completedWorkspaceDays: 7 } });
  vi.mocked(core.retention).mockResolvedValue({ kind: "chat", workflow: null, resourcesFinished: true });
  expect((await manager.sessionRetention(record.id, now)).state).toBe("off");
});
it.each(["in-progress", "deferred", "unknown"])("never expires %s work even with no cached worktrees", async state => {
  const record = await old(); vi.mocked(core.retention).mockResolvedValue({ ...completed, workflow: { state, revision: 4 } });
  expect(await manager.sweepRetention(now)).toEqual([]);
  expect((await manager.getSession(record.id))?.retention?.state).toBe("protected");
  expect(vi.mocked(core.retention).mock.calls.every(call => !call[2])).toBe(true);
});
it.each([
  { status: "running" }, { status: "awaiting_approval" }, { status: "awaiting_question" },
  { workflowCompletion: { requestId: "lease", expectedRevision: 0, state: "queued" } }, { mcpPendingApprovals: [{ id: "a", tool: "t" }] },
  { handoffDraft: { text: "unsent", attachments: [] } }, { handoffDispatch: { id: "h", state: "unknown" } },
  { coreEnvironmentOperations: [{ action: "create", input: {}, state: "pending" }] },
] as Partial<SessionRecord>[])("protects unresolved activity %j", async patch => {
  await old(patch); expect(await manager.sweepRetention(now)).toEqual([]); expect(core.retention).not.toHaveBeenCalled();
});
it("retains live sandbox-only QA and reconciles finished QA before expiry", async () => {
  const record = await old(); vi.mocked(core.retention).mockResolvedValue({ kind: "sandbox", workflow: null, resourcesFinished: false });
  expect(await manager.sweepRetention(now)).toEqual([]);
  vi.mocked(core.retention).mockResolvedValue({ kind: "sandbox", workflow: null, resourcesFinished: true });
  expect(await manager.sweepRetention(now)).toEqual([record.id]);
});
it("preserves legacy resource history, unavailable Core and malformed completion", async () => {
  const record = await old({ retentionVersion: undefined, publicationReferences: [{ workspaceId: "x", repository: "repo", url: "https://example.test/pr" }] });
  expect(await manager.sweepRetention(now)).toEqual([]);
  vi.mocked(core.retention).mockRejectedValue(new Error("Core unavailable"));
  expect(await manager.sweepRetention(now)).toEqual([]);
  expect((await manager.getSession(record.id))?.retention?.message).toBe("Core unavailable");
  vi.mocked(core.retention).mockResolvedValue({ ...completed, workflow: { state: "completed", revision: 1 } });
  expect(await manager.sweepRetention(now)).toEqual([]);
});
it("replays the exact cleanup identity after a lost response and restart", async () => {
  const record = await old();
  vi.mocked(core.retention).mockImplementation(async (_id, _user, cleanup) => { if (cleanup) throw new Error("response lost after Finish"); return completed; });
  expect(await manager.sweepRetention(now)).toEqual([]);
  const command = (await store.readRecord(record.id))!.retentionCleanup!;
  expect(command.expectedRevision).toBe(3);
  expect((await manager.sessionRetention(record.id, now)).message).toBe("response lost after Finish");
  expect((await manager.sessionRetention(record.id, now)).state).toBe("blocked");
  await manager.shutdown(); manager = build();
  vi.mocked(core.retention).mockImplementation(async (_id, _user, cleanup) => cleanup
    ? { ...completed, workflow: { ...completed.workflow!, state: "deleted" } }
    : { ...completed, workflow: { ...completed.workflow!, state: "deleting" } });
  expect(await manager.sweepRetention(now)).toEqual([record.id]);
  expect(core.retention).toHaveBeenLastCalledWith(record.id, "admin", command);
});
it("preserves a dirty/reopened workspace when Core rejects deletion and releases only the local intent", async () => {
  const record = await old();
  vi.mocked(core.retention).mockImplementation(async (_id, _user, cleanup) => { if (cleanup) throw new Error("workspace dirty"); return completed; });
  expect(await manager.sweepRetention(now)).toEqual([]);
  expect(record.retentionCleanup).toBeDefined();
  vi.mocked(core.retention).mockResolvedValue({ ...completed, workflow: { state: "in-progress", revision: 4 } });
  expect(await manager.sweepRetention(now)).toEqual([]);
  expect(record.retentionCleanup).toBeUndefined();
  expect(await store.readRecord(record.id)).not.toBeNull();
});
it("persists settings, keeps legacy ordinary duration, and never enables development expiry on upgrade", async () => {
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({ systemPrompt: "operator instruction" }));
  const upgraded = new SettingsStore(dir, 11);
  expect((await upgraded.read()).retention).toEqual({ ordinaryDays: 11, completedWorkspaceDays: null });
  expect((await upgraded.read()).workflowPrompt).toBe(DEFAULT_WORKFLOW_PROMPT);
  await upgraded.update({ workflowPrompt: "", retention: { ordinaryDays: null, completedWorkspaceDays: 7 } });
  expect((await new SettingsStore(dir).read()).workflowPrompt).toBe("");
  expect((await new SettingsStore(dir).read()).systemPrompt).toBe("operator instruction");
  await writeFile(path.join(dir, "settings.json"), "broken");
  expect((await new SettingsStore(dir).read()).retention?.ordinaryDays).toBeNull();
});
it.each([{}, { ordinaryDays: 0, completedWorkspaceDays: 7 }, { ordinaryDays: -1, completedWorkspaceDays: null }, { ordinaryDays: 2.5, completedWorkspaceDays: null }, { ordinaryDays: 2, completedWorkspaceDays: 3651 }])("rejects invalid policy %j", value => expect(validRetention(value)).toBe(false));
