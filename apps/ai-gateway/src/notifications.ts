// Telling the operator that a session is waiting for them.
//
// This is the sharper half of what makes an agent session unlike the fleet's other background work.
// A transcode has a defined end and deterministic progress; an agent session that stops on an
// approval or a question is *waiting for a person*, indefinitely, and the operator finds out only by
// opening the panel and looking.
//
// Fire-and-forget, like the audit reporter beside it: a session must keep working when Core is
// briefly unreachable. A missed notification costs a slower reply; a session that failed because a
// notification could not be delivered would be a far worse trade.

/** Statuses that mean "a person is required", and nothing else. */
const WAITING_STATUSES = new Set(["awaiting_approval", "awaiting_question"]);

export function isWaitingStatus(status: string): boolean {
  return WAITING_STATUSES.has(status);
}

/**
 * One notification per session, replaced rather than repeated.
 *
 * A session can enter a waiting status many times in one run — every approval is another — and an
 * inbox with one row per approval is an inbox nobody reads. Core dedupes on this key, so the newest
 * wait supersedes the previous rather than stacking beside it.
 */
export function dedupeKeyFor(sessionId: string): string {
  return `assistant.session.${sessionId}`;
}

export class WaitingNotifier {
  private warned = false;

  constructor(
    private readonly coreOrigin: string | null,
    private readonly serviceToken: string | null,
    private readonly appId: string,
  ) {}

  /**
   * Announces that one session needs its operator.
   *
   * Targeted at the person who started the session, not broadcast: another administrator being told
   * that someone else's agent is waiting is noise they cannot act on, and the plan's audience rule
   * says the same — an app may notify a user, never the host-admin audience.
   */
  waiting(sessionId: string, status: string, createdBy: string | null): void {
    if (!this.coreOrigin || !this.serviceToken || !createdBy) {
      return;
    }

    const asking = status === "awaiting_question";
    void fetch(`${this.coreOrigin}/api/internal/apps/${encodeURIComponent(this.appId)}/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.serviceToken}` },
      body: JSON.stringify({
        target: createdBy,
        level: "info",
        title: asking ? "The assistant has a question" : "The assistant needs approval",
        // No transcript content: what the agent proposed is in the session, and an inbox row is not
        // the place to repeat text the operator has not approved yet.
        body: asking
          ? "A session is paused until you answer."
          : "A session is paused until you allow or deny an action.",
        link: "/",
        dedupeKey: dedupeKeyFor(sessionId),
      }),
      signal: AbortSignal.timeout(1_500),
    })
      .then((response) => {
        if (!response.ok && !this.warned) {
          this.warned = true;
          console.warn(`[notify] Core returned ${response.status}; further failures muted`);
        }
      })
      .catch(() => {
        if (!this.warned) {
          this.warned = true;
          console.warn("[notify] Core unreachable; further failures muted");
        }
      });
  }
}
