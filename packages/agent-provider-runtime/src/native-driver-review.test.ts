import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentRunControlInput, AgentRunInput } from "@hosty-sdk/app/agent";
import type { HarnessAdapter } from "./internal/harness/adapter.js";
import type { AgentConnections } from "./internal/connections/registry.js";
import type { ProviderAuthority } from "./core.js";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { ProviderController } from "./controller.js";
import { NativeExecution } from "./native-driver.js";
import { AttachmentStore } from "./attachments.js";
import { TrackedNativeProcesses } from "./tracked-process.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(skills = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-driver-review-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home"), skillPath = path.join(directory, "skills"); await mkdir(home); await mkdir(skillPath);
  const provider = { appId: "independent.provider", installationId: "installation", key: "execution" }, actor: VerifiedOperation = { userId: "user", principalId: "principal", callerAppId: "independent.consumer", callerInstallation: "consumer-installation", admissionRef: "original-admission", provider, operation: "runs.start" };
  let pinned = { id: "a".repeat(64), path: skillPath, digest: "b".repeat(64), skills: [{ skillId: "c".repeat(64), digest: "d".repeat(64) }] };
  const authority = { admit: vi.fn(async () => ({})), renew: vi.fn(async () => ({})), workspace: vi.fn(async () => ({})), skills: vi.fn(async () => structuredClone(pinned)) } as unknown as ProviderAuthority;
  const starts = vi.fn(), stop = vi.fn(async () => {});
  const adapter: HarnessAdapter = { name: "isolated-sdk", capabilities: { questions: true, appMcp: true, liveReconfigure: true, autoAllow: true, denyReason: true }, probe: async () => ({ available: true }), start: options => {
    starts(options); return { send: () => options.onEvent({ type: "harness_session", harnessSessionId: "native-session" }), stop, stopAndWait: stop, interrupt: async () => {}, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => true };
  } };
  const connections = { binding: async () => ({ connectionId: "account", connectionRevision: 1, harnessKind: "claude" }), reserve: async () => () => {}, adapter: async () => adapter, executionHome: async () => home, shutdown: async () => {} } as unknown as AgentConnections;
  const store = new ProviderStore(path.join(directory, "sessions"), provider); await store.initialize();
  const controller = new ProviderController(store, authority, connections, "claude"), driver = new NativeExecution(controller, store, authority, connections, new AttachmentStore(path.join(directory, "assets"), provider), directory, () => "http://127.0.0.1:1");
  controller.driver = driver; await driver.initialize(); cleanup.push(() => controller.close());
  const id = randomUUID(), input = { configuration: { connection: { id: "account", revision: "1" }, ...(skills ? { skills: [{ skillId: "c".repeat(64) }] } : {}) } };
  await controller.createSession(id, input, JSON.stringify(input), actor);
  return { directory, store, controller, driver, actor, sessionId: id, authority, starts, stop, setPinned: (value: Partial<typeof pinned>) => { pinned = { ...pinned, ...value }; } };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID(), command: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Start" } };
  await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), f.actor); return id;
}
async function reconcile(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const snapshot = await f.controller.snapshot(id), command: AgentRunControlInput = { requestId: randomUUID(), expectedGeneration: snapshot.generation, expectedRevision: snapshot.revision, command: "reconcile", stopped: true };
  await f.controller.control(id, command, JSON.stringify(command), f.actor);
  await vi.waitFor(async () => expect((await f.store.run(id)).record.controls[command.requestId]?.receipt.state).not.toBe("accepted"));
  return (await f.store.run(id)).record.controls[command.requestId]!.receipt;
}
describe("native authority renewal and stop reconciliation", () => {
  it.each([
    { id: "e".repeat(64) }, { path: "/different/immutable/export" }, { digest: "e".repeat(64) },
    { skills: [{ skillId: "e".repeat(64), digest: "d".repeat(64) }] }, { skills: [{ skillId: "c".repeat(64), digest: "e".repeat(64) }] },
  ])("rejects changed pinned skill evidence before native dispatch %#", async changed => {
    const f = await fixture(true); f.setPinned(changed); const id = await start(f);
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true));
    expect((await f.controller.snapshot(id)).state).toBe("failed"); expect(f.starts).not.toHaveBeenCalled();
  });
  it("stops an active run when successful Core renewal returns different immutable skill content", async () => {
    const f = await fixture(true), id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    f.setPinned({ digest: "e".repeat(64) });
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true), { timeout: 4000, interval: 20 });
    expect((await f.controller.snapshot(id)).state).toBe("cancelled"); expect(f.stop).toHaveBeenCalled();
    expect(f.authority.workspace).toHaveBeenCalledWith("original-admission", "release_all", expect.any(Object));
  });
  it("honors an explicit workspace stop request even when execution authority still renews", async () => {
    const f = await fixture(), id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    await f.store.exclusive(async () => {
      const { session, record } = await f.store.run(id);
      record.workspaces = [{ id: "selected-tree", revision: "1", path: f.directory, leaseId: randomUUID() }]; await f.store.save(session);
    });
    vi.mocked(f.authority.workspace).mockImplementation(async (_admission, operation) =>
      (operation === "activity" ? { stopRequested: true } : {}) as never);
    await vi.waitFor(async () => expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true), { timeout: 4000, interval: 20 });
    expect((await f.controller.snapshot(id)).state).toBe("cancelled"); expect(f.stop).toHaveBeenCalled();
    expect(f.authority.renew).toHaveBeenCalled();
    expect(f.authority.workspace).toHaveBeenCalledWith("original-admission", "release_all", expect.any(Object));
  });
  it("rejects missing native admission rather than applying client stop attestation", async () => {
    const f = await fixture(), session = await f.store.load(f.sessionId), run = f.store.makeRun(session, randomUUID(), f.actor, "{}");
    run.snapshot.state = "unknown"; run.snapshot.phase = "interrupted"; session.runs[run.snapshot.ref.id] = run; session.session.activeRun = run.snapshot.ref; await f.store.save(session);
    expect(await reconcile(f, run.snapshot.ref.id)).toMatchObject({ state: "rejected", error: { code: "exit_unconfirmed" } });
    expect((await f.controller.snapshot(run.snapshot.ref.id)).stopConfirmed).toBe(false); expect((await f.store.load(f.sessionId)).session.activeRun?.id).toBe(run.snapshot.ref.id);
  });
  it("refuses reconciliation while a native query is still running", async () => {
    const f = await fixture(), id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    expect(await reconcile(f, id)).toMatchObject({ state: "rejected", error: { code: "exit_unconfirmed" } });
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(false);
  });
  it("does not turn process exit evidence into settlement of unknown tool effects", async () => {
    const f = await fixture(), id = await start(f); await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(1));
    await f.driver.engine.journal.exclusive(async () => { await f.driver.engine.journal.append(id, { type: "native_effect", id: "external-call", state: "unknown" }); await f.driver.engine.journal.update(id, "interrupted"); });
    expect(await reconcile(f, id)).toMatchObject({ state: "rejected", error: { code: "effects_unconfirmed" } });
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(false); expect((await f.driver.engine.journal.load(id)).receipt.effects).toEqual({ "external-call": "unknown" });
  });
  it("requires durable SDK completion as well as sealed process receipts before reconciliation", async () => {
    const f = await fixture(), session = await f.store.load(f.sessionId), id = randomUUID(), run = f.store.makeRun(session, id, f.actor, "{}");
    run.snapshot.state = "unknown"; run.snapshot.phase = "interrupted"; session.runs[id] = run; session.session.activeRun = run.snapshot.ref; await f.store.save(session);
    await f.driver.engine.journal.accept(id, { conversationId: f.sessionId, binding: { connectionId: "account", connectionRevision: 1, harnessKind: "claude" }, selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: f.sessionId }, input: "Previously accepted turn", options: {}, autoAllowedPrefixes: [] });
    await f.driver.engine.journal.update(id, "interrupted");
    const processes = await TrackedNativeProcesses.create(f.directory, id, run.snapshot.generation);
    expect(await processes.stop()).toMatchObject({ stopped: false, allClosed: true, sealed: true });
    expect(await reconcile(f, id)).toMatchObject({ state: "rejected", error: { code: "exit_unconfirmed" } });
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(false);
    // The supported SDK adapter alone writes this marker after its stopAndWait succeeds.
    await processes.confirmSdkStop();
    expect(await reconcile(f, id)).toMatchObject({ state: "applied" });
    expect((await f.controller.snapshot(id)).stopConfirmed).toBe(true); expect((await f.store.load(f.sessionId)).session.activeRun).toBeNull();
  });
});
