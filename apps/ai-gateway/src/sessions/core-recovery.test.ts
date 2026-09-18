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
    const exchange = new TokenExchange("http://core.test", "hosty.ai-gateway");
    const refresh = vi.spyOn(exchange, "refreshSelf")
      .mockRejectedValueOnce(new CoreTemporarilyUnavailable())
      .mockResolvedValue({ token: "renewed", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const mint = vi.spyOn(exchange, "exchange").mockResolvedValue({ token: "app-token", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new SessionManager(new SessionStore(directory), adapter, new AuditReporter(null, null, "hosty.ai-gateway"), directory, null, null, exchange);
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
      expect(mint).toHaveBeenLastCalledWith("renewed", "hosty:core");
    } finally { await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); }
  });
});
