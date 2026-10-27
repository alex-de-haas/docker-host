/** Core's version-one task contract. Numbers are opaque; references bind an installation. */
export type TaskProviderRef = { appId: string; installationId: string; key: string };
export type TaskRef = TaskProviderRef & { id: string };
export type TaskStatus = "Draft" | "Ready" | "InProgress" | "Blocked" | "Done" | "Cancelled";
export type TaskResource = {
  kind: "app" | "workspace" | "external"; owner: string; id: string; label?: string;
  version: { mode: "live" } | { mode: "pinned"; revision: string };
};
export type TaskAssignee = { kind: "human"; userId: string; name?: string }
  | { kind: "app"; executor: TaskProviderRef; optionId?: string; name?: string };
export type TaskInput = {
  title: string; markdown: string; assignee: TaskAssignee | null; requiresReview: boolean;
  resources: TaskResource[]; workspaceId?: string;
};
export type TaskActor = { userId: string | null; appId: string | null; installationId?: string };
export type TaskResult = { markdown: string; resources: TaskResource[] };
export type TaskExecutionState = "accepted" | "running" | "awaiting_input" | "cancelling"
  | "completed" | "failed" | "cancelled" | "interrupted";
export type TaskExecutionInput = {
  taskRef: TaskRef; taskRevision: number; executorOptionId?: string;
  input: Omit<TaskInput, "assignee">;
};
export type TaskExecutionReceipt = {
  executionId: string; revision: number; state: TaskExecutionState; stopConfirmed: boolean;
  createdAt: string; updatedAt: string; result?: TaskResult;
  error?: { code: string; message: string }; /** An absolute HTTP(S) UI URL for cross-app readers; same-app readers can resolve a local path. */
  sessionRef?: { id: string; path: string };
};
export type TaskAttempt = {
  executionId: string; executor: TaskProviderRef; request: TaskExecutionInput;
  receipt?: TaskExecutionReceipt; cancelRequested: boolean; createdAt: string;
};
export type TaskOutcome = { inputRevision: number; result: TaskResult; recordedAt: string; executionId?: string };
export type TaskRecord = TaskInput & {
  ref: TaskRef; number: string; revision: number; inputRevision: number; status: TaskStatus;
  createdBy: TaskActor; owner: TaskActor; createdAt: string; updatedAt: string;
  blocked?: { reason: string; message: string }; cancelRequested: boolean;
  result?: TaskResult; resultInputRevision?: number; attempts: TaskAttempt[]; outcomes?: TaskOutcome[];
};
export type TaskMutation = { requestId: string; expectedRevision: number };
export type TaskInputWrite = Omit<TaskInput, "requiresReview"> & { requiresReview?: boolean };
export type TaskCreate = { requestId: string; input: TaskInputWrite };
export type TaskEdit = TaskMutation & { input: TaskInputWrite };
export type TaskAction = TaskMutation & {
  action: "ready" | "draft" | "start" | "complete" | "cancel" | "accept" | "request_changes";
  result?: TaskResult; resultInputRevision?: number; feedback?: string;
};
export type TaskPage = { tasks: TaskRecord[]; nextCursor: string | null };
export type TaskCapabilities = { version: 1; prefix: string; statuses: TaskStatus[]; maxPageSize: number };
export type TaskExecutorOption = { id: string; name: string; capabilities: string[] };
export type TaskExecutorOptions = { options: TaskExecutorOption[]; defaultId: string | null };
export const taskStatuses: TaskStatus[] = ["Draft", "Ready", "InProgress", "Blocked", "Done", "Cancelled"];
export const taskExecutionTerminal = (state: TaskExecutionState) => ["completed", "failed", "cancelled", "interrupted"].includes(state);
