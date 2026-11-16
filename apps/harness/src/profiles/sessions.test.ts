import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProfileStore } from "./store.js";
import { SessionStore } from "../sessions/store.js";
import { SessionManager } from "../sessions/manager.js";
import { SettingsStore } from "../settings/store.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";
import type { ConnectionService } from "../connections/service.js";
import type { AgentProfileConfig } from "./types.js";
import { agentSelectionId } from "../agent-providers/directory.js";
const skill = "a".repeat(64);
const config = (name: string): AgentProfileConfig => ({ name, description: name, instructions: `Role: ${name}`, connectionId: "account", model: "model-one", reasoningEffort: "high", skillIds: [skill] });
let dir: string, profiles: ProfileStore, settings: SettingsStore, store: SessionStore, adapter: FakeHarnessAdapter, manager: SessionManager;
let missingProvider = false;
const connections = { list: async () => ({ connections: [], defaultId: null }), binding: async (id?: unknown) => { if (missingProvider) throw new Error("Provider removed"); return { connectionId: id ?? "account", connectionRevision: 1, harnessKind: "claude" }; },
  models: async () => ({ revision: "models", defaultModel: "model-one", models: [{ id: "model-one", label: "One", efforts: [{ id: "high", label: "High" }] }] }),
  reserve: async () => () => {}, adapter: async () => adapter } as unknown as ConnectionService;
