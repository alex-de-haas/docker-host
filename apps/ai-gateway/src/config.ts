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
  /**
   * Root for per-session workspaces — `HOSTY_APP_CACHE_DIR`, injected by Core. Null outside Core,
   * in which case every session shares `workDir` and the manager says so once.
   */
  cacheDir: string | null;
  appId: string;
  coreOrigin: string | null;
  serviceToken: string | null;
  retentionDays: number;
  harness: HarnessKind;
  /** Codex API key (operator setting). Set = the gateway signs Codex in; empty = interactive login. */
  codexApiKey?: string;
  /** Explicit Codex credential directory for the interactive mode. */
  codexHome?: string;
}

/** `fake` is the in-process test harness; it is deliberately not offered as an operator choice. */
export type HarnessKind = "claude" | "codex" | "fake";

export function resolveHarnessKind(value: string | undefined): HarnessKind {
  switch (value?.trim().toLowerCase()) {
    case "codex":
      return "codex";
    case "fake":
      return "fake";
    default:
      // Unknown values fall back to the shipped default rather than failing startup: the setting
      // is operator-entered free text, and a typo must not take the assistant down.
      return "claude";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const retention = Number.parseInt(env.HOSTY_AI_GATEWAY_RETENTION_DAYS ?? "30", 10);
  return {
    port: Number.parseInt(env.HOSTY_PORT_HTTP ?? env.PORT ?? "3400", 10),
    dataDir: env.HOSTY_APP_DATA_DIR ?? path.join(os.tmpdir(), "hosty-ai-gateway-data"),
    // A fallback cwd for a gateway started outside Core, where no cache directory is injected. It used
    // to default to the home directory, which is the last place to run an agent that reads files.
    workDir: env.HOSTY_AI_GATEWAY_WORKDIR ?? path.join(os.tmpdir(), "hosty-ai-gateway-work"),
    cacheDir: env.HOSTY_APP_CACHE_DIR?.trim() || null,
    appId: env.HOSTY_APP_ID ?? "hosty.ai-gateway",
    coreOrigin: env.HOSTY_CORE_ORIGIN?.trim() || null,
    serviceToken: env.HOSTY_APP_SERVICE_TOKEN?.trim() || null,
    retentionDays: Number.isFinite(retention) && retention > 0 ? retention : 30,
    harness: resolveHarnessKind(env.HOSTY_AI_GATEWAY_HARNESS),
    codexApiKey: env.CODEX_API_KEY?.trim() || undefined,
    codexHome: env.CODEX_HOME?.trim() || undefined,
  };
}
