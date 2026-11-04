import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DecisionClient, type DecisionRecord } from "@hosty-sdk/app/decisions";
import { DecisionsService } from "./service.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { SettingsStore } from "../settings/store.js";
import { AuditReporter } from "../audit.js";
import { WorkerJournal } from "../worker/journal.js";
import { WorkerEngine } from "../worker/engine.js";
import { WorkerClient } from "../worker/client.js";
import { createWorkerServer } from "../worker/http.js";
import { ensureServiceIdentity } from "../worker/auth.js";
import { ProfileStore } from "../profiles/store.js";
import { HarnessTaskExecutor } from "../tasks/executor.js";
import type { HarnessStartOptions } from "../harness/adapter.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "decision-native-boundary-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  vi.stubEnv("HOSTY_PUBLIC_ORIGIN_HTTP", "https://harness.example.test");
  const journal = new WorkerJournal(path.join(dir, "worker")); await journal.initialize();
  const identity = await ensureServiceIdentity(path.join(dir, "identity"));
  const starts: HarnessStartOptions[] = [], inputs: string[] = []; let releases = 0;
  const capabilities = { questions: true, appMcp: true, liveReconfigure: false, autoAllow: true, denyReason: true };
  const engine = new WorkerEngine(journal, { reserve: async () => () => { releases++; }, validateSelection: async () => {}, cwd: async () => dir,
    adapter: async () => ({ name: "codex", capabilities, probe: async () => ({ available: true }), start: options => {
      starts.push(options);
      return { send: input => {
        inputs.push(input); options.onEvent({ type: "harness_session", harnessSessionId: "native-thread" });
        if (!options.resumeHarnessSessionId) options.onEvent({ type: "question_request", questionId: "native-question", blocking: true,
          questions: [{ id: "choice", header: "Choose", question: "Which summary?", options: [{ id: "brief", label: "Brief", description: "One paragraph" }], multiSelect: false }] });
      }, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false, interrupt: async () => {}, stop: async () => {}, stopAndWait: async () => {} };
    } }),
  }, 1);
  const server = createWorkerServer(engine, async () => identity, { capabilities: async () => ({ capacity: 1 }), configure: async () => ({}), connection: async () => ({}), models: async () => ({}) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await engine.close(); });
  const worker = new WorkerClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, identity);
  const remote = worker.adapter({ connectionId: "account", connectionRevision: 1, harnessKind: "codex" }, capabilities, "codex");
  const profiles = new ProfileStore(dir, async () => ({ name: "Writer", description: "", instructions: "Write carefully", connectionId: null, model: null, reasoningEffort: null, skillIds: [] }), async () => []);
  const directory = await profiles.read(); await profiles.setDefault(directory.profiles[0]!.id, directory.revision);
  const rows = new Map<string, DecisionRecord>(), client = new DecisionClient(async () => { throw new Error("No transport"); });
  client.create = async input => {
    const existing = [...rows.values()].find(r => r.input?.correlationKey === input.input.correlationKey); if (existing) return structuredClone(existing);
    const row: DecisionRecord = { id: randomUUID(), userId: "owner", sequence: 1, revision: 1, sourceAppId: "harness", sourceInstallation: "one", sourcePrincipal: "app", correlationHash: "hash", input: input.input,
      state: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolution: null, delivery: null, continuation: null };
    rows.set(row.id, row); return structuredClone(row);
  };
  client.get = async id => structuredClone(rows.get(id)!);
  client.responses = async () => ({ items: [...rows.values()].filter(r => r.resolution && !r.delivery?.receivedAt).map(r => structuredClone(r)), pendingCount: 0, cursor: null });
  client.resolve = async (id, input) => {
    const row = rows.get(id)!; row.state = "answered"; row.revision++;
    row.resolution = { revision: row.revision, userId: "owner", principalId: "owner", answers: input.answers, answeredAt: new Date().toISOString() };
    row.delivery = { resolutionRevision: row.revision, receivedAt: null }; row.continuation = { revision: 1, commandId: null, state: "pending", updatedAt: row.createdAt };
    return structuredClone(row);
  };
  client.acknowledge = async id => { const row = rows.get(id)!; row.delivery!.receivedAt = new Date().toISOString(); row.continuation!.state = "received"; return structuredClone(row); };
  client.continuation = async (id, input) => { const row = rows.get(id)!; expect(input.expectedRevision).toBe(row.continuation!.revision); row.continuation = { ...row.continuation!, commandId: input.commandId, state: input.state, reason: input.reason, revision: input.expectedRevision + 1 }; return structuredClone(row); };
  const open = () => {
    const manager = new SessionManager(new SessionStore(dir), remote, new AuditReporter(null, null, "harness"), dir, new SettingsStore(dir), null, null, null, "http://localhost:1234", null, null, null, worker, undefined, profiles);
    const decisions = manager.decisions = new DecisionsService(manager, () => client, () => Date.now() + 8 * 3600_000);
    vi.spyOn(decisions, "kick").mockImplementation(() => {}); decisions.authorize("owner", "volatile-current-authority");
    cleanup.push(async () => { await decisions.close(); await manager.shutdown(); });
    return { manager, decisions };
  };
  const initial = open();
  return { ...initial, open, starts, inputs, releases: () => releases, journal, dir, client };
}
async function waiting(f: Awaited<ReturnType<typeof setup>>, id: string) {
  await vi.waitFor(async () => expect((await f.manager.getSession(id))?.status).toBe("awaiting_question"));
  const waits = await f.decisions.waits.list("owner"); expect(waits).toHaveLength(1);
  // The exact provider binding is part of the production session snapshot; this fixture uses a
  // static Worker adapter rather than the ConnectionService account registry.
  expect(waits[0]?.native.sessionId).toBe("native-thread");
  return waits[0]!;
}
it("parks, restarts the coordinator, and continues the same native thread once with its saved answer", async () => {
  const f = await setup();
  const chat = await f.manager.createSession({ createdBy: "owner", title: "Question" });
  await f.manager.postMessage(chat.id, "Ask first", "volatile-current-authority");
  const wait = await waiting(f, chat.id);
  // Set only the adapter kind absent from this static registry fixture before registration.
  await f.decisions.waits.update(wait.id, w => ({ ...w!, native: { ...w!.native, kind: "codex" } }));
  await f.decisions.tick();
  await vi.waitFor(async () => expect((await f.manager.getSession(chat.id))?.workerRun).toBeUndefined());
  expect((await f.manager.getSession(chat.id))?.status).toBe("awaiting_question"); expect(f.releases()).toBe(1);
  await f.decisions.close(); await f.manager.shutdown();
  const reopened = f.open(), saved = await reopened.decisions.local("owner", wait.id);
  await reopened.decisions.resolve("owner", saved.core!.id, { requestId: randomUUID(), expectedRevision: saved.core!.revision, answers: { choice: { optionIds: ["brief"] } } });
  await reopened.decisions.tick();
  await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  expect(f.starts[1]).toMatchObject({ resumeHarnessSessionId: "native-thread", requireNativeResume: true });
  expect(f.inputs[1]).toContain(saved.core!.id);
  const messages = (await reopened.manager.store.readEvents(chat.id)).filter(e => e.type === "user_message");
  expect(messages.at(-1)?.text).toBe("Continue with the saved answer.");
  expect(JSON.stringify(messages)).not.toContain('"resolutionRevision"');
  await reopened.decisions.tick(); expect(f.starts).toHaveLength(2);
  f.starts[1]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await reopened.manager.getSession(chat.id))?.status).toBe("idle"));
  await reopened.decisions.tick(); expect((await reopened.decisions.local("owner", wait.id)).state).toBe("completed");
  expect((await reopened.manager.store.readEvents(chat.id)).filter(e => e.type === "question_answered")).toHaveLength(1);
});
it("keeps the original task attempt awaiting input through parking and reports its explicit result after continuation", async () => {
  const f = await setup(), executor = new HarnessTaskExecutor(f.manager), executionId = randomUUID();
  const authority = { actor: { userId: "owner", appId: "source", installationId: "one" }, scope: "source:one", credential: "volatile-current-authority", validate: async () => {} };
  const ref = { appId: "source", installationId: "one", key: "default", id: randomUUID() };
  const input: import("@hosty-sdk/app/tasks").TaskExecutionInput = { version: 1, taskRef: ref, inputRevision: 1,
    content: { title: "Summary", markdown: "Ask before writing", review: { mode: "none" }, resources: [] },
    relations: { rootTaskRef: ref, parentTaskRef: null, relationRevision: 1 }, prerequisiteOutcomes: [] };
  const accepted = await executor.accept(executionId, input, authority); await executor.tick();
  const wait = await waiting(f, accepted.sessionRef!.id);
  await f.decisions.waits.update(wait.id, w => ({ ...w!, native: { ...w!.native, kind: "codex" } }));
  await f.decisions.tick(); await vi.waitFor(async () => expect((await f.manager.getSession(wait.sessionId))?.workerRun).toBeUndefined());
  await executor.tick(); expect(await executor.get(executionId, authority)).toMatchObject({ state: "awaiting_input", stopConfirmed: false, nativeStopConfirmed: true });
  const saved = await f.decisions.local("owner", wait.id);
  await f.decisions.resolve("owner", saved.core!.id, { requestId: randomUUID(), expectedRevision: saved.core!.revision, answers: { choice: { text: "Keep it brief" } } });
  await f.decisions.tick(); await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  expect((await f.manager.getSession(wait.sessionId))?.taskExecutionId).toBe(executionId);
  await executor.report(wait.sessionId, randomUUID(), { markdown: "The requested summary", resources: [] });
  f.starts[1]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await f.manager.getSession(wait.sessionId))?.status).toBe("idle"));
  await executor.tick(); expect(await executor.get(executionId, authority)).toMatchObject({ state: "completed", stopConfirmed: true, result: { markdown: "The requested summary" } });
  expect(f.starts).toHaveLength(2);
});
