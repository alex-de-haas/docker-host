// The aggregated tool catalog one external client sees.
//
// Built per acting user, because that is what it depends on: an app the user may not reach drops out
// when Core refuses to mint its token, exactly as it does in the CLI connector. The facade
// re-implements no access rules — it asks, and absence is the answer.
//
// Failure policy is the catalog's, not the read-only probe's: an app that cannot be reached costs
// the catalog that app and nothing else, and a page that cannot be read keeps the pages read before
// it. Refusing everything on one bad app would take away tools that work to punish one that does
// not. (readonly.ts inverts this on purpose — it produces a permission answer, where a truncated
// result is indistinguishable from a complete one.)

import type { McpProvider } from "../settings/providers.js";
import { listTools, openSession, type UpstreamTool } from "../mcp/upstream.js";
import { interfaceKey, toolName } from "./tool-key.js";

/** Same bound the connector walks: generous for any real app, finite because the cursor is the
 * app's to produce and a buggy one must not spin here. */
const MAX_PAGES = 20;

/**
 * Budget for reading **one source completely** — handshake and every page together.
 *
 * Spent across the whole walk rather than refreshed per page, which is the connector's own rule and
 * the reason it has one: an app answering each page just inside a per-page ceiling would otherwise
 * hold the fan-out for twenty times as long, and the fan-out is what a client waits on before it
 * sees any tools at all. A client would give up mid-`initialize` while one slow app kept the
 * catalog open.
 */
const SOURCE_BUDGET_MS = 10_000;

/** One exported tool, with everything needed to route a call back to where it came from. */
export interface CatalogEntry {
  /** The name the client sees, namespaced. */
  name: string;
  /** The app's own name for it. */
  tool: string;
  appId: string;
  url: string;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown>;
}

export interface CatalogSource {
  appId: string;
  displayName: string;
  url: string;
  /** The interface key Core resolved this declaration under. Part of the exported name for anything
   * other than `default`, so dropping it renames every tool of a non-default interface. */
  interfaceKey: string;
}

/**
 * Reads one source's tools and maps them into catalog entries.
 *
 * Only tools declaring `annotations.readOnlyHint: true` are exported. Fail-closed on the hint
 * itself: `false`, absent, a string, or the hint at the wrong nesting all mean "we do not know what
 * this does", and an unknown tool is not offered while external clients are read-only.
 */
export async function readSource(source: CatalogSource, token: string): Promise<CatalogEntry[]> {
  const deadline = Date.now() + SOURCE_BUDGET_MS;
  const remaining = (): number => deadline - Date.now();

  const session = await openSession(source.url, token, "hosty-ai-gateway", remaining());
  if (!session) {
    return [];
  }

  const key = interfaceKey(source.appId, source.interfaceKey);
  const entries: CatalogEntry[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (remaining() <= 0) {
      // Out of budget. Keeping the pages already read is this catalog's policy — a source that runs
      // long costs its own later tools, never the rest of the fleet's.
      break;
    }

    const listed = await listTools(source.url, token, session, cursor, remaining());
    if (!listed) {
      break;
    }

    for (const tool of listed.tools) {
      const entry = toEntry(source, key, tool);
      if (entry) {
        entries.push(entry);
      }
    }

    if (!listed.nextCursor) {
      break;
    }
    cursor = listed.nextCursor;
  }

  return entries;
}

function toEntry(source: CatalogSource, key: string, tool: UpstreamTool): CatalogEntry | null {
  if (tool.annotations?.readOnlyHint !== true) {
    return null;
  }

  const name = toolName(key, tool.name);
  if (!name) {
    // Refused rather than mangled: a name containing `__` would make the boundary ambiguous, and a
    // truncated one would collide with another tool.
    return null;
  }

  return {
    name,
    tool: tool.name,
    appId: source.appId,
    url: source.url,
    // Prefixed with the app it belongs to. The app's own text has no reason to carry that, and a
    // model choosing between two similar tools from different apps needs it.
    description: `[${source.displayName}] ${typeof tool.description === "string" ? tool.description : ""}`.trim(),
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    annotations: { ...(tool.annotations as Record<string, unknown>) },
  };
}

/** The catalog as the client sees it, plus the table that routes a call back. */
export interface Catalog {
  tools: Array<{ name: string; description: string; inputSchema: unknown; annotations: Record<string, unknown> }>;
  route: Map<string, CatalogEntry>;
  /** Apps that contributed at least one tool, in the order they were offered — the set whose skills
   * may be delivered, because instructions for tools a client does not have read as a capability. */
  contributingAppIds: string[];
}

/** Assembles the sources' entries into one catalog. Sources are read in parallel: a fan-out is what
 * a client waits on before it sees any tools at all. */
export async function buildCatalog(
  sources: readonly CatalogSource[],
  tokenFor: (appId: string) => Promise<string | null>,
): Promise<Catalog> {
  const collected = await Promise.all(
    sources.map(async (source) => {
      const token = await tokenFor(source.appId);
      return token ? readSource(source, token) : [];
    }),
  );

  const route = new Map<string, CatalogEntry>();
  const contributingAppIds: string[] = [];
  for (const entries of collected) {
    for (const entry of entries) {
      // First writer wins. Names are collision-free by construction, so a duplicate here means two
      // sources claimed one identity — keeping the first is arbitrary but stable, and overwriting
      // would let a later app shadow an earlier app's tool.
      if (!route.has(entry.name)) {
        route.set(entry.name, entry);
      }
    }
    const appId = entries[0]?.appId;
    if (appId && !contributingAppIds.includes(appId)) {
      contributingAppIds.push(appId);
    }
  }

  return {
    tools: [...route.values()].map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      annotations: entry.annotations,
    })),
    route,
    contributingAppIds,
  };
}

/** The sources a user's catalog is built from: every enabled, running provider with a resolved URL,
 * plus Core's own MCP endpoint. Policy (which providers are on) stays the operator's, exactly as it
 * is for the assistant's own sessions. */
export function sourcesFor(
  providers: readonly McpProvider[],
  enabled: Readonly<Record<string, boolean>>,
  core: { appId: string; displayName: string; url: string } | null,
): CatalogSource[] {
  // One source per *declaration*, not per app: an app may offer several MCP interfaces, and each
  // carries its own key into the exported names. The toggle stays per app.
  const sources: CatalogSource[] = providers
    .filter((provider) => enabled[provider.appId] === true && provider.running)
    .flatMap((provider) =>
      provider.interfaces.map((declaration) => ({
        appId: provider.appId,
        displayName: provider.displayName,
        url: declaration.url,
        interfaceKey: declaration.key,
      })));
  return core ? [{ ...core, interfaceKey: "default" }, ...sources] : sources;
}
