import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { verifyLegacyQuiescence } from "./provider-cutover.js";

it("rejects an active old writer and an orphan journal, then accepts confirmed closure without changing old data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-cutover-"));
  try {
    const dir = path.join(root, "agent-sessions"), journal = path.join(root, "execution-journal");
    await mkdir(dir); await mkdir(journal);
    await expect(verifyLegacyQuiescence(root)).resolves.toBeUndefined();
    const id = randomUUID(), run = randomUUID(), generation = randomUUID();
    const file = path.join(dir, id + ".json");
    const record = { version: 1, id, runs: { [run]: { snapshot: { ref: { id: run }, generation, stopConfirmed: false },
      workspaces: [] as string[], workspaceRelease: { state: "pending" } } } };
    await writeFile(file, JSON.stringify(record));
    await expect(verifyLegacyQuiescence(root)).rejects.toThrow("unclosed");
    record.runs[run]!.snapshot.stopConfirmed = true;
    record.runs[run]!.workspaces.push("worktree");
    await writeFile(file, JSON.stringify(record));
    await expect(verifyLegacyQuiescence(root)).rejects.toThrow("lease");
    record.runs[run]!.workspaceRelease.state = "released";
    await writeFile(file, JSON.stringify(record));
    const orphan = randomUUID(), orphanFile = path.join(journal, orphan + ".json");
    const receipt = { version: 1, receipt: { runId: orphan, exitConfirmed: false } };
    await writeFile(orphanFile, JSON.stringify(receipt));
    await expect(verifyLegacyQuiescence(root)).rejects.toThrow("unconfirmed");
    receipt.receipt.exitConfirmed = true;
    await writeFile(orphanFile, JSON.stringify(receipt));
    await verifyLegacyQuiescence(root);
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(record));
  } finally { await rm(root, { recursive: true, force: true }); }
});
