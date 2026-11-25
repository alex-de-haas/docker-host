import { sameProvider } from "./provider-ref.js";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAgentProvider } from "./index.js";
import * as writerScopes from "./writer-scope.js";
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
it.each([false, true])("preserves third-party capabilities and rejects unqualified workspace writers (managed scopes: %s)", async managed => {
  const probe = vi.spyOn(writerScopes, "probeWriterScope").mockResolvedValue(undefined);
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-provider-surface-")), port = await unusedPort();
  const provider = { appId: "independent.fixture.engine", installationId: "fixture-installation", key: "default" };
  const restore = captureEnv({ HOSTY_APP_ID: provider.appId, HOSTY_APP_INSTALLATION_ID: provider.installationId,
    HOSTY_APP_DATA_DIR: root, HOSTY_APP_CACHE_DIR: path.join(root, "cache"), HOSTY_CORE_ORIGIN: "http://core.invalid",
    HOSTY_APP_SERVICE_TOKEN: "synthetic-service", HOSTY_PORT_HTTP: String(port) });
  const signals = new Map((["SIGTERM", "SIGINT"] as const).map(signal => [signal, process.listeners(signal)]));
  const engine: ProviderEngine = {
    ...independentEngine,
    ...(managed ? { managedNativeScopes: true } : {}),
    capabilities: { ...independentEngine.capabilities, capabilities: ["session.resume", "scope.workspace-writers"] },
  };
  const app = await startAgentProvider({ engine, defaultPort: port });
  const native = vi.spyOn(app.controller.connections, "adapter"), origin = `http://127.0.0.1:${port}`;
  const sessionId = randomUUID(), runId = randomUUID();
  const authorize = vi.spyOn(app.controller.authority, "introspect").mockImplementation(async (_token, operation) => ({
    provider, userId: "fixture-user", principalId: "fixture-principal", callerAppId: "independent.consumer",
    callerInstallation: "consumer-installation", admissionRef: "fixture-admission", operation, sessionId, runId,
  }));
  try {
    expect((await fetch(origin + "/healthz")).status).toBe(200);
    expect(await (await fetch(origin + "/settings")).text()).toContain("Sign in through Hosty");
    const capabilities = await (await fetch(origin + "/api/agent/v2/capabilities", { headers: { authorization: "Bearer exact-operation" } })).json() as AgentCapabilities;
    expect(capabilities.version).toBe(2);
    expect(probe).toHaveBeenCalledTimes(managed ? 1 : 0);
    expect(capabilities.capabilities).toEqual(managed ? ["session.resume", "scope.restricted-native-tools"] : ["session.resume"]);
    if (!managed) expect(capabilities).toEqual(independentEngine.capabilities);
    vi.spyOn(app.controller.connections, "binding").mockResolvedValue({
      connectionId: "local", connectionRevision: 1, harnessKind: "independent-engine",
    });
    const sessionUrl = origin + "/api/agent/v2/sessions/" + sessionId;
    const headers = { authorization: "Bearer exact-operation", "content-type": "application/json" };
    const create = await fetch(sessionUrl, { method: "PUT", headers, body: JSON.stringify({
      configuration: { connection: { id: "local", revision: "1" } },
    }) });
    expect(create.status).toBe(201);
    const dispatch = vi.spyOn(app.controller.driver, "start").mockResolvedValue();
    const start = await fetch(sessionUrl + "/runs/" + runId, { method: "PUT", headers, body: JSON.stringify({
      expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Use the workspace" },
      resources: [{ kind: "worktree", id: randomUUID(), revision: "1" }],
    }) });
    expect(start.status).toBe(422);
    expect(await start.json()).toMatchObject({ error: { code: "unsupported_capability" } });
    expect(app.controller.store.occupiedSlots()).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    for (const [method, route] of [["GET", "/api/translation/v1/default/capabilities"], ["POST", "/api/translation/v1/default/translations"]]) {
      const response = await fetch(origin + route, { method, headers: { authorization: "Bearer retired-translation", "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ text: "Example", targetLanguage: "ru" }) } : {}) });
      expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
    expect(authorize).toHaveBeenCalledTimes(3); expect(native).not.toHaveBeenCalled();
  } finally {
    const closed = once(app.server, "close"); await app.close(); await closed;
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      for (const listener of process.listeners(signal)) if (!signals.get(signal)!.includes(listener)) process.removeListener(signal, listener);
    restore(); await rm(root, { recursive: true, force: true });
  }
});

it("distinguishes implementation owners and retains static ownership across serialization", () => {
  const entry = { appId: "other.engine", installationId: "installed", key: "default" };
  expect(sameProvider(entry, { ...entry, implementationId: null })).toBe(true);
  expect(sameProvider({ ...entry, implementationId: "one" }, entry)).toBe(false);
  expect(sameProvider({ ...entry, implementationId: "one" }, { ...entry, implementationId: "two" })).toBe(false);
  expect(sameProvider({ ...entry, implementationId: "one" }, { ...entry, implementationId: "one" })).toBe(true);
});