function open() { return new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir, settings, null, null, null, null, null, connections, null, null, undefined, profiles); }
beforeEach(async () => {
  missingProvider = false; dir = await mkdtemp(path.join(os.tmpdir(), "hosty-profile-session-"));
  settings = new SettingsStore(dir); await settings.update({ systemPrompt: "COMMON_OLD", workflowPrompt: "WORKFLOW_OLD", skillIds: ["b".repeat(64)] });
  profiles = new ProfileStore(dir, async () => config("Planner"), async () => [skill]);
  const defaults = await profiles.read(); await profiles.setDefault(defaults.profiles[0]!.id, defaults.revision);
  store = new SessionStore(dir); adapter = new FakeHarnessAdapter(); manager = open();
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
async function idle(id: string) { await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle")); }
it("selects all profile fields together, without inheriting global skills, and locks the role after dispatch", async () => {
  let directory = await profiles.read(); directory = await profiles.save(config("Developer"), directory.revision);
  const developer = directory.profiles.find(p => p.name === "Developer")!;
  const session = await manager.createSession({ createdBy: "admin" });
  expect(session.agentProfile?.name).toBe("Planner"); expect(session.skillIds).toEqual([skill]);
  const changed = await manager.setProfile(session.id, { profileId: developer.id, profileRevision: developer.revision, expectedRevision: 0 });
  expect(changed).toMatchObject({ connectionId: "account", executionSelection: { model: "model-one", reasoningEffort: "high" }, agentProfile: { name: "Developer" }, selectionRevision: 1 });
  await expect(manager.postMessage(session.id, "hello", undefined, [], { selectionRevision: 0 })).rejects.toMatchObject({ code: "selection_conflict" });
  await manager.postMessage(session.id, "hello", undefined, [], { selectionRevision: 1 }); await idle(session.id);
  expect(adapter.lastStart?.systemPrompt).toContain("COMMON_OLD"); expect(adapter.lastStart?.systemPrompt).toContain("Role: Developer");
  await expect(manager.setProfile(session.id, { profileId: null, expectedRevision: 1 })).rejects.toMatchObject({ code: "profile_locked" });
});
it("retains started instructions after profile edits/deletion and a manager restart", async () => {
  const session = await manager.createSession({ createdBy: "admin" });
  await manager.postMessage(session.id, "hello"); await idle(session.id);
  const original = adapter.lastStart?.systemPrompt;
  const directory = await profiles.read(); await profiles.remove(directory.defaultId!, directory.revision);
  await settings.update({ systemPrompt: "COMMON_NEW", workflowPrompt: "WORKFLOW_NEW" });
  await manager.shutdown(); manager = open();
  await manager.postMessage(session.id, "continue"); await idle(session.id);
  expect(adapter.lastStart?.systemPrompt).toBe(original);
  expect((await manager.getSession(session.id))?.agentProfile?.name).toBe("Planner");
  expect(adapter.lastStart?.resumeHarnessSessionId).toBeTruthy();
});
it("allows manual chat without a profile and does not restore old default skills", async () => {
  const session = await manager.createSession({ createdBy: "admin", profileId: null });
  expect(session.agentProfile).toBeNull(); expect(session.skillIds).toEqual([]);
});
it("replays accepted creation after profile deletion without changing its configuration", async () => {
  const initial = await profiles.read(); const input = { createdBy: "admin", profileId: initial.defaultId, clientRequestId: "create-profile-chat" };
  const session = await manager.createSession(input); await profiles.remove(initial.defaultId!, initial.revision);
  expect((await manager.createSession(input)).id).toBe(session.id);
});
it("does not substitute an unavailable provider or accept an unsupported model", async () => {
  missingProvider = true;
  await expect(manager.createSession({ createdBy: "admin" })).rejects.toThrow("Provider removed");
  expect(await store.listRecords()).toEqual([]); missingProvider = false;
  await expect(manager.validateProfile({ ...config("Broken"), model: "missing" })).rejects.toMatchObject({ code: "model_unavailable" });
});
it("serializes profile changes against first dispatch", async () => {
  const session = await manager.createSession({ createdBy: "admin" });
  const results = await Promise.allSettled([manager.postMessage(session.id, "hello"), manager.setProfile(session.id, { profileId: null, expectedRevision: 0 })]);
  expect(results[0]?.status).toBe("fulfilled"); expect(results[1]?.status).toBe("rejected");
  expect((await manager.getSession(session.id))?.agentProfile?.name).toBe("Planner"); await idle(session.id);
});

it("starts without a profile when no default was explicitly configured", async () => {
  const directory = await profiles.read(); await profiles.setDefault(null, directory.revision);
  const session = await manager.createSession({ createdBy: "admin" });
  expect(session.agentProfile).toBeNull(); expect(session.skillIds).toEqual([]);
  expect(session.providerLocked).not.toBe(true);
});

it("creates manual model and autonomy settings together without inheriting the default profile", async () => {
  const before = await settings.read();
  const session = await manager.createSession({ createdBy: "admin", connectionId: "account",
    executionSelection: { model: "model-one", reasoningEffort: "high" }, autonomy: "autonomous" });
  expect(session).toMatchObject({ agentProfile: null, connectionId: "account", skillIds: [],
    executionSelection: { model: "model-one", reasoningEffort: "high" }, autonomy: "autonomous" });
  expect(await store.readRecord(session.id)).toMatchObject({ executionSelection: session.executionSelection, autonomy: "autonomous" });
  expect(await settings.read()).toEqual(before);
  await manager.postMessage(session.id, "hello"); await idle(session.id);
  expect(adapter.lastStart).toMatchObject({ model: "model-one", reasoningEffort: "high", autonomy: "autonomous" });
});

it.each([
  [{ executionSelection: null }, "invalid_selection"],
  [{ executionSelection: { model: 1 } }, "invalid_selection"],
  [{ executionSelection: { model: "model-one", extra: true } }, "invalid_selection"],
  [{ executionSelection: { model: "missing", reasoningEffort: null } }, "model_unavailable"],
  [{ executionSelection: { model: "model-one", reasoningEffort: "unsupported" } }, "effort_unavailable"],
  [{ autonomy: "run" }, "autonomy_invalid"],
] as const)("rejects invalid initial settings before recording a chat: %j", async (input, code) => {
  await expect(manager.createSession({ createdBy: "admin", ...input })).rejects.toMatchObject({ code });
  expect(await store.listRecords()).toEqual([]);
});

it("keeps selected profiles intact when creating a chat with explicit autonomy", async () => {
  const directory = await profiles.read();
  const input = { createdBy: "admin", profileId: directory.defaultId, profileRevision: directory.profiles[0]!.revision };
  await expect(manager.createSession({ ...input, executionSelection: { model: null, reasoningEffort: null } }))
    .rejects.toMatchObject({ code: "profile_overrides" });
  expect(await store.listRecords()).toEqual([]);
  expect(await manager.createSession({ ...input, autonomy: "normal" })).toMatchObject({ agentProfile: { name: "Planner" },
    executionSelection: { model: "model-one", reasoningEffort: "high" }, autonomy: "normal" });
});

it("replays concurrent creation with immutable settings after catalog loss and rejects changed input", async () => {
  const input = { createdBy: "admin", clientRequestId: "manual-feedback", connectionId: "account",
    executionSelection: { model: "model-one", reasoningEffort: "high" }, autonomy: "autonomous" };
  const [first, second] = await Promise.all([manager.createSession(input), manager.createSession(input)]);
  expect(first.id).toBe(second.id); expect(await store.listRecords()).toHaveLength(1);
  missingProvider = true;
  expect((await manager.createSession({ ...input, executionSelection: { reasoningEffort: "high", model: "model-one" } })).id).toBe(first.id);
  await expect(manager.createSession({ ...input, autonomy: "normal" })).rejects.toMatchObject({ code: "creation_conflict" });
  await expect(manager.createSession({ ...input, executionSelection: { model: null, reasoningEffort: null } }))
    .rejects.toMatchObject({ code: "creation_conflict" });
  expect(await store.listRecords()).toHaveLength(1);
});

const remembered = { ownerId: "admin", models: { account: { model: "model-one", reasoningEffort: "high" } }, autonomy: "autonomous" };
it("uses remembered manual settings only for the resolved provider of a new unprofiled chat", async () => {
  const directory = await profiles.read(); await profiles.setDefault(null, directory.revision);
  const before = await settings.read();
  const session = await manager.createSession({ createdBy: "admin", browserDefaults: remembered });
  expect(session).toMatchObject({ agentProfile: null, connectionId: "account", executionSelection: remembered.models.account, autonomy: "autonomous" });
  expect(adapter.lastStart).toBeNull(); expect(await settings.read()).toEqual(before);
  const other = await manager.createSession({ createdBy: "admin", connectionId: "other", browserDefaults: remembered });
  expect(other.connectionId).toBe("other"); expect(other.executionSelection).toBeUndefined(); expect(other.autonomy).toBe("autonomous");
});

it("retains default and explicit profiles ahead of browser model defaults", async () => {
  const directory = await profiles.read(); const profile = directory.profiles[0]!;
  const defaults = { ownerId: "admin", models: { account: { model: null, reasoningEffort: null } }, autonomy: "autonomous" };
  for (const choice of [{}, { profileId: profile.id, profileRevision: profile.revision }]) {
    const session = await manager.createSession({ createdBy: "admin", ...choice, browserDefaults: defaults });
    expect(session).toMatchObject({ agentProfile: { id: profile.id }, executionSelection: { model: "model-one", reasoningEffort: "high" }, autonomy: "autonomous" });
  }
});

it("keeps explicit initial selection and autonomy ahead of remembered defaults", async () => {
  const session = await manager.createSession({ createdBy: "admin", profileId: null,
    executionSelection: { model: null, reasoningEffort: null }, autonomy: "normal", browserDefaults: remembered });
  expect(session).toMatchObject({ executionSelection: { model: null, reasoningEffort: null }, autonomy: "normal" });
  await expect(manager.createSession({ createdBy: "admin", profileId: null, executionSelection: { model: "missing", reasoningEffort: null }, browserDefaults: remembered }))
    .rejects.toMatchObject({ code: "model_unavailable" });
});

it.each([
  null, [], "broken", { autonomy: "run", models: [] },
  { models: { account: { model: "model-one" } } },
  { models: { account: { model: 1, reasoningEffort: "high" } } },
  { models: { account: { model: "missing", reasoningEffort: null } } },
  { models: { account: { model: "model-one", reasoningEffort: "unsupported" } } },
  { models: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i === 0 ? "account" : `provider-${i}`, { model: "model-one", reasoningEffort: "high" }])) },
])("ignores malformed or incompatible optional browser settings: %j", async browserDefaults => {
  const session = await manager.createSession({ createdBy: "admin", profileId: null,
    browserDefaults: browserDefaults && typeof browserDefaults === "object" && !Array.isArray(browserDefaults) ? { ownerId: "admin", ...browserDefaults } : browserDefaults });
  expect(session.executionSelection).toBeUndefined(); expect(session.autonomy).toBeUndefined();
});

