import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProfileStore } from "./store.js";
import type { AgentProfileConfig } from "./types.js";
const a = "a".repeat(64), b = "b".repeat(64);
const config = (name = "Developer"): AgentProfileConfig => ({ name, description: "General developer", instructions: "Use the repository conventions", connectionId: null, model: null, reasoningEffort: null, skillIds: [a, b] });
let dir: string, catalog: string[] | null, initialCalls: number, store: ProfileStore;
function open() { return new ProfileStore(dir, async () => { initialCalls++; return config("General"); }, async () => catalog); }
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "hosty-profiles-")); catalog = [a, b]; initialCalls = 0; store = open(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
describe("profile persistence", () => {
  it("initializes once, preserves old selections and persists an empty library without recreating defaults", async () => {
    const first = await store.read(); expect(first.profiles[0]?.skillIds).toEqual([a, b]);
    expect((await open().read()).defaultId).toBe(first.defaultId); expect(initialCalls).toBe(1);
    expect(first.defaultId).toBeNull(); expect(await store.select()).toBeNull();
    await store.remove(first.profiles[0]!.id, first.revision);
    expect(await open().read()).toMatchObject({ defaultId: null, profiles: [] }); expect(initialCalls).toBe(1);
  });
  it("does not erase selections on catalog failure and prunes confirmed deletion durably", async () => {
    const first = await store.read(); catalog = null;
    expect(await store.read()).toMatchObject({ revision: first.revision, catalogUnavailable: true, profiles: [{ skillIds: [a, b] }] });
    catalog = [b]; const pruned = await store.read(); expect(pruned.profiles[0]?.skillIds).toEqual([b]); expect(pruned.revision).toBe(first.revision + 1);
    catalog = [a, b]; expect((await open().read()).profiles[0]?.skillIds).toEqual([b]);
  });
  it("serializes competing editors and rejects stale writes instead of overwriting", async () => {
    const first = await store.read();
    const edits = await Promise.allSettled([store.save(config("Planner"), first.revision), store.save(config("Reviewer"), first.revision)]);
    expect(edits.map(e => e.status)).toEqual(["fulfilled", "rejected"]);
    expect((await store.read()).profiles.map(p => p.name)).toEqual(["General", "Planner"]);
  });
  it("rejects extra authority/resource fields and duplicate names", async () => {
    const first = await store.read();
    expect(() => store.save({ ...config(), workspaceId: "source" }, first.revision)).toThrow();
    await expect(store.save(config("general"), first.revision)).rejects.toMatchObject({ code: "profile_name_exists" });
    expect(() => store.save({ ...config(), skillIds: [a, a] }, first.revision)).toThrow();
  });
  it("keeps explicit default choice stable and clears it on deletion", async () => {
    const first = await store.read(); const added = await store.save(config(), first.revision);
    const developer = added.profiles.find(p => p.name === "Developer")!;
    expect(added.defaultId).toBe(first.defaultId);
    const selected = await store.setDefault(developer.id, added.revision);
    expect((await store.select())?.id).toBe(developer.id);
    await store.remove(developer.id, selected.revision); expect(await store.select()).toBeNull();
    await expect(store.select(developer.id)).rejects.toMatchObject({ code: "profile_not_found" });
  });
  it("rejects stale profile selection and does not turn malformed storage into an empty collection", async () => {
    const first = await store.read(); const old = first.profiles[0]!;
    await store.save(config("Changed"), first.revision, old.id);
    await expect(store.select(old.id, old.revision)).rejects.toMatchObject({ code: "profiles_changed" });
    await writeFile(path.join(dir, "agent-profiles.json"), "broken");
    await expect(open().read()).rejects.toThrow(); expect(initialCalls).toBe(1);
  });
});
