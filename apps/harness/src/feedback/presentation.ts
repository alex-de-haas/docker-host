import type { FeedbackDispatch } from "@hosty-sdk/app/feedback";

/** Persist only a trusted reference; retained Core snapshots supply the card's current content. */
export interface FeedbackMessageReference {
  version: 1;
  dispatchId: string;
}

export interface FeedbackPresentation {
  version: 1;
  dispatchId: string;
  instruction: string;
  reports: {
    id: string;
    appId: string;
    appName: string;
    version: string | null;
    comment: string;
    annotations: { id: string; text: string; route: string; hasImage: boolean }[];
  }[];
}

export type FeedbackTranscriptCard = FeedbackPresentation & { messageSequence: number };
export interface FeedbackTranscript { cards: FeedbackTranscriptCard[] }

export function isFeedbackMessageReference(value: unknown): value is FeedbackMessageReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Partial<FeedbackMessageReference>;
  return reference.version === 1 && typeof reference.dispatchId === "string"
    && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(reference.dispatchId);
}

/** A deleted/partly redacted batch falls back to its original transcript text. */
export function feedbackPresentation(dispatch: Pick<FeedbackDispatch, "id" | "input" | "snapshot">): FeedbackPresentation | null {
  if (!dispatch.snapshot.length || dispatch.snapshot.length !== dispatch.input.reports.length ||
    dispatch.snapshot.some(report => !dispatch.input.reports.some(selected => selected.id === report.id))) return null;
  return {
    version: 1,
    dispatchId: dispatch.id,
    instruction: dispatch.input.instruction,
    reports: dispatch.snapshot.map(report => ({
      id: report.id, appId: report.context.appId, appName: report.context.appName, version: report.context.version,
      comment: report.comment,
      annotations: report.annotations.map(note => ({ id: note.id, text: note.text, route: note.route, hasImage: !!note.mediaType })),
    })),
  };
}
