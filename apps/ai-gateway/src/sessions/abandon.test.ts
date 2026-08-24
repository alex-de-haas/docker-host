import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./store.js";
import { SettingsStore } from "../settings/store.js";
import { SessionManager } from "./manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";

const DAY = 24 * 60 * 60 * 1000;

// A session paused on an approval holds a harness process, a proxy route and its share of the
// delegation chain indefinitely. Only a clock can tell "waiting" apart from "nobody is coming back".
describe("abandoning a session nobody returned to", () => {
  let dataDir: string;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-abandon-"));
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

  async function waitingSession(): Promise<string> {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "write a file", "seed-credential");
    // The fake harness parks on an approval, which is the state this sweep exists for.
    await vi.waitFor(async () => {
      expect((await store.readRecord(record.id))?.status).toBe("awaiting_approval");
    });
    return record.id;
  }

  it("leaves a session that has not waited long enough", async () => {
    const id = await waitingSession();

    expect(await manager.sweepAbandoned(DAY)).toEqual([]);
    expect((await store.readRecord(id))?.status).toBe("awaiting_approval");
  });

  it("stops one that waited past the deadline, and keeps its transcript", async () => {
    // The point is releasing the machinery, not erasing what happened: an operator coming back to
    // find the session gone would have lost the very question it was asking.
    const id = await waitingSession();

    const swept = await manager.sweepAbandoned(DAY, Date.now() + DAY + 1);

    expect(swept).toEqual([id]);
    const record = await store.readRecord(id);
    expect(record?.status).toBe("abandoned");
    expect(await store.readEvents(id, 0)).not.toHaveLength(0);
  });

  it("does not touch a session that is merely running", async () => {
    // "Running" is the agent working. Reclaiming it on a clock would kill live work.
    const record = await manager.createSession({ createdBy: "user_admin" });

    expect(await manager.sweepAbandoned(DAY, Date.now() + 10 * DAY)).toEqual([]);
    expect((await store.readRecord(record.id))?.status).not.toBe("abandoned");
  });
});
