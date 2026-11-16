import type { ProviderSettingsDefinition } from "@hosty/agent-provider-runtime/settings";
import type { AgentCapabilities } from "@hosty-sdk/app/agent";
import { skillAdapter } from "@hosty/agent-provider-runtime/worker/skills";
import { cp, lstat, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentConnections, ConnectionError, type AgentConnection, type ConnectionBinding, type AdapterPreparation } from "@hosty/agent-provider-runtime/connections/registry";
import type { ConnectionSecrets } from "@hosty/agent-provider-runtime/connections/secrets";
import type { HarnessAdapter, NativeHistoryHome } from "@hosty/agent-provider-runtime/harness/adapter";
import { absentUsage, type ProviderUsage } from "@hosty/agent-provider-runtime/harness/provider-usage";
import { ClaudeHarnessAdapter } from "./adapter/claude.js";

export class ClaudeConnections extends AgentConnections {
  constructor(data: string, cache: string | null, secrets: ConnectionSecrets, mode?: "native" | "docker") {
    super(data, cache, secrets, { kind: "claude", name: "claude-agent-sdk", deferContainerProbe: true,
      capabilities: { promptSuggestions: true, usage: { snapshots: true, events: true, kinds: ["quota", "credits"] }, questions: true, appMcp: true, liveReconfigure: true, autoAllow: true, denyReason: true },
      authMethods: { "api-key": { credential: "required" }, "claude-token": { credential: "required" } }, historyDirectories: ["projects"] }, mode);
  }
  protected override async createAdapter(connection: AgentConnection, _binding: ConnectionBinding, docker: boolean): Promise<HarnessAdapter> {
    const secret = await this.secretGet(connection.secretKey);
    if (!secret) { await this.removeManagedHome(connection); throw new ConnectionError(409, "provider_reconnect_required", "Reconnect this provider. Its credential is missing."); }
    const home = await this.nativeHome(connection, docker);
    const env = cleanEnvironment(); env.CLAUDE_CONFIG_DIR = home;
    env[connection.auth === "api-key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"] = secret;
    return new ClaudeHarnessAdapter(env);
  }
  protected override async unavailableUsage(connection: AgentConnection, phase: "before_identity" | "after_identity"): Promise<ProviderUsage | undefined> {
    return phase === "after_identity" && connection.auth === "api-key" ? absentUsage("unsupported", "unsupported_auth") : undefined;
  }
  override async prepareAdapter(binding: ConnectionBinding, context: AdapterPreparation): Promise<HarnessAdapter> {
    const adapter = await this.adapter(binding), home = await this.executionHome(binding), historyHome = await this.executionHistoryHome(binding);
    return skillAdapter(adapter, { selected: context.skillPath, relativePath: "skills", canonicalize: true, prepare: async root => {
      const history = await realpath(path.join(home, "projects"));
      if (!historyHome || historyHome.directories.projects !== path.join(historyHome.home, "projects") || historyHome.directories.projects !== history)
        throw new Error("The selected native history binding changed.");
      await symlink(history, path.join(root, "projects"), process.platform === "win32" ? "junction" : "dir");
      return { nativeHistoryHome: historyHome };
    } });
  }
  /** This descriptor comes only from the selected registry binding, never a run request path. */
  async executionHistoryHome(binding: ConnectionBinding): Promise<NativeHistoryHome | undefined> {
    const connection = await this.get(binding.connectionId);
    if (connection.revision !== binding.connectionRevision || connection.kind !== binding.harnessKind)
      throw new ConnectionError(409, "provider_credentials_changed", "Select the current connection.");
    await this.nativeHome(connection, this.applicationMode === "docker");
    const data = await realpath(this.dataDir), expected = path.join(data, "provider-sessions", connection.id, String(connection.revision));
    const home = await realpath(path.join(this.dataDir, "provider-sessions", connection.id, String(connection.revision)));
    const projects = await realpath(path.join(home, "projects"));
    if (home !== expected || projects !== path.join(home, "projects"))
      throw new ConnectionError(409, "provider_storage_conflict", "The managed provider history redirects outside its owned location.");
    return { home, directories: { projects } };
  }
  async importEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
    if ((await this.load()).imported) return;
    const secret = env.ANTHROPIC_API_KEY?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (secret && !(await this.load()).connections.some(connection => connection.importSource === "claude-env"))
      await this.update({ name: "Claude", kind: "claude", auth: env.ANTHROPIC_API_KEY?.trim() ? "api-key" : "claude-token", secret }, undefined, "claude-env");
    await this.serialize(async () => { const state = await this.load(); await this.save({ ...state, imported: true, defaultId: state.defaultId ?? state.connections[0]?.id ?? null }); });
  }
  /** Legacy records never prove an account. The caller requires explicit operator confirmation. */
  async adoptLegacySession(
    binding: ConnectionBinding,
    nativeId: string,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(nativeId))
      throw new ConnectionError(
        400,
        "provider_legacy_invalid",
        "The native session id is invalid.",
      );
    await this.serialize(async () => {
      const connection = await this.get(binding.connectionId);
      const home = await this.nativeHome(connection);
      // Copy only the explicitly adopted native session, never unrelated conversations.
      if (connection.kind === "claude") {
        const root = path.join(os.homedir(), ".claude", "projects");
        for (const project of await readdir(root, {
          withFileTypes: true,
        }).catch(() => [])) {
          if (!project.isDirectory()) continue;
          const source = path.join(root, project.name, `${nativeId}.jsonl`);
          if (!(await lstat(source).catch(() => null))) continue;
          const destination = path.join(home, "projects", project.name);
          await mkdir(destination, { recursive: true });
          await cp(source, path.join(destination, `${nativeId}.jsonl`));
          const subagents = path.join(root, project.name, nativeId);
          if (await lstat(subagents).catch(() => null))
            await cp(subagents, path.join(destination, nativeId), {
              recursive: true,
            });
        }
      }
    });
  }
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|CODEX_API_KEY$|OPENAI_API_KEY$|OPENAI_AUTH_TOKEN$|CODEX_HOME$|CLAUDE_CONFIG_DIR$|HOSTY_)/.test(key)) delete env[key];
  return env;
}

