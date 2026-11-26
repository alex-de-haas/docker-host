import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { openProviderStore } from "./agent-providers/cutover.js";
import { createLegacyExitVerifier } from "./agent-providers/legacy-recovery.js";
import { acquireStorageOwner } from "./storage-owner.js";

async function recover(): Promise<void> {
  const { values } = parseArgs({
    options: { "data-dir": { type: "string" }, evidence: { type: "string" } },
  });
  if (!values["data-dir"] || !path.isAbsolute(values["data-dir"]) || !values.evidence || !path.isAbsolute(values.evidence))
    throw new Error("Usage: npm run recover:legacy-cutover -- --data-dir <absolute Harness data directory> --evidence <absolute evidence JSON>");

  const dataDir = await realpath(values["data-dir"]);
  const owner = await lstat(path.join(dataDir, "coordinator-owner.sqlite"));
  if (!owner.isFile() || (process.getuid && owner.uid !== process.getuid()))
    throw new Error("Run recovery as the OS user that owns the existing Harness coordinator files.");
  const release = await acquireStorageOwner(dataDir, "coordinator");
  try {
    const verifyExit = await createLegacyExitVerifier(dataDir, values.evidence);
    const store = await openProviderStore(dataDir, null, verifyExit);
    console.log("Harness v2 execution store is ready at " + store.dataDir + ".");
  } finally {
    release();
  }
}

try { await recover(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "Legacy Harness cutover could not be verified.");
  process.exitCode = 1;
}
