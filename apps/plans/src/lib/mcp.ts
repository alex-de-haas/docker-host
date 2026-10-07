import { hasScope, introspectMcpToken, SCOPE_MCP_READ } from "@hosty-sdk/app/scoped-token";
import { CoreSourceReader } from "./core-client";
import { PlansService } from "./service";
import { filterPlans, mapBounded, planLink, readFilters } from "./model";
import { PlansError } from "./auth";

export const TOOLS = [
  { name: "list_plans", description: "List current tracked-branch plans and workspace versions across installed app sources. Unavailable repositories and invalid documents remain explicit.", inputSchema: { type: "object", properties: { search: { type: "string" }, status: { type: "string" }, repository: { type: "string" }, app: { type: "string" } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  { name: "get_plan", description: "Read one plan's tracked-branch document, workspace versions, own-base documents and detail links.", inputSchema: { type: "object", properties: { repository: { type: "string" }, path: { type: "string" } }, required: ["repository", "path"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  { name: "plan_workspaces", description: "List the workspaces changing one plan, their document versions, workflow labels and assistant session links.", inputSchema: { type: "object", properties: { repository: { type: "string" }, path: { type: "string" } }, required: ["repository", "path"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
];
function rpc(id: unknown, result: unknown) { return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "Cache-Control": "no-store" } }); }
function rpcError(id: unknown, code: number, message: string) { return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers: { "Cache-Control": "no-store" } }); }
export async function mcpRequest(request: Request) {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1].trim();
  if (!bearer) return Response.json({ error: { code: "credential_required", message: "An MCP credential addressed to Plans is required." } }, { status: 401 });
  const body = await request.json().catch(() => null) as { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null;
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(null, -32700, "Expected a JSON-RPC 2.0 request.");
  const tool = body.method === "tools/call" ? body.params?.name : undefined;
  // No positive cache: Core rechecks the relationship, parent grant, installations and actor.
  const actor = await introspectMcpToken(bearer, { tool });
  if (!actor.active) return Response.json({ error: { code: actor.error?.code ?? "credential_invalid", message: actor.error ? "Core could not validate the MCP credential. Retry when Core is available." : "This MCP credential is invalid for Plans." } }, { status: actor.error ? 503 : 401, headers: { "Cache-Control": "no-store" } });
  if (!hasScope(actor, SCOPE_MCP_READ)) return Response.json({ error: { code: "scope_required", message: "The mcp:read scope is required." } }, { status: 403 });
  if (actor.role !== "host.admin") {
    if (body.method === "tools/call") return rpc(body.id ?? null, { isError: true, content: [{ type: "text", text: "Plans is available only to Hosty administrators." }] });
    return Response.json({ error: { code: "administrator_required", message: "Plans is available only to Hosty administrators." } }, { status: 403 });
  }
  if (!Object.hasOwn(body, "id")) return new Response(null, { status: 202 });
  if (body.method === "initialize") return rpc(body.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: process.env.HOSTY_APP_ID ?? "hosty.plans", version: process.env.HOSTY_APP_VERSION ?? "0.1.0" } });
  if (body.method === "tools/list") return rpc(body.id, { tools: TOOLS });
  if (body.method !== "tools/call") return rpcError(body.id, -32601, "Method not found.");
  if (!TOOLS.some(item => item.name === tool)) return rpcError(body.id, -32602, "Unknown tool.");
  try {
    const args = body.params?.arguments ?? {};
    const allowed = tool === "list_plans" ? ["search", "status", "repository", "app"] : ["repository", "path"];
    if (typeof args !== "object" || Array.isArray(args) || Object.entries(args).some(([key, value]) => !allowed.includes(key) || typeof value !== "string")) throw new PlansError("Tool arguments must be an object with the named string fields.", 400);
    const service = new PlansService(new CoreSourceReader(bearer, request.signal));
    const detailUrl = (repositoryId: string, path: string, workspaceId?: string) => new URL(planLink(repositoryId, path, workspaceId), request.url).href;
    let payload: unknown;
    if (tool === "list_plans") {
      const repositories = await service.repositories();
      const results = await mapBounded(repositories.filter(item => !args.repository || item.id === args.repository), 3, async item => {
        try { return await service.repository(item.id); }
        catch (error) { return { repository: item, plans: [], error: (error as Error).message, state: "unavailable" }; }
      });
      const filters = readFilters(new URLSearchParams({ q: String(args.search ?? ""), status: String(args.status ?? ""), repository: String(args.repository ?? ""), app: String(args.app ?? "") }));
      payload = { repositories: results.map(item => ({ repository: item.repository, state: item.state, error: item.error })), plans: filterPlans(results.flatMap(item => item.plans), filters).map(item => ({ ...item, detailUrl: detailUrl(item.repository.id, item.path), workspaces: item.workspaces.map(version => ({ ...version, detailUrl: detailUrl(item.repository.id, item.path, version.workspace.id) })) })) };
    } else {
      if (!args.repository || !args.path) throw new PlansError("Repository and path are required.", 400);
      const detail = await service.detail(args.repository as string, args.path as string);
      const workspaces = detail.workspaces.map(version => ({ ...version, detailUrl: detailUrl(detail.repository.id, detail.path, version.workspace.id) }));
      payload = tool === "plan_workspaces" ? { repository: detail.repository, path: detail.path, workspaces } : { ...detail, detailUrl: detailUrl(detail.repository.id, detail.path), workspaces };
    }
    return rpc(body.id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
  } catch (error) { return rpc(body.id, { isError: true, content: [{ type: "text", text: (error as Error).message }] }); }
}
