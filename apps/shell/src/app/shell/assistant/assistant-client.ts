import type { CoreApp } from "../types";

// Client for the AI gateway system app (docs/features/ai-gateway/plan.md, phase 3). Shell talks to
// the gateway origin directly with a short-TTL delegated token minted by Core — Core stays out of
// the data path. EventSource cannot carry an Authorization header, so the SSE stream is consumed
// with fetch + a hand-rolled reader; reattach uses the gateway's `?after=<seq>` cursor.

export const AI_GATEWAY_INTERFACE = "ai-gateway";

export type AssistantGateway = {
  appId: string;
  /** Resolved interface URL, e.g. http://127.0.0.1:3400/api */
  baseUrl: string;
  running: boolean;
};

/** Finds the installed ai-gateway provider among the apps Core reports. Hidden ⇒ no assistant UI. */
export function findAssistantGateway(apps: CoreApp[]): AssistantGateway | null {
  for (const app of apps) {
    const declarations = app.interfaces?.[AI_GATEWAY_INTERFACE];
    const url = declarations?.find((declaration) => declaration.url)?.url;
    if (url) {
      return { appId: app.id, baseUrl: url.replace(/\/$/, ""), running: app.runtimeState === "running" };
    }
  }
  return null;
}

export type AssistantEvent = {
  seq: number;
  ts: string;
  type: string;
  [key: string]: unknown;
};

export type AssistantSession = {
  id: string;
  title: string | null;
  status: string;
  createdAt: string;
};

export type HarnessHealth = {
  name: string;
  available: boolean;
  reason?: string;
};

type TokenIssuer = () => Promise<{ token: string; expiresAt: string }>;

// Statuses where reconnecting cannot help: bad/insufficient auth or a session that no longer exists.
const TERMINAL_STREAM_STATUSES = new Set([401, 403, 404, 410]);

export class AssistantClient {
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly issueToken: TokenIssuer,
  ) {}

  private async authHeader(): Promise<string> {
    // Refresh = ask Core again (the issue endpoint re-runs the full access policy every time).
    if (!this.token || this.token.expiresAtMs - Date.now() < 30_000) {
      const issued = await this.issueToken();
      this.token = { value: issued.token, expiresAtMs: new Date(issued.expiresAt).getTime() };
    }
    return `Bearer ${this.token.value}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
        authorization: await this.authHeader(),
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `Gateway request failed (${response.status}).`);
    }
    return response;
  }

  async health(): Promise<HarnessHealth> {
    const body = (await (await this.request("/health")).json()) as { harness: HarnessHealth };
    return body.harness;
  }

  async createSession(input: { title?: string; context?: Record<string, string> }): Promise<AssistantSession> {
    return (await (
      await this.request("/sessions", { method: "POST", body: JSON.stringify(input) })
    ).json()) as AssistantSession;
  }

  async postMessage(sessionId: string, text: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  async resolveApproval(sessionId: string, approvalId: string, decision: "allow" | "deny"): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { method: "POST", body: JSON.stringify({ decision }) },
    );
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  /**
   * Consumes the session's SSE stream until the signal aborts, reconnecting with the last seen
   * seq as the cursor so a dropped connection replays nothing and loses nothing.
   */
  async streamEvents(
    sessionId: string,
    onEvent: (event: AssistantEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let lastSeq = 0;
    while (!signal.aborted) {
      try {
        const response = await fetch(
          `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events?after=${lastSeq}`,
          { headers: { authorization: await this.authHeader() }, signal },
        );
        // Auth/gone responses are terminal — retrying cannot fix a revoked role or a swept
        // session, and a silent retry loop would leave the panel stuck with no explanation.
        // The synthetic seq is negative so it can never collide with a stored event.
        if (TERMINAL_STREAM_STATUSES.has(response.status)) {
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
      // Brief backoff before reattaching from the cursor.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
