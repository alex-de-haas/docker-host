import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolveAdmin } from "./auth.js";
import { SessionNotFoundError, type SessionManager } from "./sessions/manager.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { MAX_SYSTEM_PROMPT_CHARS, type SettingsStore } from "./settings/store.js";
import { renderSettingsPage } from "./settings/page.js";
import type { ProviderDirectory } from "./settings/providers.js";
import type { McpProxy } from "./mcp/proxy.js";

// Plain node:http — the API is a handful of JSON routes plus one SSE stream; a framework would be
// the largest dependency in the app for no gain.
//
// CORS: the origin is reflected and no credentials flag is set. That is deliberate, not lax — auth
// is a short-TTL signed delegated token in the Authorization header (never a cookie), so a foreign
// page gains nothing from being allowed to *send* a request it has no token for. Reflecting the
// origin is what lets Shell (a different origin) call the gateway directly, per the phase-2 CORS
// obligation in the plan.

const MAX_BODY_BYTES = 64 * 1024;

export function createGatewayServer(
  manager: SessionManager,
  adapter: HarnessAdapter,
  settings: SettingsStore | null = null,
  providers: ProviderDirectory | null = null,
  proxy: McpProxy | null = null,
): Server {
  return createServer((request, response) => {
    void route(request, response, manager, adapter, settings, providers, proxy).catch((error) => {
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
  settings: SettingsStore | null,
  providers: ProviderDirectory | null,
  proxy: McpProxy | null,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://gateway.local");
  const method = request.method ?? "GET";
  applyCors(request, response);

  if (method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  // Before the operator gate, and deliberately outside /api: the per-session MCP proxy authenticates
  // with a session key held by the harness, not with an operator's delegated token, and it is bound
  // to loopback. Its own handler enforces both (mcp/proxy.ts).
  if (proxy && (await proxy.handle(request, response, url.pathname))) {
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    const availability = await adapter.probe();
    sendJson(response, 200, {
      status: "ok",
      harness: { name: adapter.name, capabilities: adapter.capabilities, ...availability },
    });
    return;
  }

  // The settings page itself is a static shell — it holds no data and fetches everything through
  // the admin-gated /api routes below with a delegated token, exactly as the chat panel does. Serving
  // the shell without a token is what lets Shell embed it as an ordinary app UI.
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/settings")) {
    const html = renderSettingsPage();
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
    });
    response.end(html);
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
    // Capabilities travel with health because the client needs them to decide what to render: a
    // harness that cannot ask questions must not get a question card, and one that cannot be
    // reconfigured live must not be described as applying a toggle immediately.
    sendJson(response, 200, {
      status: "ok",
      harness: { name: adapter.name, capabilities: adapter.capabilities, ...availability },
    });
    return;
  }

  if (url.pathname === "/api/settings" && settings && (method === "GET" || method === "PUT")) {
    if (method === "PUT") {
      const body = await readJson(request);
      if (body.systemPrompt !== undefined && typeof body.systemPrompt !== "string") {
        sendJson(response, 400, {
          code: "system_prompt_invalid",
          message: "systemPrompt must be a string.",
        });
        return;
      }
      if (typeof body.systemPrompt === "string" && body.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
        sendJson(response, 400, {
          code: "system_prompt_too_long",
          message: `systemPrompt must be at most ${MAX_SYSTEM_PROMPT_CHARS} characters.`,
        });
        return;
      }
      if (body.mcpProviders !== undefined && !isBooleanRecord(body.mcpProviders)) {
        sendJson(response, 400, {
          code: "mcp_providers_invalid",
          message: "mcpProviders must be an object of appId -> boolean.",
        });
        return;
      }
      await settings.update({
        systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
        mcpProviders: isBooleanRecord(body.mcpProviders) ? body.mcpProviders : undefined,
      });
      if (isBooleanRecord(body.mcpProviders)) {
        // Immediately, not at the next timer tick — the page says "applied to running sessions".
        await manager.applyProviderPolicy();
      }
    }

    // Discovery runs on read so the list follows the fleet without the operator reloading anything.
    // A null result means Core could not be asked — reported as such rather than as an empty list,
    // which would read as "no app declares MCP" and be a different statement.
    const discovered = providers ? await providers.read() : null;
    if (discovered) {
      await settings.prune(discovered.installedAppIds);
    }

    const current = await settings.read();
    // Capabilities ride along so the page can say what a change actually does on this harness
    // instead of one wording that is false on one of them.
    sendJson(response, 200, {
      settings: current,
      providers: discovered?.providers ?? [],
      discovery: discovered ? "ok" : "unavailable",
      harness: { name: adapter.name, capabilities: adapter.capabilities },
      limits: { systemPromptChars: MAX_SYSTEM_PROMPT_CHARS },
    });
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
    await streamEvents(request, response, manager, sessionId, url, actor.exp);
    return;
  }

  if (rest === "/messages" && method === "POST") {
    const body = await readJson(request);
    if (typeof body.text !== "string" || !body.text.trim()) {
      sendJson(response, 400, { code: "text_required", message: "A non-empty text field is required." });
      return;
    }
    // The presented token seeds the session's delegation chain; see SessionManager.postMessage.
    await manager.postMessage(sessionId, body.text, readBearer(request));
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

  const questionMatch = rest.match(/^\/questions\/([a-zA-Z0-9-]+)$/);
  if (questionMatch && method === "POST") {
    const body = await readJson(request);
    if (!isStringRecord(body.answers) || Object.keys(body.answers).length === 0) {
      sendJson(response, 400, {
        code: "answers_required",
        message: "answers must be a non-empty object keyed by question text.",
      });
      return;
    }
    const resolved = await manager.resolveQuestion(sessionId, questionMatch[1]!, body.answers);
    if (!resolved) {
      // Same contract as a second approval decision: the first answer wins and the second is told
      // so, rather than silently overwriting what already steered the run.
      sendJson(response, 409, {
        code: "question_not_pending",
        message: "The question is unknown or already answered.",
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
  tokenExpSeconds: number,
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
  // The token was checked when the stream opened; a long-lived connection must not outlive it —
  // a revoked or downgraded admin would otherwise keep receiving transcripts indefinitely. The
  // stream ends at token expiry and the client reconnects with a freshly issued token, which
  // re-runs the full access policy on the Core side.
  const tokenDeadline = setTimeout(
    () => response.end(),
    Math.max(0, tokenExpSeconds * 1000 - Date.now()),
  );
  request.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(tokenDeadline);
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

function readBearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() : undefined;
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

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
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
