import { ToolActivityReporter } from "@hosty-sdk/app/tool-activity/server";
import { startHarnessToolActivity, ToolActivityOwners } from "./tool-activity.js";
import path from "node:path";
import { WorkerClient } from "./worker/client.js";
import { RemoteConnections } from "./worker/connections.js";
import { ensureServiceIdentity } from "./worker/auth.js";
import { workerCallbacks } from "./worker/callback.js";
import { DevelopmentClient } from "./sessions/development.js";
import { CoreConnectionSecrets } from "./connections/secrets.js";
import { WaitingNotifier } from "./notifications.js";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { AuditReporter } from "./audit.js";
import { SessionStore } from "./sessions/store.js";
import { SessionManager } from "./sessions/manager.js";
import { createGatewayServer } from "./server.js";
import { SettingsStore } from "./settings/store.js";
import { TokenExchange } from "./mcp/exchange.js";
import { McpProxy } from "./mcp/proxy.js";
import { McpFacade } from "./facade/facade.js";
import { ProviderDirectory } from "./settings/providers.js";
import { FakeHarnessAdapter } from "./harness/fake.js";
import type { HarnessAdapter } from "./harness/adapter.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });

const serviceIdentity = await ensureServiceIdentity(path.join(config.dataDir, "service-auth"));
const workerUrl = process.env.HOSTY_SERVICE_WORKER_URL;
if (config.harness !== "fake" && !workerUrl) throw new Error("Harness requires its declared worker service URL.");
const worker = workerUrl ? new WorkerClient(workerUrl, serviceIdentity) : null;
const connections = worker ? new RemoteConnections(worker) : null;
const adapter: HarnessAdapter = config.harness === "fake" ? new FakeHarnessAdapter() : {
  name: "worker", capabilities: { questions: false, appMcp: true, liveReconfigure: true, autoAllow: true, denyReason: false },
  probe: async () => connections!.summary(),
  start: () => { throw new Error("Choose a provider connection before starting a chat."); },
};
const secrets = new CoreConnectionSecrets(config.coreOrigin, config.appId, config.serviceToken);
const store = new SessionStore(config.dataDir, config.cacheDir);
const audit = new AuditReporter(config.coreOrigin, config.serviceToken, config.appId);
const notifier = new WaitingNotifier(config.coreOrigin, config.serviceToken, config.appId);
const settings = new SettingsStore(config.dataDir, config.retentionDays);
// Capture legacy launch preferences once; subsequent reads use the app-owned file.
await settings.update({});
// Core's MCP endpoint, resolved once for both consumers: the facade lists it beside the apps for
// external clients, and the provider directory offers it to the assistant's own sessions.
const coreMcpUrl = config.coreOrigin ? `${config.coreOrigin.replace(/\/$/, "")}/api/mcp` : null;
const providers = new ProviderDirectory(config.coreOrigin, config.serviceToken, config.appId, coreMcpUrl, config.executionMode === "docker");
const exchange = new TokenExchange(config.coreOrigin, config.appId, config.serviceToken);
// The proxy and the manager need each other: the proxy mints through the manager's live session
// credential, and the manager registers routes on the proxy. Declared first with a late-bound
// minter, which is the smaller of the two knots.
// Both annotated: without them the two inferred types reference each other and TypeScript gives up.
const proxy: McpProxy = new McpProxy((sessionId, appId) => manager.mintAppToken(sessionId, appId), undefined, appId => providers.resolveOffered(appId));
// Literal IPv4 on purpose: the harness is a child process on this host, and a `localhost` that
// resolves to ::1 first has cost this project a hang before (docs/features/observability).
proxy.allowRemoteWorker = Boolean(worker);
const proxyBaseUrl = config.executionMode === "docker" ? "http://api:3400" : `http://127.0.0.1:${config.port}`;
const manager: SessionManager = new SessionManager(
  store,
  adapter,
  audit,
  config.workDir,
  settings,
  providers,
  exchange,
  proxy,
  proxyBaseUrl,
  notifier,
  connections,
  new DevelopmentClient(config.coreOrigin, config.appId, config.serviceToken),
  worker,
  config.executionMode,
);

// Older Core launches have no installation identity; activity becomes available after an app restart.
const toolActivityOwners = new ToolActivityOwners(config.dataDir);
const stopToolActivity = config.coreOrigin && config.serviceToken && process.env.HOSTY_APP_INSTALLATION_ID
  ? startHarnessToolActivity(manager, new ToolActivityReporter({ coreOrigin: config.coreOrigin,
    serviceToken: config.serviceToken, appId: config.appId,
    onReported: (userId, panelId, value) => toolActivityOwners.acknowledge(userId, panelId, value) }), toolActivityOwners)
  : async () => {};

// Retention: once at boot, then daily. The manager reconciles Core resources and completion
// before removal; running it in-process avoids a separate scheduler.
const sweep = (): void => {
  void manager
    .sweepRetention()
    .then((deleted) => {
      if (deleted.length > 0) {
        console.log(`[retention] deleted ${deleted.length} session(s) under the configured policy`);
      }
    })
    .catch((error) => console.warn("[retention] sweep failed", error));
};
sweep();
const sweepTimer = setInterval(sweep, 24 * 60 * 60 * 1000);

/**
 * A session waiting for a person past this holds a harness process, a proxy route and its share of
 * the delegation chain for nothing. Checked hourly rather than daily: a day-long grid would mean a
 * session abandoned just after a tick keeps all of that for nearly two days.
 */
const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;
const abandonSweep = (): void => {
  void manager
    .sweepAbandoned(ABANDON_AFTER_MS)
    .then((abandoned) => {
      if (abandoned.length > 0) {
        console.log(`[sessions] stopped ${abandoned.length} session(s) waiting over 24h; transcripts kept`);
      }
    })
    .catch((error) => console.warn("[sessions] abandon sweep failed", error));
};
const abandonTimer = setInterval(abandonSweep, 60 * 60 * 1000);

// One MCP endpoint that is the whole host, for an external agent client with no CLI or SSH on the
// path (docs/features/mcp-facade/). Core's own MCP endpoint joins the catalog beside the apps, which
// is why the origin is resolved here rather than guessed inside the facade.
const facade = new McpFacade(
  {
    coreOrigin: config.coreOrigin,
    serviceToken: config.serviceToken,
    appId: config.appId,
    coreMcpUrl,
  },
  providers,
  settings,
);

const server = createGatewayServer(manager, adapter, settings, providers, proxy, facade, connections, workerCallbacks(serviceIdentity, secrets));
let connecting = false;
const connect = async () => {
  if (!worker || connecting) return;
  connecting = true;
  try { await worker.request("/v1/coordinator", "PUT", { callbackUrl: proxyBaseUrl }, true); }
  catch { console.warn("[worker] Service handshake pending."); }
  finally { connecting = false; }
};
const workerMonitor = setInterval(() => { void connect(); }, 10000);
workerMonitor.unref();
server.listen(config.port, () => {
  void connect();
  console.log(
    `hosty.harness listening on :${config.port} (harness=${adapter.name}, data=${config.dataDir})`,
  );
});

const shutdown = (): void => {
  clearInterval(workerMonitor);
  clearInterval(sweepTimer);
  clearInterval(abandonTimer);
  server.close();
  void stopToolActivity().then(() => manager.shutdown()).then(() => connections?.shutdown()).finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
