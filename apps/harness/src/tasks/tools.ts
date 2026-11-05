export const taskActions = ["task-executor-options", "task-options", "task-list", "task-get", "task-create", "task-edit", "task-action", "task-result", "task-fail", "task-request-input", "task-legacy-list", "task-legacy-action",
  "task-adopt", "task-prepare-executor", "task-delegate", "task-wait", "task-plan", "task-bind-workspace", "task-execution-get"] as const;
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const id = { type: "string", format: "uuid" }, revision = { type: "integer", minimum: 1 }, counter = { type: "integer", minimum: 0 };
const text = (maxLength: number) => ({ type: "string", maxLength });
const provider = object({ appId: text(200), installationId: text(200), key: text(100) }, ["appId", "installationId", "key"]);
const ref = object({ ...provider.properties, id }, ["appId", "installationId", "key", "id"]);
const refs = { type: "array", items: ref, maxItems: 100 };
const selection = object({ kind: { enum: ["option", "configuration"] }, id: text(200), revision }, ["kind", "id", "revision"]);
const resource = object({ kind: { enum: ["app", "workspace", "external"] }, owner: text(200), id: text(2000), label: text(200),
  version: { oneOf: [object({ mode: { const: "live" } }, ["mode"]), object({ mode: { const: "pinned" }, revision: text(200) }, ["mode", "revision"])] } }, ["kind", "owner", "id", "version"]);
const resources = { type: "array", items: resource, maxItems: 32 };
const review = object({ mode: { enum: ["none", "owner", "delegator"] } }, ["mode"]);
const assignee = { oneOf: [{ type: "null" }, object({ kind: { const: "human" }, userId: text(200), name: text(200) }, ["kind", "userId"]),
  object({ kind: { const: "app" }, executor: provider, selection, name: text(200) }, ["kind", "executor"])] };
const input = object({ title: text(200), markdown: text(32000), assignee, review, resources, parentTaskRef: { oneOf: [ref, { type: "null" }] }, dependsOn: refs },
  ["title", "markdown", "assignee", "resources"]);
