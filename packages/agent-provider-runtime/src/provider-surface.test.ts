import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAgentProvider } from "./index.js";
import { captureEnv } from "./internal/test-env.js";
import type { AgentCapabilities } from "@hosty-sdk/app/agent";
import { AgentConnections } from "./internal/connections/registry.js";
import type { ConnectionSecrets } from "./internal/connections/secrets.js";
import type { ProviderEngine } from "./engine.js";
import { FakeHarnessAdapter } from "./internal/harness/fake.js";
import { fixtureCapabilities } from "./test-support/provider.js";

class UnrelatedConnections extends AgentConnections {
  constructor(data: string, cache: string | null, secrets: ConnectionSecrets) {
    super(data, cache, secrets, { kind: "independent-engine", name: "Independent engine", authMethods: { none: { credential: "none" } }, capabilities: new FakeHarnessAdapter().capabilities });
  }
  protected async createAdapter() { return new FakeHarnessAdapter(); }
}
const independentEngine: ProviderEngine = {
  capabilities: { ...fixtureCapabilities, capabilities: ["session.resume"] },
  settings: { kind: "independent-engine", name: "Independent engine", authentication: [{ id: "none", label: "Local" }] },
  createConnections: ({ data, cache, secrets }) => new UnrelatedConnections(data, cache, secrets),
};

afterEach(() => vi.restoreAllMocks());
async function unusedPort(): Promise<number> {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); if (!address || typeof address === "string") throw new Error("No fixture port.");
  await new Promise<void>(resolve => reservation.close(() => resolve())); return address.port;
}
it("starts an unrelated injected engine with its declared settings and capability contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-provider-surface-")), port = await unusedPort();
  const provider = { appId: "independent.fixture.engine", installationId: "fixture-installation", key: "default" };
  const restore = captureEnv({ HOSTY_APP_ID: provider.appId, HOSTY_APP_INSTALLATION_ID: provider.installationId,
    HOSTY_APP_DATA_DIR: root, HOSTY_APP_CACHE_DIR: path.join(root, "cache"), HOSTY_CORE_ORIGIN: "http://core.invalid",
    HOSTY_APP_SERVICE_TOKEN: "synthetic-service", HOSTY_PORT_HTTP: String(port) });
  const signals = new Map((["SIGTERM", "SIGINT"] as const).map(signal => [signal, process.listeners(signal)]));
  const app = await startAgentProvider({ engine: independentEngine, defaultPort: port });
  const native = vi.spyOn(app.controller.connections, "adapter"), origin = `http://127.0.0.1:${port}`;
  const authorize = vi.spyOn(app.controller.authority, "introspect").mockResolvedValue({ provider, userId: "fixture-user", principalId: "fixture-principal",
    callerAppId: "independent.consumer", callerInstallation: "consumer-installation", admissionRef: "metadata-only", operation: "capabilities" });
  try {
    expect((await fetch(origin + "/healthz")).status).toBe(200);
    expect(await (await fetch(origin + "/settings")).text()).toContain("Sign in through Hosty");
    const capabilities = await (await fetch(origin + "/api/agent/v1/capabilities", { headers: { authorization: "Bearer exact-operation" } })).json() as AgentCapabilities;
    expect(capabilities.version).toBe(1);
    expect(capabilities).toEqual(independentEngine.capabilities);
    for (const [method, route] of [["GET", "/api/translation/v1/default/capabilities"], ["POST", "/api/translation/v1/default/translations"]]) {
      const response = await fetch(origin + route, { method, headers: { authorization: "Bearer retired-translation", "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ text: "Example", targetLanguage: "ru" }) } : {}) });
      expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
    expect(authorize).toHaveBeenCalledTimes(1); expect(native).not.toHaveBeenCalled();
  } finally {
    const closed = once(app.server, "close"); await app.close(); await closed;
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      for (const listener of process.listeners(signal)) if (!signals.get(signal)!.includes(listener)) process.removeListener(signal, listener);
    restore(); await rm(root, { recursive: true, force: true });
  }
});
