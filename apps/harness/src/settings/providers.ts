// Core owns assistant access; Harness owns local invocation preferences and instruction acceptance.
import { AppContextError } from "../sessions/app-context.js";
import type { AssistantSettings, SettingsStore, SkillAcceptance } from "./store.js";
import { readAppSkill, skillDigest, type AppSkill } from "../mcp/skills.js";

export const MCP_INTERFACE = "mcp";
export const CORE_PROVIDER_ID = "hosty:core";

export interface McpProvider {
  appId: string;
  policyIdentity?: string;
  installationIdentity?: string;
  deniedTools?: string[];
  displayName: string;
  url: string | null;
  running: boolean;
  offered?: boolean;
  interfaces: Array<{ key: string; url: string }>;
}
export interface AppDirectoryEntry {
  icon?: unknown; iconUrl?: unknown; description?: unknown; version?: unknown;
  selectedRuntime?: unknown; operationStatus?: unknown; id?: unknown; displayName?: unknown;
  runtimeState?: unknown; interfaces?: unknown;
}
interface AgentTarget {
  installedAt?: string | null;
  deniedTools?: string[];
  id: string; displayName: string; offered: boolean; runtimeState: string;
  interfaces: Array<{ key: string; url: string | null; readiness: string }>;
  skills: Array<{ key: string; digest: string | null; approvedDigest: string | null }>;
}
interface DirectorySnapshot {
  apps: AppDirectoryEntry[];
  agents: { revision: string; targets: AgentTarget[]; settingsUrl?: string | null };
}
export interface ProviderSnapshot {
  providers: McpProvider[];
  installedAppIds: string[];
  revision: string;
}

export class ProviderDirectory {
  private snapshot: DirectorySnapshot | null = null;
  private pending: Promise<DirectorySnapshot | null> | null = null;
  constructor(
    private readonly coreOrigin: string | null,
    private readonly serviceToken: string | null,
    private readonly appId: string,
    private readonly coreMcpUrl: string | null = null,
    private readonly container = false,
  ) {}

  get revision(): string | undefined { return this.snapshot?.agents.revision; }

  settingsUrl(): string | null { return this.snapshot?.agents.settingsUrl ?? null; }

  core(): McpProvider | null {
    const target = this.snapshot?.agents.targets.find(target => target.id === CORE_PROVIDER_ID);
    return target ? this.provider(target) : null;
  }

  approvedSkills(): Record<string, string> {
    return Object.fromEntries((this.snapshot?.agents.targets ?? []).flatMap(target =>
      target.skills.filter(skill => skill.key === "agent" && skill.digest && skill.digest === skill.approvedDigest)
        .map(skill => [target.id, skill.approvedDigest!])));
  }

  async instructions(settings?: AssistantSettings) {
    return Promise.all((this.snapshot?.agents.targets ?? []).filter(target => target.skills.some(skill => skill.key === "agent"))
      .map(async target => {
        const status = target.skills.find(skill => skill.key === "agent")!;
        const skill = await this.readSkill(target.id);
        const identity = this.installationIdentity(target), digest = skill ? skillDigest(skill.markdown) : null;
        const accepted = settings?.mcpSkillApprovals?.[target.id];
        return { appId: target.id, identity, digest, markdown: skill?.markdown ?? null,
          approved: Boolean(digest && accepted?.identity === identity && accepted.digest === digest) };
      }));
  }

  private installationIdentity(target: AgentTarget): string { return JSON.stringify([target.id, target.installedAt ?? "core"]); }

  localApprovedSkills(settings: AssistantSettings): Record<string, string> {
    return Object.fromEntries((this.snapshot?.agents.targets ?? []).flatMap(target => {
      const accepted = settings.mcpSkillApprovals?.[target.id];
      return accepted?.identity === this.installationIdentity(target) ? [[target.id, accepted.digest]] : [];
    }));
  }

  async migrateInstructions(store: SettingsStore): Promise<void> {
    if (!this.snapshot || (await store.read()).mcpSkillsMigrated) return;
    await store.transform(current => {
      if (current.mcpSkillsMigrated) return {};
      const accepted = { ...current.mcpSkillApprovals };
      for (const target of this.snapshot!.agents.targets) {
        const skill = target.skills.find(s => s.key === "agent");
        if (target.offered && skill?.digest && skill.digest === skill.approvedDigest && !accepted[target.id])
          accepted[target.id] = { identity: this.installationIdentity(target), digest: skill.digest };
      }
      return { mcpSkillsMigrated: true, mcpSkillApprovals: accepted };
    });
  }

  async validateInstructions(approvals: Record<string, SkillAcceptance>, previous: Record<string, SkillAcceptance> = {}): Promise<void> {
    if (!await this.read()) throw new Error("Core is unavailable. Instructions were not changed.");
    const instructions = await this.instructions();
    for (const [id, approval] of Object.entries(approvals)) {
      if (previous[id]?.identity === approval.identity && previous[id]?.digest === approval.digest) continue;
      const current = instructions.find(i => i.appId === id);
      if (!current || current.identity !== approval.identity || current.digest !== approval.digest)
        throw new Error("Application instructions changed. Read the current text before saving.");
    }
  }

