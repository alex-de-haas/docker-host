import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolveAdmin } from "./auth.js";
import { SessionNotFoundError, type SessionManager } from "./sessions/manager.js";
import type { HarnessAdapter } from "./harness/adapter.js";

// Plain node:http — the API is a handful of JSON routes plus one SSE stream; a framework would be
// the largest dependency in the app for no gain.
//
// CORS: the origin is reflected and no credentials flag is set. That is deliberate, not lax — auth
// is a short-TTL signed delegated token in the Authorization header (never a cookie), so a foreign
// page gains nothing from being allowed to *send* a request it has no token for. Reflecting the
// origin is what lets Shell (a different origin) call the gateway directly, per the phase-2 CORS
// obligation in the plan.

const MAX_BODY_BYTES = 64 * 1024;

export function createGatewayServer(manager: SessionManager, adapter: HarnessAdapter): Server {
  return createServer((request, response) => {
    void route(request, response, manager, adapter).catch((error) => {
      if (error instanceof SessionNotFoundError) {
        sendJson(response, 404, { code: "session_not_found", message: error.message });
        return;
      }
      if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { code: "payload_too_large", message: error.message });
        return;
      }
      console.error("[server] unhandled", error);
      if (!response.headersSent) {
        sendJson(response, 500, { code: "internal_error", message: "Unexpected gateway error." });
      } else {
        response.end();
      }
    });
  });
}

class PayloadTooLargeError extends Error {}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  adapter: HarnessAdapter,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://gateway.local");
  const method = request.method ?? "GET";
  applyCors(request, response);

  if (method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    const availability = await adapter.probe();
    sendJson(response, 200, {
      status: "ok",
      harness: { name: adapter.name, ...availability },
    });
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { code: "not_found", message: "Unknown route." });
    return;
  }

  // Everything under /api is operator surface: admin-only by decision, no anonymous reads.
  const actor = resolveAdmin(request);
  if (!actor) {
    sendJson(response, 401, {
      code: "unauthorized",
      message: "A delegated token for a Host administrator is required.",
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    const availability = await adapter.probe();
    sendJson(response, 200, { status: "ok", harness: { name: adapter.name, ...availability } });
    return;
  }

  if (url.pathname === "/api/sessions" && method === "POST") {
    const body = await readJson(request);
    const record = await manager.createSession({
      title: typeof body.title === "string" ? body.title : undefined,
      context: isStringRecord(body.context) ? body.context : undefined,
      createdBy: actor.sub,
    });
    sendJson(response, 200, record);
    return;
  }

  if (url.pathname === "/api/sessions" && method === "GET") {
    sendJson(response, 200, { sessions: await manager.listSessions() });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)(\/.*)?$/);
  if (!sessionMatch) {
    sendJson(response, 404, { code: "not_found", message: "Unknown route." });
    return;
  }

  const sessionId = sessionMatch[1]!;
  const rest = sessionMatch[2] ?? "";

  if (rest === "" && method === "GET") {
    const record = await manager.getSession(sessionId);
    if (!record) {
      sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
      return;
    }
    sendJson(response, 200, record);
    return;
  }

  if (rest === "/events" && method === "GET") {
    await streamEvents(request, response, manager, sessionId, url);
    return;
  }

  if (rest === "/messages" && method === "POST") {
    const body = await readJson(request);
    if (typeof body.text !== "string" || !body.text.trim()) {
      sendJson(response, 400, { code: "text_required", message: "A non-empty text field is required." });
      return;
    }
    await manager.postMessage(sessionId, body.text);
    sendJson(response, 202, { accepted: true });
    return;
  }

  const approvalMatch = rest.match(/^\/approvals\/([a-zA-Z0-9-]+)$/);
  if (approvalMatch && method === "POST") {
    const body = await readJson(request);
    if (body.decision !== "allow" && body.decision !== "deny") {
      sendJson(response, 400, { code: "decision_invalid", message: "decision must be 'allow' or 'deny'." });
      return;
    }
    const resolved = await manager.resolveApproval(
      sessionId,
      approvalMatch[1]!,
      body.decision,
      typeof body.message === "string" ? body.message : undefined,
    );
    if (!resolved) {
      sendJson(response, 409, {
        code: "approval_not_pending",
        message: "The approval is unknown or already resolved.",
      });
      return;
    }
    sendJson(response, 200, { resolved: true });
    return;
  }

  if (rest === "/cancel" && method === "POST") {
    await manager.cancelSession(sessionId);
    sendJson(response, 200, { cancelled: true });
    return;
  }

  sendJson(response, 404, { code: "not_found", message: "Unknown route." });
}

async function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  sessionId: string,
  url: URL,
): Promise<void> {
  const afterSeq = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const write = (event: unknown): void => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const { replay, unsubscribe } = await manager.subscribe(sessionId, afterSeq, write);
  for (const event of replay) {
    write(event);
  }

  // Comment heartbeat keeps intermediaries from timing the idle stream out.
  const heartbeat = setInterval(() => response.write(":hb\n\n"), 25_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-max-age", "600");
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
