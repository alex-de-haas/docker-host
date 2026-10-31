import type { AssistantSettings } from "../settings/store.js";
import type { ToolMode, ToolRule, ProviderDefault } from "./policy.js";
import type { UpstreamTool } from "./upstream.js";

export const LEGACY_DEVELOPMENT_PROVIDER = "hosty:development";
export const LEGACY_DEVELOPMENT_IDENTITY = "hosty-development-v1";
// Reviewed operation mapping, not discovery by prefix or display text. Legacy adapters retain
// their original arguments and filters. Every move from the local transport needs Core grants.
export const coreAliases: Readonly<Record<string, string>> = Object.freeze({
  delete_workspace: "delete_workspace",
  workspace_inventory: "list_workspaces",
  participants: "get_workspace_participants",
  commit_review: "get_workspace_commit_review",
  execution_select: "select_app_execution_target",
  execution_status: "get_app_execution_selection",
  rename: "rename_workspace",
  activation_plan: "workspace_activation",
  activation_apply: "workspace_activation",
  activation_status: "workspace_activation",
  activation_list: "workspace_activation",
  activation_cancel: "workspace_activation",
  activation_resume: "workspace_activation",
  activation_return: "workspace_activation",
  app_dev_status: "get_app_dev_mode",
  app_dev_plan: "plan_app_dev_mode",
  app_dev_apply: "apply_app_dev_mode",
  merge_upstream: "merge_workspace_upstream",
  remote_status: "remote_status",
  remote_connect: "remote_connect",
  remote_fetch: "remote_fetch",
  remote_push_base: "remote_push_base",
  pr_push: "pr_push",
  app_local_status: "app_local_status",
  app_creation_guide: "app_creation_guide",
  app_create: "app_create",
  app_creation_status: "app_creation_status",
  app_creation_capabilities: "app_creation_capabilities",
  workflow_status: "workflow_status",
  workflow_complete: "workflow_complete",
  workflow_resume: "workflow_resume",
  workflow_pause: "workflow_pause",
  list: "list_workspaces",
  prepare: "prepare_workspace",
  status: "get_workspace",
  diff: "get_workspace_diff",
  commit: "commit_workspace",
  refresh: "refresh_workspace",
  merge: "merge_workspace_target",
  abort_merge: "abort_workspace_merge",
  references: "record_workspace_pull_requests",
  pr_resolve_review: "pr_resolve_review",
  pr_commit: "pr_commit",
  pr_list: "pr_list",
  pr_connections: "pr_connections",
  pr_status: "pr_status",
  pr_configure: "pr_configure",
  pr_publish: "pr_publish",
  pr_link: "pr_link",
  pr_ready: "pr_ready",
  pr_merge: "pr_merge",
  pr_complete: "pr_complete",
  pr_corrective: "pr_corrective",
  task_options: "task_options",
  task_list: "task_list",
  task_get: "task_get",
  task_create: "task_create",
  task_edit: "task_edit",
  task_action: "task_action",
  environment_consent: "environment_consent",
  environment_create: "environment_create",
  environment_list: "environment_list",
  environment_status: "environment_status",
  environment_start: "environment_start",
  environment_stop: "environment_stop",
  environment_restart: "environment_restart",
  environment_finish: "environment_finish",
  environment_setup: "environment_setup",
  environment_api: "environment_api",
});
const originalCoreTools = new Set([
  "get_host_status",
  "restart_core",
  "get_core_operation",
  "get_core_development",
  "list_apps",
  "get_app",
  "start_app",
  "stop_app",
  "restart_app",
  "plan_app_update",
  "apply_app_update",
  "tail_app_logs",
  "search_audit",
  "prepare_workspace",
  "list_workspaces",
  "get_workspace",
  "rename_workspace",
  "acquire_workspace_lease",
  "release_workspace_lease",
  "delete_workspace",
  "get_workspace_diff",
  "refresh_workspace",
  "commit_workspace",
  "merge_workspace_target",
  "abort_workspace_merge",
  "record_workspace_pull_requests",
  "get_app_development_guide",
  "get_app_dev_mode",
  "plan_app_dev_mode",
  "apply_app_dev_mode",
  "get_app_execution_targets",
  "select_app_execution_target",
  "get_app_execution_selection",
  "select_workspace_execution",
  "get_workspace_execution_selection",
  "configure_workspace_runtime",
  "workspace_activation",
]);
const key = (provider: string, name: string) => JSON.stringify([provider, name]);

