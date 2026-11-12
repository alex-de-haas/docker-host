import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { durableMkdir } from "./persistence.js";

/** OS locks are released on process death; a stale PID/heartbeat never authorizes takeover. */
export class StorageOwnershipError extends Error {
  readonly code = "storage_in_use";
  constructor(cause: unknown) {
    super("The Harness storage writer is already active or its ownership cannot be established.", { cause });
  }
}

/** The lock database contains no conversation data and holds one exclusive transaction. */
export async function acquireStorageOwner(directory: string, role: "coordinator" | "worker"): Promise<() => void> {
  await durableMkdir(directory);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path.join(directory, `${role}-owner.sqlite`));
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (cause) {
    database?.close();
    throw new StorageOwnershipError(cause);
  }
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    process.removeListener("exit", release);
    database.close();
  };
  process.once("exit", release);
  return release;
}
