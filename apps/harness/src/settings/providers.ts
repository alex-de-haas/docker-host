// Core owns offers and skill approvals; this client caches only credential-free discovery.
import { readAppSkill, type AppSkill } from "../mcp/skills.js";

export const MCP_INTERFACE = "mcp";
export const CORE_PROVIDER_ID = "hosty:core";

export interface McpProvider {
  appId: string;
  policyIdentity?: string;
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

  private provider(target: AgentTarget): McpProvider {
    const declarations = target.interfaces.filter(item => item.url && item.readiness === "ready");
    const interfaces = declarations.map(item => ({
      key: item.key, url: target.id === CORE_PROVIDER_ID && this.coreMcpUrl ? this.coreMcpUrl : item.url!,
    }));
    return {
      policyIdentity: JSON.stringify([target.id, target.installedAt ?? "core", interfaces]),
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
  async resolveOffered(appId: string, expectedUrl?: string): Promise<string | null> {
    const current = await this.read();
    if (!current) throw new Error("Core's agent directory is unavailable.");
    const target = appId === CORE_PROVIDER_ID ? this.core() : current.providers.find(provider => provider.appId === appId);
    if (!target?.offered || !target.running) return null;
    return expectedUrl ? target.interfaces.find(item => item.url === expectedUrl)?.url ?? null : target.url;
  }
}
