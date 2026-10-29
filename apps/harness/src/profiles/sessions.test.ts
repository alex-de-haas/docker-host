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
const skill = "a".repeat(64);
const config = (name: string): AgentProfileConfig => ({ name, description: name, instructions: `Role: ${name}`, connectionId: "account", model: "model-one", reasoningEffort: "high", skillIds: [skill] });
let dir: string, profiles: ProfileStore, settings: SettingsStore, store: SessionStore, adapter: FakeHarnessAdapter, manager: SessionManager;
let missingProvider = false;
const connections = { binding: async (id?: unknown) => { if (missingProvider) throw new Error("Provider removed"); return { connectionId: id ?? "account", connectionRevision: 1, harnessKind: "claude" }; },
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
afterEach(async () => { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); });
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
