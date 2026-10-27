export const taskActions = ["task-options", "task-list", "task-get", "task-create", "task-edit", "task-action", "task-result"] as const;
const descriptions = {
  "task-options": "Discover task provider, human assignees and installed execution apps. Supply executor {appId, installationId, key} to get its opaque choices and defaultId. Harness profiles are not shared.",
  "task-list": "List tasks visible to this session's owner. Tasks need no documents or workspace.",
  "task-get": "Read a task and its current revision before editing or changing status.",
  "task-create": "Create a Draft task. Reuse requestId after a lost reply. Input includes title, markdown, assignee, requiresReview and resources. References grant no access.",
  "task-edit": "Replace Draft task input using its current expectedRevision and a stable requestId. Active or uncertain executions must stop first.",
  "task-action": "Apply ready, draft, start, complete, cancel, accept or request_changes. Ready dispatches app-assigned tasks. Review requires resultInputRevision; request_changes also requires feedback.",
  "task-result": "Report the explicit outcome of the task bound to this execution. Supply requestId and result with markdown and resources. This does not finish the native turn: finish normally after reporting. Ordinary model output alone does not complete a task.",
};
export const taskTools = () => taskActions.map(action => ({ name: action.replaceAll("-", "_"), description: descriptions[action],
  inputSchema: { type: "object", properties: {
    executor: { type: "object", properties: { appId: { type: "string" }, installationId: { type: "string" }, key: { type: "string" } }, required: ["appId", "installationId", "key"] },
    taskId: { type: "string", format: "uuid" }, requestId: { type: "string", format: "uuid" },
    expectedRevision: { type: "integer", minimum: 1 }, input: { type: "object", properties: {
      title: { type: "string", maxLength: 200 }, markdown: { type: "string", maxLength: 32000 },
      requiresReview: { type: "boolean", default: false }, workspaceId: { type: "string" },
      assignee: { description: "null, {kind: human, userId, name?}, or {kind: app, executor: {appId, installationId, key}, optionId?, name?}; discover values with task_options." },
      resources: { type: "array", description: "Owned references: {kind: app|workspace|external, owner, id, label?, version: {mode: live} or {mode: pinned, revision}}. References grant no access." },
    }, required: ["title", "markdown", "assignee", "resources"] },
    action: { type: "string", enum: ["ready", "draft", "start", "complete", "cancel", "accept", "request_changes"] },
    result: { type: "object", properties: { markdown: { type: "string", maxLength: 32000 }, resources: { type: "array" } }, required: ["markdown", "resources"] },
    resultInputRevision: { type: "integer" }, feedback: { type: "string", maxLength: 4000 },
    cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 },
  }, additionalProperties: false }, annotations: { readOnlyHint: action === "task-options" || action === "task-list" || action === "task-get", destructiveHint: false, openWorldHint: false } }));
