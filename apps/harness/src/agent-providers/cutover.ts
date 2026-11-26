import { SessionStore, type SessionRecord } from "../sessions/store.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { durableWriteFile, durableMkdir } from "../persistence.js";
import type { ObservedNativeSession, ObservedRun } from "../agent-sessions/observations.js";

export type VerifyArchivedExit = (run: ObservedRun, binding: ObservedNativeSession | undefined) => Promise<boolean>;
export const legacyRunId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** The extraction release starts with new consumer records; it never adopts legacy native state. */
export async function assertCleanProviderCutover(store: Pick<SessionStore, "dataDir" | "listRecordInventory">): Promise<void> {
  const marker = path.join(store.dataDir, "agent-consumer-format.json");
  try {
    const value = JSON.parse(await readFile(marker, "utf8")) as { version?: unknown };
    if (value.version !== 2) throw new TypeError("Harness provider cutover is required. Stop legacy writers and preserve or reset their data before selecting an empty v2 data root.");
    // After the verified one-time cutover, a damaged conversation remains isolated by its
    // own store recovery fence; it must not take healthy provider consumers offline.
    return;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Harness provider storage format is unavailable. Recover its format marker before starting; no data was changed automatically.");
  }
  const inventory = await store.listRecordInventory();
  if (inventory.unavailableIds.length) throw new Error("Harness provider cutover cannot be verified because conversation storage is unavailable or damaged. Preserve the existing data and recover its inventory before updating; no data was deleted automatically.");
  const legacy = inventory.records.filter(record => record.agentConsumerVersion !== 2);
  if (legacy.length) throw new Error("Harness provider cutover is required. Install and configure the provider applications, stop all old work, remove the old conversation history and verify native history cleanup before updating Harness. Legacy conversations cannot be imported or resumed; no data was deleted automatically.");
  await durableWriteFile(marker, JSON.stringify({ version: 2 }));
}

async function optionalJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function isObservedRun(value: unknown): value is ObservedRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<ObservedRun>;
  return typeof run.id === "string" && legacyRunId.test(run.id)
    && typeof run.owner === "string" && run.owner.length > 0
    && (run.conversation === null || typeof run.conversation === "string")
    && (run.nativeSession === null || typeof run.nativeSession === "string")
    && (run.generation === null || typeof run.generation === "string")
    && typeof run.stopConfirmed === "boolean" && typeof run.state === "string"
    && (run.retired === undefined || run.retired === true);
}

async function checkObservations(dataDir: string, activeConversations: ReadonlySet<string>, activeRuns: ReadonlySet<string>,
  verifyArchivedExit?: VerifyArchivedExit): Promise<void> {
  const report = await optionalJson(path.join(dataDir, "agent-observations.json")) as {
    sessions?: unknown; runs?: unknown; cancellations?: unknown;
  } | undefined;
  if (report === undefined) return;
  if (!report || !Array.isArray(report.runs) || !Array.isArray(report.cancellations))
    throw new Error("The legacy execution observation inventory is invalid.");
  const bindings = new Map<string, ObservedNativeSession>();
  if (verifyArchivedExit && Array.isArray(report.sessions)) {
    for (const binding of report.sessions) {
      if (!binding || typeof binding.id !== "string" || bindings.has(binding.id))
        throw new Error("The legacy native-session observation inventory is invalid.");
      bindings.set(binding.id, binding);
    }
  }
  const closed = new Set<string>();
  for (const run of report.runs) {
    if (!isObservedRun(run) || closed.has(run.id))
      throw new Error("The legacy execution observation inventory has an invalid or duplicate run.");
    const orphaned = !activeRuns.has(run.id) && (run.conversation === null || !activeConversations.has(run.conversation));
    // v1 only retired this projection after the provider applied the exact retirement.
    // It deliberately retained unknown tool outcomes and did not set stopConfirmed.
    const retired = orphaned && run.retired && run.state === "unknown" && run.generation === null;
    const binding = run.nativeSession === null ? undefined : bindings.get(run.nativeSession);
    if (!run.stopConfirmed && !retired && !(orphaned && await verifyArchivedExit?.(run, binding)))
      throw new Error("Legacy run " + run.id + " has no confirmed native exit. Drain its writer or provide verified provider evidence for the archived run before selecting v2.");
    closed.add(run.id);
  }
  for (const receipt of report.cancellations) {
    if (!receipt || typeof receipt.runId !== "string" || !legacyRunId.test(receipt.runId)
      || !["pending", "completed", "rejected"].includes(receipt.state))
      throw new Error("The legacy cancellation inventory is invalid.");
    if (receipt.state === "pending" && !closed.has(receipt.runId))
      throw new Error("Legacy cancellation references run " + receipt.runId + " without a confirmed native exit.");
  }
}

