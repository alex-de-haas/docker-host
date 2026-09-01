import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, type StoredEvent } from "./store.js";
import { SettingsStore } from "../settings/store.js";
import { SessionManager } from "./manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";

// `main.ts` calls shutdown and then `process.exit(0)`, so whatever shutdown does not wait for is
// work the process kills mid-flight: a record torn between its two writes on disk, and — because
// the failure path warns — a console line printed after a test has already returned, which vitest
// fails an otherwise green run for.
describe("shutting the manager down", () => {
  let dataDir: string;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-shutdown-"));
    store = new SessionStore(dataDir);
    manager = new SessionManager(
      store,
      new FakeHarnessAdapter(),
      new AuditReporter(null, null, "hosty.ai-gateway"),
      dataDir,
      new SettingsStore(dataDir),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("waits for a harness event that is still being written", async () => {
    const record = await manager.createSession({ createdBy: "user_admin" });

    // Only the turn's closing event is slowed. Blocking every write would deadlock `postMessage`,
    // which persists the user's own message before the harness is handed anything.
    let finished = false;
    const append = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation(async (id: string, event: StoredEvent) => {
      if (event.type === "result") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await append(id, event);
        finished = true;
        return;
      }

      await append(id, event);
    });

    // Returns while that handler is still in flight: the adapter's callback is synchronous, so the
    // manager dispatches event handlers without awaiting them.
    await manager.postMessage(record.id, "hello", "seed-credential");

    await manager.shutdown();

    // The assertion the fix is about. Untracked, shutdown resolves in a microtask or two and this
    // is still false, with the write landing afterwards — against a data directory the caller is
    // by then entitled to delete.
    expect(finished).toBe(true);
  });

  it("still finishes when there is nothing in flight", async () => {
    // Paired with the case above: a drain that waited on something that never settles would hang
    // the process instead of tearing one write, which is the worse of the two failures.
    await manager.createSession({ createdBy: "user_admin" });

    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});
