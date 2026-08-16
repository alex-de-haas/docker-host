// Which of an app's tools it declares read-only.
//
// Only asked for apps the operator has opted into (settings.mcpAutoAllow), because the answer is only
// ever used to skip an approval card for those. An app nobody trusted costs nothing here.
//
// The lifecycle is not optional: the protocol requires `initialize` before any other request, and an
// app built on a standard MCP SDK rejects a bare `tools/list`. The connector learned this the
// expensive way — it worked against demo-app's hand-rolled server, which does not enforce the
// lifecycle, so every SDK-based app would have silently answered nothing.

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 10_000;

/**
 * The tool names this app declares `readOnlyHint: true`, or **null** when that could not be
 * established — unreachable, refused, or an answer of the wrong shape.
 *
 * Null and an empty set are deliberately different, and the caller must treat them differently: an
 * empty set means "this app offers nothing read-only", while null means "we do not know", and only
 * one of those may ever lead to skipping an approval.
 */
export async function readOnlyToolNames(url: string, token: string): Promise<Set<string> | null> {
  const session = await post(url, token, null, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "hosty-ai-gateway", version: "1" },
  });
  if (!session) {
    return null;
  }

  // Best effort: an app that ignores the notification is not broken, and one that is unreachable
  // fails the listing below anyway.
  await post(url, token, session.sessionId, "notifications/initialized", undefined, true);

  const listed = await post(url, token, session.sessionId, "tools/list");
  const tools = listed?.body?.result?.tools;
  if (!Array.isArray(tools)) {
    return null;
  }

  const names = new Set<string>();
  for (const tool of tools) {
    if (
      typeof tool?.name === "string" &&
      tool.name.length > 0 &&
      // Fail-closed on the individual tool too: only a literal `true` counts. `false`, absent, a
      // string, or the hint at the wrong nesting all mean "we do not know what this does".
      tool?.annotations?.readOnlyHint === true
    ) {
      names.add(tool.name);
    }
  }

  return names;
}

interface Exchange {
  sessionId: string | null;
  body: { result?: { tools?: unknown } } | null;
}

async function post(
  url: string,
  token: string,
  sessionId: string | null,
  method: string,
  params?: Record<string, unknown>,
  notification = false,
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
function parse(text: string): { result?: { tools?: unknown } } | null {
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
