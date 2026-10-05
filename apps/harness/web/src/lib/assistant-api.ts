"use client";

import type { AgentConnection } from "@/components/agent-providers";
import { appFetch } from "@hosty-sdk/app/browser-auth";

// App-local requests carry this document's app grant or same-origin cookie.
// MCP delegation requires separate authority on the server.

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
  autonomy?: "normal" | "autonomous";
  handoffDraft?: { text: string; attachments: StoredAttachment[] };
  handoffDispatch?: { id: string; state: string; error?: string };
  id: string;
  connectionId?: string;
  connectionRevision?: number;
  harnessKind?: "claude" | "codex";
  providerLocked?: boolean;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
  appIds?: string[];
  appContextRevision?: number;
  contextApps?: ContextApp[];
};

export type HarnessHealth = {
  name: string;
  available: boolean;
  reason?: string;
  /** Absent on an older gateway; treated as "cannot", so nothing is over-promised. */
  capabilities?: { appContext?: boolean; questions?: boolean; liveReconfigure?: boolean; denyReason?: boolean };
};

export type ContextApp = { id: string; displayName: string; available: boolean; runtimeState?: string; icon?: string; iconUrl?: string };
export class AssistantApiError extends Error {
  constructor(public readonly code: string | undefined, message: string) { super(message); }
}
export async function listContextApps(search = "", offset = 0): Promise<{ apps: ContextApp[]; nextOffset: number | null }> {
  return (await call(`/session-apps?search=${encodeURIComponent(search)}&offset=${offset}`)).json();
}
export async function selectedContextApps(ids: string[]): Promise<ContextApp[]> {
  if (!ids.length) return [];
  return ((await (await call(`/session-apps?ids=${encodeURIComponent(ids.join(","))}`)).json()) as { apps: ContextApp[] }).apps;
}
export async function setSessionApps(id: string, appIds: string[], expectedRevision: number): Promise<AssistantSession> {
  return (await call(`/sessions/${encodeURIComponent(id)}/apps`, { method: "PUT", body: JSON.stringify({ appIds, expectedRevision }) })).json();
}

/** Terminal for a stream: retrying cannot fix a revoked role or a session that is gone. */
const TERMINAL_STREAM_STATUSES = new Set([401, 403, 404, 410]);

/** Same-origin app identity; the server obtains any MCP delegation without exposing it to script. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await appFetch(`/api${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
    throw new AssistantApiError(body?.code, body?.message || `Request failed (${response.status}).`);
  }
  return response;
}

export async function getHealth(sessionId?: string): Promise<HarnessHealth> {
  // The route answers an envelope; the harness is the part that matters here.
  const body = (await (await call(sessionId ? `/health?sessionId=${encodeURIComponent(sessionId)}` : "/health")).json()) as { harness: HarnessHealth };
  return body.harness;
}

/** The display name behind each MCP server name, so a transcript can say "Media Server". */
export async function listAppNames(): Promise<Record<string, string>> {
  const body = (await (await call("/apps")).json()) as { apps?: Array<{ server: string; displayName: string }> };
  return Object.fromEntries((body.apps ?? []).map((app) => [app.server, app.displayName]));
}

export async function listSessions(): Promise<AssistantSession[]> {
  const body = (await (await call("/sessions")).json()) as { sessions?: AssistantSession[] };
  return body.sessions ?? [];
}

export async function createSession(input: { connectionId?: string; title?: string; context?: Record<string, string>; appIds?: string[]; clientRequestId?: string } = {}): Promise<AssistantSession> {
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

export async function postMessage(sessionId: string, text: string, attachments: string[] = [], appContextRevision = 0, withoutAppDetails = false): Promise<void> {
  await call(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, attachments, appContextRevision, withoutAppDetails }),
  });
}

export type StoredAttachment = { name: string; size: number };

/**
 * Hands the gateway a file for this session. The body is the file itself — no multipart, no
 * encoding — with the operator's name for it in the path; what comes back is the stored name, which
 * may differ (sanitised, de-duplicated) and is the one a message refers to.
 */
export async function uploadAttachment(sessionId: string, file: File): Promise<StoredAttachment> {
  const response = await call(
    `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(file.name)}`,
    {
      method: "PUT",
      body: file,
      // `call` labels any body as JSON; this one is bytes.
      headers: { "content-type": "application/octet-stream" },
    },
  );
  return ((await response.json()) as { attachment: StoredAttachment }).attachment;
}

/** Decides a pending approval. A deny may carry the operator's reason, which reaches the model. */
export async function resolveApproval(
  sessionId: string,
  approvalId: string,
  decision: "allow" | "deny",
  message?: string,
): Promise<void> {
  await call(`/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    body: JSON.stringify({ decision, ...(message ? { message } : {}) }),
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
  while (!signal.aborted) {
    try {
      const response = await appFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${lastSeq}`,
        {
          credentials: "include",
          signal,
        },
      );
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

export async function listAgentConnections(): Promise<{ connections: AgentConnection[]; defaultId: string | null }> {
  return (await call("/connections")).json();
}
export async function setSessionProvider(id: string, connectionId: string, confirmLegacy = false): Promise<AssistantSession> {
  return (await call(`/sessions/${encodeURIComponent(id)}/provider`, { method: "PUT", body: JSON.stringify({ connectionId, confirmLegacy }) })).json();
}
export async function stopSession(id: string): Promise<void> {
  await call(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/** Retry the same accepted dispatch; this never creates a new request or conversation. */
export async function retryHandoff(id: string): Promise<AssistantSession> {
  const record = await (await call(`/assistant/v1/handoffs/${encodeURIComponent(id)}`)).json() as { attachments: { attachmentId: string }[] };
  await call(`/assistant/v1/handoffs/${encodeURIComponent(id)}/finalize`, { method: "POST", body: JSON.stringify({ attachmentIds: record.attachments.map(a => a.attachmentId) }) });
  return getSession(id);
}

export type Workspace = {
  id: string; path: string; repository: string; branch: string; state: string; originalBase: string;
  targetBranch: string; leases: string[]; apps: { appId: string; subpath?: string | null }[];
  pullRequests: string[]; operations: { id: string; state: string; error?: string }[];
  observation?: { state: string; at: string; head?: string; ahead?: number; behind?: number; error?: string;
    sessionFiles?: string[]; local?: { files: { path: string; status: string }[] } };
};
export async function workspaceAction<T>(sessionId: string, action: string, input: Record<string, unknown> = {}): Promise<T> {
  return (await call(`/sessions/${encodeURIComponent(sessionId)}/workspaces`, { method: "POST", body: JSON.stringify({ ...input, action }) })).json();
}

export interface Publication {
  workspaceId: string; repository: string; branch: string; targetBranch: string; number?: number; url?: string;
  outcome?: string; completedAt?: string; cleanupRequested: boolean; dependencies: string[];
  observation?: { at: string; state: string; head?: string; mergeCommit?: string; draft: boolean; mergeState?: string;
    reviewDecision?: string; unresolvedThreads: number; complete: boolean; checks?: { name: string; state: string }[]; error?: string };
  history: { number: number; url: string }[];
  operations: { id: string; kind: string; state: string; error?: string }[];
}

export async function setSessionAutonomy(id: string, autonomy: "normal" | "autonomous"): Promise<AssistantSession> {
  return (await call(`/sessions/${encodeURIComponent(id)}/autonomy`, { method: "PUT", body: JSON.stringify({ autonomy }) })).json();
}