/** Caller holds the coordinator's root writer lock. Leave all v1 bytes offline in their original locations. */
export async function openProviderStore(dataDir: string, cacheDir: string | null, verifyArchivedExit?: VerifyArchivedExit): Promise<SessionStore> {
  const directory = path.join(dataDir, "execution-v2");
  const store = new SessionStore(directory, cacheDir && path.join(cacheDir, "execution-v2"), dataDir);
  const marker = await optionalJson(path.join(directory, "agent-consumer-format.json")) as { version?: number } | undefined;
  if (marker?.version === 2) return store;
  if (marker !== undefined) throw new Error("Unknown provider storage format in the v2 execution directory.");
  const originalMarker = await optionalJson(path.join(dataDir, "agent-consumer-format.json")) as { version?: number } | undefined;
  if (originalMarker && originalMarker.version !== 1) throw new Error("Unknown legacy provider storage format.");
  const legacy = new SessionStore(dataDir);
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(path.join(dataDir, "sessions"), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries = []; }
  const activeConversations = new Set(entries.map(entry => entry.name));
  const activeRuns = new Set<string>();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("The legacy conversation inventory contains a linked entry.");
    if (!entry.isDirectory()) continue;
    const file = path.join(dataDir, "sessions", entry.name, "record.json");
    const row = await optionalJson(file) as SessionRecord | undefined;
    if (!row || row.id !== entry.name || !["idle", "cancelled", "failed"].includes(row.status)
      || row.workerRun || row.workerRecovery?.state === "pending" || row.sourceAdmission || row.providerStopRequestedRunId
      || row.providerRecovery?.state === "pending" || row.subagentStartPending || row.decisionWaitIds?.length
      || row.taskRun?.started && !row.taskRun.exitConfirmed || row.developmentLease && row.developmentLeaseState !== "stopped")
      throw new Error("Legacy conversation " + JSON.stringify(entry.name) + " has an unconfirmed writer. Drain it before selecting provider v2.");
    if (row.agentRunId) activeRuns.add(row.agentRunId);
    const execution = await legacy.readProviderExecution(row.id) ?? row.providerExecution;
    if (!execution) {
      if (row.agentRunId && !row.taskRun?.exitConfirmed)
        throw new Error("Legacy conversation " + JSON.stringify(row.id) + " has no exit record.");
      continue;
    }
    const run = execution.run;
    if (Object.keys(execution.mutations ?? {}).length || Object.values(execution.continuations ?? {}).some(item => ["awaiting_authorization", "pending"].includes(item.state))
      || execution.runId && (!run || !run.stopConfirmed || run.ref.id !== execution.runId || run.sessionId !== execution.sessionId
        || row.providerStopProof?.runId === run.ref.id && row.providerStopProof.generation !== run.generation
        || run.pendingContinuations?.some(item => item.state !== "superseded")))
      throw new Error("Legacy conversation " + JSON.stringify(row.id) + " has an unconfirmed provider mutation, native run or continuation. Drain it before selecting v2.");
  }
  await checkObservations(dataDir, activeConversations, activeRuns, verifyArchivedExit);
  await durableMkdir(directory);
  await assertCleanProviderCutover(store);
  return store;
}
