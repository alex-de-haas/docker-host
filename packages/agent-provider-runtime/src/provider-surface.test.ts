import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAgentProvider } from "./index.js";
import { captureEnv } from "./internal/test-env.js";
import type { AgentCapabilities } from "@hosty-sdk/app/agent";
import type { AgentKind } from "./internal/connections/registry.js";

afterEach(() => vi.restoreAllMocks());
async function unusedPort(): Promise<number> {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); if (!address || typeof address === "string") throw new Error("No fixture port.");
  await new Promise<void>(resolve => reservation.close(() => resolve())); return address.port;
}
it.each(["codex", "claude", "ollama"] as const)("keeps %s settings and agent APIs while rejecting retired native translation routes", async (kind: AgentKind) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-provider-surface-")), port = await unusedPort();
  const provider = { appId: "independent.fixture." + kind, installationId: "fixture-installation", key: "default" };
  const restore = captureEnv({ HOSTY_APP_ID: provider.appId, HOSTY_APP_INSTALLATION_ID: provider.installationId,
    HOSTY_APP_DATA_DIR: root, HOSTY_APP_CACHE_DIR: path.join(root, "cache"), HOSTY_CORE_ORIGIN: "http://core.invalid",
    HOSTY_APP_SERVICE_TOKEN: "synthetic-service", HOSTY_PORT_HTTP: String(port) });
  const signals = new Map((["SIGTERM", "SIGINT"] as const).map(signal => [signal, process.listeners(signal)]));
  const app = await startAgentProvider({ kind, defaultPort: port });
  const native = vi.spyOn(app.controller.connections, "adapter"), origin = `http://127.0.0.1:${port}`;
  const authorize = vi.spyOn(app.controller.authority, "introspect").mockResolvedValue({ provider, userId: "fixture-user", principalId: "fixture-principal",
    callerAppId: "independent.consumer", callerInstallation: "consumer-installation", admissionRef: "metadata-only", operation: "capabilities" });
  try {
    expect((await fetch(origin + "/healthz")).status).toBe(200);
    expect(await (await fetch(origin + "/settings")).text()).toContain("Sign in through Hosty");
    const capabilities = await (await fetch(origin + "/api/agent/v1/capabilities", { headers: { authorization: "Bearer exact-operation" } })).json() as AgentCapabilities;
    expect(capabilities.version).toBe(1);
    expect(capabilities.capabilities).not.toContain("translation.codex"); expect(capabilities.capabilities).not.toContain("translation.claude");
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
it("declares all three applications as agent-only providers", async () => {
  for (const slug of ["codex-provider", "claude-code-provider", "ollama-provider"]) {
    const value = JSON.parse(await readFile(new URL(`../../../apps/${slug}/manifest.json`, import.meta.url), "utf8"));
    expect(value.provides).toEqual(["agent"]); expect(Object.keys(value.interfaces)).toEqual(["agent"]);
    expect(value.interfaces.agent[0].capabilities.some((capability: string) => capability.startsWith("translation."))).toBe(false);
  }
});
