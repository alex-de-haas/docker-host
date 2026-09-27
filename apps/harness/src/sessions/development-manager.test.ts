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
