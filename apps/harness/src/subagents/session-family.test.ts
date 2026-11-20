import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRunSnapshot } from "@hosty-sdk/app/agent";
import { AppContextError } from "../sessions/app-context.js";
import { AuditReporter } from "../audit.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
import { ProfileStore } from "../profiles/store.js";
import { SessionBusyError, SessionManager } from "../sessions/manager.js";
import { DevelopmentClient } from "../sessions/development.js";
import { SessionStore } from "../sessions/store.js";
import { observeChild, type ChildLaunch, type SessionSubagent } from "./types.js";

let dir: string, store: SessionStore, profiles: ProfileStore, manager: SessionManager;
let starts: Map<string, HarnessStartOptions>, sends: Array<{ id: string; text: string }>;
const checked = async () => {};
const profileConfig = (name: string) => ({ name, description: name, instructions: "", connectionId: null, model: null, reasoningEffort: null, skillIds: [] });
const provider = { appId: "test-provider", installationId: "test-installation", key: "test" };
const adapter: HarnessAdapter = {
  name: "family-fixture", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }),
  start: options => {
    starts.set(options.sessionId, options);
    return { send: text => { sends.push({ id: options.sessionId, text }); }, stop: async () => {}, stopAndWait: async () => {}, interrupt: async () => {},
      setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false };
  },
};
const build = (development: DevelopmentClient | null = null) => new SessionManager(store, adapter, new AuditReporter(null, null, "harness"), dir,
  null, null, null, null, null, null, null, development, null, undefined, profiles);
const terminal = (launch: ChildLaunch, answer: string): AgentRunSnapshot => ({
  ref: { provider, id: launch.runId }, sessionId: randomUUID(), generation: "1", revision: "7", state: "succeeded", phase: "terminal",
  stopConfirmed: true, freshness: "current", observedAt: new Date().toISOString(), configurationRevision: "1", lastSequence: "9",
  cursor: "9", pending: [], effects: { certainty: "known", unresolvedCallIds: [] },
  result: { status: "succeeded", messageId: "final", text: "An interim report.\n" + answer },
  messages: [{ id: "final", role: "assistant", text: answer, state: "complete" }],
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "harness-family-"));
  store = new SessionStore(dir, path.join(dir, "cache"));
  profiles = new ProfileStore(dir, async () => profileConfig("Development"));
  starts = new Map(); sends = []; manager = build();
});
afterEach(async () => {
  await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true });
});

