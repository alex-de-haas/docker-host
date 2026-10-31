import { coreAliases } from "./core-migration.js";
import { AppContextError } from "../sessions/app-context.js";
import type { TaskProviderRef } from "@hosty-sdk/app/tasks";

export interface LegacyCoreContext {
  sessionId: string;
  leaseId?: string;
  workspaceId?: string;
  taskProvider?: TaskProviderRef;
}
export interface CanonicalCall { name: string; arguments: Record<string, unknown> }
const select = (input: Record<string, unknown>, names: string[]) => Object.fromEntries(names.filter(n => input[n] !== undefined).map(n => [n, input[n]]));
/** Compatibility only. The current Core catalog owns discovery and all invocation authority. */
export function canonicalAlias(action: string, input: Record<string, unknown>, context: LegacyCoreContext): CanonicalCall | null {
  const alias = action.replaceAll("-", "_"), name = action === "workflow-pause-confirm" ? "workflow_pause" : coreAliases[alias];
  if (!name) return null;
  const call = (args: Record<string, unknown>): CanonicalCall => ({ name, arguments: args });
  const nested = (value: Record<string, unknown>) => call({ input: value });
  const workspace = () => {
    if (!context.workspaceId) throw new AppContextError(409, "workspace_missing", "This conversation has no associated workspace.");
    return context.workspaceId;
  };
  switch (action) {
    case "list": return call({}); // The adapter filters the collection by the old association.
    case "workspace-inventory": return call({});
    case "prepare": {
      const leaseId = input.leaseId ?? context.leaseId;
      if (!leaseId) throw new AppContextError(409, "workspace_lease_required", "A native activity lease is required before preparing source.");
      return call({ ...select(input, ["requestId", "appId", "name", "targetBranch"]), taskId: context.sessionId, leaseId,
        navigationPath: `/assistant?session=${encodeURIComponent(context.sessionId)}` });
    }
    case "participants": return call({ workspaceId: workspace() });
    case "rename": return call({ ...select(input, ["requestId", "name"]), workspaceId: input.workspaceId ?? workspace() });
    case "commit-review": case "merge-upstream": return call({ workspaceId: input.workspaceId, input: select(input, Object.keys(input).filter(k => k !== "workspaceId")) });
    case "activation-plan": case "activation-apply": case "activation-status": case "activation-list":
    case "activation-cancel": case "activation-resume": case "activation-return":
      return call({ workspaceId: input.workspaceId, kind: action.slice("activation-".length), input: select(input, Object.keys(input).filter(k => k !== "workspaceId")) });
    case "execution-select": return call({ appId: input.appId, input: select(input, Object.keys(input).filter(k => k !== "appId")) });
    case "execution-status": return call(select(input, ["appId", "requestId"]));
    case "app-dev-status": return call(select(input, ["appId"]));
    case "app-dev-plan": case "app-dev-apply": return call({ ...select(input, ["appId", "requestId", "targetRuntime", "worktreeId", "planDigest", "acceptDataChanges"]), action: input.devAction });
    case "remote-status": case "app-local-status": return nested({ worktreeId: input.workspaceId, appId: input.appId });
    case "remote-connect": case "remote-fetch": case "remote-push-base":
      return nested({ worktreeId: input.workspaceId, input: select(input, Object.keys(input).filter(k => k !== "workspaceId")) });
    case "app-creation-guide": return call(select(input, ["topic"]));
    case "app-creation-capabilities": case "pr-connections": return call({});
    case "app-creation-status": return nested({ taskId: context.sessionId, requestId: input.requestId });
    case "app-create": {
      if (!context.leaseId) throw new AppContextError(409, "workspace_lease_required", "A native activity lease is required before creating source.");
      return nested({ taskId: context.sessionId, leaseId: context.leaseId, input,
        navigationPath: `/assistant?session=${encodeURIComponent(context.sessionId)}` });
    }
    case "workflow-pause-confirm": return nested({ workspaceId: workspace(), input, confirm: true });
    case "workflow-status": return nested({ workspaceId: workspace() });
    case "workflow-complete": case "workflow-resume": case "workflow-pause":
      return nested({ workspaceId: workspace(), input });
    case "pr-list": return nested({}); // The adapter preserves the legacy authorized collection.
    case "pr-status": return nested({ worktreeId: input.workspaceId });
    case "pr-resolve-review": case "pr-commit": case "pr-configure": case "pr-push": case "pr-publish":
    case "pr-link": case "pr-ready": case "pr-merge": case "pr-complete": case "pr-corrective":
      return nested({ worktreeId: input.workspaceId, input: select(input, Object.keys(input).filter(k => k !== "workspaceId")) });
    case "environment-list": return call({});
    case "environment-status": return call(select(input, ["environmentId"]));
    case "environment-consent": case "environment-create": return nested(input);
    case "environment-start": case "environment-stop": case "environment-restart": case "environment-finish": case "environment-setup": case "environment-api":
      return call({ environmentId: input.environmentId, input: select(input, Object.keys(input).filter(k => k !== "environmentId")) });
    case "task-options": case "task-list": case "task-get": case "task-create": case "task-edit": case "task-action": {
      if (!context.taskProvider) throw new AppContextError(503, "task_provider_unavailable", "The original task provider installation is unavailable.");
      const provider = context.taskProvider;
      if (action === "task-options") return nested({ provider, ...select(input, ["executor"]) });
      if (action === "task-list") return nested({ provider, ...select(input, ["cursor", "limit"]) });
      if (action === "task-create") return nested({ provider, input });
      const taskRef = { ...provider, id: input.taskId };
      return nested(action === "task-get" ? { taskRef } : { taskRef, input: select(input, Object.keys(input).filter(k => k !== "taskId")) });
    }
    case "delete-workspace": case "status": case "diff": case "commit": case "refresh": case "merge": case "abort-merge": case "references":
      return call(input);
    default: throw new AppContextError(503, "legacy_tool_unmapped", "This retained alias has no reviewed canonical argument adapter.");
  }
}
