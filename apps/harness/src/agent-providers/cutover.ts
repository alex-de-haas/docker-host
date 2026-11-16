import type { SessionStore } from "../sessions/store.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { durableWriteFile } from "../persistence.js";

/** The extraction release starts with new consumer records; it never adopts legacy native state. */
export async function assertCleanProviderCutover(store: Pick<SessionStore, "dataDir" | "listRecordInventory">): Promise<void> {
  const marker = path.join(store.dataDir, "agent-consumer-format.json");
  try {
    const value = JSON.parse(await readFile(marker, "utf8")) as { version?: unknown };
    if (value.version !== 1) throw new Error("Unknown agent consumer storage format.");
    // After the verified one-time cutover, a damaged conversation remains isolated by its
    // own store recovery fence; it must not take healthy provider consumers offline.
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Harness provider storage format is unavailable. Recover its format marker before starting; no data was changed automatically.");
  }
  const inventory = await store.listRecordInventory();
  if (inventory.unavailableIds.length) throw new Error("Harness provider cutover cannot be verified because conversation storage is unavailable or damaged. Preserve the existing data and recover its inventory before updating; no data was deleted automatically.");
  const legacy = inventory.records.filter(record => record.agentConsumerVersion !== 1);
  if (legacy.length) throw new Error("Harness provider cutover is required. Install and configure the provider applications, stop all old work, remove the old conversation history and verify native history cleanup before updating Harness. Legacy conversations cannot be imported or resumed; no data was deleted automatically.");
  await durableWriteFile(marker, JSON.stringify({ version: 1 }));
}
