import { NextResponse } from "next/server";
import { validateDelegatedToken, type DelegatedTokenClaims } from "@hosty-sdk/app/delegated";
import { getAppDirectorySnapshot } from "@/lib/host-auth";
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
//   * **Core authenticates.** The caller presents a short-TTL delegated token Core signed; this app
//     validates it locally against the public key Core injected, so Core stays out of the data path
//     and there is no per-call round trip. The app builds no identity system of its own.
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

  // Authentication first, before the method is even looked at: an unauthenticated caller learns
  // nothing about which tools exist.
  const claims = readDelegatedClaims(request);
  if (!claims) {
    return NextResponse.json(
      { error: { code: "delegated_token_required", message: "A valid Hosty delegated token for this app is required." } },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // A notification (no id) gets no response body, per JSON-RPC.
  const id = body.id ?? null;
  if (body.method === "notifications/initialized") {
    return new NextResponse(null, { status: 202 });
  }

  switch (body.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "com.haas.demo-app", version: "1" },
      });
    case "tools/list":
      return jsonRpcResult(id, { tools: TOOLS });
    case "tools/call":
      return callTool(id, body.params ?? {}, claims);
    default:
      return jsonRpcError(id, -32601, `Method not found: ${body.method}`);
  }
}

const TOOLS = [
  {
    name: "list_people",
    description:
      "Lists the people in this app's directory with the app role each one holds. Requires the demo.people.read permission for the calling Hosty user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_my_app_role",
    description:
      "Returns the calling Hosty user's role inside this app, where that role came from, and the permissions it grants. Useful for explaining why another tool was refused.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function callTool(
  id: number | string | null,
  params: Record<string, unknown>,
  claims: DelegatedTokenClaims,
) {
  const name = typeof params.name === "string" ? params.name : "";
  const assignments = await readDemoAppRoleAssignments();
  // The delegated token carries the Hosty identity; this app turns it into its own domain role.
  // `status: "active"` because a valid, unexpired token is what Core issues only for an active,
  // permitted user — every issue re-runs the full access policy on the Core side.
  const permissions = resolveDemoAppPermissions(
    { status: "active", userId: claims.sub, hostRole: claims.role },
    assignments,
  );

  if (name === "get_my_app_role") {
    return toolResult(id, {
      userId: claims.sub,
      hostRole: claims.role,
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
      return toolResult(id, {
        error: `The app role '${permissions.role}' does not grant demo.people.read, so this directory is not readable for ${claims.sub}.`,
      });
    }

    const directory = await getAppDirectorySnapshot();
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

/** Reads and validates the bearer token. Audience defaults to HOSTY_APP_ID, so a token minted for
 * another app is rejected — the check that stops one app's token from working on another. */
function readDelegatedClaims(request: Request): DelegatedTokenClaims | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return token ? validateDelegatedToken(token) : null;
}

/** Tool payloads go back as JSON text content, the shape MCP clients expect. */
function toolResult(id: number | string | null, payload: unknown) {
  return jsonRpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
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
