import { randomUUID, createHash } from "node:crypto";
import type { SettingsStore } from "../settings/store.js";
import { openSession, listTools, type UpstreamTool } from "./upstream.js";

export type ToolMode = "ask" | "run" | "disabled";
export interface ToolRule { identity: string; mode: ToolMode; definition?: string }
export interface ToolCatalog { provider: string; identity: string; tools: UpstreamTool[] }
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
interface Pending { session: string; approvalId: string; finish: (allowed: boolean) => void }
/** One approval gate for local development tools and app MCP, independent of the native adapter. */
export class McpToolPolicy {
  private readonly catalogs = new Map<string, ToolCatalog>();
  private readonly pending = new Map<string, Pending>();
  private readonly dispatched = new Map<string, string>();
  constructor(private readonly settings: SettingsStore | null,
    private readonly notify: (session: string, event: { type: "approval_request"; approvalId: string; toolName: string; input: unknown }) => Promise<void>,
    private readonly settled: (session: string, id: string, tool: string, allowed: boolean, automatic: boolean) => Promise<void>,
    private readonly timeout = 90_000) {}
  snapshot(): ToolCatalog[] { return [...this.catalogs.values()]; }
  async catalog(provider: string, identity: string, tools: UpstreamTool[]): Promise<UpstreamTool[]> {
    if (tools.length > 1000 || new Set(tools.map(t => t.name)).size !== tools.length ||
        tools.some(t => typeof t.name !== "string" || !t.name || t.name.length > 200 || /[\x00-\x1f]/.test(t.name)))
      throw new Error("Tool discovery is invalid; existing policy was preserved.");
    const change = (current: Awaited<ReturnType<SettingsStore["read"]>>) => {
      const rules = { ...current.mcpToolRules };
      // A complete first snapshot migrates only known read-only tools. New tools subsequently ask.
      const first = !current.mcpPolicyMigrated?.includes(`provider:${provider}`);
      for (const key of Object.keys(rules)) {
        let pair: string[]; try { if (!validKey(key)) throw new Error(); pair = JSON.parse(key); } catch { delete rules[key]; continue; }
        if (pair[0] === provider && (!tools.some(t => t.name === pair[1]) || rules[key]?.identity !== identity || rules[key]?.definition !== definition(tools.find(t => t.name === pair[1]) ?? { name: "" }))) delete rules[key];
      }
      for (const tool of tools) {
        const key = ruleKey(provider, tool.name);
        if (!rules[key]) rules[key] = { identity, definition: definition(tool), mode: first && current?.mcpAutoAllow[provider] && tool.annotations?.readOnlyHint === true ? "run" : "ask" };
      }
      return { mcpToolRules: rules, mcpPolicyMigrated: [...new Set([...(current.mcpPolicyMigrated ?? []), `provider:${provider}`])].slice(-2000) };
    };
    const settings = await this.settings?.transform(change);
    this.catalogs.set(provider, { provider, identity, tools });
    return tools.filter(t => settings?.mcpToolRules?.[ruleKey(provider, t.name)]?.mode !== "disabled");
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
    const rule = (await this.settings?.read())?.mcpToolRules?.[ruleKey(provider, tool)];
    const catalog = this.catalogs.get(provider);
    const current = catalog?.tools.find(t => t.name === tool);
    return catalog?.identity === identity && current && rule?.identity === identity && rule.definition === definition(current) ? rule.mode : "ask";
  }
  async authorize(session: string, provider: string, identity: string, requestId: string, tool: string, input: unknown, signal: AbortSignal): Promise<() => Promise<void>> {
    const key = JSON.stringify([session, provider, requestId]);
    const fingerprint = createHash("sha256").update(JSON.stringify([identity, tool, input])).digest("hex");
    if (this.dispatched.has(key)) throw new Error(this.dispatched.get(key) === fingerprint
      ? "This MCP request was already received. Inspect its outcome; recover Core operations with the original operation requestId."
      : "MCP request ID was reused with different arguments.");
    if (this.dispatched.size >= 5000) throw new Error("Session request limit reached; reconnect before dispatching another operation.");
    this.dispatched.set(key, fingerprint);
    let mode = await this.mode(provider, identity, tool);
    if (mode === "disabled") throw new Error("This tool is disabled in Harness MCP settings.");
    if (signal.aborted) throw new Error("MCP request was canceled before dispatch.");
    const observedTool = this.catalogs.get(provider)?.tools.find(t => t.name === tool);
    const observedDefinition = observedTool && definition(observedTool);
    if (!observedDefinition || this.catalogs.get(provider)?.identity !== identity) throw new Error("Unknown or changed tool; discover tools again.");
    const automatic = mode === "run";
    const dispatchGuard = async () => {
      const currentMode = await this.mode(provider, identity, tool);
      const current = this.catalogs.get(provider);
      const currentTool = current?.tools.find(t => t.name === tool);
      if (signal.aborted || current?.identity !== identity || !currentTool || definition(currentTool) !== observedDefinition ||
          currentMode === "disabled" || automatic && currentMode !== "run")
        throw new Error("Tool policy changed or the request was canceled before dispatch. Retry with a new MCP request.");
    };
    const name = `${provider}: ${tool}`;
    if (automatic) { await this.settled(session, "", name, true, true); await dispatchGuard(); return dispatchGuard; }
    const id = randomUUID();
    let finish!: (value: boolean) => void;
    const decision = new Promise<boolean>(resolve => { finish = resolve; });
    this.pending.set(id, { session, approvalId: id, finish });
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
  cancel(session: string): void {
    for (const p of this.pending.values()) if (p.session === session) p.finish(false);
    for (const key of this.dispatched.keys()) if (JSON.parse(key)[0] === session) this.dispatched.delete(key);
  }
  close(): void { for (const p of this.pending.values()) p.finish(false); }
}
