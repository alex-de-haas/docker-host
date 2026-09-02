// Discovery of MCP providers, read from Core.
//
// Core is the registry: it validates manifests, normalizes the declared `interfaces` at
// install/update, and resolves each declaration to a ready-to-call URL from the app's endpoints.
// The gateway asks and owns only the policy (which of them are enabled). Nothing is pushed the
// other way, and the toggles never live in Core.
//
// The service token is the gateway's own app→Core credential, the same one the audit reporter uses.

import { readAppSkill, type AppSkill } from "../mcp/skills.js";

export const MCP_INTERFACE = "mcp";

/**
 * Core's own MCP endpoint, offered to the assistant as one provider beside the apps.
 *
 * Not an app id: it is the audience Core mints delegated tokens for its own surface under, and the
 * name the facade already lists Core's tools under — one string names Core wherever a target is named.
 */
export const CORE_PROVIDER_ID = "hosty:core";

export interface McpProvider {
  appId: string;
  displayName: string;
  /** Resolved from the caller's vantage point by Core; null when the app exposes no usable URL.
   * The *default* declaration's URL, kept for the assistant's own sessions, which address an app
   * rather than one of its interfaces. */
  url: string | null;
  running: boolean;
  /**
   * Every `mcp` declaration this app makes, with the interface key Core resolved it under.
   *
   * One app may declare several, and the key is part of a tool's exported name in the CLI
   * connector's mapping (`app__admin__tool`). Discovery dropped it and kept only the first URL,
   * which silently renamed every tool of a non-default interface and made the extra declarations
   * unreachable — so the facade's names diverged from the connector's for exactly the apps that
   * have more than one surface.
   *
   * Policy stays per app regardless: one toggle covers everything an app declares, because the
   * question an operator answers is "may this app's tools reach an agent".
   */
  interfaces: Array<{ key: string; url: string }>;
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
    /** Core's MCP endpoint, when the assistant's sessions may be offered it; null keeps Core out. */
    private readonly coreMcpUrl: string | null = null,
  ) {}

  /**
   * Core as a provider for the assistant's own sessions, or null when no Core MCP URL was given.
   *
   * Kept out of `read()` on purpose. That roster is what the facade builds its catalog from, and the
   * facade carries Core on its own terms — always offered, never subject to the panel's toggle, and
   * still reachable while an app-directory read fails. The panel is the surface that wants Core as
   * one provider among the apps, with the same switch and approval mode, so the panel's callers add
   * it. Reported running unconditionally: the gateway only exists while Core does.
   */
  core(): McpProvider | null {
    if (!this.coreMcpUrl) {
      return null;
    }
    return {
      appId: CORE_PROVIDER_ID,
      displayName: "Hosty Core",
      url: this.coreMcpUrl,
      running: true,
      interfaces: [{ key: "default", url: this.coreMcpUrl }],
    };
  }

  /**
   * One app's agent skill, read as this app.
   *
   * Lives here because the credentials do: the alternative was a second copy of the Core origin,
   * service token and app id in the session manager, and a second copy is what goes stale.
   *
   * Null covers every way there is nothing to hand a model — the app declares no skill, declared one
   * that was never packaged, or Core is briefly unreachable. A session must still start; an agent
   * that knows less is a smaller cost than an assistant that will not open because one app is
   * mid-update.
   */
  async readSkill(targetAppId: string): Promise<AppSkill | null> {
    if (!this.coreOrigin || !this.serviceToken) {
      return null;
    }
    return readAppSkill(this.coreOrigin, this.serviceToken, this.appId, targetAppId);
  }

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
      const mcp = (declarations as Array<Record<string, unknown>>).filter(
        (declaration) => declaration?.name === MCP_INTERFACE,
      );
      if (mcp.length === 0) {
        continue;
      }

      const interfaces = mcp
        .filter((declaration): declaration is Record<string, unknown> & { url: string } =>
          typeof declaration.url === "string" && declaration.url.length > 0)
        .map((declaration) => ({
          // Core sends the key it resolved the declaration under; `default` is the one the naming
          // scheme leaves out, and it is also the sane fallback for a Core too old to send one.
          key: typeof declaration.key === "string" && declaration.key ? declaration.key : "default",
          url: declaration.url,
        }));

      providers.push({
        appId: entry.id,
        displayName: typeof entry.displayName === "string" ? entry.displayName : entry.id,
        url: interfaces.find((declaration) => declaration.key === "default")?.url ?? interfaces[0]?.url ?? null,
        running: entry.runtimeState === "running",
        interfaces,
      });
    }

    return { providers, installedAppIds };
  }
}
