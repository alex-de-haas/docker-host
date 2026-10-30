export type FeedbackRect = { x: number; y: number; width: number; height: number };
export type FeedbackTarget = { kind: "element" | "region" | "page"; label?: string; selector?: string;
  bounds?: FeedbackRect; viewport?: { width: number; height: number; scale: number } };
export type FeedbackNoteInput = { id: string; text: string; route: string; capturedAt: string; target?: FeedbackTarget;
  image?: { mediaType: string; data: string } };
export type FeedbackSubmit = { requestId: string; comment: string; annotations: FeedbackNoteInput[]; scope?: { coreId: string; appId: string; installation: string; userId: string } };
export type FeedbackCapabilities = { version: 1; coreId: string; appId: string; installation: string; userId: string;
  maxAnnotations: number; maxImageBytes: number; maxTotalImageBytes: number; administrator?: boolean };
export type FeedbackNote = Omit<FeedbackNoteInput, "image"> & { mediaType: string | null };
export type FeedbackReport = { id: string; reporterId: string; comment: string; annotations: FeedbackNote[];
  context: { appId: string; appName: string; installation: string; version: string | null; observedAt: string;
    executionKind: string; workspaceId: string | null; sourceRevision: string | null };
  workspaceId: string | null; revision: number; status: string; currentAttemptId: string | null; disposition: string | null };
export type FeedbackSelection = { id: string; revision: number };
export type FeedbackDispatchInput = { requestId: string; sessionId: string; workspaceId: string | null;
  reports: FeedbackSelection[]; instruction: string; appContextRevision?: number; selectionRevision?: number };
export type FeedbackOutcome = { reportId: string; summary: string; handledAnnotationIds: string[]; handled: boolean };
export type FeedbackDispatch = { id: string; callerAppId: string; callerInstallation: string; actorId: string;
  input: FeedbackDispatchInput; snapshot: FeedbackReport[]; createdAt: string; state: string; messageSequence: number | null;
  workspaceId: string | null; outcomes: FeedbackOutcome[] | null; error: string | null };
export type FeedbackCollection = { reports: FeedbackReport[]; dispatches: FeedbackDispatch[] };
export type FeedbackDelivery = { state: string; messageSequence?: number; workspaceId?: string | null; error?: string };
export class FeedbackError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

