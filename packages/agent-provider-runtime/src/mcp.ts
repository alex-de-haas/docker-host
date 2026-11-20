import { createHash } from "node:crypto";
import type { AgentMcpPolicy, AgentMcpSelection, AgentMcpTarget } from "@hosty-sdk/app/agent";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { McpProxy } from "./internal/mcp/proxy.js";
import { McpToolPolicy } from "./internal/mcp/policy.js";
import type { AssistantSettings } from "./internal/settings/store.js";
import type { ProviderAuthority } from "./core.js";
import { ProviderWorkflow } from "./workflow.js";

export const mcpTargetKey = (target: AgentMcpTarget) => target.kind === "core" ? "core" : JSON.stringify([target.appId, target.installationId, target.key]);
type Target = { runId: string; admissionRef: string; target: AgentMcpTarget; tools?: string[] };
export class ProviderMcp {
  readonly proxy: McpProxy;
  readonly policy: McpToolPolicy;
  readonly workflow: ProviderWorkflow;
  private targets = new Map<string, Target>();
  private autonomous = new Set<string>();
  private preferences: AssistantSettings = { systemPrompt: "", mcpProviders: {}, mcpAutoAllow: {}, mcpSkillDigests: {} };
  constructor(private readonly authority: ProviderAuthority, private readonly origin: () => string,
    notify: (runId: string, event: { type: "approval_request"; approvalId: string; toolName: string; input: unknown }) => Promise<void>,
    settled: (runId: string, id: string, tool: string, allowed: boolean, automatic: boolean) => Promise<void>) {
    this.policy = new McpToolPolicy({ read: async () => structuredClone(this.preferences), transform: async change => {
      for (;;) {
        const previous = this.preferences, patch = await change(structuredClone(previous));
        // Discovery must not restore exceptions from before a concurrent policy replacement.
        if (this.preferences !== previous) continue;
        this.preferences = { ...previous, ...patch }; return structuredClone(this.preferences);
      }
    } }, notify, settled, 24 * 60 * 60 * 1000, runId => this.autonomous.has(runId));
    this.workflow = new ProviderWorkflow(authority, notify, settled, runId => this.autonomous.has(runId));
    this.proxy = new McpProxy(async (runId, key) => {
      const target = this.targets.get(key); if (!target || target.runId !== runId) return null;
      const minted = await authority.mcp(target.admissionRef, target.target, target.tools);
      return { token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) };
    }, 120_000, async key => {
      const target = this.targets.get(key); if (!target) return null;
      return (await authority.mcp(target.admissionRef, target.target, target.tools)).url;
    });
    this.proxy.policy = this.policy;
    this.proxy.identity = async key => this.targets.has(key) ? mcpTargetKey(this.targets.get(key)!.target) : "unavailable";
    this.proxy.allowedTool = (runId, key, name) => { const target = this.targets.get(key); return !!target && target.runId === runId && (!target.tools || target.tools.includes(name)); };
  }
  async configure(runId: string, admissionRef: string, selection: AgentMcpSelection | undefined, autonomous: boolean): Promise<{ servers: Record<string, unknown>; prefixes: string[] }> {
    if (selection?.connections?.length) throw new AgentApiError("unsupported_capability", "External MCP connections must be configured by this provider; arbitrary URLs and commands are not accepted.", 422);
    const prepared: Array<{ key: string; target: Target; policy?: AgentMcpPolicy }> = [];
    const targets = [];
    const keys = new Set<string>();
    for (const selected of selection?.targets ?? []) {
      const key = "target_" + createHash("sha256").update(JSON.stringify([runId, mcpTargetKey(selected.target)])).digest("hex").slice(0, 24);
      const minted = await this.authority.mcp(admissionRef, selected.target, selected.tools);
      prepared.push({ key, target: { runId, admissionRef, target: selected.target, tools: selected.tools }, policy: selected.policy });
      keys.add(key); targets.push({ appId: key, url: minted.url });
    }
    // A configuration replaces this run's policy, including removed exceptions and derived grants.
    // Wait for every credential before changing policy, and preserve other runs' latest preferences.
    const nextPreferences = structuredClone(this.preferences);
    const replaced = new Set([...this.targets].filter(([, target]) => target.runId === runId).map(([key]) => key).concat([...keys]));
    for (const key of replaced) { delete nextPreferences.mcpDefaults?.[key]; delete nextPreferences.mcpAutoAllow[key]; }
    for (const rule of Object.keys(nextPreferences.mcpToolRules ?? {}))
      if (replaced.has((JSON.parse(rule) as [string, string])[0])) delete nextPreferences.mcpToolRules![rule];
    nextPreferences.mcpPolicyMigrated = nextPreferences.mcpPolicyMigrated?.filter(marker => !marker.startsWith("provider:") || !replaced.has(marker.slice("provider:".length)));
    for (const { key, target, policy } of prepared) {
      const identity = mcpTargetKey(target.target);
      (nextPreferences.mcpDefaults ??= {})[key] = { identity, mode: policy?.default ?? "ask" };
      nextPreferences.mcpAutoAllow[key] = policy?.autoAllowReadOnly === true;
      for (const [name, rule] of Object.entries(policy?.tools ?? {})) (nextPreferences.mcpToolRules ??= {})[JSON.stringify([key, name])] = { identity, mode: rule.mode === "run" && !rule.definition ? "ask" : rule.mode, definition: rule.definition };
    }
    this.preferences = nextPreferences;
    if (autonomous) this.autonomous.add(runId); else this.autonomous.delete(runId);
    for (const item of prepared) this.targets.set(item.key, item.target);
    for (const [key, target] of this.targets) if (target.runId === runId && !keys.has(key)) this.targets.delete(key);
    const workflow = this.workflow.target(runId); if (workflow) targets.push(workflow);
    const token = this.proxy.register(runId, targets);
    return { servers: Object.fromEntries(targets.map(target => [target.appId, { type: "http", url: `${this.origin()}/internal/mcp/${encodeURIComponent(runId)}/${target.appId}`, headers: { Authorization: `Bearer ${token}` } }])),
      prefixes: targets.map(target => `mcp__${target.appId}__`) };
  }
  resolve(runId: string, decisionId: string, allowed: boolean) { return this.policy.resolve(runId, decisionId, allowed) || this.workflow.resolve(runId, decisionId, allowed); }
  close(runId: string): void { this.workflow.close(runId); this.proxy.unregister(runId); this.autonomous.delete(runId); for (const [key, target] of this.targets) if (target.runId === runId) this.targets.delete(key); }
}
