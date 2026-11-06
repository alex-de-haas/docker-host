"use client";

import { useEffect, useState } from "react";
import { call } from "./api";
import type { AssistantEvent } from "./assistant-api";
import { isFeedbackMessageReference, type FeedbackMessageReference, type FeedbackTranscript, type FeedbackTranscriptCard } from "../../../src/feedback/presentation";

export type { FeedbackTranscriptCard } from "../../../src/feedback/presentation";

export function feedbackReferenceForEvent(event: AssistantEvent): FeedbackMessageReference | undefined {
  return event.type === "user_message" && isFeedbackMessageReference(event.feedback)
    && typeof event.clientRequestId === "string" && event.feedback.dispatchId.toLowerCase() === event.clientRequestId.toLowerCase() ? event.feedback : undefined;
}

/** Match factual admission identity; message text is never a presentation discriminator. */
export function feedbackCardForEvent(event: AssistantEvent, cards: readonly FeedbackTranscriptCard[]): FeedbackTranscriptCard | undefined {
  if (event.type !== "user_message" || typeof event.clientRequestId !== "string") return;
  if (event.feedback !== undefined && !feedbackReferenceForEvent(event)) return;
  const requestId = event.clientRequestId.toLowerCase();
  const matches = cards.filter(card => card.version === 1 && card.messageSequence === event.seq && card.dispatchId.toLowerCase() === requestId);
  return matches.length === 1 ? matches[0] : undefined;
}

const EMPTY_CARDS: readonly FeedbackTranscriptCard[] = [];

export function useFeedbackTranscript(sessionId: string | undefined, events: readonly AssistantEvent[], ready: boolean): {
  cards: readonly FeedbackTranscriptCard[]; loading: boolean;
} {
  // One initial lookup covers legacy history. Only new trusted feedback references trigger another
  // lookup during a live conversation; streamed prose and ordinary prompts do not poll Core.
  const revision = events.some(event => event.type === "user_message")
    ? JSON.stringify(events.flatMap(event => feedbackReferenceForEvent(event) ? [[event.seq, event.clientRequestId]] : [])) : "";
  const enabled = !!sessionId && ready && !!revision;
  const key = `${sessionId ?? ""}:${revision}`;
  const [state, setState] = useState<{ key: string; sessionId: string; cards: readonly FeedbackTranscriptCard[] } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const controller = new AbortController(); let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const result = await (await call("/feedback/transcript?sessionId=" + encodeURIComponent(sessionId), { signal: controller.signal })).json() as FeedbackTranscript;
        if (!controller.signal.aborted && current === generation)
          setState({ key, sessionId, cards: Array.isArray(result.cards) ? result.cards : EMPTY_CARDS });
      } catch {
        // Ordinary chat history remains readable if feedback permission or retained data is gone.
        if (!controller.signal.aborted && current === generation) setState({ key, sessionId, cards: EMPTY_CARDS });
      }
    };
    void refresh();
    const focus = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", focus);
    return () => { controller.abort(); generation++; window.removeEventListener("focus", focus); };
  }, [enabled, key, sessionId]);

  return {
    cards: enabled && state?.sessionId === sessionId ? state.cards : EMPTY_CARDS,
    loading: enabled && state?.key !== key,
  };
}
