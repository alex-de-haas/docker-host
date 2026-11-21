import type { ConnectionService } from "../connections/service.js";
import { AppContextError } from "../sessions/app-context.js";
import { profileConfigFields, type ProfileStore } from "./store.js";
import type { AgentProfileConfig } from "./types.js";

type ProfileChatDependencies = {
  profiles: ProfileStore;
  connections?: Pick<ConnectionService, "list" | "models"> | null;
  guard: () => Promise<void>;
  validateProfile: (input: unknown) => Promise<AgentProfileConfig>;
};

function requireFields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw new AppContextError(400, "profile_invalid", "Use only the documented profile fields for this tool.");
}

function readId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new AppContextError(400, "profile_invalid", "Supply a profile ID from profile_list.");
  return value;
}

export async function callProfileChatTool(name: string, input: Record<string, unknown>, deps: ProfileChatDependencies) {
  if (name === "profile_options") {
    requireFields(input, ["connectionId"]);
    if (!deps.connections) throw new AppContextError(503, "connections_unavailable", "The provider connection directory is unavailable.");
    if (input.connectionId !== undefined) {
      if (typeof input.connectionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(input.connectionId))
        throw new AppContextError(400, "profile_invalid", "Supply a connectionId from profile_options.");
      return { connectionId: input.connectionId, ...await deps.connections.models(input.connectionId) };
    }
    const directory = await deps.connections.list();
    return { defaultId: directory.defaultId, connections: directory.connections.map(({ id, name, available, reason, provider }) => ({
      id, name, available, ...(reason ? { reason } : {}), ...(provider?.name ? { providerName: provider.name } : {}),
    })) };
  }
  if (name === "profile_list") {
    requireFields(input, ["profileId"]);
    const id = input.profileId === undefined ? undefined : readId(input.profileId);
    const directory = await deps.profiles.read();
    const state = { directoryRevision: directory.revision, defaultId: directory.defaultId, ...(directory.catalogUnavailable ? { catalogUnavailable: true } : {}) };
    if (!id) return { ...state, profiles: directory.profiles.map(({ id, name, description, revision }) => ({ id, name, description, revision })) };
    const profile = directory.profiles.find(profile => profile.id === id);
    if (!profile) throw new AppContextError(404, "profile_not_found", "This profile was deleted. Read the directory again.");
    return { ...state, profile };
  }

  if (name !== "profile_create" && name !== "profile_edit")
    throw new AppContextError(404, "tool_unavailable", "Unknown profile tool.");
  const edit = name === "profile_edit";
  requireFields(input, edit ? ["profileId", "expectedRevision", "changes"] : ["expectedRevision", "profile"]);
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1)
    throw new AppContextError(400, "profile_invalid", "Supply the directoryRevision returned by profile_list as expectedRevision.");
  const values = edit ? input.changes : input.profile;
  requireFields(values, profileConfigFields);
  let base: Partial<AgentProfileConfig> = {
    description: "", instructions: "", connectionId: null, model: null, reasoningEffort: null, skillIds: [],
  };
  let id: string | undefined;
  if (edit) {
    id = readId(input.profileId);
    if (Object.keys(values).length === 0) throw new AppContextError(400, "profile_invalid", "Supply at least one profile change.");
    const directory = await deps.profiles.read();
    if (directory.revision !== input.expectedRevision) throw new AppContextError(409, "profiles_changed", "Profiles changed. Reload before editing.");
    const saved = directory.profiles.find(profile => profile.id === id);
    if (!saved) throw new AppContextError(404, "profile_not_found", "This profile was deleted. Read the directory again.");
    const { id: _id, revision: _revision, ...config } = saved;
    base = config;
  }
  const config = await deps.validateProfile({ ...base, ...values });
  const stored = await deps.profiles.save(config, input.expectedRevision, id, "require-installed", deps.guard);
  const profile = id ? stored.profiles.find(profile => profile.id === id)! : stored.profiles.at(-1)!;
  return { directoryRevision: stored.revision, profile };
}
