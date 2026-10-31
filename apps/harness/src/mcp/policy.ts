import { randomUUID, createHash } from "node:crypto";
import { migrateCorePolicy, migratedTool, coreAliases } from "./core-migration.js";
import type { SettingsStore } from "../settings/store.js";
import { openSession, listTools, type UpstreamTool } from "./upstream.js";

export type ToolMode = "ask" | "run" | "disabled";
export interface ProviderDefault { identity: string; mode: "ask" | "run" }
export function validDefaults(value: unknown): value is Record<string, ProviderDefault> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 1000 &&
    Object.values(value).every(v => v && typeof v === "object" && typeof v.identity === "string" && v.identity.length < 3000 && ["ask", "run"].includes(v.mode)));
}
export interface ToolRule { identity: string; mode: ToolMode; definition?: string }
export interface ToolCatalog { provider: string; identity: string; tools: UpstreamTool[]; localOwner?: { appId: string; displayName: string; installationId?: string } }
const definition = (tool: UpstreamTool) => createHash("sha256").update(JSON.stringify(tool)).digest("hex");
export const ruleKey = (provider: string, name: string) => JSON.stringify([provider, name]);
function validKey(key: string): boolean {
  try { const pair: unknown = JSON.parse(key); return Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === "string" && v.length > 0); }
  catch { return false; }
}
export function validRules(value: unknown): value is Record<string, ToolRule> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 2000 &&
    Object.entries(value).every(([key, v]) => key.length < 500 && validKey(key) && v && typeof v === "object" &&
      typeof v.identity === "string" && v.identity.length < 3000 && ["ask", "run", "disabled"].includes(v.mode));
}
interface Pending { session: string; provider: string; approvalId: string; finish: (allowed: boolean) => void }
/** One approval gate for local development tools and app MCP, independent of the native adapter. */
export class McpToolPolicy {
  private readonly catalogs = new Map<string, ToolCatalog>();
  private readonly pending = new Map<string, Pending>();
  private readonly dispatched = new Map<string, string>();
  private readonly generations = new Map<string, symbol>();
  constructor(private readonly settings: SettingsStore | null,
    private readonly notify: (session: string, event: { type: "approval_request"; approvalId: string; toolName: string; input: unknown }) => Promise<void>,
    private readonly settled: (session: string, id: string, tool: string, allowed: boolean, automatic: boolean) => Promise<void>,
    private readonly timeout = 90_000,
    private readonly autonomous: (session: string) => boolean = () => false) {}
  localOwner?: { appId: string; displayName: string; installationId?: string };
  get localIdentity(): string {
    const owner = this.localOwner;
    return this.canonicalCore && owner?.installationId ? JSON.stringify(["hosty-local-v2", owner.appId, owner.installationId]) : "hosty-development-v1";
  }
  async localCatalog(tools: UpstreamTool[]): Promise<UpstreamTool[]> {
    return this.catalog("hosty:development", this.localIdentity,
      this.canonicalCore ? tools.filter(t => !Object.hasOwn(coreAliases, t.name)) : tools);
  }
  async authorizeLocal(session: string, requestId: string, name: string, input: unknown, signal: AbortSignal): Promise<() => Promise<void>> {
    const canonical = coreAliases[name], core = this.catalogs.get("hosty:core");
    return canonical && this.canonicalCore && core
      ? this.authorize(session, "hosty:core", core.identity, requestId, canonical, input, signal)
      : this.authorize(session, "hosty:development", this.localIdentity, requestId, name, input, signal);
  }
  get canonicalCore(): boolean {
    return this.catalogs.get("hosty:core")?.tools.some(tool => {
      const metadata = tool._meta?.["io.hosty/core-tool"] as { schemaVersion?: unknown; owner?: unknown } | undefined;
      return metadata?.schemaVersion === 1 && metadata.owner === "hosty:core";
    }) ?? false;
  }
  snapshot(): ToolCatalog[] {
    return [...this.catalogs.values()].map(catalog => catalog.provider === "hosty:development" && this.canonicalCore
      ? { ...catalog, localOwner: this.localOwner, tools: catalog.tools.filter(t => !Object.hasOwn(coreAliases, t.name)) } : catalog);
  }
  async catalog(provider: string, identity: string, tools: UpstreamTool[]): Promise<UpstreamTool[]> {
    if (tools.length > 1000 || new Set(tools.map(t => t.name)).size !== tools.length ||
        tools.some(t => typeof t.name !== "string" || !t.name || t.name.length > 200 || /[\x00-\x1f]/.test(t.name)))
      throw new Error("Tool discovery is invalid; existing policy was preserved.");
    const change = (current: Awaited<ReturnType<SettingsStore["read"]>>) => {
      const rules = { ...current.mcpToolRules };
      // Preserve exceptions for temporarily missing tools. A changed definition asks again;
      // genuinely new tools inherit the operator's provider default.
      const first = !current.mcpPolicyMigrated?.includes(`provider:${provider}`);
      for (const tool of tools) {
        const key = ruleKey(provider, tool.name), rule = rules[key];
        if (rule && (rule.identity !== identity || rule.definition !== definition(tool)))
          rules[key] = { identity, definition: definition(tool), mode: rule.mode === "disabled" ? "disabled" : "ask" };
        else if (!rule && first && current.mcpAutoAllow[provider] && tool.annotations?.readOnlyHint === true)
          rules[key] = { identity, definition: definition(tool), mode: "run" };
      }
      let mcpCoreMigration = provider === "hosty:core" ? migrateCorePolicy(current, identity, tools, rules, definition) : current.mcpCoreMigration;
      if (provider === "hosty:development" && identity !== "hosty-development-v1" && mcpCoreMigration) {
        const archived = { ...mcpCoreMigration.legacyRules };
        for (const tool of tools) {
          const old = current.mcpToolRules?.[ruleKey(provider, tool.name)];
          if (old?.identity === "hosty-development-v1" && !archived[tool.name]) archived[tool.name] = { ...old };
        }
        mcpCoreMigration = { ...mcpCoreMigration, legacyRules: archived };
      }
      return { mcpCoreMigration, mcpToolRules: rules, mcpPolicyMigrated: [...new Set([...(current.mcpPolicyMigrated ?? []), `provider:${provider}`])].slice(-2000) };
    };
    const settings = await this.settings?.transform(change);
    this.catalogs.set(provider, { provider, identity, tools });
    return tools.filter(t => {
      const migrated = migratedTool(settings, provider, identity, t.name);
      return settings?.mcpToolRules?.[ruleKey(migrated?.provider ?? provider, migrated?.tool ?? t.name)]?.mode !== "disabled";
    });
  }
  async update(rules: Record<string, ToolRule>): Promise<void> {
    if (!validRules(rules)) throw new Error("Invalid MCP tool rules.");
    for (const [key, rule] of Object.entries(rules)) {
      let pair: unknown; try { if (!validKey(key)) throw new Error(); pair = JSON.parse(key); } catch { throw new Error("Invalid tool key."); }
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Invalid tool key.");
      const catalog = this.catalogs.get(pair[0]);
      if (!catalog || catalog.identity !== rule.identity || !catalog.tools.some(t => t.name === pair[1]))
        throw new Error("Tool catalog changed. Refresh before changing permissions.");
      rules[key] = { ...rule, definition: definition(catalog.tools.find(t => t.name === pair[1])!) };
    }
    await this.settings?.transform(current => ({ mcpToolRules: { ...current.mcpToolRules, ...rules } }));
  }
  async discover(provider: string, identity: string, url: string, token: string): Promise<UpstreamTool[]> {
    const session = await openSession(url, token);
    if (!session) throw new Error("Tool discovery is unavailable; existing policy was preserved.");
    const tools: UpstreamTool[] = []; let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await listTools(url, token, session, cursor);
      if (!result) throw new Error("Tool discovery is incomplete; existing policy was preserved.");
      tools.push(...result.tools);
      if (tools.length > 1000) throw new Error("Tool catalog exceeds the supported limit.");
      if (!result.nextCursor) return this.catalog(provider, identity, tools);
      cursor = result.nextCursor;
    }
    throw new Error("Tool catalog pagination is incomplete.");
  }
  async mode(provider: string, identity: string, tool: string): Promise<ToolMode> {
    const settings = await this.settings?.read();
    const migrated = migratedTool(settings, provider, identity, tool);
    if (migrated) return this.mode(migrated.provider, migrated.identity, migrated.tool);
    const rule = settings?.mcpToolRules?.[ruleKey(provider, tool)];
    if (rule?.mode === "disabled") return "disabled";
    if (rule?.identity === identity && rule.mode === "ask") return "ask";
    const catalog = this.catalogs.get(provider), current = catalog?.tools.find(t => t.name === tool);
    if (catalog?.identity !== identity || !current) return "ask";
    if (rule?.identity === identity && rule.definition === definition(current)) return rule.mode;
    const fallback = settings?.mcpDefaults?.[provider];
    return fallback?.identity === identity ? fallback.mode : "ask";
  }

  /** Validate the whole editor before its single settings-file write. */
  preparePreferences(defaults: Record<string, ProviderDefault>, rules: Record<string, ToolRule>) {
    if (!validDefaults(defaults) || !validRules(rules) || Object.entries(rules).some(([key, r]) => r.mode === "disabled" && JSON.parse(key)[0] !== "hosty:development"))
      throw new Error("Invalid invocation preferences. Disable tools through Core access review.");
    for (const [provider, rule] of Object.entries(defaults)) {
      if (this.catalogs.get(provider)?.identity !== rule.identity) throw new Error("Refresh the changed tool catalog before saving.");
    }
    const prepared: Record<string, ToolRule> = {};
    for (const [key, rule] of Object.entries(rules)) {
      const [provider, name] = JSON.parse(key) as string[];
      const catalog = this.catalogs.get(provider!), tool = catalog?.tools.find(t => t.name === name);
      if (!tool || catalog?.identity !== rule.identity) throw new Error("Refresh the changed tool catalog before saving.");
      prepared[key] = { ...rule, definition: definition(tool) };
    }
    return { defaults, rules: prepared };
  }

  async authorize(session: string, provider: string, identity: string, requestId: string, tool: string, input: unknown, signal: AbortSignal): Promise<() => Promise<void>> {
    const scope = JSON.stringify([session, provider]);
    const generation = this.generations.get(scope) ?? Symbol();
    this.generations.set(scope, generation);
    const key = JSON.stringify([session, provider, requestId]);
    const fingerprint = createHash("sha256").update(JSON.stringify([identity, tool, input])).digest("hex");
    if (this.dispatched.has(key)) throw new Error(this.dispatched.get(key) === fingerprint
      ? "This MCP request was already received. Inspect its outcome; recover Core operations with the original operation requestId."
      : "MCP request ID was reused with different arguments.");
    if (this.dispatched.size >= 5000) throw new Error("Session request limit reached; reconnect before dispatching another operation.");
    this.dispatched.set(key, fingerprint);
    let mode = await this.mode(provider, identity, tool);
    if (mode === "disabled") throw new Error("This tool is disabled in Harness MCP settings.");
    if (signal.aborted || this.generations.get(scope) !== generation) throw new Error("MCP request was canceled before dispatch.");
    const observedTool = this.catalogs.get(provider)?.tools.find(t => t.name === tool);
    const observedDefinition = observedTool && definition(observedTool);
    const effectiveDefinition = async () => {
      const target = migratedTool(await this.settings?.read(), provider, identity, tool);
      if (!target) return null;
      const catalog = this.catalogs.get(target.provider), entry = catalog?.tools.find(t => t.name === target.tool);
      return JSON.stringify([target.identity, catalog?.identity, entry && definition(entry)]);
    };
    const observedEffectiveDefinition = await effectiveDefinition();
    if (!observedDefinition || this.catalogs.get(provider)?.identity !== identity) throw new Error("Unknown or changed tool; discover tools again.");
    const canRunAutomatically = async (effective: ToolMode) => {
      const current = await this.settings?.read();
      const migrated = migratedTool(current, provider, identity, tool);
      const rule = current?.mcpToolRules?.[ruleKey(migrated?.provider ?? provider, migrated?.tool ?? tool)];
      const explicitAsk = rule?.identity === (migrated?.identity ?? identity) && rule.mode === "ask";
      return effective === "run" || this.autonomous(session) && !explicitAsk;
    };
    const automatic = await canRunAutomatically(mode);
    const dispatchGuard = async () => {
      const currentMode = await this.mode(provider, identity, tool);
      const current = this.catalogs.get(provider);
      const currentTool = current?.tools.find(t => t.name === tool);
      if (signal.aborted || this.generations.get(scope) !== generation || current?.identity !== identity || !currentTool || definition(currentTool) !== observedDefinition ||
          observedEffectiveDefinition !== await effectiveDefinition() ||
          currentMode === "disabled" || automatic && !await canRunAutomatically(currentMode))
        throw new Error("Tool policy changed or the request was canceled before dispatch. Retry with a new MCP request.");
    };
    const name = `${provider}: ${tool}`;
    if (automatic) { await this.settled(session, "", name, true, true); await dispatchGuard(); return dispatchGuard; }
    const id = randomUUID();
    let finish!: (value: boolean) => void;
    const decision = new Promise<boolean>(resolve => { finish = resolve; });
    this.pending.set(id, { session, provider, approvalId: id, finish });
    const cancel = () => finish(false);
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.timeout);
    try {
      await this.notify(session, { type: "approval_request", approvalId: id, toolName: name, input });
      const approved = await decision;
      const latestTool = this.catalogs.get(provider)?.tools.find(t => t.name === tool);
      const allowed = approved && observedDefinition === (latestTool && definition(latestTool));
      mode = await this.mode(provider, identity, tool);
      await this.settled(session, id, name, allowed && mode !== "disabled" && !signal.aborted, false);
      if (!allowed || mode === "disabled" || signal.aborted) throw new Error("Tool call denied, expired, canceled or disabled before dispatch.");
      await dispatchGuard(); return dispatchGuard;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); this.pending.delete(id); }
  }
  resolve(session: string, id: string, allowed: boolean): boolean {
    const pending = this.pending.get(id);
    if (!pending || pending.session !== session) return false;
    this.pending.delete(id); pending.finish(allowed); return true;
  }
  /** Revoke one provider's requests, or the entire native client on session teardown. */
  cancel(session: string, provider?: string): void {
    const matches = (key: string) => { const pair: string[] = JSON.parse(key); return pair[0] === session && (provider === undefined || pair[1] === provider); };
    for (const key of this.generations.keys()) if (matches(key)) this.generations.delete(key);
    for (const p of this.pending.values()) if (p.session === session && (provider === undefined || p.provider === provider)) p.finish(false);
    for (const key of this.dispatched.keys()) if (matches(key)) this.dispatched.delete(key);
  }
  close(): void { for (const p of this.pending.values()) p.finish(false); }
}