it("delivers exact profile-selected child results across owner reconnect, busy parent and restart", async () => {
  const directory = await profiles.save(profileConfig("QA"), (await profiles.read()).revision);
  const first = directory.profiles.find(profile => profile.name === "Development")!, qa = directory.profiles.find(profile => profile.name === "QA")!;
  const parent = await manager.createSession({ createdBy: "alice" }), other = await manager.createSession({ createdBy: "bob" });
  await manager.refreshSessionCredentials(parent.id, "alice", "fixture-alice");
  const spawn = { requestId: randomUUID(), profileId: first.id, profileRevision: first.revision, prompt: "Implement the change" };
  const created = await manager.subagentAction(parent.id, "subagent-spawn", spawn, checked) as { childSessionId: string };
  const childId = created.childSessionId;
  expect(await manager.subagentAction(parent.id, "subagent-spawn", spawn, checked)).toMatchObject({ childSessionId: childId });
  await expect(manager.subagentAction(parent.id, "subagent-spawn", { ...spawn, prompt: "Changed" }, checked)).rejects.toMatchObject({ status: 409 });
  await expect(manager.subagentAction(other.id, "subagent-status", { childSessionId: childId }, checked)).rejects.toMatchObject({ status: 404 });
  await vi.waitFor(async () => {
    expect((await manager.getSession(childId))?.subagentStartPending).toBeUndefined();
    expect(sends.filter(item => item.id === childId)).toHaveLength(1);
  });
  expect(await manager.getSession(childId)).toMatchObject({ createdBy: "alice", parentSessionId: parent.id, agentProfile: { id: first.id } });
  expect((await store.readEvents(childId)).filter(event => event.type === "subagent_assignment")).toHaveLength(1);
  const wait = { requestId: randomUUID(), childSessionIds: [childId], mode: "all" };
  expect(await manager.subagentAction(parent.id, "subagent-wait", wait, checked)).toMatchObject({ state: "pending" });
  await manager.postMessage(parent.id, "An independent operator message");
  const [launch] = (await store.readSessionFamily(parent.id)).launches;
  await store.saveHistoryRun(childId, "alice", terminal(launch!, "Implementation ready"));
  await manager.recoverSubagents();
  await vi.waitFor(async () => expect((await store.readSessionFamily(parent.id)).waits[0]?.state).toBe("ready"));
  expect(sends.filter(item => item.id === parent.id)).toHaveLength(1);
  starts.get(parent.id)!.onEvent({ type: "result", status: "success" });
  // Win the parent lane just as its outcome is handed to postMessage.
  const post = manager.postMessage.bind(manager);
  const race = vi.spyOn(manager, "postMessage").mockImplementation(async (...args) => {
    if (args[4]?.subagentInput === "result") throw new SessionBusyError();
    return post(...args);
  });
  await vi.waitFor(async () => expect((await manager.getSession(parent.id))?.status).toBe("idle"));
  await manager.shutdown(); race.mockRestore();
  manager = build(); await manager.recoverSubagents();
  expect((await store.readSessionFamily(parent.id)).waits[0]?.state).toBe("ready");
  await manager.refreshSessionCredentials(other.id, "bob", "fixture-bob");
  expect(sends.filter(item => item.text.startsWith("Harness subagent results"))).toHaveLength(0);
  await manager.refreshActorCredentials("alice", "fresh-alice");
  await vi.waitFor(async () => expect((await store.readSessionFamily(parent.id)).waits[0]?.state).toBe("delivered"));
  const delivered = sends.filter(item => item.text.startsWith("Harness subagent results"));
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.id).toBe(parent.id);
  expect(JSON.parse(delivered[0]!.text.split("\n")[1]!).children[0].result).toBe("Implementation ready");
  expect((await store.readEvents(parent.id)).filter(event => event.type === "user_message").map(event => event.text)).toEqual(["An independent operator message"]);
  expect((await store.readEvents(parent.id)).filter(event => event.type === "subagent_continuation")).toHaveLength(1);
  expect(await manager.subagentAction(parent.id, "subagent-wait", wait, checked)).toMatchObject({ state: "delivered" });
  const early = { ...wait, requestId: randomUUID(), mode: "any" };
  expect(await manager.subagentAction(parent.id, "subagent-wait", early, checked)).toMatchObject({ state: "returned", children: [{ id: childId, result: "Implementation ready" }] });
  const qaChild = await manager.subagentAction(parent.id, "subagent-spawn", { ...spawn, requestId: randomUUID(), profileId: qa.id,
    profileRevision: qa.revision, prompt: "Verify the change" }, checked) as { childSessionId: string };
  await vi.waitFor(async () => expect(await manager.getSession(qaChild.childSessionId)).toMatchObject({ parentSessionId: parent.id, agentProfile: { id: qa.id } }));
  expect(sends.filter(item => item.text.startsWith("Harness subagent results"))).toHaveLength(1);
});

it("retries a transient admission without operator action and leaves a stopped parent's wait cancelled", async () => {
  const profile = (await profiles.read()).profiles[0]!;
  const parent = await manager.createSession({ createdBy: "alice" });
  await manager.refreshSessionCredentials(parent.id, "alice", "fixture-alice");
  const create = manager.createSession.bind(manager);
  const unavailable = vi.spyOn(manager, "createSession").mockRejectedValueOnce(
    new AppContextError(503, "provider_unavailable", "Provider is restarting.")).mockImplementation(create);
  const child = await manager.subagentAction(parent.id, "subagent-spawn", {
    requestId: randomUUID(), profileId: profile.id, profileRevision: profile.revision, prompt: "Implement the change",
  }, checked) as { childSessionId: string };
  const status = () => manager.subagentAction(parent.id, "subagent-status", { childSessionId: child.childSessionId }, checked);
  await vi.waitFor(async () => expect(await status()).toMatchObject({ child: { status: "unknown", detail: "Provider is restarting." } }));
  await vi.waitFor(async () => expect(await status()).toMatchObject({ child: { status: "running" } }), { timeout: 4000 });
  expect(unavailable).toHaveBeenCalledTimes(2);
  const wait = { requestId: randomUUID(), childSessionIds: [child.childSessionId], mode: "all" };
  expect(await manager.subagentAction(parent.id, "subagent-wait", wait, checked)).toMatchObject({ state: "pending" });
  await manager.cancelSession(parent.id);
  expect(await manager.subagentAction(parent.id, "subagent-wait", wait, checked)).toMatchObject({ state: "cancelled" });
  expect((await manager.getSession(child.childSessionId))?.status).toBe("running");
  const [launch] = (await store.readSessionFamily(parent.id)).launches;
  await store.saveHistoryRun(child.childSessionId, "alice", terminal(launch!, "Finished independently"));
  await manager.recoverSubagents();
  await vi.waitFor(async () => expect(await status()).toMatchObject({ child: { status: "completed", result: "Finished independently" } }));
  expect(sends.filter(item => item.id === parent.id)).toHaveLength(0);
  await vi.waitFor(async () => expect((await manager.getSession(parent.id))?.subagentsPending).toBeFalsy());
});