it("allows ordinary defaults when the remembered model catalog is unavailable", async () => {
  vi.spyOn(connections, "models").mockRejectedValue(new Error("Catalog unavailable"));
  const session = await manager.createSession({ createdBy: "admin", profileId: null, browserDefaults: remembered });
  expect(session.executionSelection).toBeUndefined(); expect(session.autonomy).toBe("autonomous");
});

it("replays original creation after browser defaults change without consulting current providers", async () => {
  const input = { createdBy: "admin", profileId: null, clientRequestId: "remembered-chat" };
  const first = await manager.createSession({ ...input, browserDefaults: remembered });
  missingProvider = true;
  const replay = await manager.createSession({ ...input, browserDefaults: { ownerId: "admin", autonomy: "normal", models: { account: { model: null, reasoningEffort: null } } } });
  expect(replay.id).toBe(first.id); expect(replay).toMatchObject({ executionSelection: remembered.models.account, autonomy: "autonomous" });
  expect(await store.listRecords()).toHaveLength(1);
});

it("does not apply browser preferences to an admitted task session", async () => {
  const session = await manager.createSession({ createdBy: "admin", profileId: null, taskExecutionId: "accepted-attempt", browserDefaults: remembered });
  expect(session).toMatchObject({ taskExecutionId: "accepted-attempt", autonomy: "autonomous" });
  expect(session.executionSelection).toBeUndefined();
  const normal = await manager.createSession({ createdBy: "admin", profileId: null, taskExecutionId: "second-attempt", browserDefaults: { ownerId: "admin", autonomy: "normal" } });
  expect(normal.autonomy).toBe("autonomous");
});

