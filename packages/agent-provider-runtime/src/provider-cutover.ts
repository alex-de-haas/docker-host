import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TrackedNativeProcesses } from "./tracked-process.js";

const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
async function* oldRecords(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || !id.test(entry.name.slice(0, -5))) continue;
    if (!entry.isFile()) throw new Error("Invalid legacy execution record.");
    const file = path.join(directory, entry.name);
    if (!(await lstat(file)).isFile()) throw new Error("Invalid legacy execution file.");
    yield { id: entry.name.slice(0, -5), data: JSON.parse(await readFile(file, "utf8")) };
  }
}

/** The installed v1 service must be quiesced by Core before replacing its binary. No old bytes are adopted. */
export async function verifyLegacyQuiescence(data: string) {
  const closed = new Set<string>();
  for await (const session of oldRecords(path.join(data, "agent-sessions"))) {
    if (session.data?.version !== 1 || session.data.id !== session.id || !session.data.runs
        || typeof session.data.runs !== "object" || Array.isArray(session.data.runs)) throw new Error("Unreadable legacy execution inventory.");
    for (const [runId, unknownRun] of Object.entries(session.data.runs)) {
      const run = unknownRun as {
        snapshot?: { ref?: { id?: string }; generation?: string; stopConfirmed?: boolean };
        workspaces?: unknown[]; workspaceRelease?: { state?: string }; reservedFor?: unknown;
      };
      if (!id.test(runId) || run.snapshot?.ref?.id !== runId || !id.test(run.snapshot?.generation ?? ""))
        throw new Error("Invalid legacy attempt identity.");
      if (run.workspaces?.length && run.workspaceRelease?.state !== "released")
        throw new Error("Release the previous provider's workspace lease before changing execution protocol.");
      if (run.snapshot.stopConfirmed !== true && !run.reservedFor
          && !(await TrackedNativeProcesses.readEvidence(data, runId, run.snapshot.generation!)).stopped)
        throw new Error("The previous provider has an unclosed execution. Drain the previous release before starting v2.");
      closed.add(runId);
    }
  }
  // A lost aggregate cannot turn an orphaned native journal into evidence of physical closure.
  for await (const record of oldRecords(path.join(data, "execution-journal"))) {
    const receipt = record.data?.receipt;
    if (record.data?.version !== 1 || receipt?.runId !== record.id
        || !closed.has(record.id) && receipt.exitConfirmed !== true)
      throw new Error("The previous provider has an unconfirmed native execution.");
  }
}
