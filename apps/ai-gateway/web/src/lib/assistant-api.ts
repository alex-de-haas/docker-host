"use client";

import { getDelegatedToken } from "./delegated-token";

// The assistant's own API, called from the page the gateway serves.
//
// This is the Shell client moved inward, and the move deletes most of it: no base URL to resolve, no
// delegated token to mint, refresh and attach, no Core round trip before the first request. The page
// is served by the process it talks to, so every call is relative and carries this app's own Hosty
// session — the same credential every other embedded Hosty page uses.

export type AssistantEvent = {
  seq: number;
  ts: string;
  type: string;
  message?: string;
  [key: string]: unknown;
};

export type AssistantQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
};

export type AssistantSession = {
  id: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
};

export type HarnessHealth = {
  name: string;
  available: boolean;
  reason?: string;
  /** Absent on an older gateway; treated as "cannot", so nothing is over-promised. */
  capabilities?: { questions?: boolean; liveReconfigure?: boolean };
};

/** Terminal for a stream: retrying cannot fix a revoked role or a session that is gone. */
const TERMINAL_STREAM_STATUSES = new Set([401, 403, 404, 410]);

/**
 * One request, carrying the operator's delegated token when an embedder grants one.
 *
 * The token is not what authenticates the page — the app-session cookie does that, and the gateway
 * accepts either. It is here because the gateway keeps the presented token as the session's
 * delegation seed for app MCP, so a panel that stopped sending it would leave the agent with no app
 * tools and no error to show for it.
 *
 * A 401 is retried exactly once with a refreshed token: only this page learns a token was refused,
 * and a single retry separates "the token aged out mid-turn" from "this operator has no access".
 */
async function call(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const token = await getDelegatedToken(retried);
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
      // Last on purpose: a caller header that shadowed this would drop the session's delegation
      // seed and take the agent's app tools with it, silently.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  if (response.status === 401 && token && !retried) {
    return call(path, init, true);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || `Request failed (${response.status}).`);
  }
  return response;
}

export async function getHealth(): Promise<HarnessHealth> {
  // The route answers an envelope; the harness is the part that matters here.
  const body = (await (await call("/health")).json()) as { harness: HarnessHealth };
  return body.harness;
}

export async function listSessions(): Promise<AssistantSession[]> {
  const body = (await (await call("/sessions")).json()) as { sessions?: AssistantSession[] };
  return body.sessions ?? [];
}

export async function createSession(input: { title?: string; context?: Record<string, string> } = {}): Promise<AssistantSession> {
  return (await call("/sessions", { method: "POST", body: JSON.stringify(input) })).json() as Promise<AssistantSession>;
}

/** Renames a session. An empty title clears the name, and the next message derives one again. */
export async function renameSession(sessionId: string, title: string): Promise<AssistantSession> {
  return (
    await call(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    })
  ).json() as Promise<AssistantSession>;
}

/** Deletes a session and everything it kept: its record, its transcript, and any run still going. */
export async function deleteSession(sessionId: string): Promise<void> {
  await call(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

export async function getSession(sessionId: string): Promise<AssistantSession> {
  return (await call(`/sessions/${encodeURIComponent(sessionId)}`)).json() as Promise<AssistantSession>;
}

export async function postMessage(sessionId: string, text: string): Promise<void> {
  await call(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function resolveApproval(sessionId: string, approvalId: string, decision: "allow" | "deny"): Promise<void> {
  await call(`/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}

/**
 * Answers a pending question. `answers` is keyed by **question text**, which is the gateway's and
 * the harness's own keying — there is no index correlation anywhere in the chain.
 */
export async function resolveQuestion(
  sessionId: string,
  questionId: string,
  answers: Record<string, string>,
): Promise<void> {
  await call(`/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  });
}

export async function cancelSession(sessionId: string): Promise<void> {
  await call(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", body: JSON.stringify({}) });
}

/**
 * Follows one session's event log until aborted.
 *
 * Resumes from a sequence cursor rather than replaying: a dropped connection reattaches where it
 * left off, which is what makes the hourly bound the gateway puts on a cookie-authenticated stream
 * invisible to the operator. A torn frame is dropped for the same reason — the cursor heals it.
 */
export async function streamEvents(
  sessionId: string,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let lastSeq = 0;
  // A long conversation outlives a short-TTL token, so a 401 here is far more likely to be an aged
  // token than a revoked role. Refreshed once before the refusal is believed, exactly as `call`
  // does — treating the first 401 as terminal would end a live stream on a routine expiry.
  let refreshNext = false;
  let retriedOn401 = false;
  while (!signal.aborted) {
    try {
      const token = await getDelegatedToken(refreshNext);
      refreshNext = false;
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${lastSeq}`,
        {
          credentials: "include",
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          signal,
        },
      );
      if (response.status === 401 && token && !retriedOn401) {
        // Immediately, without the backoff below: this is the token being renewed, not the server
        // being unwell. The flag is cleared only once a stream actually opens, so a genuinely
        // refused caller falls through to the terminal branch instead of spinning here.
        retriedOn401 = true;
        refreshNext = true;
        continue;
      }
      if (TERMINAL_STREAM_STATUSES.has(response.status)) {
        // Reported rather than retried, and with a negative seq so it can never collide with a
        // stored event. A silent retry loop would leave the panel stuck with no explanation.
        onEvent({
          seq: -1,
          ts: new Date().toISOString(),
          type: "error",
          message: `The event stream ended (${response.status}) — the session may be gone or access was revoked. Start a new session.`,
        });
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`stream failed (${response.status})`);
      }

      retriedOn401 = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; heartbeats are comment lines (":hb").
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) {
            break;
          }
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice("data: ".length))
            .join("\n");
          if (!data) {
            continue;
          }
          try {
            const event = JSON.parse(data) as AssistantEvent;
            if (typeof event.seq === "number" && event.seq > lastSeq) {
              lastSeq = event.seq;
            }
            onEvent(event);
            // Terminal, unlike every other end of this stream: the session is gone, so the EOF that
            // follows is not a dropped connection to retry. Reconnecting would fetch a 404 and put
            // an error in a transcript the operator has already deleted.
            if (event.type === "session_deleted") {
              return;
            }
          } catch {
            // A torn frame is dropped; the seq cursor makes the reconnect self-healing.
          }
        }
      }
    } catch {
      if (signal.aborted) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
