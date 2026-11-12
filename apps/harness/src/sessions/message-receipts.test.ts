import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as persistence from "../persistence.js";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { AuditReporter } from "../audit.js";
import { ProviderDirectory } from "../settings/providers.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";

let dir: string, store: SessionStore, manager: SessionManager, directory: ProviderDirectory;
let starts: HarnessStartOptions[], sent: string[];
const adapter: HarnessAdapter = {
  name: "receipt-recording", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }),
  start: options => { starts.push(options); return { send: text => { sent.push(text); }, stop: async () => {}, interrupt: async () => {}, setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false }; },
};
const build = () => new SessionManager(store, adapter, new AuditReporter(null, null, "gateway"), dir, null, directory);
const request = (clientRequestId = randomUUID()) => ({ clientRequestId, actorUserId: "admin", expectedRevision: 0, selectionRevision: 0, withoutDetails: false });
const finishTurn = async (id: string) => {
  starts.at(-1)!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
};
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-message-receipts-"));
  store = new SessionStore(dir, path.join(dir, "cache"));
  directory = new ProviderDirectory(null, null, "gateway");
  vi.spyOn(directory, "readApps").mockResolvedValue([{ id: "notes", displayName: "Notes" }]);
  starts = []; sent = []; manager = build();
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe("durable message admission", () => {
  it("does not resend a completed message after a lost response, restart, or a later distinct turn", async () => {
    const session = await manager.createSession({ createdBy: "admin" });
    const original = request();
    const results = await Promise.all([
      manager.postMessage(session.id, "original", undefined, [], original),
      manager.postMessage(session.id, "original", undefined, [], original),
    ]);
    expect(results).toEqual([expect.objectContaining({ clientRequestId: original.clientRequestId, state: "accepted" }), expect.objectContaining({ clientRequestId: original.clientRequestId, state: "accepted" })]);
    expect(sent).toEqual(["original"]);
    await finishTurn(session.id);
    await manager.shutdown(); manager = build();
    await expect(manager.postMessage(session.id, "original", undefined, [], original)).resolves.toMatchObject({ state: "accepted" });
    expect(starts).toHaveLength(1);
    await manager.postMessage(session.id, "original", undefined, [], request());
    await finishTurn(session.id);
    await manager.postMessage(session.id, "original", undefined, [], original);
    expect(sent).toEqual(["original", "original"]);
    expect((await store.readEvents(session.id)).filter(e => e.type === "user_message").map(e => e.clientRequestId)).toEqual([original.clientRequestId, expect.any(String)]);
  });

  it("binds every submitted field and actor without adding a session-creator restriction", async () => {
    const session = await manager.createSession({ createdBy: "legacy-owner" });
    const root = await store.ensureWorkspace(session.id);
    await writeFile(path.join(root!, "first.txt"), "one"); await writeFile(path.join(root!, "second.txt"), "two");
    const original = request();
    await manager.postMessage(session.id, "text", undefined, ["first.txt"], original);
    for (const change of [
      { text: "different" }, { attachments: ["second.txt"] },
      { expectedRevision: 1 }, { selectionRevision: 1 }, { withoutDetails: true },
    ]) {
      await expect(manager.postMessage(session.id, "text" in change ? change.text! : "text", undefined,
        "attachments" in change ? change.attachments! : ["first.txt"], { ...original, ...change })).rejects.toMatchObject({ code: "message_request_conflict" });
    }
    await expect(manager.postMessage(session.id, "text", undefined, ["first.txt"], { ...original, actorUserId: "other-admin" })).rejects.toMatchObject({ status: 403, code: "message_request_forbidden" });
    await expect(manager.messageReceipt(session.id, original.clientRequestId, "other-admin")).rejects.toMatchObject({ status: 403 });
    expect(sent).toHaveLength(1);
  });

  it("persists unknown before any transcript publication or provider start", async () => {
    const session = await manager.createSession({ createdBy: "admin" }); const original = request();
    const append = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation(async (id, event, allocation) => {
      if (event.type === "user_message") expect(await store.readMessageReceipt(id, original.clientRequestId)).toMatchObject({ state: "unknown", actorUserId: "admin" });
      await append(id, event, allocation);
    });
    const receipt = await manager.postMessage(session.id, "text", undefined, [], original);
    expect(receipt).toMatchObject({ state: "accepted", eventSeq: expect.any(Number) });
    expect(await manager.messageReceipt(session.id, original.clientRequestId, "admin")).toEqual(receipt);
  });

  it("correlates the exact user message when a concurrent upload advances the transcript", async () => {
    const session = await manager.createSession({ createdBy: "admin" });
    await manager.postMessage(session.id, "first", undefined, [], request()); await finishTurn(session.id);
    const append = store.appendEvent.bind(store);
    let upload: Promise<void> | undefined;
    vi.spyOn(store, "appendEvent").mockImplementation(async (id, event, allocation) => {
      await append(id, event, allocation);
      if (event.type === "user_message" && event.text === "second")
        upload = manager.addAttachment(id, { name: "concurrent.txt", size: 0, path: "concurrent.txt" });
    });
    const receipt = await manager.postMessage(session.id, "second", undefined, [], request());
    await upload;
    const message = (await store.readEvents(session.id)).find(event => event.type === "user_message" && event.text === "second");
    expect((await manager.getSession(session.id))!.lastEventSeq).toBeGreaterThan(message!.seq);
    expect(receipt).toMatchObject({ state: "accepted", eventSeq: message!.seq });
  });

  it("never dispatches again if accepting the durable receipt failed after send", async () => {
    const session = await manager.createSession({ createdBy: "admin" }); const original = request();
    const save = store.saveMessageReceipt.bind(store);
    vi.spyOn(store, "saveMessageReceipt").mockImplementation(async (id, receipt) => {
      if (receipt.state === "accepted") throw new Error("synthetic disk failure after provider dispatch");
      await save(id, receipt);
    });
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toThrow("synthetic disk failure");
    expect(await manager.messageReceipt(session.id, original.clientRequestId, "admin")).toMatchObject({ state: "unknown" });
    await finishTurn(session.id);
    await manager.shutdown(); manager = build();
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toMatchObject({ code: "message_outcome_unknown" });
    expect(sent).toEqual(["text"]);
  });

  it("treats a synchronous send failure as ambiguous even when the adapter may already have acted", async () => {
    const session = await manager.createSession({ createdBy: "admin" }); const original = request();
    vi.spyOn(adapter, "start").mockImplementationOnce(options => {
      starts.push(options);
      return { send: text => { sent.push(text); throw new Error("synthetic lost provider acknowledgement"); }, stop: async () => {}, interrupt: async () => {}, setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false };
    });
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toThrow("lost provider acknowledgement");
    expect(await manager.messageReceipt(session.id, original.clientRequestId, "admin")).toMatchObject({ state: "unknown" });
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toMatchObject({ code: "message_outcome_unknown" });
    expect(sent).toEqual(["text"]);
  });

  it("does not publish or dispatch if the initial unknown receipt cannot be persisted", async () => {
    const session = await manager.createSession({ createdBy: "admin" }); const original = request();
    vi.spyOn(store, "saveMessageReceipt").mockRejectedValueOnce(new Error("synthetic admission storage failure"));
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toThrow("admission storage failure");
    expect(starts).toEqual([]); expect(sent).toEqual([]);
    expect((await store.readEvents(session.id)).filter(event => event.type === "user_message")).toEqual([]);
    await expect(manager.messageReceipt(session.id, original.clientRequestId, "admin")).rejects.toMatchObject({ code: "message_request_not_found" });
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).resolves.toMatchObject({ state: "accepted" });
  });

  it("retains a definite pre-send rejection and allows only an explicit distinct request", async () => {
    const session = await manager.createSession({ createdBy: "admin" }); const original = request();
    vi.spyOn(store, "appendEvent").mockRejectedValueOnce(new Error("synthetic known pre-effect failure"));
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toThrow("synthetic known pre-effect failure");
    expect(await manager.messageReceipt(session.id, original.clientRequestId, "admin")).toMatchObject({ state: "rejected", error: { code: "message_dispatch_failed" } });
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toMatchObject({ code: "message_request_rejected" });
    await manager.postMessage(session.id, "text", undefined, [], request());
    expect(sent).toEqual(["text"]);
  });

  it("permits safe same-ID retry after a failure before admission", async () => {
    const session = await manager.createSession({ createdBy: "admin", appIds: ["notes"] }); const original = request();
    vi.mocked(directory.readApps).mockResolvedValueOnce(null);
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toMatchObject({ code: "app_context_unavailable" });
    await expect(manager.messageReceipt(session.id, original.clientRequestId, "admin")).rejects.toMatchObject({ status: 404, code: "message_request_not_found" });
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).resolves.toMatchObject({ state: "accepted" });
    expect(sent).toHaveLength(1);
  });

  it("serializes receipt lookup with in-flight admission so recovery cannot observe a false absence", async () => {
    const session = await manager.createSession({ createdBy: "admin", appIds: ["notes"] }); const original = request();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(directory.readApps).mockImplementationOnce(async () => { enter(); await wait; return [{ id: "notes" }]; });
    const sending = manager.postMessage(session.id, "text", undefined, [], original); await entered;
    let settled = false;
    const recovery = manager.messageReceipt(session.id, original.clientRequestId, "admin").finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
    release(); await sending;
    await expect(recovery).resolves.toMatchObject({ state: "accepted" });
  });

  it("refuses invalid request IDs or a missing actor before dispatch", async () => {
    const session = await manager.createSession({ createdBy: "admin" });
    for (const value of ["../escape", "short", null, 12]) {
      await expect(manager.postMessage(session.id, "text", undefined, [], { ...request(), clientRequestId: value })).rejects.toMatchObject({ status: 400, code: "message_request_id_invalid" });
    }
    await expect(manager.postMessage(session.id, "text", undefined, [], { clientRequestId: randomUUID() })).rejects.toMatchObject({ status: 403, code: "message_actor_required" });
    expect(sent).toEqual([]);
  });

  it("fails closed on an unreadable durable receipt instead of treating it as absent", async () => {
    const session = await manager.createSession({ createdBy: "admin" }); const original = request();
    await manager.postMessage(session.id, "text", undefined, [], original); await finishTurn(session.id);
    await writeFile(path.join(dir, "sessions", session.id, "message-requests", original.clientRequestId + ".json"), "corrupted receipt");
    await manager.shutdown(); manager = build();
    await expect(manager.postMessage(session.id, "text", undefined, [], original)).rejects.toThrow();
    expect(sent).toEqual(["text"]);
  });
  it("fences a distinct request after an uncertain adapter start and only explicit recovery clears it", async () => {
    const session = await manager.createSession({ createdBy: "admin" }), original = request();
    vi.spyOn(adapter, "start").mockImplementationOnce(() => { throw new Error("start may already have spawned native work"); });
    await expect(manager.postMessage(session.id, "original", undefined, [], original)).rejects.toThrow("may already have spawned");
    expect(await manager.messageReceipt(session.id, original.clientRequestId, "admin")).toMatchObject({ state: "unknown" });
    await manager.shutdown(); store = new SessionStore(dir, path.join(dir, "cache")); manager = build();
    await expect(manager.postMessage(session.id, "new", undefined, [], request())).rejects.toMatchObject({ code: "source_admission_recovery_required" });
    const review = await manager.executionRecovery(session.id, "admin");
    expect(review).toMatchObject({ sourceOnly: true, generation: "source-admission", expectedRevision: 0 });
    const input = { ...review!, requestId: randomUUID(), consumerExitConfirmed: true };
    await manager.recoverExecution(session.id, "admin", input);
    await manager.recoverExecution(session.id, "admin", input);
    expect(await manager.messageReceipt(session.id, original.clientRequestId, "admin")).toMatchObject({ state: "unknown" });
    await manager.postMessage(session.id, "new", undefined, [], request());
    expect(sent).toEqual(["new"]);
  });

  it("preserves immutable accepted attachment versions when mutable cache files disappear", async () => {
    const session = await manager.createSession({ createdBy: "admin" });
    const workspace = await store.ensureWorkspace(session.id);
    await writeFile(path.join(workspace!, "input.txt"), "first input");
    await manager.postMessage(session.id, "inspect", undefined, ["input.txt"], request()); await finishTurn(session.id);
    const first = await store.acceptedAttachment(session.id, "input.txt");
    await writeFile(path.join(workspace!, "input.txt"), "second input");
    await manager.postMessage(session.id, "inspect", undefined, ["input.txt"], request()); await finishTurn(session.id);
    await rm(workspace!, { recursive: true });
    expect((await store.acceptedAttachment(session.id, "input.txt", first!.revision))?.bytes.toString()).toBe("first input");
    expect((await store.acceptedAttachment(session.id, "input.txt"))?.bytes.toString()).toBe("second input");
    const messages = (await store.readEvents(session.id)).filter(e => e.type === "user_message");
    expect(messages[0]!.attachmentDigests).toEqual({ "input.txt": first!.digest });
  });

  it("does not start native work or acknowledge input before its durable transcript barrier", async () => {
    const session = await manager.createSession({ createdBy: "admin" });
    let entered = false, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const append = persistence.durableAppendFile;
    vi.spyOn(persistence, "durableAppendFile").mockImplementation(async (target, bytes) => {
      if (String(bytes).includes('"type":"user_message"')) { entered = true; await barrier; }
      await append(target, bytes);
    });
    let settled = false;
    const pending = manager.postMessage(session.id, "durable first", undefined, [], request()).finally(() => { settled = true; });
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(starts).toEqual([]); expect(sent).toEqual([]); expect(settled).toBe(false);
    release(); await expect(pending).resolves.toMatchObject({ state: "accepted" });
    expect(sent).toEqual(["durable first"]);
  });

  it("keeps an uncertain native handle fenced until supported Stop confirms exit", async () => {
    const session = await manager.createSession({ createdBy: "admin" }), original = request();
    let writers = 0, maximumWriters = 0;
    const stop = vi.fn(async () => { writers--; }).mockRejectedValueOnce(new Error("native exit remains unconfirmed"));
    vi.spyOn(adapter, "start").mockImplementation(options => {
      starts.push(options); writers++; maximumWriters = Math.max(maximumWriters, writers);
      const first = starts.length === 1;
      return { send: text => { sent.push(text); if (first) throw new Error("provider acted before losing acknowledgement"); },
        stop: async () => {}, stopAndWait: first ? stop : async () => { writers--; }, interrupt: async () => {},
        setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false };
    });
    await expect(manager.postMessage(session.id, "original", undefined, [], original)).rejects.toThrow("acted before losing");
    const admission = (await manager.getSession(session.id))!.sourceAdmission!;
    const input = { requestId: randomUUID(), runId: admission.runId, generation: "source-admission", expectedRevision: 0, consumerExitConfirmed: true };
    await expect(manager.executionRecovery(session.id, "admin")).rejects.toMatchObject({ code: "recovery_active" });
    await expect(manager.recoverExecution(session.id, "admin", input)).rejects.toMatchObject({ code: "recovery_active" });
    await expect(manager.postMessage(session.id, "overlap", undefined, [], request())).rejects.toMatchObject({ code: "source_admission_recovery_required" });
    await expect(manager.cancelSession(session.id)).rejects.toThrow("exit remains unconfirmed");
    await expect(manager.executionRecovery(session.id, "admin")).rejects.toMatchObject({ code: "recovery_active" });
    await expect(manager.recoverExecution(session.id, "admin", input)).rejects.toMatchObject({ code: "recovery_active" });
    expect((await manager.getSession(session.id))!.sourceAdmission).toEqual(admission);
    expect(await manager.messageReceipt(session.id, original.clientRequestId, "admin")).toMatchObject({ state: "unknown" });
    expect(writers).toBe(1);
    await manager.cancelSession(session.id); expect(writers).toBe(0);
    expect(await manager.executionRecovery(session.id, "admin")).toMatchObject({ sourceOnly: true, runId: admission.runId });
    await manager.recoverExecution(session.id, "admin", input);
    await manager.postMessage(session.id, "next", undefined, [], request());
    expect(sent).toEqual(["original", "next"]); expect(maximumWriters).toBe(1);
    expect(await manager.messageReceipt(session.id, original.clientRequestId, "admin")).toMatchObject({ state: "unknown" });
  });

  it("projects a live storage fence after an uncertain queue-file write without a message admission", async () => {
    const session = await manager.createSession({ createdBy: "admin" });
    const write = persistence.durableWriteFile;
    vi.spyOn(persistence, "durableWriteFile").mockImplementationOnce(async (target, bytes) => {
      await write(target, bytes); throw new persistence.DurableWriteError(target, new Error("lost publication acknowledgement"));
    });
    await expect(store.saveSourceFile(session.id, path.join(store.messageQueueDirectory(session.id), "retained-input"), "input"))
      .rejects.toMatchObject({ code: "session_storage_uncertain" });
    const visible = (await manager.getSession(session.id))!;
    expect(visible.sourceAdmission).toBeUndefined();
    expect(visible.storageRecovery).toMatchObject({ state: "required", code: "session_storage_uncertain" });
    expect((await manager.listSessions()).find(record => record.id === session.id)?.storageRecovery).toEqual(visible.storageRecovery);
    await expect(manager.postMessage(session.id, "blocked", undefined, [], request())).rejects.toMatchObject({ code: "session_storage_uncertain" });
    expect(starts).toEqual([]);
  });

  it("does not release native approvals or answers through a sealed live source store", async () => {
    const session = await manager.createSession({ createdBy: "admin" });
    const approval = vi.fn(() => true), question = vi.fn(async () => true);
    vi.spyOn(adapter, "start").mockImplementationOnce(options => {
      starts.push(options);
      return { send: text => { sent.push(text); }, stop: async () => {}, interrupt: async () => {},
        setMcpServers: async () => false, resolveApproval: approval, resolveQuestion: question };
    });
    await manager.postMessage(session.id, "ask", undefined, [], request());
    starts[0]!.onEvent({ type: "approval_request", approvalId: "approval", toolName: "write", input: {} });
    starts[0]!.onEvent({ type: "question_request", questionId: "question", questions: [{ header: "Choice", question: "Choose?", multiSelect: false, options: [] }] });
    await vi.waitFor(async () => expect((await manager.getSession(session.id))?.status).toBe("awaiting_question"));
    const write = persistence.durableWriteFile;
    vi.spyOn(persistence, "durableWriteFile").mockImplementationOnce(async (target, bytes) => {
      await write(target, bytes); throw new persistence.DurableWriteError(target, new Error("uncertain source publication"));
    });
    await expect(store.saveSourceFile(session.id, path.join(store.messageQueueDirectory(session.id), "control-fence"), "input"))
      .rejects.toMatchObject({ code: "session_storage_uncertain" });
    await expect(manager.resolveApproval(session.id, "approval", "allow", undefined, "admin")).rejects.toMatchObject({ code: "session_storage_uncertain" });
    await expect(manager.resolveQuestion(session.id, "question", { "Choose?": "answer" })).rejects.toMatchObject({ code: "session_storage_uncertain" });
    expect(approval).not.toHaveBeenCalled(); expect(question).not.toHaveBeenCalled();
  });

});
