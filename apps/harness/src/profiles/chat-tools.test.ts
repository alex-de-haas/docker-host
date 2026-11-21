import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionService } from "../connections/service.js";
import { callProfileChatTool } from "./chat-tools.js";
import { profileConfig, ProfileStore } from "./store.js";

const skill = "a".repeat(64);
const otherSkill = "b".repeat(64);
const initial = { name: "General", description: "", instructions: "General instructions", connectionId: null,
  model: null, reasoningEffort: null, skillIds: [] };
const modelCatalog = { revision: "v1", models: [{ id: "m", label: "Model", efforts: [{ id: "high", label: "High" }] }] };
const connections: Pick<ConnectionService, "list" | "models"> = {
  list: async () => ({ defaultId: "account", connections: [{ id: "account", name: "Account", kind: "agent", revision: 1, available: true }] }),
  models: async () => modelCatalog,
};
let directory: string;
let profiles: ProfileStore;
const catalog = vi.fn<() => Promise<string[] | null>>();
const guard = vi.fn<() => Promise<void>>();
const validateProfile = vi.fn(async (input: unknown) => profileConfig(input));
const call = (name: string, input: Record<string, unknown>) => callProfileChatTool(name, input, { profiles, connections, validateProfile, guard });

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "hosty-profile-chat-"));
  catalog.mockReset().mockResolvedValue([skill, otherSkill]);
  guard.mockReset().mockResolvedValue(undefined);
  validateProfile.mockClear();
  profiles = new ProfileStore(directory, async () => initial, catalog);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("reads summaries, full profiles and model/effort choices without changing any configuration", async () => {
  const state = await profiles.read();
  const { id, name, description, revision } = state.profiles[0]!;
  const file = path.join(directory, "agent-profiles.json");
  const before = await readFile(file, "utf8");
  expect(await call("profile_list", {})).toEqual({ directoryRevision: state.revision, defaultId: null, profiles: [{ id, name, description, revision }] });
  expect(await call("profile_list", { profileId: id })).toMatchObject({ profile: state.profiles[0] });
  expect(await call("profile_options", {})).toEqual({ defaultId: "account", connections: [{ id: "account", name: "Account", available: true }] });
  expect(await call("profile_options", { connectionId: "account" })).toEqual({ connectionId: "account", ...modelCatalog });
  expect(await readFile(file, "utf8")).toBe(before);
  expect(guard).not.toHaveBeenCalled();
});

it("creates a shared profile and patches only the requested fields, returning persisted revisions and skill IDs", async () => {
  const before = await profiles.read();
  const config = { ...initial, name: "Reviewer", connectionId: "account", model: "m", reasoningEffort: "high",
    description: "Review the change", skillIds: [otherSkill, skill] };
  const created = await call("profile_create", { expectedRevision: before.revision, profile: config });
  const directory = await profiles.read();
  const reviewer = directory.profiles.find(p => p.name === config.name)!;
  expect(created).toEqual({ directoryRevision: directory.revision, profile: { ...config, id: reviewer.id, revision: 1 } });
  const edited = await call("profile_edit", { profileId: reviewer.id, expectedRevision: directory.revision, changes: { instructions: "Focus on correctness." } });
  const result = await profiles.read();
  const updated = result.profiles.find(p => p.id === reviewer.id);
  expect(updated).toEqual({ ...reviewer, revision: 2, instructions: "Focus on correctness." });
  expect(edited).toEqual({ directoryRevision: result.revision, profile: updated });
  expect(result.defaultId).toBe(before.defaultId);
  expect(guard).toHaveBeenCalledTimes(2);
});

it("rejects a skill removed between catalog validation and save, and preserves the prior stored profile", async () => {
  const directory = await profiles.read();
  const profile = directory.profiles[0]!;
  // Profile read and serialized store refresh still see both packages. The final check sees the removal.
  catalog.mockResolvedValueOnce([skill, otherSkill]).mockResolvedValueOnce([skill, otherSkill]).mockResolvedValueOnce([skill]);
  await expect(call("profile_edit", { expectedRevision: directory.revision, profileId: profile.id,
    changes: { instructions: "New role", skillIds: [skill, otherSkill] } })).rejects.toMatchObject({ code: "skill_unavailable" });
  expect(await profiles.read()).toEqual(directory);
  expect(guard).not.toHaveBeenCalled();
});

it("preserves the installed selection when a competing Settings edit commits first", async () => {
  const before = await profiles.read();
  const profile = before.profiles[0]!;
  validateProfile.mockImplementationOnce(async input => {
    await profiles.save({ ...initial, description: "Changed in Settings", skillIds: [otherSkill] }, before.revision, profile.id);
    return profileConfig(input);
  });
  await expect(call("profile_edit", { expectedRevision: before.revision, profileId: profile.id,
    changes: { instructions: "A conflicting role", skillIds: [skill] } })).rejects.toMatchObject({ code: "profiles_changed" });
  expect((await profiles.read()).profiles[0]).toMatchObject({ description: "Changed in Settings", instructions: initial.instructions, skillIds: [otherSkill] });
});

it("rejects invalid fields, an unverifiable nonempty skill selection, and revocation at the serialized write", async () => {
  const before = await profiles.read();
  await expect(call("profile_create", { expectedRevision: before.revision, profile: { name: "Role", permissions: [] } }))
    .rejects.toMatchObject({ code: "profile_invalid" });
  catalog.mockResolvedValue(null);
  await expect(call("profile_create", { expectedRevision: before.revision, profile: { name: "Role", skillIds: [skill] } }))
    .rejects.toMatchObject({ code: "skill_catalog_unavailable" });
  expect(guard).not.toHaveBeenCalled();
  catalog.mockResolvedValue([skill, otherSkill]);
  guard.mockRejectedValueOnce(new Error("Authorization revoked"));
  await expect(call("profile_create", { expectedRevision: before.revision, profile: { name: "Role", skillIds: [skill] } }))
    .rejects.toThrow("Authorization revoked");
  expect(await profiles.read()).toEqual(before);
});
