// One MCP endpoint that is the whole host.
//
// An external agent client (Claude Code, an editor, a phone client) puts *one* entry in its config
// and gets Core's control-plane tools, every enabled app's tools, and those apps' skills — over
// HTTPS, with no CLI or SSH anywhere on the path. That is the gap `hosty mcp` cannot close: the
// connector is a process, so it has to run on the host.
//
// Nothing here re-implements an access rule. The client's credential is introspected by Core on
// every request, every tool call travels on a delegated token Core minted for the acting user, and
// an app that user may not reach simply produces no tools. The facade decides what is *offered*;
// Core decides what is *allowed*.
//
// Read-only, fail-closed, for as long as external clients are: only a tool declaring
// `readOnlyHint: true` is exported, and a name the catalog does not carry is refused on call as well
// as hidden from the listing — hiding alone would still let a client call from a list it cached.

import type { IncomingMessage, ServerResponse } from "node:http";
import { composeSystemPrompt, partitionSkills, type AppSkill } from "../mcp/skills.js";
import { PROTOCOL_VERSION, callTool, openSession } from "../mcp/upstream.js";
import type { ProviderDirectory } from "../settings/providers.js";
import type { SettingsStore } from "../settings/store.js";
import { buildCatalog, sourcesFor, type Catalog } from "./catalog.js";
import { CORE_TARGET, introspect, mintOnBehalfOf } from "./tokens.js";

/** The path an external client is pointed at. */
export const FACADE_PATH = "/mcp";

/** Same ceiling the operator API uses; a JSON-RPC request body is far smaller. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * How long an assembled catalog is reused for one user.
 *
 * This caches a *listing*, never an authorization, and the distinction is what makes it safe: every
 * call still introspects the client's credential and still mints a fresh delegated token, so a
 * catalog that has gone stale can offer a name whose call then fails at Core — it can never make a
 * refused call succeed. Short anyway, because the fan-out it saves is also what a client waits on.
 */
const CATALOG_TTL_MS = 30_000;

interface CachedCatalog {
  catalog: Catalog;
  instructions: string | undefined;
  expiresAtMs: number;
}

export interface FacadeConfig {
  coreOrigin: string | null;
  serviceToken: string | null;
  appId: string;
  /** Core's own MCP endpoint. Null on a host where it cannot be resolved, which costs the catalog
   * Core's four tools and nothing else. */
  coreMcpUrl: string | null;
}

export class McpFacade {
  private readonly catalogs = new Map<string, CachedCatalog>();

  constructor(
    private readonly config: FacadeConfig,
    private readonly providers: ProviderDirectory,
    private readonly settings: SettingsStore,
  ) {}

  /** True when this request was the facade's, answered or refused. */
  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (pathname !== FACADE_PATH) {
      return false;
    }

