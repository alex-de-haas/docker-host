import type { IncomingMessage, ServerResponse } from "node:http";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";
import type { AgentSessionQuery, NativeSessionRef, RunRef, RunCancel } from "@hosty-sdk/app/agent-sessions";
import { AppContextError } from "../sessions/app-context.js";
import type { AgentSessionService } from "./service.js";

export async function agentSessionRoute(request: IncomingMessage, response: ServerResponse, url: URL, service: AgentSessionService): Promise<boolean> {
  const root = "/api/agent-sessions/v1";
  if (url.pathname !== root && !url.pathname.startsWith(root + "/")) return false;
  try {
    const route = url.pathname.slice(root.length), operation = route.slice(1).replaceAll("/", ".");
    if (request.method !== "POST" || url.search || !["sessions.query", "sessions.get", "runs.get", "runs.cancel", "runs.notifications"].includes(operation)) throw new ProviderError("not_found", "Unknown execution observation operation.", 404);
    const token = request.headers.authorization?.match(/^Bearer (hosty_provider\.2\.[^\s]+)$/)?.[1];
    if (!token || request.headers.cookie) throw new ProviderError("permission_denied", "Use an exact Core-mediated execution credential.", 401);
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 1024 * 1024) throw new ProviderError("budget_exceeded", "Execution requests are bounded to 1 MiB.", 413); chunks.push(Buffer.from(chunk)); }
    const body = Buffer.concat(chunks), client = new ProviderClient();
    const validate = () => client.validateMediated(token, "agent-sessions", { operation, method: "POST", path: route, body }, service.provider.key);
    const actor = await validate(); let input: Record<string, unknown>;
    try { input = JSON.parse(body.toString("utf8")); } catch { throw new ProviderError("invalid_input", "Expected a JSON object.", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProviderError("invalid_input", "Expected a JSON object.", 400);
    const abort = new AbortController(); const disconnected = () => abort.abort(); response.once("close", disconnected);
    try {
    const result = operation === "sessions.query" ? await service.list(actor, input as AgentSessionQuery)
      : operation === "sessions.get" ? await service.getSession(actor, input.nativeSession as NativeSessionRef)
      : operation === "runs.notifications" ? await service.notifications(actor, input as Parameters<AgentSessionService["notifications"]>[1], abort.signal)
      : operation === "runs.get" ? await service.getRun(actor, input.run as RunRef)
      : await service.cancel(actor, input as RunCancel, validate);
    await validate();
    const payload = JSON.stringify(result);
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new ProviderError("budget_exceeded", "Execution observations are bounded to 1 MiB.", 429);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(payload);
    } finally { response.off("close", disconnected); }
  } catch (error) {
    if (!(error instanceof ProviderError) && !(error instanceof AppContextError)) throw error;
    response.writeHead(error.status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: { code: error.code, message: error.message, retryable: error.status >= 500 } }));
  }
  return true;
}
