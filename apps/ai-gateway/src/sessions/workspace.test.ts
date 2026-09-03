import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./store.js";
import { SettingsStore } from "../settings/store.js";
import { SessionManager } from "./manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";

const DAY = 24 * 60 * 60 * 1000;

// A working directory of the session's own. Every run used to start in one shared `workDir`, which
// defaulted to the home directory — a file placed "next to the session" was visible to all of them
// at once. What matters as much as the directory existing is when it stops existing: with the
// session, and not before.
describe("a session's workspace", () => {
  let dataDir: string;
  let cacheDir: string;
  let store: SessionStore;
  let adapter: FakeHarnessAdapter;
  let manager: SessionManager;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-ws-data-"));
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "hosty-ws-cache-"));
    store = new SessionStore(dataDir, cacheDir);
    adapter = new FakeHarnessAdapter();
    manager = build(store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("is where the harness starts, under the cache root and not the data root", async () => {
    const id = await start();

    const cwd = adapter.lastStart!.cwd;
    expect(cwd).toBe(path.join(cacheDir, "sessions", id, "workspace"));
    expect(existsSync(cwd)).toBe(true);
    // The point of the second root: from here, nothing above is a transcript.
    expect(cwd.startsWith(dataDir)).toBe(false);
  });

  it("falls back to the shared directory when no cache root was injected, and says so once", async () => {
    // A gateway outside Core. The shared cwd is the old behaviour kept for that case only, and the
    // warning is the one line that explains it — once, or it would be printed per message.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const shared = new SessionManager(
      new SessionStore(dataDir, null), adapter,
      new AuditReporter(null, null, "hosty.ai-gateway"), dataDir, new SettingsStore(dataDir));
    const record = await shared.createSession({ createdBy: "user_admin" });
    await shared.postMessage(record.id, "hello", "seed-credential");
    await shared.postMessage(record.id, "again", "seed-credential");

    expect(adapter.lastStart!.cwd).toBe(dataDir);
    expect(warn.mock.calls.filter(([line]) => String(line).includes("shares"))).toHaveLength(1);
    await shared.shutdown();
  });

  it("creates the shared fallback directory rather than starting a harness in a missing one", async () => {
    // The old default was the home directory, which always exists. A temp path does not until
    // something makes it, and a harness spawned into a missing cwd fails with ENOENT before the
    // operator has typed a second word.
    const missing = path.join(os.tmpdir(), `hosty-ws-missing-${process.pid}-${Date.now()}`);
    expect(existsSync(missing)).toBe(false);
    const shared = new SessionManager(
      new SessionStore(dataDir, null), adapter,
      new AuditReporter(null, null, "hosty.ai-gateway"), missing, new SettingsStore(dataDir));
    try {
      const record = await shared.createSession({ createdBy: "user_admin" });
      await shared.postMessage(record.id, "hello", "seed-credential");

      expect(adapter.lastStart!.cwd).toBe(missing);
      expect(existsSync(missing)).toBe(true);
    } finally {
      await shared.shutdown();
      rmSync(missing, { recursive: true, force: true });
    }
  });

  it("is removed when the session is deleted", async () => {
    const id = await start();
    const cwd = adapter.lastStart!.cwd;

    await manager.deleteSession(id, "user_admin");

    expect(existsSync(cwd)).toBe(false);
  });

  it("is removed when retention expires the session", async () => {
    const id = await start();
    const cwd = adapter.lastStart!.cwd;
    await manager.shutdown();

    const swept = await store.sweepRetention(30, new Date(Date.now() + 31 * DAY));

    expect(swept).toEqual([id]);
    expect(existsSync(cwd)).toBe(false);
  });

  it("survives abandonment, because an abandoned session resumes", async () => {
    // The direction the plan nearly got wrong. Abandonment stops the harness and keeps the
    // transcript so the next message resumes it; a workspace removed here would take the files a
    // resumed turn still refers to. Paired with the two exits above, or "never remove" would pass.
    const id = await start({ parked: true });
    const cwd = adapter.lastStart!.cwd;

    expect(await manager.sweepAbandoned(DAY, Date.now() + DAY + 1)).toEqual([id]);

    expect(existsSync(cwd)).toBe(true);
  });

  function build(sessionStore: SessionStore): SessionManager {
    return new SessionManager(
      sessionStore, adapter,
      new AuditReporter(null, null, "hosty.ai-gateway"), dataDir, new SettingsStore(dataDir));
  }

  /** A started session — parked on an approval when asked, which is the state abandonment sweeps. */
  async function start(options: { parked?: boolean } = {}): Promise<string> {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, options.parked ? "write a file" : "hello", "seed-credential");
    if (options.parked) {
      await vi.waitFor(async () => {
        expect((await store.readRecord(record.id))?.status).toBe("awaiting_approval");
      });
    }
    return record.id;
  }
});
