import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { AgentApiError, type AgentProviderRef, type AgentSession } from "@hosty-sdk/app/agent";
import { validateAgentRequest, agentReplayCursor, encodeAgentSseEvent } from "@hosty-sdk/app/agent/server";
import type { ProviderController } from "./controller.js";
import type { AttachmentStore } from "./attachments.js";
import { bytesHash, type VerifiedOperation } from "./store.js";

export const API_PREFIX = "/api/agent/v1";
export const json = (response: ServerResponse, status: number, value: unknown) => { const payload = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) }); response.end(payload); };
export async function readCommand(request: IncomingMessage, max = 1024 * 1024): Promise<string> {
  const parts: Buffer[] = []; let length = 0;
  for await (const part of request) { const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); length += bytes.length; if (length > max) throw new AgentApiError("payload_budget", "Command exceeds its byte allowance.", 413); parts.push(bytes); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)); } catch { throw new AgentApiError("invalid_input", "Command is not valid UTF-8.", 400); }
}
function sameProvider(a: AgentProviderRef, b: AgentProviderRef): boolean { return a.appId === b.appId && a.installationId === b.installationId && a.key === b.key; }
export function agentRoutes(controller: ProviderController, attachments: AttachmentStore) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith(API_PREFIX + "/")) return false;
    const route = url.pathname.slice(API_PREFIX.length) + url.search;
    if (request.method !== "GET" && request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new AgentApiError("unsupported_media_type", "Send application/json.", 415);
    const body = await readCommand(request), parsed = validateAgentRequest(request.method ?? "GET", route, body);
    const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1]; if (!bearer) throw new AgentApiError("token_required", "A fresh Core operation credential is required.", 401);
    const actor = await controller.authority.introspect(bearer, parsed.operation, parsed.method, parsed.path, bytesHash(body));
    if (!actor || !sameProvider(actor.provider, controller.store.provider) || actor.operation !== parsed.operation
      || parsed.sessionId && actor.sessionId !== undefined && parsed.sessionId !== actor.sessionId || parsed.runId && actor.runId !== parsed.runId)
      throw new AgentApiError("operation_mismatch", "Core authorization does not match this provider operation.", 403);
    let result: unknown, status = 200;
    switch (parsed.operation) {
      case "capabilities": result = controller.capabilities; break;
      case "connections.list": {
        const listed = await controller.connections.list(), entries = listed.connections.filter(connection => connection.kind === controller.kind)
          .map(connection => ({ id: connection.id, revision: String(connection.revision), name: connection.name, ready: connection.available, reason: connection.reason, capabilities: controller.capabilities.capabilities }));
        result = page(entries, parsed.query.cursor, parsed.query.limit, value => value.id, "connections"); break;
      }
      case "connections.models": {
        const catalog = await controller.connections.models(parsed.connectionId!);
        result = { revision: catalog.revision, defaultModel: catalog.defaultModel ?? null, models: catalog.models.map(model => ({ id: model.id, name: model.label,
          reasoningEfforts: model.efforts.map(effort => effort.id), defaultReasoningEffort: model.defaultEffort ?? null, unavailableReason: model.unavailableReason })), nextCursor: null }; break;
      }
      case "connections.usage": { const usage = await controller.connections.usage(parsed.connectionId!, true); result = { observedAt: new Date().toISOString(), available: usage.state === "available", data: usage }; break; }
      case "attachments.write": result = await attachments.chunk(parsed.attachmentId!, parsed.chunkIndex!, parsed.input, actor); break;
      case "sessions.create": result = await controller.createSession(parsed.sessionId!, parsed.input, body, actor, () => { status = 201; }); break;
      case "sessions.configure": result = await controller.configureSession(parsed.sessionId!, parsed.input, body, actor, () => { status = 201; }); break;
      case "sessions.read": result = (await controller.store.load(parsed.sessionId!, actor)).session; break;
      case "sessions.list": result = page(await controller.store.list(actor), parsed.query.cursor, parsed.query.limit, value => value.ref.id, "sessions"); break;
      case "runs.start": result = await controller.startRun(parsed.sessionId!, parsed.runId!, parsed.input, body, actor, () => { status = 202; }); break;
      case "runs.read": await controller.store.pruneReplay(parsed.runId!, actor); result = await controller.snapshot(parsed.runId!, actor); break;
      case "runs.respond": result = await controller.respond(parsed.runId!, parsed.input, body, actor); break;
      case "runs.cancel": result = await controller.cancel(parsed.runId!, parsed.input, body, actor); break;
      case "runs.control": result = await controller.control(parsed.runId!, parsed.input, body, actor); break;
      case "runs.controls.read": { const { record } = await controller.store.run(parsed.runId!, actor); const control = record.controls[parsed.requestId!]; if (!control) throw new AgentApiError("control_not_found", "Control not found.", 404); result = control.receipt; break; }
      case "runs.events": {
        await controller.store.pruneReplay(parsed.runId!, actor);
        const after = agentReplayCursor(parsed.query.after, typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined);
        await eventStream(controller, request, response, parsed.runId!, actor, after, () => controller.authority.introspect(bearer, parsed.operation, parsed.method, parsed.path, bytesHash(body))); return true;
      }
    }
    json(response, status, result); return true;
  };
}
function page<T>(values: T[], cursor: string | undefined, limit = 50, id: (value: T) => string, key: string) {
  const compare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
  values.sort((a, b) => compare(id(a), id(b))); let after = "";
  if (cursor) { try { const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (typeof value !== "string") throw new Error(); after = value; } catch { throw new AgentApiError("invalid_cursor", "Invalid page cursor.", 400); } }
  const selected = values.filter(value => compare(id(value), after) > 0).slice(0, limit + 1), next = selected.length > limit; if (next) selected.pop();
  return { [key]: selected, nextCursor: next ? Buffer.from(JSON.stringify(id(selected.at(-1)!))).toString("base64url") : null };
}
async function eventStream(controller: ProviderController, request: IncomingMessage, response: ServerResponse, id: string, actor: VerifiedOperation, after: string | undefined, revalidate: () => Promise<unknown>) {
  const { store } = controller; let current = (await store.run(id, actor)).record;
  let position = after ? store.decodeCursor(after) : { generation: current.snapshot.generation, sequence: "0" };
  const check = () => {
    if (position.generation !== current.snapshot.generation || BigInt(position.sequence) > BigInt(current.snapshot.lastSequence) || BigInt(position.sequence) + 1n < BigInt(current.firstSequence))
      throw new AgentApiError("replay_expired", "Reload the authoritative snapshot and continue strictly after its cursor.", 410, false, { snapshot: `${API_PREFIX}/runs/${id}` });
  };
  check();
  let closed = false, tail = Promise.resolve();
  const send = (payload: string) => { if (closed || response.destroyed) return Promise.resolve(); if (response.write(payload)) return Promise.resolve(); return Promise.race([once(response, "drain").then(() => {}), new Promise<void>((_, reject) => { const timer = setTimeout(() => reject(new Error("Slow event consumer.")), 5000); timer.unref(); })]); };
  const flush = () => { tail = tail.then(async () => { if (closed) return; current = (await store.run(id, actor)).record; check();
    for (const event of current.events) if (BigInt(event.sequence) > BigInt(position.sequence)) { await send(encodeAgentSseEvent(event, store.cursor(event.generation, event.sequence))); position = { generation: event.generation, sequence: event.sequence }; }
  }).catch(() => { response.end(); }); };
  // Subscribe before the first catch-up read so no committed event can fall between replay and live.
  const unsubscribe = store.subscribe(id, flush);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  await send(": ready\n\n"); flush();
  const heartbeat = setInterval(() => { void send(": keepalive\n\n").catch(() => response.end()); }, 15_000); heartbeat.unref();
  const authority = setInterval(() => { void revalidate().catch(() => response.end()); }, 30_000); authority.unref();
  const remaining = actor.expiresAt ? Math.max(0, Date.parse(actor.expiresAt) - Date.now()) : 115_000;
  const expiry = setTimeout(() => response.end(), Math.min(115_000, Number.isFinite(remaining) ? remaining : 0)); expiry.unref();
  await new Promise<void>(resolve => { const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); clearInterval(authority); clearTimeout(expiry); unsubscribe(); resolve(); }; response.once("close", close); response.once("finish", close); request.once("aborted", close); });
}