export const claudeCapabilities: AgentCapabilities = {
  version: 1, eventVersions: ["agent-event.1"],
  capabilities: ["session.resume", "configuration.resume-compatible", "configuration.approval-mode", "skills.catalog", "skills.exclusive-selection", "mcp.core", "mcp.apps", "mcp.policy-update", "workflow.consumer", "model.change-on-resume", "decisions.questions", "decisions.auto-allow", "connections.usage", "runs.park", "runs.barrier", "runs.reconcile", "native-tools.none", "decisions.deny-reason", "runs.live-configure", "predictions", "subagents.native"],
  limits: { maxCommandBytes: 1024 * 1024, maxEventBytes: 1024 * 1024, maxSnapshotBytes: 1024 * 1024, maxReplayBytes: 64 * 1024 * 1024, replayRetentionMs: 7 * 24 * 60 * 60 * 1000, maxControls: 10000, maxPageSize: 100, maxDurationMs: 24 * 60 * 60 * 1000  },
  configuration: { resumeCompatible: ["instructions", "systemPrompt", "skills", "nativeTools", "approvalMode", "predictions"] },
  nativeTools: { default: "provider_default", none: true },
  subagents: { defaultEnabled: true, policy: "enforceable", observation: "partial" },
};

export const claudeSettings: ProviderSettingsDefinition = {
  kind: "claude", name: "Claude Code", connectionName: "Claude", authentication: [
    { id: "api-key", label: "API key", credential: true }, { id: "claude-token", label: "Claude Code token", credential: true }],
  usage: { grouping: "account", accountGroups: ["claude:five_hour", "claude:seven_day"],
    knownGroups: ["claude:five_hour", "claude:seven_day", "claude:seven_day_oauth_apps", "claude:seven_day_opus", "claude:seven_day_sonnet"], scopedGroupPrefixes: ["claude:model:"] },
};