const outcome = object({ taskRef: ref, inputRevision: revision, executionId: { oneOf: [id, { type: "null" }] }, resultRevision: revision }, ["taskRef", "inputRevision", "executionId", "resultRevision"]);
const result = object({ markdown: text(32000), resources }, ["markdown", "resources"]);
const requestId = { ...id, description: "A fresh globally unique UUID for a new operation. Never reuse sample IDs or IDs from another chat or task. Retain this exact UUID and input only when recovering the same operation." };
const mutation = { requestId, expectedRevision: revision };
const writeScope = object({ mode: { enum: ["read", "write", "exclusive"] }, paths: { type: "array", items: text(2000), maxItems: 100 } }, ["mode", "paths"]);
const schemas: Record<typeof taskActions[number], ReturnType<typeof object>> = {
  "task-legacy-list": object({ cursor: counter }),
  "task-legacy-action": object({ requestId, id: text(64), action: { enum: ["remove", "restore"] } }, ["requestId", "id", "action"]),
  "task-executor-options": object({}),
  "task-options": object({ executor: provider }),
  "task-list": object({ cursor: text(200), limit: { type: "integer", minimum: 1, maximum: 100 }, status: { enum: ["Draft", "Ready", "InProgress", "Blocked", "Done", "Cancelled"] }, parentTaskRef: ref, rootTaskRef: ref, rootsOnly: { type: "boolean" }, removed: { type: "boolean" } }),
  "task-get": object({ taskId: id }, ["taskId"]),
  "task-create": object({ requestId, expectedGraphRevision: revision, input }, ["requestId", "input"]),
  "task-edit": object({ ...mutation, taskId: id, expectedGraphRevision: revision, input }, ["requestId", "expectedRevision", "taskId", "expectedGraphRevision", "input"]),
  "task-action": object({ ...mutation, taskId: id, action: { enum: ["ready", "draft", "start", "complete", "cancel", "accept", "request_changes", "retry", "disposition", "remove", "restore"] },
    removalScope: { type: "array", minItems: 1, maxItems: 100, items: object({ taskRef: ref, revision }, ["taskRef", "revision"]) },
    result, resultRef: outcome, feedback: text(4000), selection,
    disposition: object({ kind: { enum: ["superseded", "not_required"] }, reason: text(2000), replacementRefs: refs }, ["kind", "reason", "replacementRefs"]) }, ["requestId", "expectedRevision", "taskId", "action"]),
  "task-result": object({ requestId, completed: { const: true, description: "Attest that the requested work and required checks are complete; an unfinished blocker is not success." }, result }, ["requestId", "completed", "result"]),
  "task-fail": object({ requestId, result }, ["requestId", "result"]),
  "task-request-input": object({ requestId, reason: text(2000), questions: { type: "array", minItems: 1, maxItems: 4,
    items: object({ id: text(100), header: text(100), question: text(4000), isOther: { type: "boolean" },
      options: { type: "array", maxItems: 8, items: object({ label: text(500), description: text(2000) }, ["label", "description"]) } }, ["id", "header", "question"]) } }, ["requestId", "reason", "questions"]),
  "task-adopt": object({ requestId, title: text(200), markdown: text(32000), resources, review,
    selectionRevision: counter, contextRevision: counter, autonomyRevision: counter }, ["requestId", "title", "markdown", "resources", "selectionRevision", "contextRevision", "autonomyRevision"]),
  "task-prepare-executor": object({ requestId, directoryRevision: counter, option: object({ id: text(200), revision }, ["id", "revision"]),
    name: text(100), rationale: text(2000), instructions: text(32000), skillIds: { type: "array", items: text(200), maxItems: 64 } }, ["requestId", "directoryRevision"]),
  "task-delegate": object({ requestId, expectedGraphRevision: revision, title: text(200), markdown: text(32000), resources, selection,
    rationale: text(2000), dependsOn: refs, writeScope }, ["requestId", "expectedGraphRevision", "title", "markdown", "resources", "selection", "rationale"]),
  "task-wait": object({ requestId, children: refs, mode: { enum: ["any", "all"] },
    observed: { type: "array", maxItems: 100, items: object({ taskRef: ref, taskRevision: counter }, ["taskRef", "taskRevision"]) } }, ["requestId", "children", "mode"]),
  "task-plan": object({ requestId, expectedRevision: counter, markdown: text(32000) }, ["requestId", "expectedRevision", "markdown"]),
  "task-bind-workspace": object({ requestId, expectedRevision: counter, workspaceId: text(200),
    prepare: object({ appId: text(200), name: text(120), targetBranch: text(200) }, ["appId", "name"]) }, ["requestId", "expectedRevision"]),
  "task-execution-get": object({ cursor: text(200), limit: { type: "integer", minimum: 1, maximum: 100 } }),
};
const descriptions: Record<typeof taskActions[number], string> = {
  "task-legacy-list": "List bounded owner-visible quarantined legacy records. They cannot execute. Removal only hides a retained record and is reversible.",
  "task-legacy-action": "Remove or restore one exact retained legacy record without changing its original bytes, sessions or resources. Task-bound agents cannot use this operation.",
  "task-executor-options": "Read this Harness executor directory: saved profile descriptions, immutable revisions and availability. Use this session-owned tool to choose task performers and recheck setup after a Decision. It never creates profiles.",
  "task-options": "Read the current executor directory: profile descriptions, immutable selection revisions and known availability. Choose existing profiles first.",
  "task-list": "List visible tasks with optional ancestry filters; in an admitted execution, read the current tree.",
  "task-get": "Read a task's current revisions, accepted outcomes and retained attempts before changing it.",
  "task-create": "Create a Draft task, preserving requestId on retry. An admitted execution creates only direct children of its bound task; use task_delegate for armed delegated work.",
  "task-edit": "Replace a stopped Draft's input with current task and graph revisions. Parent is immutable.",
  "task-action": "Apply a common lifecycle action. Review direct children using exact resultRef; request_changes needs feedback. Retry only after confirmed stop, preserving the task and its history. remove/restore require the complete reviewed removalScope of taskRef and revision, preserve history and resources, and are unavailable to task-bound agents.",
  "task-result": "Report successful completion only after required work, child review and verification. Set completed=true to attest success. Never report an unfinished blocker here. Then finish the turn.",
  "task-fail": "Report an unsuccessful terminal attempt with diagnostic evidence, then finish. This leaves the task Blocked, not Done. For missing human input use task_request_input instead so the same attempt can continue.",
  "task-request-input": "Request mandatory human information or setup intervention for this task through Decisions. Supply stable question IDs and a reason; never request secrets. After the durable acknowledgement, yield immediately without task_result or polling. The same task resumes after the answer; recheck setup prerequisites against real state. Use native nonblocking questions only for optional clarification.",
  "task-adopt": "Start task work from chat by creating or recovering one root and adopting this same session. Read session revisions with task_execution_get first. Normal mode requires the owner's Decisions approval; never launch children before admission.",
  "task-prepare-executor": "Choose a saved option at the current directory revision. Only when no profile fits, supply name, rationale, instructions and installed skillIds for a one-off child. It inherits this session's connection/model; no catalog profile is created.",
  "task-delegate": "Create and arm a direct child under this admitted task with the chosen selection and rationale. Dependencies require accepted results; every child has a fresh session and delegator review. Unknown write scope is exclusive.",
  "task-wait": "Register a durable wait for direct child outcomes. Include each observed child taskRevision to avoid replaying known results; task revisions remain monotonic across execution attempts. If pending, yield the turn immediately: Worker parks it and resumes the same context after a relevant result or failure, without polling.",
  "task-plan": "Save a versioned execution plan for this root without altering its admitted objective. Use expectedRevision 0 for the first plan.",
  "task-bind-workspace": "Select or prepare the root's optional authorized workspace. All descendant and retained sessions share its association. This grants no lifecycle or publication authority.",
  "task-execution-get": "Read this session's task binding, root plan, limits and bounded child results. Before adoption, read the current session revisions and mode.",
};
export const taskTools = () => taskActions.map(action => ({ name: action.replaceAll("-", "_"), description: descriptions[action], inputSchema: schemas[action],
  annotations: { readOnlyHint: ["task-executor-options", "task-options", "task-list", "task-get", "task-execution-get", "task-legacy-list"].includes(action), destructiveHint: ["task-action", "task-legacy-action"].includes(action), openWorldHint: false } }));

