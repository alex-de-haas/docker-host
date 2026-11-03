import type { IncomingMessage, ServerResponse } from "node:http";
import { DecisionError, type DecisionResolve, type DecisionQuery } from "@hosty-sdk/app/decisions";
import type { DecisionsService } from "./service.js";

export async function decisionsRoute(request: IncomingMessage, response: ServerResponse, url: URL, service: DecisionsService, owner: string,
  read: () => Promise<Record<string, unknown>>): Promise<boolean> {
  const method = request.method ?? "GET", path = url.pathname.slice("/api/decisions".length);
  const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
  if (path === "/projections" && method === "GET") { send(await service.projections(owner)); return true; }
  if (!path && method === "GET") {
    const query: DecisionQuery = {};
    for (const key of ["cursor", "state", "subject", "task"] as const) if (url.searchParams.has(key)) Object.assign(query, { [key]: url.searchParams.get(key)! });
    if (url.searchParams.has("limit")) query.limit = Number(url.searchParams.get("limit"));
    send(await service.list(owner, query)); return true;
  }
  const local = /^\/waits\/([a-f0-9]{64})(?:\/(retry))?$/.exec(path);
  if (local && (method === "GET" || method === "POST" && local[2] === "retry")) {
    if (method === "POST") await service.retry(owner, local[1]!);
    const wait = await service.local(owner, local[1]!);
    send({ id: wait.id, sessionId: wait.sessionId, questionId: wait.questionId, state: wait.state, core: wait.core ?? null, error: wait.error ?? null, reason: wait.reason ?? null }); return true;
  }
  const match = /^\/([0-9a-f-]{36})(?:\/(resolve))?$/.exec(path);
  if (match && method === "GET" && !match[2]) { send(await service.get(owner, match[1]!)); return true; }
  if (match && method === "POST" && match[2] === "resolve") {
    const input = await read();
    if (typeof input.requestId !== "string" || !Number.isSafeInteger(input.expectedRevision) || !input.answers || typeof input.answers !== "object" || Array.isArray(input.answers))
      throw new DecisionError("decision_invalid", "Provide the displayed revision, a request UUID, and question answers.", 400);
    send(await service.resolve(owner, match[1]!, input as unknown as DecisionResolve)); return true;
  }
  return false;
}
