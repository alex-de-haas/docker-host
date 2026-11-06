/** Core's version-one task contract. References bind an installation; numbers are display labels. */
export type TaskProviderRef = { appId: string; installationId: string; key: string };
export type TaskRef = TaskProviderRef & { id: string };
export type TaskStatus = "Draft" | "Ready" | "InProgress" | "Blocked" | "Done" | "Cancelled";
export type TaskResource = {
  kind: "app" | "workspace" | "external"; owner: string; id: string; label?: string;
  version: { mode: "live" } | { mode: "pinned"; revision: string };
};
export type TaskSelection = { kind: "option" | "configuration"; id: string; revision: number };
export type TaskAssignee = { kind: "human"; userId: string; name?: string }
  | { kind: "app"; executor: TaskProviderRef; selection?: TaskSelection; name?: string };
export type TaskReview = { mode: "none" | "owner" | "delegator" };
export type TaskInput = {
  title: string; markdown: string; assignee: TaskAssignee | null; resources: TaskResource[];
  review: TaskReview; parentTaskRef: TaskRef | null; dependsOn: TaskRef[];
};
export type TaskActor = { userId: string | null; appId: string | null; installationId?: string };
export type TaskResult = { markdown: string; resources: TaskResource[] };
export type TaskOutcomeRef = { taskRef: TaskRef; inputRevision: number; executionId: string | null; resultRevision: number };
export type TaskExecutionState = "accepted" | "running" | "awaiting_input" | "cancelling"
  | "completed" | "failed" | "cancelled" | "interrupted";
export type TaskExecutionInput = {
  version: 1; taskRef: TaskRef; inputRevision: number; selection?: TaskSelection;
  content: Pick<TaskInput, "title" | "markdown" | "resources" | "review">;
  relations: { rootTaskRef: TaskRef; parentTaskRef: TaskRef | null; relationRevision: number };
  prerequisiteOutcomes: TaskOutcomeRef[];
};
export type TaskExecutionReceipt = {
  childOutcomes?: TaskOutcomeRef[];
  executionId: string; revision: number; state: TaskExecutionState; stopConfirmed: boolean;
  /** A parked native segment is stopped while its business attempt remains active. */
  nativeStopConfirmed?: boolean;
  wait?: { kind: "children" | "human" | "mode" | "source" | "limits"; reference: string };
  createdAt: string; updatedAt: string; result?: TaskResult;
  error?: { code: string; message: string };
  /** Absolute HTTP(S) for cross-app readers; same-app readers may resolve a local path. */
  sessionRef?: { id: string; path: string };
};
export type TaskAttempt = {
  executionId: string; executor: TaskProviderRef; request: TaskExecutionInput;
  receipt?: TaskExecutionReceipt; cancelRequested: boolean; createdAt: string; invalidated?: boolean;
};
export type TaskOutcome = {
  ref: TaskOutcomeRef; result: TaskResult; childOutcomes?: TaskOutcomeRef[]; recordedAt: string; acceptedAt?: string; invalidated?: boolean;
};
export type TaskDisposition = { kind: "superseded" | "not_required"; reason: string; replacementRefs: TaskRef[] };
export type TaskCoordination = { rootGeneration: number; coordinatorEpoch: number; executionId: string };
export type TaskRecord = TaskInput & {
  removed?: { batchId: string; at: string; by: TaskActor };
  coordination?: TaskCoordination;
  ref: TaskRef; number: string; revision: number; inputRevision: number; status: TaskStatus;
  rootTaskRef: TaskRef; depth: number; relationRevision: number; graphRevision: number;
  createdBy: TaskActor; owner: TaskActor; createdAt: string; updatedAt: string;
  blocked?: { reason: string; message: string }; cancelRequested: boolean; armed: boolean;
  result?: TaskResult; resultRef?: TaskOutcomeRef; acceptedResultRef?: TaskOutcomeRef;
  attempts: TaskAttempt[]; outcomes: TaskOutcome[]; disposition?: TaskDisposition;
};
export type TaskMutation = { requestId: string; expectedRevision: number };
/** Defaults apply only to omitted optional fields; obsolete v1 fields are rejected. */
export type TaskInputWrite = Omit<TaskInput, "review" | "parentTaskRef" | "dependsOn"> & Partial<Pick<TaskInput, "review" | "parentTaskRef" | "dependsOn">>;
export type TaskCreate = { requestId: string; input: TaskInputWrite; expectedGraphRevision?: number };
export type TaskEdit = TaskMutation & { input: TaskInputWrite; expectedGraphRevision?: number };
export type TaskAction = TaskMutation & {
  action: "ready" | "draft" | "start" | "complete" | "cancel" | "accept" | "request_changes" | "retry" | "disposition" | "remove" | "restore";
  result?: TaskResult; resultRef?: TaskOutcomeRef; feedback?: string;
  selection?: TaskSelection; disposition?: TaskDisposition;
  removalScope?: Array<{ taskRef: TaskRef; revision: number }>;
};
export type TaskRequestReceipt = { requestId: string; state: "applied"; taskRef: TaskRef; result: TaskRecord };
export type TaskPage = { tasks: TaskRecord[]; nextCursor: string | null };
export type TaskListOptions = { cursor?: string; limit?: number; status?: TaskStatus; parentTaskRef?: TaskRef; rootTaskRef?: TaskRef; rootsOnly?: boolean; removed?: boolean };
export type TaskCapabilities = { version: 1; prefix: string; statuses: TaskStatus[]; maxPageSize: number; capabilities?: string[] };
export type TaskExecutorAvailability = { state: "available" | "unavailable" | "unknown"; reason?: string };
export type TaskExecutorOption = {
  id: string; revision: number; name: string; description: string; capabilities: string[];
  availability: TaskExecutorAvailability;
};
export type TaskExecutorOptions = { version: 1; revision: number; options: TaskExecutorOption[]; defaultId: string | null };
export const taskStatuses: TaskStatus[] = ["Draft", "Ready", "InProgress", "Blocked", "Done", "Cancelled"];
export const taskExecutionTerminal = (state: TaskExecutionState) => ["completed", "failed", "cancelled", "interrupted"].includes(state);
/** Collision-free opaque reference for cross-provider links and filters; grants no task access. */
export const taskReferenceKey = (ref: TaskRef): string => JSON.stringify([ref.appId, ref.installationId, ref.key, ref.id]);
