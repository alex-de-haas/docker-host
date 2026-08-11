import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { AuditReporter } from "./audit.js";
import { SessionStore } from "./sessions/store.js";
import { SessionManager } from "./sessions/manager.js";
import { createGatewayServer } from "./server.js";
import { SettingsStore } from "./settings/store.js";
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
const settings = new SettingsStore(config.dataDir);
const manager = new SessionManager(store, adapter, audit, config.workDir, settings);

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

const server = createGatewayServer(manager, adapter, settings);
server.listen(config.port, () => {
  console.log(
    `hosty.ai-gateway listening on :${config.port} (harness=${adapter.name}, data=${config.dataDir})`,
  );
});

const shutdown = (): void => {
  clearInterval(sweepTimer);
  server.close();
  void manager.shutdown().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
