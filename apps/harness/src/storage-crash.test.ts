import { afterEach, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore } from "./sessions/store.js";
import { SessionBusyError, SessionManager } from "./sessions/manager.js";
import { AuditReporter } from "./audit.js";
import { FakeHarnessAdapter } from "./harness/fake.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks(); });
it.each(["preparing", "input", "before-acceptance", "after-acceptance"])("retains admission and never replays effects after killing a writer at %s", async stage => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-admission-crash-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const child = fork(path.join(import.meta.dirname, "../test/storage-crash-child.mjs"), [root, stage], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, HOSTY_CORE_ORIGIN: "", HOSTY_APP_SERVICE_TOKEN: "", HOSTY_APP_ID: "crash-fixture", NODE_ENV: "test" },
  });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } });
  let output = ""; child.stderr?.on("data", data => { output += data; });
  const boundary = await new Promise<{ sessionId: string; requestId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Crash fixture failed to reach ${stage}: ${output}`)), 15_000);
    child.once("message", value => { clearTimeout(timer); resolve(value as { sessionId: string; requestId: string }); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Crash fixture exited (${code}): ${output}`)); });
  });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const store = new SessionStore(root), adapter = new FakeHarnessAdapter(), starts = vi.spyOn(adapter, "start");
  const manager = new SessionManager(store, adapter, new AuditReporter(null, null, "crash-fixture"), root);
  cleanup.push(() => manager.shutdown());
  const record = (await store.readRecord(boundary.sessionId))!;
  expect(record.sourceAdmission?.clientRequestId).toBe(boundary.requestId);
  const receipt = await store.readMessageReceipt(boundary.sessionId, boundary.requestId);
  expect(receipt?.state ?? null).toBe(stage === "preparing" ? null : stage === "after-acceptance" ? "accepted" : "unknown");
  const events = await store.readEvents(boundary.sessionId);
  expect(events.filter(event => event.type === "user_message")).toHaveLength(stage === "preparing" ? 0 : 1);
  expect(record.lastEventSeq).toBe(events.at(-1)?.seq ?? 0);
  if (receipt) {
    const replay = manager.postMessage(boundary.sessionId, "Synthetic durable input", undefined, [], {
      clientRequestId: boundary.requestId, actorUserId: "owner", expectedRevision: 0, selectionRevision: 0, withoutDetails: false,
    });
    if (receipt.state === "accepted") await expect(replay).resolves.toMatchObject({ state: "accepted" });
    else await expect(replay).rejects.toMatchObject({ code: "message_outcome_unknown" });
  }
  const blocked = await manager.postMessage(boundary.sessionId, "Distinct input", undefined, [], {
    clientRequestId: randomUUID(), actorUserId: "owner", expectedRevision: 0, selectionRevision: 0, withoutDetails: false,
  }).then(() => null, error => error);
  expect(blocked instanceof SessionBusyError || blocked?.code === "source_admission_recovery_required").toBe(true);
  const effects = await readFile(path.join(root, "synthetic-effects"), "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error; return "";
  });
  expect(effects).toBe(stage === "before-acceptance" || stage === "after-acceptance" ? "one\n" : "");
  expect(starts).not.toHaveBeenCalled();
}, 20_000);
