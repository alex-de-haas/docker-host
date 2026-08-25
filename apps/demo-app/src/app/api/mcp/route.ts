import { NextResponse } from "next/server";
import { validateDelegatedToken } from "@hosty-sdk/app/delegated";
import { hasScope, introspectScopedToken, SCOPE_MCP_READ } from "@hosty-sdk/app/scoped-token";
import { getAppDirectorySnapshot } from "@/lib/host-auth";
import { getDemoConfig } from "@/lib/demo-config";
import {
  readDemoAppRoleAssignments,
  resolveDemoAppPermissions,
  resolveDemoDirectoryUserRole,
} from "@/lib/app-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The app-owned MCP endpoint — the reference implementation of the contract other Hosty apps
// follow (docs/features/app-mcp/feature.md; umbrella step 4).
//
// The division of labour is the whole point, and it is easy to get backwards:
//
//   * **Core authenticates.** The app builds no identity system of its own. Two credentials arrive
//     here and both are Core's answer to "who is this", differing only in how the answer is
//     obtained: a short-TTL **delegated token**, signed and validated locally against the key Core
//     injected (no round trip, but unrevocable — which is why it lives five minutes and cannot sit
//     in a client's config file), and a **scoped access token**, opaque and introspected against
//     Core on every call (a round trip, but revocation lands instantly — which is what lets an
//     external agent client keep one in its configuration).
//   * **The app authorizes.** Core cannot know what "read the people directory" means here or who
//     may do it. Every tool below re-runs this app's own permission model for the delegated actor —
//     the same model the HTTP routes use, not a parallel one written for agents. An MCP surface
//     that skipped this would be an unauthenticated remote API wearing a protocol.
//
// JSON-RPC is hand-rolled rather than taken from the MCP SDK, deliberately: the read-only surface is
// three methods, and keeping it inline makes the Hosty-specific parts — token validation, audience
// checking, and the per-tool permission check — the visible content of the file, which is what an
// app author copying this needs to see.

const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as JsonRpcRequest | null;
  if (!body || typeof body.method !== "string") {
    return jsonRpcError(null, -32700, "Parse error: expected a JSON-RPC request object.");
  }

  // The tool being invoked, resolved before authentication so the scoped path can name it to Core —
  // that name is the audit line for an external client's action, which never reaches Core otherwise.
  const invokedTool =
    body.method === "tools/call" && typeof body.params?.name === "string" ? body.params.name : undefined;

  // Authentication first, before the method is even acted on: an unauthenticated caller learns
  // nothing about which tools exist.
  const actor = await resolveActor(request, invokedTool);
  if (!actor.ok) {
    return NextResponse.json(
      { error: { code: actor.code, message: actor.message } },
      { status: actor.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  // A notification (no id) gets no response body, per JSON-RPC.
  const id = body.id ?? null;
  if (body.method === "notifications/initialized") {
    return new NextResponse(null, { status: 202 });
  }

  switch (body.method) {
    case "initialize": {
      // Identity comes from the app's own resolved config (HOSTY_APP_ID / HOSTY_APP_VERSION, which
      // Core injects) rather than literals: a hard-coded pair silently drifts from the manifest at
      // the next version bump, and this file is meant to be copied.
      const config = getDemoConfig();
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: config.appId, version: config.appVersion },
      });
    }
    case "tools/list":
      return jsonRpcResult(id, { tools: TOOLS });
    case "tools/call":
      return callTool(id, body.params ?? {}, actor.actor);
    default:
      return jsonRpcError(id, -32601, `Method not found: ${body.method}`);
  }
}

