import { SessionStore, type SessionRecord } from "../sessions/store.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { durableWriteFile, durableMkdir } from "../persistence.js";

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

/** Caller holds the coordinator's root writer lock. Leave all v1 bytes offline in their original locations. */
export async function openProviderStore(dataDir: string, cacheDir: string | null): Promise<SessionStore> {
  const directory = path.join(dataDir, "execution-v2");
  const store = new SessionStore(directory, cacheDir && path.join(cacheDir, "execution-v2"), dataDir);
  const marker = await optionalJson(path.join(directory, "agent-consumer-format.json")) as { version?: number } | undefined;
  if (marker?.version === 2) return store;
  if (marker !== undefined) throw new Error("Unknown provider storage format in the v2 execution directory.");
  const originalMarker = await optionalJson(path.join(dataDir, "agent-consumer-format.json")) as { version?: number } | undefined;
  if (originalMarker && originalMarker.version !== 1) throw new Error("Unknown legacy provider storage format.");
  const legacy = new SessionStore(dataDir);
  const observations = await optionalJson(path.join(dataDir, "agent-observations.json")) as {
    runs: { stopConfirmed?: boolean }[]; cancellations: { state: string }[];
  } | undefined;
  if (observations && (!Array.isArray(observations.runs) || observations.runs.some(run => run.stopConfirmed !== true)
    || !Array.isArray(observations.cancellations) || observations.cancellations.some(receipt => receipt.state === "pending")))
    throw new Error("A legacy native execution or cancellation is still unconfirmed. Finish draining it before the provider cutover.");
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(path.join(dataDir, "sessions"), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dataDir, "sessions", entry.name, "record.json");
    const row = await optionalJson(file) as SessionRecord | undefined;
    if (!row || row.id !== entry.name || !["idle", "cancelled", "failed"].includes(row.status)
      || row.workerRun || row.workerRecovery?.state === "pending" || row.sourceAdmission || row.providerStopRequestedRunId
      || row.providerRecovery?.state === "pending" || row.subagentStartPending || row.decisionWaitIds?.length
      || row.taskRun?.started && !row.taskRun.exitConfirmed || row.developmentLease && row.developmentLeaseState !== "stopped")
      throw new Error("The legacy conversation inventory has an unconfirmed writer. Drain it before selecting provider v2.");
    const execution = await legacy.readProviderExecution(row.id) ?? row.providerExecution;
    if (!execution) { if (row.agentRunId && !row.taskRun?.exitConfirmed) throw new Error("A legacy run has no exit record."); continue; }
    const run = execution.run;
    if (Object.keys(execution.mutations ?? {}).length || Object.values(execution.continuations ?? {}).some(item => ["awaiting_authorization", "pending"].includes(item.state))
      || execution.runId && (!run || !run.stopConfirmed || run.ref.id !== execution.runId || run.sessionId !== execution.sessionId
        || row.providerStopProof?.runId === run.ref.id && row.providerStopProof.generation !== run.generation
        || run.pendingContinuations?.some(item => item.state !== "superseded")))
      throw new Error("A legacy provider mutation, native run or continuation has no exit record. Drain it before selecting provider v2.");
  }
  await durableMkdir(directory);
  await assertCleanProviderCutover(store);
  return store;
}
