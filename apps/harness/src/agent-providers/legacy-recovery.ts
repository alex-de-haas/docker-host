import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sameProviderRef } from "../../shared/provider-reference.js";
import type { SessionRecord } from "../sessions/store.js";
import { legacyRunId, type VerifyArchivedExit } from "./cutover.js";
import type { ProviderExecutionState } from "./execution.js";
import { verifyLegacyProviderExit } from "./legacy-provider-exit.js";

type LegacyExecution = Omit<ProviderExecutionState, "mutations"> & {
  mutations?: Record<string, { operation?: string; method?: string; path?: string; runId?: string; sessionId?: string }>;
};
type ArchivedRecord = Omit<SessionRecord, "agentConsumerVersion" | "providerExecution"> & {
  agentConsumerVersion?: unknown; providerExecution?: LegacyExecution;
};

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value);
}

async function readEvidence(file: string, label: string, optional = false): Promise<unknown> {
  try {
    const info = await lstat(file);
    if (info.isFile() && info.size <= 16 * 1024 * 1024)
      return JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    if (optional && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to read " + label + ".", { cause });
  }
  throw new Error("Invalid " + label + ".");
}

function hasOnlyCancellation(execution: LegacyExecution, runId: string, sessionId: string): boolean {
  const mutations = execution.mutations ?? {};
  const continuations = execution.continuations ?? {};
  return typeof mutations === "object" && !Array.isArray(mutations)
    && typeof continuations === "object" && !Array.isArray(continuations)
    && Object.values(continuations).every(item => item?.state === "superseded")
    && Object.values(mutations).every(request => request?.operation === "runs.cancel" && request.method === "POST"
      && request.path === "/runs/" + runId + "/cancel" && request.runId === runId
      && (request.sessionId === undefined || request.sessionId === sessionId));
}

export async function createLegacyExitVerifier(dataDir: string, evidenceFile: string): Promise<VerifyArchivedExit> {
  const evidence = await readEvidence(evidenceFile, "the legacy cutover evidence file") as {
    version?: unknown;
    records?: { archivedRecord?: unknown; providerRoot?: unknown; archivedProviderSession?: unknown }[];
  } | null;
  if (evidence?.version !== 1 || !Array.isArray(evidence.records))
    throw new Error("Invalid legacy cutover evidence file. Expected version 1 and a records array.");

  const activeSessions = path.join(await realpath(dataDir), "sessions");
  const records = new Map<string, { record: ArchivedRecord; recordPath: string; providerRoot: string; archivedProviderSession?: string }>();
  for (const entry of evidence.records) {
    if (!isAbsolutePath(entry?.archivedRecord) || !isAbsolutePath(entry.providerRoot)
      || (entry.archivedProviderSession !== undefined && !isAbsolutePath(entry.archivedProviderSession)))
      throw new Error("Each legacy evidence entry requires absolute archivedRecord and providerRoot paths and an absolute archivedProviderSession path when supplied.");
    const recordPath = await realpath(entry.archivedRecord);
    const relative = path.relative(activeSessions, recordPath);
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep)))
      throw new Error("Legacy evidence must reference an archived conversation outside the active sessions directory.");
    const record = await readEvidence(entry.archivedRecord, "an archived conversation record") as ArchivedRecord | null;
    if (typeof record?.agentRunId !== "string" || !legacyRunId.test(record.agentRunId)
      || (record.agentConsumerVersion !== undefined && record.agentConsumerVersion !== 1) || records.has(record.agentRunId))
      throw new Error("The evidence file contains an invalid or duplicate v1 conversation record.");
    records.set(record.agentRunId, { record, recordPath, providerRoot: entry.providerRoot, archivedProviderSession: entry.archivedProviderSession });
  }

  return async (observation, binding) => {
    const evidence = records.get(observation.id);
    if (!evidence) return false;
    const { record, recordPath, providerRoot, archivedProviderSession } = evidence;
    if (record.sourceAdmission || record.workerRecovery?.state === "pending" || record.providerRecovery?.state === "pending"
      || record.subagentStartPending || record.decisionWaitIds?.length || record.taskRun?.started && !record.taskRun.exitConfirmed)
      return false;
    if (record.contextChanges !== undefined && !Array.isArray(record.contextChanges)) return false;
    const contextId = record.contextChanges?.at(-1)?.requestId;
    if (record.contextChanges?.length && (typeof contextId !== "string" || !legacyRunId.test(contextId))) return false;
    const sidecarName = contextId ? "provider-execution-" + contextId.toLowerCase() + ".json" : "provider-execution.json";
    // v1's independent outbox can contain a newer admission than the archived chat checkpoint.
    const sidecar = await readEvidence(path.join(path.dirname(recordPath), sidecarName), "the archived provider outbox", true)
      .catch(() => null) as LegacyExecution | null | undefined;
    if (sidecar === null || (contextId && !sidecar) || (sidecar && sidecar.contextId !== contextId)) return false;
    const inline = record.providerExecution;
    const execution = sidecar ?? inline;
    const run = execution?.run;
    const provider = run?.ref?.provider;
    if (typeof record.id !== "string" || !legacyRunId.test(record.id) || record.createdBy !== observation.owner
      || (observation.conversation !== null && record.id !== observation.conversation)
      || record.developmentLease && record.developmentLeaseState !== "stopped" || record.workerRun
      || execution?.version !== 1 || !run || !provider || typeof run.ref.id !== "string" || !legacyRunId.test(run.ref.id)
      || typeof run.generation !== "string" || !legacyRunId.test(run.generation)
      || typeof run.sessionId !== "string" || !legacyRunId.test(run.sessionId)
      || execution.runId !== run.ref.id || record.providerObservedRunId !== run.ref.id
      || execution.sessionId !== run.sessionId || record.harnessSessionId !== run.sessionId
      || (record.providerStopProof?.runId === run.ref.id && record.providerStopProof.generation !== run.generation)
      || record.providerStopRequestedRunId && record.providerStopRequestedRunId !== run.ref.id
      || (run.pendingContinuations !== undefined && (!Array.isArray(run.pendingContinuations)
        || run.pendingContinuations.some(item => item?.state !== "superseded")))
      || !hasOnlyCancellation(execution, run.ref.id, run.sessionId)
      || (sidecar && inline && (!hasOnlyCancellation(inline, run.ref.id, run.sessionId)
        || (inline.run && (inline.run.ref?.id !== run.ref.id || inline.run.generation !== run.generation
          || inline.run.sessionId !== run.sessionId || !sameProviderRef(inline.run.ref?.provider, provider)))))
      || !sameProviderRef(execution.selection?.provider, provider) || !sameProviderRef(record.selection?.provider, provider))
      return false;
    if (observation.nativeSession !== null) {
      const digest = createHash("sha256").update(JSON.stringify([
        record.id, record.createdBy, record.harnessKind, record.connectionId, record.connectionIdentity, record.harnessSessionId,
      ])).digest("hex");
      if (!binding || binding.owner !== observation.owner || binding.binding !== digest
        || (binding.conversation !== null && binding.conversation !== record.id)) return false;
    } else if (observation.conversation === null) {
      return false;
    }
    const attempt = observation.providerAttempt;
    if (attempt && (attempt.ref?.id !== run.ref.id || attempt.generation !== run.generation
      || !sameProviderRef(attempt.ref?.provider, provider))) return false;
    return verifyLegacyProviderExit(providerRoot, { provider, runId: run.ref.id, generation: run.generation, sessionId: run.sessionId,
      archivedProviderSession });
  };
}
