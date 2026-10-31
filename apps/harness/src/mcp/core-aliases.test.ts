import { expect, it } from "vitest";
import { canonicalAlias } from "./core-aliases.js";
import { coreAliases } from "./core-migration.js";
const context = { sessionId: "conversation-one", leaseId: "native-lease", workspaceId: "aggregate", taskProvider: { appId: "independent.tasks", installationId: "install", key: "chosen" } };
it("adapts every reviewed alias without discovering private tools by prefix", () => {
  for (const [alias, name] of Object.entries(coreAliases)) expect(canonicalAlias(alias.replaceAll("_", "-"), { workspaceId: "tree" }, context)?.name).toBe(name);
  for (const name of ["context-list", "task-result", "unreviewed-platform-action"]) expect(canonicalAlias(name, {}, context)).toBeNull();
});
it("preserves explicit merge inputs and distinguishes target and upstream merges", () => {
  const input = { workspaceId: "tree", requestId: "original-id", expectedHead: "reviewed", allowUnrelatedHistories: true };
  expect(canonicalAlias("merge-upstream", input, context)).toEqual({ name: "merge_workspace_upstream", arguments: {
    workspaceId: "tree", input: { requestId: "original-id", expectedHead: "reviewed", allowUnrelatedHistories: true } } });
  expect(canonicalAlias("merge", input, context)).toEqual({ name: "merge_workspace_target", arguments: input });
});
it("preserves creation request IDs, supplies the client allocation context and requires a lease", () => {
  const input = { requestId: "original-id", appId: "new.app", bootstrapCommit: true };
  const call = canonicalAlias("app-create", input, context)!;
  expect(call.arguments).toEqual({ input: { taskId: context.sessionId, leaseId: context.leaseId, input,
    navigationPath: "/assistant?session=conversation-one" } });
  expect(() => canonicalAlias("prepare", input, { sessionId: "chat" })).toThrow("activity lease");
});
it("qualifies old task IDs by the original provider and keeps executor selection explicit", () => {
  expect(canonicalAlias("task-get", { taskId: "task-id" }, context)?.arguments).toEqual({ input: { taskRef: { ...context.taskProvider, id: "task-id" } } });
  const input = { taskId: "task-id", requestId: "original-id", expectedRevision: 4, action: "ready" };
  expect(canonicalAlias("task-action", input, context)?.arguments).toEqual({ input: { taskRef: { ...context.taskProvider, id: "task-id" }, input: { requestId: "original-id", expectedRevision: 4, action: "ready" } } });
  expect(() => canonicalAlias("task-list", {}, { sessionId: "chat" })).toThrow("provider installation");
});
it("does not infer a work lifecycle target when the conversation has none", () => {
  expect(() => canonicalAlias("workflow-pause", { requestId: "id" }, { sessionId: "chat" })).toThrow("no associated workspace");
  expect(canonicalAlias("workflow-pause", { requestId: "id", expectedRevision: 2 }, context)?.arguments)
    .toEqual({ input: { workspaceId: "aggregate", input: { requestId: "id", expectedRevision: 2 } } });
});
