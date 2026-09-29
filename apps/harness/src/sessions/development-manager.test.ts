import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./store.js";
import { SessionManager } from "./manager.js";
import { DevelopmentClient } from "./development.js";
import { ProviderDirectory } from "../settings/providers.js";
import { AuditReporter } from "../audit.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
let dir: string, manager: SessionManager, store: SessionStore, client: DevelopmentClient;
let starts: HarnessStartOptions[], sent: string[];
const tree = { id: "a".repeat(64), path: "/owned/worktree", state: "active", apps: [{ appId: "notes" }], operations: [], leases: [] };
const adapter: HarnessAdapter = { name: "recording", capabilities: { questions: false, appMcp: true, liveReconfigure: true, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }), start: options => { starts.push(options); return { send: text => sent.push(text), stop: async () => {}, interrupt: async () => {}, setMcpServers: async () => true, resolveApproval: () => false, resolveQuestion: () => false }; } };
let directory: ProviderDirectory;
const build = () => new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir, null, directory, null, null, "http://127.0.0.1:3400", null, null, client);
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-development-test-")); store = new SessionStore(dir, path.join(dir, "cache"));
  directory = new ProviderDirectory(null, null, "hosty.harness"); vi.spyOn(directory, "readApps").mockResolvedValue([{ id: "notes", displayName: "Notes", runtimeState: "stopped" }]);
  client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
  vi.spyOn(client, "call").mockImplementation(async (_id, _token, action) => action === "list" ? { workspaces: [tree] } : tree);
  starts = []; sent = []; manager = build();
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const finish = async (id: string) => { starts.at(-1)!.onEvent({ type: "result", status: "success" }); await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle")); };
describe("development session coordination", () => {
  it("does not allocate for conversation and includes the instructions on subsequent turns", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    await manager.postMessage(record.id, "hello", "credential"); await finish(record.id);
    await manager.postMessage(record.id, "continue", "credential"); await finish(record.id);
    expect(client.call).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
    for (const prompt of sent) expect(prompt).toContain("Do not access or modify original source checkouts");
    expect(starts[0]!.mcpServers).toHaveProperty("hosty-workspaces");
  });
  it("prepares only attached apps, persists associations and holds a lease for active source work", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    await expect(manager.workspaceAction(record.id, "prepare", { appId: "other" }, "token", "admin")).rejects.toThrow("Attach");
    await expect(manager.workspaceAction(record.id, "prepare", { appId: "notes" }, "token", "other")).rejects.toThrow("another user");
    await manager.workspaceAction(record.id, "prepare", { appId: "notes", requestId: "prepare-id" }, "token", "admin");
    expect((await store.readRecord(record.id))!.developmentWorkspaces?.[0]?.id).toBe(tree.id);
    await manager.postMessage(record.id, "edit", "token");
    expect(client.call).toHaveBeenCalledWith(record.id, "token", "lease", expect.objectContaining({ workspaceId: tree.id }));
    expect(sent[0]).toContain(tree.path);
    await expect(manager.workspaceAction(record.id, "cleanup", { workspaceId: tree.id }, "token", "admin")).rejects.toThrow();
    await finish(record.id);
    expect(client.call).toHaveBeenCalledWith(record.id, "token", "release-lease", expect.objectContaining({ workspaceId: tree.id }));
    await manager.shutdown(); manager = build();
    await manager.postMessage(record.id, "resume", "fresh-token");
    expect(client.call).toHaveBeenCalledWith(record.id, "fresh-token", "list", {});
    expect(sent.at(-1)).toContain(tree.path);
  });
  it("recovers a lost prepare response before running and refuses execution when lease coordination fails", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    vi.mocked(client.call).mockRejectedValueOnce(new Error("response lost"));
    await expect(manager.workspaceAction(record.id, "prepare", { appId: "notes" }, "token", "admin")).rejects.toThrow("response lost");
    vi.mocked(client.call).mockImplementation(async (_id, _token, action) => { if (action === "lease") throw new Error("Core unavailable"); return { workspaces: [tree] }; });
    await expect(manager.postMessage(record.id, "resume", "token")).rejects.toThrow("Core unavailable");
    expect(starts).toHaveLength(0);
  });
});

it("binds shared MCP approvals to the session owner and persists denial after restart", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  await manager.postMessage(record.id, "edit", "credential");
  await manager.mcpPolicy.catalog("hosty:development", "v1", [{ name: "pr_merge" }]);
  const pending = manager.mcpPolicy.authorize(record.id, "hosty:development", "v1", "request", "pr_merge", { expectedHead: "abc" }, new AbortController().signal).catch(error => error);
  const event = await vi.waitFor(async () => {
    const approval = (await store.readEvents(record.id)).find(e => e.type === "approval_request");
    expect(approval).toBeDefined(); return approval!;
  });
  await expect(manager.resolveApproval(record.id, event.approvalId as string, "allow", undefined, "another-user")).rejects.toThrow("another user");
  await manager.shutdown(); await pending;
  manager = build(); await manager.recoverMcpApprovals();
  expect((await store.readRecord(record.id))!.mcpPendingApprovals).toEqual([]);
  expect((await store.readEvents(record.id)).some(e => e.type === "approval_decision" && e.decision === "deny")).toBe(true);
  expect(await manager.resolveApproval(record.id, event.approvalId as string, "allow")).toBe(false);
  expect(client.call).not.toHaveBeenCalled();
});

it("retains corrective PR history before completion and allows an explicit unpublished abandonment", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  vi.mocked(client.call).mockImplementation(async (_id, _token, action) => {
    if (action === "pr-status") return { workspaceId: "workspace", repository: "owner/repo", url: "https://github.com/owner/repo/pull/2", publishedHead: "new", history: [{ url: "https://github.com/owner/repo/pull/1", head: "old" }] };
    expect((await store.readRecord(record.id))!.publicationReferences).toHaveLength(2);
    return {};
  });
  await manager.workspaceAction(record.id, "pr-complete", { workspaceId: "workspace", outcome: "merged" }, "token", "admin");
  vi.mocked(client.call).mockResolvedValue({ workspaceId: "workspace", repository: "owner/repo" });
  await manager.workspaceAction(record.id, "pr-complete", { workspaceId: "workspace", outcome: "abandoned" }, "token", "admin");
  expect((await store.readRecord(record.id))!.publicationReferences).toHaveLength(2);
});
