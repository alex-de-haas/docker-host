// Discovery of MCP providers, read from Core.
//
// Core is the registry: it validates manifests, normalizes the declared `interfaces` at
// install/update, and resolves each declaration to a ready-to-call URL from the app's endpoints.
// The gateway asks and owns only the policy (which of them are enabled). Nothing is pushed the
// other way, and the toggles never live in Core.
//
// The service token is the gateway's own app→Core credential, the same one the audit reporter uses.

export const MCP_INTERFACE = "mcp";

export interface McpProvider {
  appId: string;
  displayName: string;
  /** Resolved from the caller's vantage point by Core; null when the app exposes no usable URL. */
  url: string | null;
  running: boolean;
}

interface AppDirectoryEntry {
  id?: unknown;
  displayName?: unknown;
  runtimeState?: unknown;
  interfaces?: unknown;
}

export class ProviderDirectory {
  constructor(
    private readonly coreOrigin: string | null,
    private readonly serviceToken: string | null,
    private readonly appId: string,
  ) {}

  /**
   * Every installed app declaring an `mcp` interface, plus the full installed roster so stale
   * toggles can be pruned against it.
   *
   * Returns nulls rather than throwing when Core is unreachable: the settings page must still open
   * and show the system prompt. A discovery failure is reported as such — an empty list would read
   * as "no app declares MCP", which is a different and misleading statement.
   */
  async read(): Promise<{ providers: McpProvider[]; installedAppIds: string[] } | null> {
    if (!this.coreOrigin || !this.serviceToken) {
      return null;
    }

    let entries: AppDirectoryEntry[];
    try {
      const response = await fetch(
        `${this.coreOrigin}/api/internal/apps/${encodeURIComponent(this.appId)}/app-directory`,
        {
          headers: { authorization: `Bearer ${this.serviceToken}` },
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { apps?: unknown };
      // A 200 whose body is not the expected shape is a failed read, not an empty fleet. Treating it
      // as empty would flow into prune([]) below and permanently delete every provider toggle the
      // operator had set — data loss caused by a version skew or a mangling intermediary.
      if (!Array.isArray(body.apps)) {
        return null;
      }
      entries = body.apps as AppDirectoryEntry[];
    } catch {
      return null;
    }

    const providers: McpProvider[] = [];
    const installedAppIds: string[] = [];
    for (const entry of entries) {
      if (typeof entry?.id !== "string") {
        continue;
      }
      installedAppIds.push(entry.id);

      const declarations = Array.isArray(entry.interfaces) ? entry.interfaces : [];
      const mcp = (declarations as Array<Record<string, unknown>>).find(
        (declaration) => declaration?.name === MCP_INTERFACE,
      );
      if (!mcp) {
        continue;
      }

      providers.push({
        appId: entry.id,
        displayName: typeof entry.displayName === "string" ? entry.displayName : entry.id,
        url: typeof mcp.url === "string" && mcp.url ? mcp.url : null,
        running: entry.runtimeState === "running",
      });
    }

    return { providers, installedAppIds };
  }
}
