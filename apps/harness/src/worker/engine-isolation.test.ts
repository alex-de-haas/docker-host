import { afterEach, expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
it.each(["confirmed", "unconfirmed", "pending", "unsupported"])("contains a sealed event write with %s native exit without terminating unrelated work", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-worker-isolation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const child = fork(path.join(import.meta.dirname, "../../test/worker-storage-isolation-child.mjs"), [root, mode], {
    execArgv: ["--unhandled-rejections=strict", "--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, HOSTY_CORE_ORIGIN: "", HOSTY_APP_SERVICE_TOKEN: "", HOSTY_APP_ID: "isolation-fixture", NODE_ENV: "test" },
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  });
  let stderr = "", result: unknown;
  child.stderr?.on("data", data => { stderr += data; }); child.on("message", value => { result = value; });
  const [code, signal] = await once(child, "exit");
  expect(code, stderr).toBe(0); expect(signal).toBeNull();
  expect(result).toMatchObject({ survived: true, healthy: "completed", damaged: "interrupted", faults: 1,
    sends: [["damaged", 1], ["healthy", 1]], releases: expect.arrayContaining(mode === "unsupported" ? [["healthy", 1]] : [["damaged", 1], ["healthy", 1]]) });
}, 15_000);
