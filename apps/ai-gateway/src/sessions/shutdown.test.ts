import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, type StoredEvent } from "./store.js";
import { SettingsStore } from "../settings/store.js";
import { SessionManager } from "./manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import type { HarnessEvent, HarnessRun, HarnessStartOptions } from "../harness/adapter.js";
import { AuditReporter } from "../audit.js";

/** Hands the test the callback a run pushes events through, so it can fire one whenever it likes. */
class CapturingAdapter extends FakeHarnessAdapter {
  emit: ((event: HarnessEvent) => void) | null = null;

  override start(options: HarnessStartOptions): HarnessRun {
    this.emit = options.onEvent;
    return super.start(options);
  }
}

// `main.ts` calls shutdown and then `process.exit(0)`, so whatever shutdown does not wait for is
// work the process kills mid-flight: a record torn between its two writes on disk, and — because
// the failure path warns — a console line printed after a test has already returned, which vitest
// fails an otherwise green run for.
describe("shutting the manager down", () => {
  let dataDir: string;
  let store: SessionStore;
  let manager: SessionManager;
  let adapter: CapturingAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-shutdown-"));
    store = new SessionStore(dataDir);
    adapter = new CapturingAdapter();
    manager = new SessionManager(
      store,
      adapter,
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

  it("ignores a harness event that arrives after shutdown began", async () => {
    // Stopping a run does not stop its callbacks: `CodexRun.stop` sends SIGTERM and returns while its
    // stdout listener stays attached, so buffered output can still parse into an event. Waiting for
    // the set to empty is not enough on its own — the drain can find it empty, return, and have this
    // arrive into a process that is already exiting.
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "hello", "seed-credential");
    await manager.shutdown();
    const before = (await store.readEvents(record.id)).length;

    adapter.emit?.({ type: "assistant_text", text: "too late" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await store.readEvents(record.id)).length).toBe(before);
  });

  it("gives up on a write that never settles rather than holding the process open", async () => {
    // Its own manager, so the shared teardown is not left waiting on a promise that never resolves.
    const stuckDir = mkdtempSync(path.join(os.tmpdir(), "hosty-shutdown-stuck-"));
    const stuckStore = new SessionStore(stuckDir);
    const stuck = new SessionManager(
      stuckStore,
      new FakeHarnessAdapter(),
      new AuditReporter(null, null, "hosty.ai-gateway"),
      stuckDir,
      new SettingsStore(stuckDir),
    );

    // Only setTimeout, so the microtask the fake harness emits through still runs for real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const record = await stuck.createSession({ createdBy: "user_admin" });
      const append = stuckStore.appendEvent.bind(stuckStore);
      vi.spyOn(stuckStore, "appendEvent").mockImplementation(async (id: string, event: StoredEvent) => {
        // A store that has stopped answering — a data mount gone unresponsive, not a slow disk.
        if (event.type === "result") {
          await new Promise<void>(() => undefined);
        }

        await append(id, event);
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await stuck.postMessage(record.id, "hello", "seed-credential");

      const shutting = stuck.shutdown();
      await vi.advanceTimersByTimeAsync(2_000);

      // The claim the first cut got wrong: capping the number of passes bounded nothing, because the
      // first pass waits as long as its slowest write. A gateway that cannot exit is the worse
      // failure, so the deadline wins and says what it abandoned.
      await expect(shutting).resolves.toBeUndefined();
      expect(String(warn.mock.calls[0]?.[0])).toContain("gave up");
    } finally {
      vi.useRealTimers();
      rmSync(stuckDir, { recursive: true, force: true });
    }
  });

  it("still finishes when there is nothing in flight", async () => {
    // Paired with the case above: a drain that waited on something that never settles would hang
    // the process instead of tearing one write, which is the worse of the two failures.
    await manager.createSession({ createdBy: "user_admin" });

    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});
