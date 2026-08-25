// Talking to an app's MCP endpoint: the protocol lifecycle, in one place.
//
// Two callers need it and want *different* things from a failure — the read-only probe
// (readonly.ts) is building a permission answer and refuses on any doubt, while the facade
// (facade/catalog.ts) is building a catalog and keeps what it managed to read. That difference is
// deliberate and belongs to them; the handshake below does not, and a second copy of it is how the
// next protocol fix reaches one caller and not the other.
//
// The lifecycle is not optional: the protocol requires `initialize` before any other request, and an
// app built on a standard MCP SDK rejects a bare `tools/list`. The connector learned this the
// expensive way — it worked against demo-app's hand-rolled server, which does not enforce the
// lifecycle, so every SDK-based app would have silently answered nothing.

export const PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_TIMEOUT_MS = 10_000;

/** An established upstream session. `id` is null for an app that issues no `Mcp-Session-Id`. */
export interface UpstreamSession {
  id: string | null;
}

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown };
}

export interface ToolPage {
  tools: UpstreamTool[];
  nextCursor: string | null;
}

/**
 * Runs `initialize` and the `notifications/initialized` that must follow it. Null when the app
 * cannot be reached or refuses the handshake — the caller decides what that means.
 */
export async function openSession(
  url: string,
  token: string,
  clientName = "hosty-ai-gateway",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<UpstreamSession | null> {
  if (timeoutMs <= 0) {
    return null;
  }

  const opened = await post(
    url,
    token,
    null,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    },
    false,
    timeoutMs,
  );
  if (!opened) {
    return null;
  }

  // Best effort: an app that ignores the notification is not broken, and one that is unreachable
  // fails the next request anyway.
  await post(url, token, opened.sessionId, "notifications/initialized", undefined, true);
  return { id: opened.sessionId };
}

/** One page of `tools/list`. Null when the page could not be read at all. */
export async function listTools(
  url: string,
  token: string,
  session: UpstreamSession,
  cursor?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolPage | null> {
  if (timeoutMs <= 0) {
    return null;
  }

  const listed = await post(
    url,
    token,
    session.id,
    "tools/list",
    cursor ? { cursor } : undefined,
    false,
    timeoutMs,
  );
  const result = listed?.body?.result as { tools?: unknown; nextCursor?: unknown } | undefined;
  if (!Array.isArray(result?.tools)) {
    return null;
  }

  return {
    tools: result.tools.filter(
      (tool): tool is UpstreamTool => typeof (tool as UpstreamTool)?.name === "string" && (tool as UpstreamTool).name.length > 0,
    ),
    nextCursor: typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : null,
  };
}

/**
 * Invokes a tool and hands back whatever the app answered — result or error, unexamined.
 *
 * A tool's own refusal is a *result* the model must read (that is how an app explains a missing
 * permission), so nothing here reinterprets one as a failure. Null means the app could not be
 * reached, which is the only thing the caller has to turn into an error of its own.
 */
export async function callTool(
  url: string,
  token: string,
  session: UpstreamSession,
  name: string,
  args: unknown,
  timeoutMs = 120_000,
): Promise<{ result?: unknown; error?: unknown } | null> {
  const called = await post(
    url,
    token,
    session.id,
    "tools/call",
    { name, arguments: args ?? {} },
    false,
    timeoutMs,
  );
  return called?.body ? { result: called.body.result, error: called.body.error } : null;
}

interface Exchange {
  sessionId: string | null;
  body: { result?: unknown; error?: unknown } | null;
}

async function post(
  url: string,
  token: string,
  sessionId: string | null,
  method: string,
  params?: Record<string, unknown>,
  notification = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Exchange | null> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    // Both, because a streamable-HTTP server may answer either way and one that cannot match the
    // Accept header refuses outright.
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        // A notification carries no id, and adding one would make the app answer something the
        // protocol says it must not.
        ...(notification ? {} : { id: 1 }),
        method,
        ...(params ? { params } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }

    const issued = response.headers.get("mcp-session-id");
    const text = await response.text();
    return { sessionId: issued ?? sessionId, body: notification ? null : parse(text) };
  } catch {
    return null;
  }
}

/** Reads a JSON-RPC response that may have arrived as a one-message SSE stream. */
function parse(text: string): { result?: unknown; error?: unknown } | null {
  const trimmed = text.trimStart();
  try {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        return JSON.parse(line.slice("data:".length).trim());
      }
    }
  } catch {
    return null;
  }
  return null;
}
