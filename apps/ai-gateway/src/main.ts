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
import { ProviderDirectory } from "./settings/providers.js";
import { ClaudeHarnessAdapter } from "./harness/claude.js";
import { CodexHarnessAdapter } from "./harness/codex.js";
import { FakeHarnessAdapter } from "./harness/fake.js";
import type { HarnessAdapter } from "./harness/adapter.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });

const adapter: HarnessAdapter =
  config.harness === "fake"
    ? new FakeHarnessAdapter()
    : config.harness === "codex"
      ? new CodexHarnessAdapter({
          apiKey: config.codexApiKey,
          codexHome: config.codexHome,
          dataDir: config.dataDir,
        })
      : new ClaudeHarnessAdapter();
const store = new SessionStore(config.dataDir);
const audit = new AuditReporter(config.coreOrigin, config.serviceToken, config.appId);
const notifier = new WaitingNotifier(config.coreOrigin, config.serviceToken, config.appId);
const settings = new SettingsStore(config.dataDir);
const providers = new ProviderDirectory(config.coreOrigin, config.serviceToken, config.appId);
const exchange = new TokenExchange(config.coreOrigin, config.appId);
// The proxy and the manager need each other: the proxy mints through the manager's live session
// credential, and the manager registers routes on the proxy. Declared first with a late-bound
// minter, which is the smaller of the two knots.
// Both annotated: without them the two inferred types reference each other and TypeScript gives up.
const proxy: McpProxy = new McpProxy((sessionId, appId) => manager.mintAppToken(sessionId, appId));
// Literal IPv4 on purpose: the harness is a child process on this host, and a `localhost` that
// resolves to ::1 first has cost this project a hang before (docs/features/observability).
const proxyBaseUrl = `http://127.0.0.1:${config.port}`;
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
);

// Retention: once at boot, then daily. The sweep is cheap (a directory listing), and running it
// in-process keeps retention working without any external scheduler.
const sweep = (): void => {
  void store
    .sweepRetention(config.retentionDays)
    .then((deleted) => {
      if (deleted.length > 0) {
        console.log(`[retention] deleted ${deleted.length} session(s) older than ${config.retentionDays}d`);
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

const server = createGatewayServer(manager, adapter, settings, providers, proxy);
server.listen(config.port, () => {
  console.log(
    `hosty.ai-gateway listening on :${config.port} (harness=${adapter.name}, data=${config.dataDir})`,
  );
});

const shutdown = (): void => {
  clearInterval(sweepTimer);
  clearInterval(abandonTimer);
  server.close();
  void manager.shutdown().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