export interface CorePolicyMigration {
  version: 1;
  identity: string;
  tools: string[];
  aliases: string[];
  legacyRules: Record<string, ToolRule>;
  legacyDefault?: ProviderDefault;
}
export function validCoreMigration(value: unknown): value is CorePolicyMigration {
  if (!value || typeof value !== "object") return false;
  const v = value as CorePolicyMigration;
  const names = (n: unknown): n is string[] => Array.isArray(n) && n.length <= 1000 &&
    n.every(x => typeof x === "string" && x.length > 0 && x.length <= 200) && new Set(n).size === n.length;
  const rule = (r: ToolRule) => r && typeof r === "object" && typeof r.identity === "string" && r.identity.length < 3000 &&
    ["disabled", "ask", "run"].includes(r.mode) && (r.definition === undefined || typeof r.definition === "string");
  return v.version === 1 && typeof v.identity === "string" && v.identity.length < 3000 && names(v.tools) && names(v.aliases) &&
    v.aliases.every(a => Object.hasOwn(coreAliases, a)) && !!v.legacyRules && typeof v.legacyRules === "object" && !Array.isArray(v.legacyRules) &&
    Object.entries(v.legacyRules).length <= 1000 && Object.entries(v.legacyRules).every(([n, r]) => n.length > 0 && n.length <= 200 && !/[\x00-\x1f]/.test(n) && rule(r)) &&
    (v.legacyDefault === undefined || rule(v.legacyDefault) && v.legacyDefault.mode !== ("disabled" as ToolMode));
}
function coreTool(tool: UpstreamTool): boolean {
  const metadata = tool._meta?.["io.hosty/core-tool"] as { owner?: unknown; schemaVersion?: unknown } | undefined;
  return metadata?.owner === "hosty:core" && metadata.schemaVersion === 1;
}
const stricter = (a: ToolMode, b: ToolMode): ToolMode =>
  a === "disabled" || b === "disabled" ? "disabled" : a === "ask" || b === "ask" ? "ask" : "run";

/** Called inside the same SettingsStore transaction as catalog normalization. No resource calls. */
export function migrateCorePolicy(current: AssistantSettings, identity: string, tools: UpstreamTool[], rules: Record<string, ToolRule>, definition: (tool: UpstreamTool) => string): CorePolicyMigration {
  const previous = current.mcpCoreMigration;
  const receipt: CorePolicyMigration = previous ? { ...previous, identity, tools: [...previous.tools], aliases: [...previous.aliases], legacyRules: { ...previous.legacyRules } } : {
    version: 1, identity, tools: [], aliases: [], legacyRules: {},
    legacyDefault: current.mcpDefaults?.[LEGACY_DEVELOPMENT_PROVIDER],
  };
  for (const tool of tools) {
    const canonicalKey = key("hosty:core", tool.name);
    let effective = rules[canonicalKey]?.mode;
    if (!receipt.tools.includes(tool.name)) {
      // Existing direct Core preferences remain intact. Newly exposed operations require review,
      // even when a previous provider-wide default was Run unprompted.
      if (!originalCoreTools.has(tool.name)) effective = stricter(effective ?? "ask", "ask");
      receipt.tools.push(tool.name);
    }
    if (coreTool(tool)) for (const [alias, canonical] of Object.entries(coreAliases)) {
      if (canonical !== tool.name || receipt.aliases.includes(alias)) continue;
      const old = current.mcpToolRules?.[key(LEGACY_DEVELOPMENT_PROVIDER, alias)];
      if (old) receipt.legacyRules[alias] = { ...old };
      const fallback = current.mcpDefaults?.[LEGACY_DEVELOPMENT_PROVIDER];
      const oldMode = old?.mode === "disabled" ? "disabled" : old?.identity === LEGACY_DEVELOPMENT_IDENTITY ? old.mode :
        fallback?.identity === LEGACY_DEVELOPMENT_IDENTITY ? fallback.mode : "ask";
      // Local aliases gain a new Core target/grant boundary. An existing direct Core choice
      // remains authoritative; an absent local preference is not a conflicting Ask rule.
      if (old || fallback?.identity === LEGACY_DEVELOPMENT_IDENTITY) {
        const canonicalDefault = current.mcpDefaults?.["hosty:core"];
        const reviewedCore = originalCoreTools.has(tool.name) && (current.mcpToolRules?.[canonicalKey]?.identity === identity
          || canonicalDefault?.identity === identity);
        effective = stricter(effective ?? (canonicalDefault?.identity === identity ? canonicalDefault.mode : "run"),
          oldMode === "run" && !reviewedCore ? "ask" : oldMode);
      }
      receipt.aliases.push(alias);
    }
    if (effective) rules[canonicalKey] = { identity, mode: effective, definition: definition(tool) };
  }
  return receipt;
}

export function migratedTool(settings: AssistantSettings | undefined, provider: string, identity: string, tool: string): { provider: string; identity: string; tool: string } | undefined {
  const receipt = settings?.mcpCoreMigration;
  if (provider !== LEGACY_DEVELOPMENT_PROVIDER || identity !== LEGACY_DEVELOPMENT_IDENTITY || !receipt?.aliases.includes(tool)) return undefined;
  return { provider: "hosty:core", identity: receipt.identity, tool: coreAliases[tool]! };
}
