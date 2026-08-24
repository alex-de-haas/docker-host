"use client";

// Unsent text, kept per session in this browser.
//
// The gateway never sees a draft — it only learns of text when it is sent — so the client is the only
// place that can keep one. Reported 2026-08-18: text typed, panel closed to go copy an error message,
// text gone. Docking the panel removed the reason to close it; this removes the loss on reload, which
// docking does nothing about.
//
// Per session rather than one global draft: switching sessions and finding someone else's half-written
// sentence in the box would be its own kind of loss.

const PREFIX = "hosty.assistant.draft.";

/** Long enough for any real message; short enough that local storage cannot be filled from the box. */
const MAX_DRAFT_CHARS = 32_000;

/**
 * Reads, writes and clears are each guarded.
 *
 * Local storage throws in private modes and when a quota is reached, and a draft is a convenience:
 * losing one is the cost this feature exists to reduce, but *failing to open the assistant* because
 * a draft could not be stored would be a far worse trade.
 */
export function readDraft(sessionId: string): string {
  try {
    return window.localStorage.getItem(PREFIX + sessionId) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(sessionId: string, text: string): void {
  try {
    if (text.trim()) {
      window.localStorage.setItem(PREFIX + sessionId, text.slice(0, MAX_DRAFT_CHARS));
    } else {
      // An emptied box is a decision too: leaving the old text behind would resurrect something the
      // operator deliberately cleared.
      window.localStorage.removeItem(PREFIX + sessionId);
    }
  } catch {
    // Nothing to recover: the draft stays in the box for this page's lifetime, which is what the
    // operator can see anyway.
  }
}

export function clearDraft(sessionId: string): void {
  try {
    window.localStorage.removeItem(PREFIX + sessionId);
  } catch {
    // Ignored for the same reason.
  }
}

/**
 * Drops drafts belonging to sessions that no longer exist.
 *
 * Without this the store grows for the lifetime of the browser profile: every session ever opened
 * leaves a key behind, and the operator has no way to see or clear them.
 */
export function pruneDrafts(liveSessionIds: readonly string[]): void {
  try {
    const live = new Set(liveSessionIds);
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PREFIX) && !live.has(key.slice(PREFIX.length))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignored: an unprunable store is untidy, never wrong.
  }
}
