import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AppContextError } from "../sessions/app-context.js";
import { validSkillIds } from "../skills.js";
import type { AgentProfile, AgentProfileConfig, ProfileDirectory } from "./types.js";

const fields = ["name", "description", "instructions", "connectionId", "model", "reasoningEffort", "skillIds"];
const identifier = (value: unknown) => value === null || typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value);
export function profileConfig(input: unknown): AgentProfileConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(key => !fields.includes(key)) || typeof v.name !== "string" || !v.name.trim() || v.name.trim().length > 100
    || /[\x00-\x1f\x7f]/.test(v.name) || typeof v.description !== "string" || v.description.length > 2000
    || typeof v.instructions !== "string" || v.instructions.length > 8000 || !identifier(v.connectionId)
    || !identifier(v.model) || !identifier(v.reasoningEffort) || !validSkillIds(v.skillIds)) throw invalid();
  return { name: v.name.trim(), description: v.description, instructions: v.instructions,
    connectionId: v.connectionId as string | null, model: v.model as string | null,
    reasoningEffort: v.reasoningEffort as string | null, skillIds: [...v.skillIds] };
}
function invalid() { return new AppContextError(400, "profile_invalid", "Enter a name, description, role instructions, provider, model and valid skill selections."); }
function conflict() { return new AppContextError(409, "profiles_changed", "Profiles changed. Reload before saving or selecting again."); }
function missing() { return new AppContextError(404, "profile_not_found", "This profile was deleted. Choose another profile."); }

/** One serialized owner and atomic replacement. A failed read never resets the library. */
export class ProfileStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(directory: string, private readonly initial: () => Promise<AgentProfileConfig>,
    private readonly catalog: () => Promise<string[] | null> = async () => null) { this.file = path.join(directory, "agent-profiles.json"); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action); this.queue = task.catch(() => {}); return task;
  }
  private async write(state: ProfileDirectory): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ version: 1, ...state }, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, this.file); }
    finally { await rm(temporary, { force: true }); }
  }
  private async load(): Promise<ProfileDirectory> {
    let raw: string;
    try { raw = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const profile = { ...profileConfig(await this.initial()), id: randomUUID(), revision: 1 };
      const state = { revision: 1, defaultId: profile.id, profiles: [profile] }; await this.write(state); return state;
    }
    const state = JSON.parse(raw);
    if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Array.isArray(state.profiles)
      || state.profiles.length > 200 || state.profiles.some((p: AgentProfile) => !p || typeof p.id !== "string" || !/^[a-f0-9-]{36}$/.test(p.id)
        || !Number.isSafeInteger(p.revision) || p.revision < 1)
      || new Set(state.profiles.map((p: AgentProfile) => p.id)).size !== state.profiles.length
      || state.defaultId !== null && !state.profiles.some((p: AgentProfile) => p.id === state.defaultId)) throw new Error("Invalid stored agent profiles.");
    const profiles = state.profiles.map((p: AgentProfile) => ({ ...profileConfig(Object.fromEntries(fields.map(k => [k, p[k as keyof AgentProfile]]))), id: p.id, revision: p.revision }));
    return { revision: state.revision, defaultId: state.defaultId, profiles };
  }
  private async current(): Promise<ProfileDirectory> {
    const state = await this.load();
    const ids = await this.catalog().catch(() => null);
    if (ids === null) return { ...state, catalogUnavailable: true };
    if (!validSkillIds(ids)) throw new Error("Invalid skill catalog; existing profile selections were retained.");
    const available = new Set(ids); let changed = false;
    for (const profile of state.profiles) {
      const selected = profile.skillIds.filter(id => available.has(id));
      if (selected.length !== profile.skillIds.length) { profile.skillIds = selected; profile.revision++; changed = true; }
    }
    if (changed) { state.revision++; await this.write(state); }
    return state;
  }
  read(): Promise<ProfileDirectory> { return this.serial(() => this.current()); }
  select(id?: unknown, revision?: unknown): Promise<AgentProfile | null> {
    return this.serial(async () => {
      const state = await this.current(); const selected = id === undefined ? state.defaultId : id;
      if (selected === null) return null;
      if (typeof selected !== "string") throw invalid();
      const profile = state.profiles.find(p => p.id === selected); if (!profile) throw missing();
      if (revision !== undefined && revision !== profile.revision) throw conflict();
      return profile;
    });
  }
  save(input: unknown, expectedRevision: unknown, id?: string): Promise<ProfileDirectory> {
    const config = profileConfig(input);
    return this.serial(async () => {
      const state = await this.current(); if (expectedRevision !== state.revision) throw conflict();
      const existing = id ? state.profiles.find(p => p.id === id) : undefined;
      if (id && !existing) throw missing();
      if (!id && state.profiles.length >= 200) throw new AppContextError(400, "profiles_full", "Remove a profile before adding another.");
      if (state.profiles.some(p => p.id !== id && p.name.toLocaleLowerCase() === config.name.toLocaleLowerCase()))
        throw new AppContextError(409, "profile_name_exists", "Choose a different profile name.");
      // Re-read the authoritative catalog for new selections; failed catalog reads do not prune.
      const available = await this.catalog().catch(() => null);
      if (available !== null) {
        if (!validSkillIds(available)) throw new Error("Invalid skill catalog.");
        config.skillIds = config.skillIds.filter(id => available.includes(id));
      }
      const profile: AgentProfile = { ...config, id: id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1 };
      state.profiles = existing ? state.profiles.map(p => p.id === id ? profile : p) : [...state.profiles, profile];
      state.revision++; delete state.catalogUnavailable; await this.write(state); return state;
    });
  }
  remove(id: string, expectedRevision: unknown): Promise<ProfileDirectory> {
    return this.serial(async () => {
      const state = await this.current(); if (expectedRevision !== state.revision) throw conflict();
      if (!state.profiles.some(p => p.id === id)) throw missing();
      state.profiles = state.profiles.filter(p => p.id !== id); if (state.defaultId === id) state.defaultId = null;
      state.revision++; delete state.catalogUnavailable; await this.write(state); return state;
    });
  }
  setDefault(id: unknown, expectedRevision: unknown): Promise<ProfileDirectory> {
    return this.serial(async () => {
      const state = await this.current(); if (expectedRevision !== state.revision) throw conflict();
      if (id !== null && !state.profiles.some(p => p.id === id)) throw missing();
      state.defaultId = id as string | null; state.revision++; delete state.catalogUnavailable; await this.write(state); return state;
    });
  }
}
