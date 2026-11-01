import type { IncomingMessage, ServerResponse } from "node:http";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";
import type { SourceConversationQuery, HistoryEntryGet, HistoryQuery, HistorySearch, HistoryShareCreate, HistoryShareRevoke, ProviderRef, ConversationRef } from "@hosty-sdk/app/history";
import type { HistoryService } from "./service.js";

/** Only exact, introspected Core-mediated requests enter the cross-provider contract. */
export async function historyRoute(request: IncomingMessage, response: ServerResponse, url: URL, history: HistoryService): Promise<boolean> {
  const root = "/api/history/v1";
  if (url.pathname !== root && !url.pathname.startsWith(root + "/")) return false;
  const route = url.pathname.slice(root.length), method = request.method ?? "GET";
  const operation = route.slice(1).replaceAll("/", ".");
  const operations = new Set(["capabilities", "conversations.query", "conversations.get", "entries.query", "entries.get", "search", "shares.query", "shares.create", "shares.revoke", "attachments.resolve", "attachments.content", "exports.snapshot", "exports.changes", "notifications"]);
  try {
    if (!operations.has(operation) || method !== (operation === "capabilities" ? "GET" : "POST") || url.search) throw new ProviderError("not_found", "Unknown history operation.", 404);
    const token = request.headers.authorization?.match(/^Bearer (hosty_provider\.2\.[^\s]+)$/)?.[1];
    if (!token || request.headers.cookie) throw new ProviderError("permission_denied", "Use the exact Core-mediated history credential.", 401);
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      length += chunk.length; if (length > 1024 * 1024) throw new ProviderError("budget_exceeded", "History requests are bounded to 1 MiB.", 413);
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks), client = new ProviderClient();
    const validate = () => client.validateMediated(token, "conversation-history", { operation, method, path: route, body }, history.provider.key);
    const actor = await validate();
    if (actor.hostRole !== "host.admin") throw new ProviderError("permission_denied", "Harness history requires a current administrator.", 403);
    let input: Record<string, unknown> = {};
    if (body.length) {
      try { input = JSON.parse(body.toString("utf8")); }
      catch { throw new ProviderError("invalid_input", "Expected a JSON object.", 400); }
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProviderError("invalid_input", "Expected a JSON object.", 400);
    }
    const abort = new AbortController();
    const disconnected = () => abort.abort(); response.once("close", disconnected);
    try {
    const result = operation === "capabilities" ? history.capabilities
      : operation === "notifications" ? await history.notifications(actor, input as Parameters<HistoryService["notifications"]>[1], abort.signal)
      : operation === "conversations.query" ? await history.list(actor, input as SourceConversationQuery)
      : operation === "conversations.get" ? await history.conversation(actor, input.conversation as ConversationRef)
      : operation === "entries.query" ? await history.read(actor, input as HistoryQuery)
      : operation === "entries.get" ? await history.get(actor, input as HistoryEntryGet)
      : operation === "search" ? await history.search(actor, input as Omit<HistorySearch, "providers"> & { provider: ProviderRef })
      : operation.startsWith("exports.") ? await history.export(actor, input as Parameters<HistoryService["export"]>[1], operation === "exports.changes")
      : operation.startsWith("attachments.") ? await history.attachment(actor, input as Parameters<HistoryService["attachment"]>[1], operation === "attachments.content")
      : operation === "shares.query" ? await history.shares(actor, input.conversation as ConversationRef)
      : operation === "shares.create" ? await history.share(actor, input as HistoryShareCreate)
      : await history.share(actor, input as HistoryShareRevoke, true);
    // Revocation during a slow source read is checked before any content leaves the provider.
    await validate();
    if (Buffer.isBuffer(result)) { await history.deliver(actor, result, () => { response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" }).end(result); }); return true; }
    const payload = JSON.stringify(result);
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new ProviderError("budget_exceeded", "History responses are bounded to 1 MiB.", 429);
    await history.deliver(actor, result, () => { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(payload); });
    } finally { response.off("close", disconnected); }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    response.writeHead(error.status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: { code: error.code, message: error.message, retryable: error.status >= 500 } }));
  }
  return true;
}
