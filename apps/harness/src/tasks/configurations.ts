import type { TaskExecutionInput, TaskRef, TaskSelection } from "@hosty-sdk/app/tasks";
import type { AgentProfile } from "../profiles/types.js";
import type { SessionRecord } from "../sessions/store.js";
import type { ProfileStore } from "../profiles/store.js";
import { validSkillIds, skillRequest, type SkillCatalog } from "../skills.js";
import { TaskStore, fingerprint, taskError, uuid } from "./store.js";

export type TaskConfigurationScope = {
  owner: string; rootTaskRef: TaskRef; parentTaskRef: TaskRef; parentExecutionId: string;
  parentSessionId: string; generation: number; coordinatorEpoch: number;
};
export type TaskConfiguration = {
  version: 1; selection: TaskSelection; scope: TaskConfigurationScope; createdAt: string;
  name: string; rationale: string; directoryRevision: number; requestHash: string;
  launchMode: "new" | "adopt"; sessionId?: string;
  adoption?: { id: string; before: string; configurationSnapshot: string; autonomyRevision: number; cancellationGeneration: number; approved: boolean };
  /** An immutable role snapshot, never inserted into the saved profile directory. */
  profile: AgentProfile;
  binding: Pick<SessionRecord, "connectionId" | "connectionRevision" | "connectionIdentity" | "harnessKind">;
};
export type PrepareTaskConfiguration = {
  requestId: string; directoryRevision: number; name: string; rationale: string;
  instructions: string; skillIds: string[];
};

/** Prepared roles are private, immutable and bound to the admitting root/parent execution. */
export class TaskConfigurations {
  constructor(private readonly store: TaskStore, private readonly profiles?: ProfileStore,
    private readonly skills: () => Promise<string[]> = async () => (await skillRequest<SkillCatalog>("")).skills.map(s => s.id)) {}
  async prepare(scope: TaskConfigurationScope, parent: SessionRecord, value: unknown): Promise<TaskConfiguration> {
    const input = value as PrepareTaskConfiguration;
    if (!input || Object.keys(input).some(k => !["requestId", "directoryRevision", "name", "rationale", "instructions", "skillIds"].includes(k))
      || typeof input.name !== "string" || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f\x7f]/.test(input.name)
      || typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > 2000
      || typeof input.instructions !== "string" || !input.instructions.trim() || input.instructions.length > 32000 || input.instructions.includes("\0")
      || !validSkillIds(input.skillIds) || input.skillIds.length > 64 || !Number.isSafeInteger(input.directoryRevision))
      return taskError("configuration_invalid", "Supply a bounded role, instructions, installed skills and why saved profiles do not fit.", 400);
    if (parent.id !== scope.parentSessionId || parent.createdBy !== scope.owner || parent.taskExecutionId !== scope.parentExecutionId)
      return taskError("configuration_forbidden", "Prepare a role only from the current admitted parent execution.", 403);
    const id = uuid(input.requestId), key = "configuration:" + id, requestHash = fingerprint({ scope, input });
    const prior = await this.store.readJournal<TaskConfiguration>(key);
    if (prior) {
      if (prior.scope.owner !== scope.owner || prior.requestHash !== requestHash) return taskError("request_conflict", "Recover the configuration with its original request and parent context.");
      return prior;
    }
    const directory = await this.profiles?.read();
    if (input.directoryRevision !== (directory?.revision ?? 0)) return taskError("selection_changed", "Read available saved profiles before preparing a fallback role.");
    const installed = new Set(input.skillIds.length ? await this.skills() : []);
    if (input.skillIds.some(id => !installed.has(id))) return taskError("skill_unavailable", "Select only currently installed skills.");
    const config: TaskConfiguration = {
      version: 1, selection: { kind: "configuration", id, revision: 1 }, scope, createdAt: new Date().toISOString(),
      name: input.name.trim(), rationale: input.rationale, directoryRevision: input.directoryRevision, requestHash, launchMode: "new",
      profile: { id, revision: 1, name: input.name.trim(), description: input.rationale, instructions: input.instructions,
        connectionId: parent.connectionId ?? null, model: parent.executionSelection?.model ?? null,
        reasoningEffort: parent.executionSelection?.reasoningEffort ?? null, skillIds: [...input.skillIds] },
      binding: { connectionId: parent.connectionId, connectionRevision: parent.connectionRevision,
        connectionIdentity: parent.connectionIdentity, harnessKind: parent.harnessKind },
    };
    return this.store.transaction(state => {
      const existing = state.journal?.[key] as TaskConfiguration | undefined;
      if (existing && existing.requestHash !== requestHash) return taskError("request_conflict", "This configuration request already has different inputs.");
      if (existing) return existing;
      (state.journal ??= {})[key] = config; return config;
    });
  }
  async resolve(selection: TaskSelection, owner: string, input: TaskExecutionInput): Promise<TaskConfiguration> {
    const config = await this.store.readJournal<TaskConfiguration>("configuration:" + uuid(selection.id));
    if (!config || config.scope.owner !== owner || selection.kind !== "configuration" || selection.revision !== config.selection.revision
      || fingerprint(config.scope.rootTaskRef) !== fingerprint(input.relations.rootTaskRef)
      || config.launchMode === "adopt" && fingerprint(input.taskRef) !== fingerprint(config.scope.rootTaskRef)
      || config.launchMode === "new" && fingerprint(config.scope.parentTaskRef) !== fingerprint(input.relations.parentTaskRef))
      return taskError("configuration_unavailable", "The prepared role is unavailable in this task context.", 404);
    if (config.launchMode === "new") {
      const parent = await this.store.get(config.scope.parentTaskRef.id, { userId: owner, appId: null });
      if (parent.coordination?.executionId !== config.scope.parentExecutionId || parent.coordination.coordinatorEpoch !== config.scope.coordinatorEpoch
        || parent.coordination.rootGeneration !== config.scope.generation)
        return taskError("configuration_stale", "Prepare a fresh task-specific role from the current coordinator.");
    }
    const installed = new Set(config.profile.skillIds.length ? await this.skills() : []);
    if (config.profile.skillIds.some(id => !installed.has(id))) return taskError("skill_unavailable", "An admitted role's selected skill is no longer installed.");
    return config;
  }
}
