import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireStorageOwner } from "./storage-owner.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-storage-owner-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
it("refuses a second writer and permits independent API and Worker ownership", async () => {
  const root = await directory();
  const first = await acquireStorageOwner(root, "coordinator"); cleanup.push(first);
  await expect(acquireStorageOwner(root, "coordinator")).rejects.toMatchObject({ code: "storage_in_use" });
  const worker = await acquireStorageOwner(root, "worker"); cleanup.push(worker);
  first(); first();
  const next = await acquireStorageOwner(root, "coordinator"); cleanup.push(next);
});
it("releases ownership after a killed writer without deleting or guessing stale lock files", async () => {
  const root = await directory();
  const module = pathToFileURL(path.join(import.meta.dirname, "storage-owner.ts")).href;
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    `import { acquireStorageOwner } from ${JSON.stringify(module)}; await acquireStorageOwner(${JSON.stringify(root)}, "coordinator"); process.send("ready"); setInterval(() => {}, 1000);`],
  { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = ""; child.stderr?.on("data", data => { output += data; });
  cleanup.push(() => { child.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owner fixture did not become ready: ${output}`)), 10_000);
    child.once("message", () => { clearTimeout(timer); resolve(); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Owner fixture exited (${code}): ${output}`)); });
  });
  await expect(acquireStorageOwner(root, "coordinator")).rejects.toMatchObject({ code: "storage_in_use" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGKILL"); await exited;
  const reopened = await acquireStorageOwner(root, "coordinator"); cleanup.push(reopened);
});
