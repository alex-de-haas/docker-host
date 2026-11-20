import { createServer } from "node:http";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { ProviderEngine } from "./engine.js";
export type { ProviderEngine, NativeInputContext, NativeInputPreparer } from "./engine.js";
export { prepareNativeInput } from "./engine.js";
import { CoreConnectionSecrets } from "./internal/connections/secrets.js";
import { ProviderStore } from "./store.js";
import { AttachmentStore } from "./attachments.js";
import { CoreAuthority } from "./core.js";
import { ProviderController } from "./controller.js";
import { NativeExecution } from "./native-driver.js";
import { agentRoutes, json } from "./server.js";

export async function startAgentProvider(options: { engine: ProviderEngine; defaultPort: number }) {
  const env = process.env, appId = env.HOSTY_APP_ID, installationId = env.HOSTY_APP_INSTALLATION_ID;
  const data = env.HOSTY_APP_DATA_DIR, origin = env.HOSTY_CORE_ORIGIN, serviceToken = env.HOSTY_APP_SERVICE_TOKEN;
  if (!appId || !installationId || !data || !origin || !serviceToken) throw new Error("Start this provider through Hosty Core with its own app identity and data directory.");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const port = Number(env.HOSTY_PORT_HTTP ?? env.PORT ?? options.defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid provider HTTP port.");
  const provider = { appId, installationId, key: "default" }, authority = new CoreAuthority(origin, appId, serviceToken);
  const connections = options.engine.createConnections({ data, cache: env.HOSTY_APP_CACHE_DIR ?? null, secrets: new CoreConnectionSecrets(origin, appId, serviceToken) });
  const store = new ProviderStore(path.join(data, "agent-sessions"), provider); await store.initialize();
  const attachments = new AttachmentStore(path.join(data, "attachments"), provider);
  const controller = new ProviderController(store, authority, connections, options.engine.capabilities, Number(env.AGENT_MAX_CONCURRENCY ?? 4));
  const driver = new NativeExecution(controller, store, authority, connections, attachments, data, () => `http://127.0.0.1:${port}`, options.engine.prepareInput); controller.driver = driver;
  await driver.initialize();
  const api = agentRoutes(controller, attachments);
  // Settings are an app-owned Hosty-authenticated surface; importing it does not start a native agent.
  const { createProviderSettings } = await import("./settings.js");
  const settings = createProviderSettings({ definition: options.engine.settings, connections, isConnectionInUse: async id => (await store.records()).some(session => session.session.activeRun && session.session.configuration?.connection.id === id) });
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? "/", "http://provider.invalid");
    if (url.pathname === "/healthz") { json(response, 200, { status: "ready" }); return; }
    if (await driver.mcp.proxy.handle(request, response, url.pathname) || await settings(request, response, url.pathname) || await api(request, response, url)) return;
    json(response, 404, { error: { code: "not_found", message: "Unknown provider route.", retryable: false } });
  })().catch(error => {
    if (response.headersSent) { response.end(); return; }
    const known = error instanceof AgentApiError || error && typeof error.status === "number" && typeof error.code === "string";
    json(response, known ? error.status : 500, { error: { code: known ? error.code : "provider_unavailable", message: known ? error.message : "The provider could not complete the operation.", retryable: known ? error.retryable ?? error.status >= 500 : true } });
  }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", () => { server.off("error", reject); resolve(); }); });
  server.once("close", () => store.history.close());
  console.log(`[agent-provider] ${appId} ready on port ${port}.`);
  let stopping = false;
  const close = async () => { if (stopping) return; stopping = true; await controller.close(); server.close(); server.closeAllConnections(); };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void close().catch(() => { process.exitCode = 1; }); });
  return { server, controller, close };
}
