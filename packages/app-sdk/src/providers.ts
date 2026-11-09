/** Provider categories supported by Core. Task execution does not expose model/profile configuration. */
export type ProviderKind = "speech-to-text" | "assistant" | "translation" | "tasks" | "task-executor" | "conversation-history" | "agent-sessions";
export type ProviderDescriptor = {
  appId: string; displayName: string; kind: ProviderKind; key: string;
  version: number | null; capabilities: string[]; url: string | null; available: boolean;
  /** Declared browser surfaces for resolving assistant handoffs; absent on older Core versions. */
  uiSurfaces?: Array<{ endpoint: string | null; path: string; url: string | null;
    kind?: "panel" | "navigation" | "entrypoint"; panelId?: string | null }> | null;
  /** Opaque Core installation identity; compare for equality, never parse. */
  installationId?: string | null;
};
export type AppPermissionState = { required: string[]; optional: string[]; granted: string[]; reviewAvailable?: boolean; unsupportedRequired?: string[]; status?: string };
export type ProviderInvocation = { callerAppId: string; callerInstallation: string; userId: string | null; hostRole: string | null; kind: ProviderKind; key: string };
/** Core-mediated v2 invocations carry the original principal; direct clients have no app identity. */
export type MediatedProviderInvocation = {
  taskWorkflow?: TaskWorkflowBinding;
  version: 2; callerAppId: string | null; callerInstallation: string | null; userId: string; hostRole: string;
  principalId: string; kind: ProviderKind; key: string; operation: string; resourceIds: string[];
  taskDispatch?: TaskDispatchRef | null;
  taskDelegation?: { dispatch: TaskDispatchRef; taskRef: import("./tasks.js").TaskRef; executionId: string | null } | null;
  export?: { grantId: string; revision: string; ownerUserId: string; provider: import("./agent-sessions.js").ProviderRef; conversationIds: string[] | null } | null;
};
/** The provider computes these values from the actual incoming request, never from unverified claims. */
export type MediatedProviderRequest = { operation: string; method: string; path: string; body: Uint8Array | string };
export type SpeechResult = { text: string; language?: string | null };
export type SpeechCapabilities = { version: 1; mediaTypes: string[]; maxBytes: number; maxDurationSeconds: number; backend: string; ready: boolean };
export type TranslationRequest = { text: string; targetLanguage: string; sourceLanguage?: string; format?: "text" | "markdown" };
export type TranslationResult = { text: string; targetLanguage: string; sourceLanguage: string };
export type TranslationCapabilities = { version: 1; formats: string[]; maxCharacters: number; maxSegmentCharacters: number; maxBytes: number; maxOutputBytes: number; timeoutSeconds: number; backend: string; ready: boolean; reason?: string };

/** Errors retain Core/provider codes so consumers can distinguish denial from unavailable service. */
export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

/** Non-secret receipt reference. Only its reviewed source and executor installations can use it. */
export type TaskDispatchRef = { userId: string; principalId: string; requestId: string };
export type TaskDispatchScope = { taskRef: import("./tasks.js").TaskRef; executor: import("./tasks.js").TaskProviderRef;
  inputRevision: number; inputHash: string; selection: import("./tasks.js").TaskSelection | null; executionId: string | null; workspaceId?: string | null; executionHash?: string | null };
export type TaskDispatchRequest = { dispatch: TaskDispatchRef; executor: import("./tasks.js").TaskProviderRef;
  operation: "options" | "get" | "accept" | "cancel"; executionId?: string; input?: import("./tasks.js").TaskExecutionInput; requestId?: string };

/** Executor-only access to the workspace already selected by an immutable task attempt. */
export type TaskSourceReference = { rootDispatch: TaskDispatchRef; contextId: string; contextRevision: number; workspaceId: string };
export type TaskWorkspaceRequest = {
  dispatch: TaskDispatchRef; executionId: string; sessionId: string; leaseId: string;
  kind: "observe" | "attach" | "lease" | "activity" | "associate_history" | "history_observe";
  source?: TaskSourceReference; taskRef?: import("./tasks.js").TaskRef;
  requestId?: string; expectedRevision?: number; title?: string; navigationPath?: string;
  activity?: { status: string; leaseId: string; stopped?: boolean; title?: string; sequence?: number };
};

/** Exact current coordinator identity, constructed by Core rather than a model argument. */
export type TaskWorkflowBinding = {
  rootDispatch: TaskDispatchRef; rootTaskRef: import("./tasks.js").TaskRef;
  parentTaskRef: import("./tasks.js").TaskRef; parentExecutionId: string;
  coordinatorEpoch: number; rootGeneration: number;
};
export type TaskWorkflowRequest = Omit<TaskWorkflowBinding, "rootTaskRef"> & {
  requestId: string; operation: "create_child" | "edit" | "read" | "action" | "observe" | "bind_session" | "prepare_source" | "bind_source" | "observe_source";
  payload: Record<string, unknown>;
};
