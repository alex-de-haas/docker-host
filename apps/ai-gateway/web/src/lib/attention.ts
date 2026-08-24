"use client";

// Which sessions are waiting for a person, and telling the embedder so its tab can say so.

/** The statuses that mean a person is required. Mirrors the gateway's own list. */
const WAITING = new Set(["awaiting_approval", "awaiting_question"]);

export function isWaiting(status: string): boolean {
  return WAITING.has(status);
}

export type Listed = { id: string; status: string; createdAt: string };

/**
 * Blocked sessions first, then newest.
 *
 * "Running in the background" means "waiting for you" at least as often as it means "working", and a
 * list that does not separate those is close to useless — the operator scrolls a chronological list
 * looking for the one row that needs them.
 */
export function orderSessions<T extends Listed>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => {
    const blocked = Number(isWaiting(right.status)) - Number(isWaiting(left.status));
    return blocked !== 0 ? blocked : Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });
}

export function waitingCount(sessions: readonly Listed[]): number {
  return sessions.filter((session) => isWaiting(session.status)).length;
}

/** The message an embedder reads to badge its tab. */
export const ATTENTION_MESSAGE = "hosty:assistant-attention";

/**
 * Publishes the count to whoever embedded this page.
 *
 * Posted from here rather than polled by the embedder: this page already holds the session list and
 * an open event stream, so it is the one source. A shell polling the gateway for the same fact would
 * be a second source that disagrees with this one for as long as its interval.
 *
 * Broadcast, because the count is not a secret and the embedder verifies the sender against its own
 * DOM rather than trusting anything claimed here.
 */
export function publishAttention(count: number): void {
  if (typeof window === "undefined" || window.parent === window) {
    return;
  }

  try {
    window.parent.postMessage({ type: ATTENTION_MESSAGE, count }, "*");
  } catch {
    // An embedder that cannot be posted to simply shows no badge.
  }
}
