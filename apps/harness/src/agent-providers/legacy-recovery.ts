import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sameProviderRef } from "../../shared/provider-reference.js";
import type { SessionRecord } from "../sessions/store.js";
import { legacyRunId, type VerifyArchivedExit } from "./cutover.js";
import { verifyLegacyProviderExit } from "./legacy-provider-exit.js";

type ArchivedRecord = Omit<SessionRecord, "agentConsumerVersion"> & { agentConsumerVersion?: unknown };

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value);
}

async function readEvidence(file: string, label: string): Promise<unknown> {
  try {
    const info = await lstat(file);
    if (info.isFile() && info.size <= 16 * 1024 * 1024)
      return JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new Error("Unable to read " + label + ".", { cause });
  }
  throw new Error("Invalid " + label + ".");
}

export async function createLegacyExitVerifier(dataDir: string, evidenceFile: string): Promise<VerifyArchivedExit> {
  const evidence = await readEvidence(evidenceFile, "the legacy cutover evidence file") as {
    version?: unknown;
    records?: { archivedRecord?: unknown; providerRoot?: unknown; archivedProviderSession?: unknown }[];
  } | null;
  if (evidence?.version !== 1 || !Array.isArray(evidence.records))
    throw new Error("Invalid legacy cutover evidence file. Expected version 1 and a records array.");

  const activeSessions = path.join(await realpath(dataDir), "sessions");
  const records = new Map<string, { record: ArchivedRecord; providerRoot: string; archivedProviderSession?: string }>();
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
    records.set(record.agentRunId, { record, providerRoot: entry.providerRoot, archivedProviderSession: entry.archivedProviderSession });
  }

  return async (observation, binding) => {
    const evidence = records.get(observation.id);
    if (!evidence) return false;
    const { record, providerRoot, archivedProviderSession } = evidence;
    const execution = record.providerExecution;
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
      || run.pendingContinuations?.some(item => item.state !== "superseded")
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