// `annotations` is not decoration, and a reference implementation is copied as-is — so declare it.
// Consumers key permission policy off these hints, and `hosty mcp` goes further: it is read-only for
// external clients and treats a *missing* readOnlyHint as "this might mutate", so a tool without one
// is not offered at all. An app that omits them silently exports nothing.
const TOOLS = [
  {
    name: "list_people",
    description:
      "Lists the people in this app's directory with the app role each one holds. Requires the demo.people.read permission for the calling Hosty user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "get_my_app_role",
    description:
      "Returns the calling Hosty user's role inside this app, where that role came from, and the permissions it grants. Useful for explaining why another tool was refused.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];

async function callTool(id: number | string | null, params: Record<string, unknown>, actor: Actor) {
  const name = typeof params.name === "string" ? params.name : "";
  const assignments = await readDemoAppRoleAssignments();
  // Whichever credential arrived, it carried the Hosty identity; this app turns it into its own
  // domain role. `status: "active"` because Core hands out neither credential's answer for a user
  // who is disabled or has lost access — every delegated issue and every introspection re-runs the
  // full access policy on the Core side.
  const permissions = resolveDemoAppPermissions(
    { status: "active", userId: actor.userId, hostRole: actor.hostRole },
    assignments,
  );

  if (name === "get_my_app_role") {
    return toolResult(id, {
      userId: actor.userId,
      hostRole: actor.hostRole,
      appRole: permissions.role,
      roleLabel: permissions.roleLabel,
      source: permissions.source,
      permissions: permissions.permissions,
    });
  }

  if (name === "list_people") {
    if (!permissions.permissions.includes("demo.people.read")) {
      // A refusal the model can act on: it names the permission and the role that lacks it, so the
      // agent can explain the gap instead of retrying blindly. Still a normal tool result — a
      // transport error would just end the turn.
      return toolResult(
        id,
        {
          error: `The app role '${permissions.role}' does not grant demo.people.read, so this directory is not readable for ${actor.userId}.`,
        },
        // isError is the protocol's own failure signal: a client can tell the call failed without
        // parsing the JSON inside the text content. It stays a tool *result*, so the model still
        // reads the explanation and can act on it — unlike a JSON-RPC error, which just ends the turn.
        true,
      );
    }

    const directory = await getAppDirectorySnapshot();
    if (directory.status !== "ok") {
      // An unreachable directory is not an empty one. Returning zero people here would have the
      // agent report "there is nobody" during an outage — a false statement about the domain rather
      // than a report about the failure.
      return toolResult(
        id,
        {
          error: `The people directory is unavailable (${directory.status}${directory.error ? `: ${directory.error.message}` : ""}). This is a failure to read, not an empty directory.`,
        },
        true,
      );
    }

    return toolResult(id, {
      people: directory.users.map((user) => {
        const resolved = resolveDemoDirectoryUserRole(user, assignments);
        return {
          id: user.id,
          displayName: user.displayName,
          hostRole: user.hostRole,
          appRole: resolved.role,
        };
      }),
      total: directory.users.length,
    });
  }

  return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
}

/** Who Core says is calling. Both credentials reduce to this — the rest of the file never learns
 * which one arrived, because the app's authorization model does not depend on it. */
type Actor = { userId: string; hostRole: string | null };

type ActorResolution =
  | { ok: true; actor: Actor }
  | { ok: false; status: number; code: string; message: string };

/**
 * Accepts either credential, in the order that costs least.
 *
 * The delegated token is tried first because it validates locally: a gateway-proxied or
 * `hosty mcp` call never pays for a round trip. Only a bearer that is *not* a delegated token is
 * introspected against Core, which is the external-client path.
 *
 * Both audience checks are Core's, not this app's: `validateDelegatedToken` defaults its expected
 * audience to HOSTY_APP_ID, and introspection is answered for the app the service token identifies.
 * A credential minted for another app is refused either way, without this file comparing ids.
 */
async function resolveActor(request: Request, tool: string | undefined): Promise<ActorResolution> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return { ok: false, status: 401, code: "credential_required", message: "A Hosty credential for this app is required." };
  }

  const claims = validateDelegatedToken(token);
  if (claims) {
    return { ok: true, actor: { userId: claims.sub, hostRole: claims.role } };
  }

  const introspected = await introspectScopedToken(token, { tool });
  if (introspected.active) {
    // Every tool here is read-only, so `mcp:read` is the whole of what this surface offers. The
    // scope is checked even though nothing else is on offer yet: a credential that was never
    // granted this must not work merely because there is nothing narrower to compare it against.
    if (!hasScope(introspected, SCOPE_MCP_READ)) {
      return {
        ok: false,
        status: 403,
        code: "scope_required",
        message: `This credential does not carry the '${SCOPE_MCP_READ}' scope.`,
      };
    }

    return { ok: true, actor: { userId: introspected.sub, hostRole: introspected.role } };
  }

  // Any error at all means the credential was never actually checked — Core unreachable, this app
  // not configured to reach it, or an answer that could not be read. All of them are 503: answering
  // 401 would tell a client with a perfectly good token to go and get another one, to fix a fault on
  // this side of the wire. An `active: false` with no error is the opposite — Core checked and said
  // no — and only that is a 401.
  if (introspected.error) {
    return {
      ok: false,
      status: 503,
      code: introspected.error.code,
      message: "This app could not validate the credential with Hosty Core.",
    };
  }

  return { ok: false, status: 401, code: "credential_invalid", message: "The credential is not valid for this app." };
}

/** Tool payloads go back as JSON text content, the shape MCP clients expect. */
function toolResult(id: number | string | null, payload: unknown, isError = false) {
  return jsonRpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  });
}

function jsonRpcResult(id: number | string | null, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: { "Cache-Control": "no-store" } });
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