it("adopts the first child workspace and uses fresh participation revisions for parallel siblings", async () => {
  const client = new DevelopmentClient("http://core.test", "test-harness", "fixture-service");
  const workspaceId = "a".repeat(64), associated = new Set<string>();
  let revision = 3;
  vi.spyOn(client, "activity").mockResolvedValue({ workspaceId: null, revision: null, stopRequested: false, state: "unbound" });
  vi.spyOn(client, "call").mockImplementation(async (id, token, action, input) => {
    expect(token).toBe("fixture-alice");
    if (action === "association") return { workspace: associated.has(id) ? { id: workspaceId, revision } : null };
    if (action === "attach") {
      expect(input.workspaceId).toBe(workspaceId);
      if (input.expectedRevision !== revision) throw new AppContextError(409, "workspace_revision_conflict", "Refresh membership.");
      associated.add(id); return { workspace: { id: workspaceId, revision: ++revision } };
    }
    return action === "list" ? { workspaces: [] } : {};
  });
  await manager.shutdown();
  manager = build(client);
  const parent = await manager.createSession({ createdBy: "alice" });
  await manager.refreshSessionCredentials(parent.id, "alice", "fixture-alice");
  const profile = (await profiles.read()).profiles[0]!;
  const spawn = async (prompt: string) => (await manager.subagentAction(parent.id, "subagent-spawn", { requestId: randomUUID(), profileId: profile.id,
    profileRevision: profile.revision, prompt }, checked) as { childSessionId: string }).childSessionId;
  const creator = await spawn("Create a workspace");
  await vi.waitFor(async () => expect((await store.readSessionFamily(parent.id)).launches[0]?.dispatched).toBe(true));
  associated.add(creator);
  const [creatorLaunch] = (await store.readSessionFamily(parent.id)).launches;
  await store.saveHistoryRun(creator, "alice", terminal(creatorLaunch!, "Workspace ready"));
  await manager.recoverSubagents();
  await vi.waitFor(async () => expect((await manager.getSession(parent.id))?.workspaceAssociation?.id).toBe(workspaceId));
  const [first, second] = await Promise.all([spawn("First check"), spawn("Second check")]);
  await vi.waitFor(async () => {
    const launches = (await store.readSessionFamily(parent.id)).launches;
    expect(launches.every(row => row.dispatched)).toBe(true);
    expect(associated).toEqual(new Set([parent.id, creator, first, second]));
  }, { timeout: 5000 });
  const wait = { childSessionIds: [first, second], requestId: randomUUID(), mode: "all" };
  expect(await manager.subagentAction(parent.id, "subagent-wait", wait, checked)).toMatchObject({ state: "pending" });
  const launches = (await store.readSessionFamily(parent.id)).launches;
  const last = launches.find(row => row.child.id === second)!;
  await store.saveHistoryRun(second, "alice", terminal(last, "Second finished first"));
  await manager.recoverSubagents();
  expect(await manager.subagentAction(parent.id, "subagent-wait", wait, checked)).toMatchObject({ state: "pending" });
  expect(await manager.subagentAction(parent.id, "subagent-wait", { ...wait, requestId: randomUUID(), mode: "any" }, checked)).toMatchObject({
    state: "returned", children: [{ id: second, result: "Second finished first" }],
  });
  await store.saveHistoryRun(first, "alice", terminal(launches.find(row => row.child.id === first)!, "First finished last"));
  await manager.recoverSubagents();
  await vi.waitFor(async () => expect((await store.readSessionFamily(parent.id)).waits[0]?.state).toBe("delivered"));
  expect((await manager.getSession(parent.id))?.subagents?.map(child => child.id)).toEqual([creator, first, second]);
});

it("keeps unconfirmed exit open and selects the final root assistant message", () => {
  const child: SessionSubagent = { id: "child", profileId: "qa", profileName: "QA", prompt: "Test", status: "running" };
  const run = terminal({ runId: "original" } as ChildLaunch, "Verified");
  expect(observeChild(child, { ...run, stopConfirmed: false, phase: "interrupted" }, false).status).toBe("unknown");
  expect(observeChild(child, { ...run, result: undefined, messages: undefined }, true)).toBe(child);
  expect(observeChild(child, run, false)).toMatchObject({ status: "completed", result: "Verified" });
});
