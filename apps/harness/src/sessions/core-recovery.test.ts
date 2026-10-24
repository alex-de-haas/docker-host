import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";
import { CoreTemporarilyUnavailable, TokenExchange } from "../mcp/exchange.js";

describe("active harness during Core reconnect", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("retries a failed refresh without stopping or replacing the active harness or requiring another message", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hosty-core-recovery-"));
    const adapter = new FakeHarnessAdapter();
    const start = vi.spyOn(adapter, "start");
    const exchange = new TokenExchange("http://core.test", "hosty.harness");
    const refresh = vi.spyOn(exchange, "refreshSelf")
      .mockRejectedValueOnce(new CoreTemporarilyUnavailable())
      .mockResolvedValue({ token: "renewed", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const mint = vi.spyOn(exchange, "exchange").mockResolvedValue({ token: "app-token", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new SessionManager(new SessionStore(directory), adapter, new AuditReporter(null, null, "hosty.harness"), directory, null, null, exchange);
    try {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const record = await manager.createSession({ createdBy: "admin" });
      await manager.postMessage(record.id, "ask about the active task", "original");
      const run = start.mock.results[0]!.value;
      const stop = vi.spyOn(run, "stop");
      const reconfigure = vi.spyOn(run, "setMcpServers");
      await vi.advanceTimersByTimeAsync(180_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(reconfigure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(reconfigure).not.toHaveBeenCalled();
      expect(await manager.mintAppToken(record.id, "hosty:core")).toMatchObject({ token: "app-token" });
      expect(mint).toHaveBeenLastCalledWith("renewed", "hosty:core", record.id);
      mint.mockResolvedValueOnce(null);
      expect(await manager.mintAppToken(record.id, "hosty:core")).toBeNull();
      expect(stop).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      await expect(manager.refreshSessionCredentials(record.id, "another-user", "hostyg_fresh")).rejects.toThrow("another user");
      await manager.refreshSessionCredentials(record.id, "admin", "hostyg_fresh");
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    } finally { await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("restores every live conversation for the actor without starting a new turn or changing another actor", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hosty-actor-recovery-"));
    const adapter = new FakeHarnessAdapter();
    const start = vi.spyOn(adapter, "start");
    const manager = new SessionManager(new SessionStore(directory), adapter, new AuditReporter(null, null, "hosty.harness"), directory);
    try {
      const first = await manager.createSession({ createdBy: "admin" });
      const second = await manager.createSession({ createdBy: "admin" });
      await manager.createSession({ createdBy: "other" });
      const update = vi.spyOn(manager, "refreshSessionCredentials");
      await manager.refreshActorCredentials("admin", "hostyg_new");
      expect(update.mock.calls.map(c => c[0]).sort()).toEqual([first.id, second.id].sort());
      await manager.refreshActorCredentials("admin", "hostyg_new");
      expect(update).toHaveBeenCalledTimes(2); expect(start).not.toHaveBeenCalled();
    } finally { await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("coalesces pending actor refreshes to the latest credential without blocking another actor", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hosty-actor-coalescing-"));
    const manager = new SessionManager(new SessionStore(directory), new FakeHarnessAdapter(), new AuditReporter(null, null, "hosty.harness"), directory);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.spyOn(manager, "refreshActorCredentials").mockReturnValueOnce(blocked).mockResolvedValue(undefined);
    try {
      manager.scheduleActorCredentialRefresh("admin", "hostyg_first");
      manager.scheduleActorCredentialRefresh("admin", "hostyg_first");
      manager.scheduleActorCredentialRefresh("admin", "hostyg_middle");
      manager.scheduleActorCredentialRefresh("admin", "hostyg_latest");
      manager.scheduleActorCredentialRefresh("other", "hostyg_other");
      expect(refresh.mock.calls).toEqual([["admin", "hostyg_first"], ["other", "hostyg_other"]]);
      release();
      await vi.waitFor(() => expect(refresh.mock.calls).toEqual([["admin", "hostyg_first"], ["other", "hostyg_other"], ["admin", "hostyg_latest"]]));
    } finally { release(); await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports a failed background refresh without credentials and retries the same actor credential", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hosty-actor-retry-"));
    const store = new SessionStore(directory);
    const adapter = new FakeHarnessAdapter();
    const start = vi.spyOn(adapter, "start");
    const manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), directory);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const session = await manager.createSession({ createdBy: "admin" });
      await manager.postMessage(session.id, "Keep this conversation running", "hostyg_previous");
      const run = start.mock.results[0]!.value;
      const stop = vi.spyOn(run, "stop");
      const refresh = vi.spyOn(manager as unknown as { refreshMcpServers: () => Promise<boolean> }, "refreshMcpServers")
        .mockRejectedValueOnce(new Error("Provider failed with hostyg_private_credential"))
        .mockResolvedValue(true);
      manager.scheduleActorCredentialRefresh("admin", "hostyg_fresh");
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[sessions] Background credential refresh failed; the next identity check will retry."));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("hostyg_private_credential");
      manager.scheduleActorCredentialRefresh("admin", "hostyg_fresh");
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
      expect(start).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
      expect(JSON.stringify(await store.readEvents(session.id))).not.toContain("hostyg_fresh");
    } finally { await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not continue queued actor credential refreshes after shutdown", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hosty-actor-shutdown-"));
    const manager = new SessionManager(new SessionStore(directory), new FakeHarnessAdapter(), new AuditReporter(null, null, "hosty.harness"), directory);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.spyOn(manager, "refreshActorCredentials").mockReturnValue(blocked);
    try {
      manager.scheduleActorCredentialRefresh("admin", "hostyg_first");
      manager.scheduleActorCredentialRefresh("admin", "hostyg_queued");
      await manager.shutdown();
      manager.scheduleActorCredentialRefresh("admin", "hostyg_late");
      release(); await new Promise(resolve => setTimeout(resolve, 0));
      expect(refresh.mock.calls).toEqual([["admin", "hostyg_first"]]);
    } finally { release(); await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); }
  });


});
