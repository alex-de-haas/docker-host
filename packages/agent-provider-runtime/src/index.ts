import { setTimeout as delay } from "node:timers/promises";
import { acquireAttemptScope, AttemptSupervisors, needsSupervisor } from "./attempt-supervisor.js";
import { createServer } from "node:http";
import { verifyLegacyQuiescence } from "./provider-cutover.js";
import { DatabaseSync } from "node:sqlite";
import { probeWriterScope, writerCapability, type WriterScope } from "./writer-scope.js";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { ProviderEngine, EngineConnections } from "./engine.js";
export type { ProviderEngine, NativeInputContext, NativeInputPreparer } from "./engine.js";
export { prepareNativeInput } from "./engine.js";
import { CoreConnectionSecrets } from "./internal/connections/secrets.js";
import { ProviderStore } from "./store.js";
import { AttachmentStore } from "./attachments.js";
import { CoreAuthority } from "./core.js";
import { ProviderController } from "./controller.js";
import { NativeExecution } from "./native-driver.js";
import { agentRoutes, json } from "./server.js";

export async function startAgentProvider<C extends EngineConnections>(options: { engine: ProviderEngine<C>; defaultPort: number }) {
  const env = process.env, appId = env.HOSTY_APP_ID, installationId = env.HOSTY_APP_INSTALLATION_ID;
  const data = env.HOSTY_APP_DATA_DIR, origin = env.HOSTY_CORE_ORIGIN, serviceToken = env.HOSTY_APP_SERVICE_TOKEN;
  if (!appId || !installationId || !data || !origin || !serviceToken) throw new Error("Start this provider through Hosty Core with its own app identity and data directory.");
  const attemptId = process.argv[2] === "--hosty-attempt" ? process.argv[3] : undefined;
  const generation = attemptId && env.HOSTY_PROVIDER_GENERATION;
  const generationLease = generation ? new DatabaseSync(path.join(generation, ".generation-use.sqlite"), { readOnly: true }) : undefined;
  generationLease?.exec("BEGIN; SELECT id FROM generation WHERE id = 1");
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (!attemptId) await verifyLegacyQuiescence(data);
  const port = Number(env.HOSTY_PORT_HTTP ?? env.PORT ?? options.defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid provider HTTP port.");
  const provider = { appId, installationId, key: "default" }, authority = new CoreAuthority(origin, appId, serviceToken);
  const connections = options.engine.createConnections({ data, cache: env.HOSTY_APP_CACHE_DIR ?? null, secrets: new CoreConnectionSecrets(origin, appId, serviceToken) });
  const store = new ProviderStore(path.join(data, "agent-sessions"), provider); await store.initialize();
  const attachments = new AttachmentStore(path.join(data, "attachments"), provider);
  const driver = new AttemptSupervisors(store, data);
  const scope = attemptId ? acquireAttemptScope(driver.directory, attemptId) : undefined;
  if (attemptId && !scope) process.exit(0);
  const run = attemptId ? (await store.run(attemptId)).record : undefined;
  let writerScope: WriterScope | undefined;
  if (options.engine.managedNativeScopes) {
    if (attemptId && process.platform === "win32") {
      // The HTTP service probes once. Every actual native launch still creates its own OS job
      // and must obtain its own closure receipt. The probe never proves an attempt has stopped.
      if (process.argv[4] === "--windows-job") writerScope = { kind: "windows-job" };
    } else writerScope = await probeWriterScope(data);
  }
  const capabilities = structuredClone(options.engine.capabilities);
  capabilities.capabilities = capabilities.capabilities.filter(capability => capability !== writerCapability);
  if (writerScope) capabilities.capabilities.push(writerCapability);
  if (options.engine.managedNativeScopes && !writerScope) {
    capabilities.capabilities = capabilities.capabilities.filter(capability => capability !== "subagents.native");
    capabilities.capabilities.push("scope.restricted-native-tools");
    delete capabilities.subagents;
  }
  const controller = new ProviderController(store, authority, connections, capabilities, Number(env.AGENT_MAX_CONCURRENCY ?? 4));
  if (scope && attemptId && run) {
    const id = attemptId;
    let localPort = 0;
    const native = new NativeExecution(controller, store, authority, connections, attachments, data,
      () => `http://127.0.0.1:${localPort}`, options.engine.prepareInput, options.engine.gitSkillWorkflowTimeoutMs, id, writerScope);
    controller.driver = native;
    const listener = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://provider.invalid");
      void native.mcp.proxy.handle(request, response, url.pathname).then(handled => {
        if (!handled) json(response, 404, { error: "not_found" });
      }).catch(() => { if (!response.headersSent) json(response, 503, { error: "proxy_unavailable" }); else response.end(); });
    });
    // When a native SDK hangs during stop, ending this process also tears down its in-process
    // adapters and the private parent channels of all registered native runners. The successor
    // must still verify physical closure before it releases the run slot.
    let closingSince = 0;
    const stopDeadline = setInterval(() => {
      void store.run(id).then(({ record }) => {
        if (!record.decisionsFenced || record.snapshot.stopConfirmed) { closingSince = 0; return; }
        closingSince ||= Date.now();
        if (Date.now() - closingSince >= 20_000) process.exit(72);
      }).catch(() => {});
    }, 1000);
    stopDeadline.unref();
    try {
      if (needsSupervisor(run)) {
        await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("Missing attempt transport.");
        localPort = address.port;
        await native.initialize();
        while (needsSupervisor((await store.run(id)).record)) {
          await controller.resumeCommands(id).catch(() => {});
          await delay(350);
        }
      }
    } finally {
      clearInterval(stopDeadline);
      await controller.close();
      listener.close(); listener.closeAllConnections();
      store.history.close();
      scope.close(); generationLease?.close();
    }
    process.exit(0);
  }
  controller.driver = driver;
  await driver.initialize(writerScope?.kind === "windows-job");
  const api = agentRoutes(controller, attachments);
  const interfaces = options.engine.openInterfaces?.(connections, data);
  // Settings are an app-owned Hosty-authenticated surface; importing it does not start a native agent.
  const { createProviderSettings } = await import("./settings.js");
  const settings = createProviderSettings({ definition: options.engine.settings, connections, isConnectionInUse: async id => (await store.records()).some(session => session.session.activeRun && session.session.configuration?.connection.id === id) });
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? "/", "http://provider.invalid");
    if (url.pathname === "/healthz") { json(response, 200, { status: "ready" }); return; }
    if (await settings(request, response, url.pathname) || await interfaces?.route(request, response, url) || await api(request, response, url)) return;
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
  const close = async () => { if (stopping) return; stopping = true; interfaces?.close(); await controller.close(); await connections.shutdown(); server.close(); server.closeAllConnections(); };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void close().catch(() => { process.exitCode = 1; }); });
  return { server, controller, close };
}