    if (!this.config.coreOrigin || !this.config.serviceToken) {
      // Without Core there is no way to establish who is calling, and a facade that cannot do that
      // must answer nothing rather than fall back to trusting the caller.
      send(response, 503, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Hosty Core is not configured for this app." } });
      return true;
    }

    if (request.method !== "POST") {
      // Streamable HTTP also defines a GET stream for server-initiated messages. Refused rather than
      // half-implemented: a client that opened one would wait for notifications this facade does not
      // yet send (docs/features/mcp-facade/plan.md).
      send(response, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "This endpoint accepts POST." } });
      return true;
    }

    let body: JsonRpcRequest | null;
    try {
      body = JSON.parse(await readBody(request)) as JsonRpcRequest;
    } catch {
      send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
      return true;
    }

    if (!body || typeof body.method !== "string") {
      send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
      return true;
    }

    // Resolved before authentication so the tool's name can travel to Core, where it becomes the
    // audit line for this client's action — the call reaches Core nowhere else.
    const invokedTool =
      body.method === "tools/call" && typeof body.params?.name === "string" ? body.params.name : undefined;

    const presented = readBearer(request);
    if (!presented) {
      // The header a client needs in order to try again, per the MCP authorization spec's shape.
      response.setHeader("www-authenticate", 'Bearer realm="hosty"');
      send(response, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "A Hosty access token scoped to this app is required." } });
      return true;
    }

    const actor = await introspect(
      { coreOrigin: this.config.coreOrigin, serviceToken: this.config.serviceToken, appId: this.config.appId },
      presented,
      invokedTool,
    );
    if (!actor.active) {
      // Core unreachable is not a bad credential: answering 401 would send a client with a perfectly
      // good token off to get another one while the truth is that nothing could be checked.
      const unreachable = actor.error && actor.error.code !== "introspection_unconfigured";
      send(response, unreachable ? 503 : 401, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: unreachable ? -32000 : -32001,
          message: unreachable ? "This app could not reach Hosty Core to validate the credential." : "The credential is not valid for this app.",
        },
      });
      return true;
    }

    // A notification carries no id and gets no response body, per JSON-RPC.
    if (body.method === "notifications/initialized") {
      response.writeHead(202).end();
      return true;
    }

    const id = body.id ?? null;
    switch (body.method) {
      case "initialize": {
        const assembled = await this.catalogFor(actor.sub, presented);
        send(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: this.config.appId, version: "1" },
            ...(assembled.instructions ? { instructions: assembled.instructions } : {}),
          },
        });
        return true;
      }
      case "tools/list": {
        const assembled = await this.catalogFor(actor.sub, presented);
        send(response, 200, { jsonrpc: "2.0", id, result: { tools: assembled.catalog.tools } });
        return true;
      }
      case "tools/call": {
        await this.invoke(response, id, actor.sub, presented, body.params ?? {});
        return true;
      }
      default:
        send(response, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${body.method}` } });
        return true;
    }
  }

  /** Drops a user's cached catalog. Called when policy changes, so a provider the operator just
   * turned off stops being offered without waiting out the TTL. */
  invalidate(): void {
    this.catalogs.clear();
  }

  private async invoke(
    response: ServerResponse,
    id: JsonRpcId,
    userId: string,
    presented: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const name = typeof params.name === "string" ? params.name : "";
    const assembled = await this.catalogFor(userId, presented);
    const entry = assembled.catalog.route.get(name);
    if (!entry) {
      // Refused on call as well as hidden from the listing: a client calling from a cached list
      // must not reach a tool the filter excluded. The message says the surface is filtered rather
      // than only that the name is unknown, so a model can tell the two apart.
      send(response, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}. This surface offers read-only tools only.` },
      });
      return;
    }

    const token = await mintOnBehalfOf(
      this.config.coreOrigin!,
      this.config.serviceToken!,
      this.config.appId,
      presented,
      entry.appId,
    );
    if (!token) {
      send(response, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `Hosty would not issue a credential for ${entry.appId} on your behalf.` },
      });
      return;
    }

    const session = await openSession(entry.url, token.token);
    const called = session ? await callTool(entry.url, token.token, session, entry.tool, params.arguments) : null;
    if (!called) {
      send(response, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `${entry.appId} did not answer.` },
      });
      return;
    }

    // The app's own answer, passed through unexamined — including a refusal, which is a *result* the
    // model must read rather than an error that would end its turn.
    send(response, 200, called.error ? { jsonrpc: "2.0", id, error: called.error } : { jsonrpc: "2.0", id, result: called.result });
  }

  private async catalogFor(userId: string, presented: string): Promise<CachedCatalog> {
    const cached = this.catalogs.get(userId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached;
    }

    const [discovered, policy] = await Promise.all([this.providers.read(), this.settings.read()]);
    const sources = discovered
      ? sourcesFor(
          discovered.providers,
          policy.mcpProviders,
          this.config.coreMcpUrl
            ? { appId: CORE_TARGET, displayName: "Hosty Core", url: this.config.coreMcpUrl }
            : null,
        )
      : [];

    const catalog = await buildCatalog(sources, (appId) =>
      mintOnBehalfOf(this.config.coreOrigin!, this.config.serviceToken!, this.config.appId, presented, appId).then(
        (token) => token?.token ?? null,
      ),
    );

    const assembled: CachedCatalog = {
      catalog,
      instructions: await this.instructionsFor(catalog, policy.mcpSkillDigests ?? {}),
      expiresAtMs: Date.now() + CATALOG_TTL_MS,
    };
    this.catalogs.set(userId, assembled);
    return assembled;
  }

  /**
   * The facade's own text first and unwrapped, then the skills of apps whose tools this client
   * actually received — and only those the operator has approved.
   *
   * The approval gate is right here and not in the connector because the callers differ: `hosty mcp`
   * runs on the host's control channel, where the caller already holds operator power and a gate
   * would refuse someone who could simply uninstall the app. A facade caller is a remote user who is
   * not that person.
   */
  private async instructionsFor(catalog: Catalog, approved: Record<string, string>): Promise<string | undefined> {
    const own =
      "You are connected to a Hosty host. The tools below come from the apps installed on it and " +
      "from Hosty Core itself; each tool's description names the app it belongs to. This surface is " +
      "read-only: anything that would change the host is not offered here.";

    const skills: AppSkill[] = [];
    for (const appId of catalog.contributingAppIds) {
      if (appId === CORE_TARGET) {
        continue;
      }
      const skill = await this.providers.readSkill(appId);
      if (skill) {
        skills.push(skill);
      }
    }

    return composeSystemPrompt(own, partitionSkills(skills, approved).deliver);
  }
}

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function readBearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() || null : null;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("payload too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