  async accessReview(credential: string, input: { requestId: string; revision: string; targets: unknown[] }) {
    const request = await this.reviewRequest(credential, "", { assistantAccess: { ...input, assistantId: this.appId } });
    return request.status === "draft" ? this.reviewRequest(credential, `/${encodeURIComponent(request.id)}/submit`, {}) : request;
  }
  async reviewRequest(credential: string, suffix: string, body?: unknown): Promise<{ id: string; status: string; approvalUrl: string; error?: string }> {
    if (!this.coreOrigin || !this.serviceToken) throw new Error("Core is unavailable.");
    const response = await fetch(`${this.coreOrigin}/api/internal/apps/${encodeURIComponent(this.appId)}/installations${suffix}`, {
      method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${this.serviceToken}`,
        "X-Hosty-App-Identity": credential, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as { id: string; status: string; approvalUrl: string; error?: string; message?: string; code?: string };
    if (!response.ok) throw new AppContextError(response.status, result.code ?? "mcp_review_failed", result.message ?? "Core could not prepare this access review.");
    return result;
  }

  async readSkill(targetAppId: string): Promise<AppSkill | null> {
    if (!this.coreOrigin || !this.serviceToken) return null;
    return readAppSkill(this.coreOrigin, this.serviceToken, this.appId, targetAppId);
  }

  private async refresh(): Promise<DirectorySnapshot | null> {
    if (this.pending) return this.pending;
    this.pending = this.fetchSnapshot();
    try { return await this.pending; } finally { this.pending = null; }
  }

  private async fetchSnapshot(): Promise<DirectorySnapshot | null> {
    if (!this.coreOrigin || !this.serviceToken) return null;
    try {
      const revision = this.snapshot?.agents.revision;
      const response = await fetch(
        this.coreOrigin + "/api/internal/apps/" + encodeURIComponent(this.appId) + "/app-directory"
          + (revision ? "?revision=" + encodeURIComponent(revision) : ""),
        { headers: { authorization: "Bearer " + this.serviceToken }, signal: AbortSignal.timeout(3_000) },
      );
      if (response.status === 304) return this.snapshot;
      if (!response.ok) return null;
      const body = await response.json() as DirectorySnapshot;
      // An older Core has no offer policy. Do not reinterpret it as permission to offer every app.
      if (!Array.isArray(body.apps) || typeof body.agents?.revision !== "string" || !Array.isArray(body.agents.targets)) return null;
      this.snapshot = body;
      return body;
    } catch { return null; }
  }

  async readApps(): Promise<AppDirectoryEntry[] | null> {
    return (await this.refresh())?.apps ?? null;
  }

  private reachableUrl(value: string): string {
    if (!this.container) return value;
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.hostname.endsWith(".hosty.localhost")) return value;
    url.hostname = "host.docker.internal";
    return url.href;
  }

  private provider(target: AgentTarget): McpProvider {
    const declarations = target.interfaces.filter(item => item.url && item.readiness === "ready");
    const interfaces = declarations.map(item => ({
      key: item.key, url: this.reachableUrl(target.id === CORE_PROVIDER_ID && this.coreMcpUrl ? this.coreMcpUrl : item.url!),
    }));
    return {
      policyIdentity: JSON.stringify([target.id, target.installedAt ?? "core", interfaces]),
      installationIdentity: this.installationIdentity(target), deniedTools: target.deniedTools ?? [],
      appId: target.id, displayName: target.displayName, offered: target.offered === true,
      url: interfaces.find(item => item.key === "default")?.url ?? interfaces[0]?.url ?? null,
      running: interfaces.length > 0, interfaces,
    };
  }

  async read(): Promise<ProviderSnapshot | null> {
    const snapshot = await this.refresh();
    if (!snapshot) return null;
    return {
      providers: snapshot.agents.targets.filter(target => target.id !== CORE_PROVIDER_ID).map(target => this.provider(target)),
      installedAppIds: snapshot.apps.flatMap(app => typeof app.id === "string" ? [app.id] : []),
      revision: snapshot.agents.revision,
    };
  }

  /** Every forwarded request checks the current policy and resolves the current URL. */
  async resolveOffered(appId: string, expectedUrl?: string, external = false): Promise<string | null> {
    const current = await this.read();
    if (!current) throw new Error("Core's agent directory is unavailable.");
    const target = appId === CORE_PROVIDER_ID ? this.core() : current.providers.find(provider => provider.appId === appId);
    if (!target || (!external && !target.offered) || !target.running) return null;
    return expectedUrl ? target.interfaces.find(item => item.url === expectedUrl)?.url ?? null : target.url;
  }
}
