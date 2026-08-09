import os from "node:os";
import path from "node:path";

// Startup snapshot of the environment Core injects (ports, data dir, identity) plus the gateway's
// own settings. Manifest settings arrive as plain env vars, so everything is read once here.
export interface GatewayConfig {
  port: number;
  dataDir: string;
  /** Directory operator harness sessions start in. Host-wide work is the point of the operator
   * profile, so this defaults to the operator's home rather than the app checkout. */
  workDir: string;
  appId: string;
  coreOrigin: string | null;
  serviceToken: string | null;
  retentionDays: number;
  harness: "claude" | "fake";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const retention = Number.parseInt(env.HOSTY_AI_GATEWAY_RETENTION_DAYS ?? "30", 10);
  return {
    port: Number.parseInt(env.HOSTY_PORT_HTTP ?? env.PORT ?? "3400", 10),
    dataDir: env.HOSTY_APP_DATA_DIR ?? path.join(os.tmpdir(), "hosty-ai-gateway-data"),
    workDir: env.HOSTY_AI_GATEWAY_WORKDIR ?? os.homedir(),
    appId: env.HOSTY_APP_ID ?? "hosty.ai-gateway",
    coreOrigin: env.HOSTY_CORE_ORIGIN?.trim() || null,
    serviceToken: env.HOSTY_APP_SERVICE_TOKEN?.trim() || null,
    retentionDays: Number.isFinite(retention) && retention > 0 ? retention : 30,
    harness: env.HOSTY_AI_GATEWAY_HARNESS === "fake" ? "fake" : "claude",
  };
}