it.each([undefined, "previous-account"])("ignores browser settings whose owner does not match the creator: %s", async ownerId => {
  const session = await manager.createSession({ createdBy: "admin", profileId: null, browserDefaults: { ...remembered, ownerId } });
  expect(session.executionSelection).toBeUndefined(); expect(session.autonomy).toBeUndefined();
});


it("uses the last qualified available provider and its model pair without configuring a shared default", async () => {
  const directory = await profiles.read(); await profiles.setDefault(null, directory.revision);
  const selection = { provider: { appId: "independent.agent", installationId: "installation-a", key: "coding" }, connection: { id: "personal-account", revision: "7" } };
  const connectionId = agentSelectionId(selection);
  const list = vi.spyOn(connections, "list").mockResolvedValue({ defaultId: null, connections: [
    { id: connectionId, name: "Personal", kind: "agent", revision: "7", available: true },
  ] });
  const binding = vi.spyOn(connections, "binding").mockImplementation(async id => id === connectionId
    ? { connectionId, connectionRevision: "7", harnessKind: "agent", selection } : null);
  const before = await settings.read(), profileBefore = await profiles.read();
  const session = await manager.createSession({ createdBy: "admin", browserDefaults: { ownerId: "admin", connectionId,
    models: { [connectionId]: { model: "model-one", reasoningEffort: "high" } } } });
  expect(session).toMatchObject({ agentProfile: null, connectionId, connectionRevision: "7", selection,
    executionSelection: { model: "model-one", reasoningEffort: "high" } });
  expect(await store.readRecord(session.id)).toMatchObject({ connectionId, selection });
  expect(list).toHaveBeenCalledOnce(); expect(binding).toHaveBeenCalledExactlyOnceWith(connectionId);
  expect(adapter.lastStart).toBeNull(); expect(await settings.read()).toEqual(before); expect(await profiles.read()).toEqual(profileBefore);
});

it("keeps default and explicit profiles, including inherited provider defaults, ahead of provider hints", async () => {
  let directory = await profiles.read();
  const original = directory.profiles[0]!;
  directory = await profiles.save({ ...config("Inherited"), connectionId: null }, directory.revision, original.id);
  const profile = directory.profiles.find(value => value.id === original.id)!;
  const list = vi.spyOn(connections, "list");
  for (const choice of [{}, { profileId: profile.id, profileRevision: profile.revision }]) {
    const session = await manager.createSession({ createdBy: "admin", ...choice, browserDefaults: { ownerId: "admin", connectionId: "other" } });
    expect(session).toMatchObject({ agentProfile: { id: profile.id, connectionId: null }, connectionId: "account" });
  }
  expect(list).not.toHaveBeenCalled();
});

it.each(["other", null])("preserves explicit provider choice %s instead of the remembered provider", async connectionId => {
  const original = connections.binding.bind(connections);
  vi.spyOn(connections, "binding").mockImplementation(async id => id === null ? null : original(id));
  const list = vi.spyOn(connections, "list");
  const session = await manager.createSession({ createdBy: "admin", connectionId,
    browserDefaults: { ownerId: "admin", connectionId: "remembered" } });
  expect(session.agentProfile).toBeNull();
  expect(session.connectionId).toBe(connectionId ?? undefined);
  expect(list).not.toHaveBeenCalled();
});

it.each([undefined, "another-user"])("does not use another identity's provider hint: %s", async ownerId => {
  const list = vi.spyOn(connections, "list");
  const session = await manager.createSession({ createdBy: "admin", profileId: null, browserDefaults: { ownerId, connectionId: "other" } });
  expect(session.connectionId).toBe("account"); expect(list).not.toHaveBeenCalled();
});