export const TASK_ORCHESTRATION_GUIDE = `Task execution: use a fresh globally unique request UUID for every new operation, never a repeated sample or counter from another chat. Retain the exact UUID and input when retrying an uncertain operation. Ordinary chat work stays in this independent session and uses an authorized workspace when source changes require one; do not create or adopt Tasks merely because work has multiple steps or the session is Autonomous. Start Tasks only when the user explicitly requests task orchestration or the selected profile explicitly requires Tasks for this work. A profile name such as manager alone is not an instruction. When Tasks are requested or required, use task_execution_get and task_adopt to create one root and bind this conversation. The remaining task orchestration instructions apply to task-bound work. Wait for explicit user consent when Normal must become Autonomous. Reuse the bound root; never create unrelated roots to evade limits. Read task_executor_options and prefer configured profiles by description. task_prepare_executor supplies one-off instructions and installed skills only when those profiles do not fit. Delegate through task_delegate so children retain attribution, history and limits; do not substitute invisible native subagents. Each task attempt owns a fresh session. Record a plan with task_plan, accepted prerequisites for ordering and conservative write scopes for concurrent work. Park with task_wait instead of polling. Review each direct child's exact resultRef with task_action before accepting it. Failures and uncertain exits are not success or permission to duplicate execution. Missing mandatory input or setup requires task_request_input and yielding for the durable Decision; an ordinary chat question is insufficient. Use task_fail for an unsuccessful terminal attempt. Complete only after required children and verification are accepted, report task_result with completed=true, then finish. Task mode never overrides repository planning, publication or explicit Ask/Disabled rules.`;