it.each([null, 7, [], {}, "", "   ", "x".repeat(513)])("ignores a malformed optional provider hint: %j", async connectionId => {
  const list = vi.spyOn(connections, "list");
  const session = await manager.createSession({ createdBy: "admin", profileId: null, browserDefaults: { ownerId: "admin", connectionId } });
  expect(session.connectionId).toBe("account"); expect(list).not.toHaveBeenCalled();
});

it.each(["unavailable", "missing", "directory-error"])("falls back to the existing default when the remembered provider is %s", async state => {
  const list = vi.spyOn(connections, "list");
  if (state === "directory-error") list.mockRejectedValue(new Error("Current directory denied"));
  else list.mockResolvedValue({ defaultId: "account", connections: state === "missing" ? [] : [
    { id: "remembered", name: "Remembered", kind: "agent", revision: "1", available: false },
  ] });
  const binding = vi.spyOn(connections, "binding");
  const session = await manager.createSession({ createdBy: "admin", profileId: null, browserDefaults: { ownerId: "admin", connectionId: "remembered" } });
  expect(session.connectionId).toBe("account"); expect(binding).toHaveBeenCalledExactlyOnceWith(undefined);
});

it.each(["account-revision", "provider-installation"])("never rebases an old provider hint after %s changes", async change => {
  const old = { provider: { appId: "independent.agent", installationId: "first-installation", key: "coding" }, connection: { id: "same-account", revision: "1" } };
  const replacement = structuredClone(old);
  if (change === "account-revision") replacement.connection.revision = "2";
  else replacement.provider.installationId = "replacement-installation";
  const oldId = agentSelectionId(old), currentId = agentSelectionId(replacement);
  expect(oldId).not.toBe(currentId);
  vi.spyOn(connections, "list").mockResolvedValue({ defaultId: null, connections: [
    { id: currentId, name: "Current account", kind: "agent", revision: replacement.connection.revision, available: true },
  ] });
  const binding = vi.spyOn(connections, "binding").mockResolvedValue(null);
  const session = await manager.createSession({ createdBy: "admin", profileId: null, browserDefaults: { ownerId: "admin", connectionId: oldId } });
  expect(session.connectionId).toBeUndefined(); expect(binding).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("ignores provider hints for admitted task sessions", async () => {
  const list = vi.spyOn(connections, "list");
  const session = await manager.createSession({ createdBy: "admin", profileId: null, taskExecutionId: "prepared-attempt",
    browserDefaults: { ownerId: "admin", connectionId: "other" } });
  expect(session).toMatchObject({ connectionId: "account", taskExecutionId: "prepared-attempt" }); expect(list).not.toHaveBeenCalled();
});

it("replays the original accepted provider after the browser hint changes and discovery fails", async () => {
  const list = vi.spyOn(connections, "list").mockResolvedValue({ defaultId: null, connections: [
    { id: "remembered", name: "Remembered", kind: "agent", revision: "1", available: true },
  ] });
  const input = { createdBy: "admin", profileId: null, clientRequestId: "remembered-provider" };
  const first = await manager.createSession({ ...input, browserDefaults: { ownerId: "admin", connectionId: "remembered" } });
  list.mockRejectedValue(new Error("Discovery unavailable")); missingProvider = true;
  const replay = await manager.createSession({ ...input, browserDefaults: { ownerId: "admin", connectionId: "different-provider" } });
  expect(replay.id).toBe(first.id); expect(replay.connectionId).toBe("remembered"); expect(list).toHaveBeenCalledOnce();
  expect(await store.listRecords()).toHaveLength(1);
});

it("falls back normally when a remembered provider changes after discovery but before binding", async () => {
  vi.spyOn(connections, "list").mockResolvedValue({ defaultId: "account", connections: [
    { id: "remembered", name: "Remembered", kind: "agent", revision: "1", available: true },
  ] });
  const original = connections.binding.bind(connections);
  const binding = vi.spyOn(connections, "binding").mockImplementation(async id => {
    if (id === "remembered") throw new Error("Provider installation/account authority changed");
    return original(id);
  });
  const session = await manager.createSession({ createdBy: "admin", profileId: null,
    browserDefaults: { ownerId: "admin", connectionId: "remembered" } });
  expect(session.connectionId).toBe("account");
  expect(binding.mock.calls).toEqual([["remembered"], [undefined]]);
});
