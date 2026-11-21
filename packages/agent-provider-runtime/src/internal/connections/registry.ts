import { ConnectionUsage } from "./usage.js";
import { absentUsage, type ProviderUsage } from "../harness/provider-usage.js";
import type { HarnessAdapter, HarnessAvailability, HarnessRun } from "../harness/adapter.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ConnectionSecrets } from "./secrets.js";
import { ConnectionError } from "./errors.js";
export { ConnectionError } from "./errors.js";

/** Engine and authentication identities are opaque to the shared runtime. */
export type AgentKind = string;
export type AuthMethod = string;
export interface AgentConnection {
  id: string; name: string; kind: string; auth: string; revision: number; secretKey: string;
  publishedInterfaces?: string[]; settingsRevision?: number;
  hostDirectory?: string; baseUrl?: string; importSource?: string; dockerImportIdentity?: string;
}
export interface RegistryState {
  version: 1; connections: AgentConnection[]; defaultId: string | null; imported: boolean; retiredKeys?: string[];
}
export type ConnectionBinding = { connectionId: string; connectionRevision: number; harnessKind: string; connectionIdentity?: string };
export type AdapterPreparation = { skillPath: string; sessionDirectory: string };
export type ConnectionLogin = { id: string; connectionId: string; status: "pending" | "complete" | "failed" | "cancelled"; verificationUrl?: string; userCode?: string; message?: string };
export interface ConnectionProfile {
  kind: string; name: string; capabilities: HarnessAdapter["capabilities"];
  authMethods: Record<string, { credential: "required" | "managed" | "external" | "none" }>;
  historyDirectories?: readonly string[];
  /** Some remote process profiles cannot probe their executable from the coordinator. */
  deferContainerProbe?: boolean;
}
const empty = (): RegistryState => ({ version: 1, connections: [], defaultId: null, imported: false });
const safeId = (id: string): boolean => /^[a-zA-Z0-9-]{1,80}$/.test(id);

/** Durable connection bookkeeping. Native authorization and engines belong to the owning app. */
export abstract class AgentConnections {
  protected readonly usageCache: ConnectionUsage;
  protected readonly usageRuns = new Map<string, Set<HarnessRun>>();
  protected readonly diagnosing = new Set<string>();
  protected readonly diagnosticDone = new Map<string, Promise<void>>();
  protected readonly usageUpdates = new Set<Promise<void>>();
  protected state: RegistryState | null = null;
  protected active = new Map<string, number>();
  protected changing = new Set<string>();
  protected assertInactive(id: string): void {
    if (this.active.get(id) || this.diagnosing.has(id))
      throw new ConnectionError(
        409,
        "provider_in_use",
        "Stop this provider’s open chats before replacing credentials, signing in again or removing the connection.",
      );
  }
  protected queue: Promise<unknown> = Promise.resolve();
  protected syncErrors = new Map<string, string>();
  protected syncTimer: ReturnType<typeof setInterval>;
  constructor(
    protected readonly dataDir: string,
    protected readonly cacheDir: string | null,
    protected readonly secrets: ConnectionSecrets,
    readonly profile: ConnectionProfile,
    protected readonly applicationMode?: "native" | "docker",
  ) {
    this.usageCache = new ConnectionUsage(path.join(dataDir, "connection-usage"));
    this.syncTimer = setInterval(() => {
      void this.syncCredentials();
    }, 5000);
    this.syncTimer.unref();
  }
  protected serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(action);
    this.queue = result;
    return result;
  }
  protected async load(): Promise<RegistryState> {
    if (this.state) return this.state;
    try {
      const state = JSON.parse(
        await readFile(path.join(this.dataDir, "connections.json"), "utf8"),
      ) as RegistryState;
      if (
        state.version !== 1 ||
        !Array.isArray(state.connections) ||
        state.connections.some(
          (c) =>
            !c ||
            typeof c.id !== "string" ||
            !safeId(c.id) ||
            typeof c.name !== "string" ||
            !c.name.trim() ||
            typeof c.secretKey !== "string" ||
            !(this.profile.authMethods[c.auth]?.credential === "none" ? c.secretKey === "" : /^agent\.[a-z0-9-]+$/.test(c.secretKey)) ||
            !Number.isSafeInteger(c.revision) ||
            c.revision < 1 ||
            c.kind !== this.profile.kind || !Object.hasOwn(this.profile.authMethods, c.auth) ||
            !this.validConnection(c)
        ) ||
        new Set(state.connections.map((c) => c.id)).size !==
          state.connections.length ||
        (state.retiredKeys !== undefined &&
          (!Array.isArray(state.retiredKeys) ||
            state.retiredKeys.some(
              (k) => typeof k !== "string" || !/^agent\.[a-z0-9-]+$/.test(k),
            )))
      )
        throw new Error(
          "Invalid provider settings. Restore the connection registry before continuing.",
        );
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = empty();
    }
    return this.state;
  }
  protected async save(state: RegistryState): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, "connections.json");
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, file);
    this.state = state;
  }
  protected async secretGet(key: string): Promise<string | null> {
    try {
      return await this.secrets.get(key);
    } catch {
      throw new ConnectionError(
        503,
        "provider_secrets_unavailable",
        "Core secret storage is unavailable. Retry when Core is reachable.",
      );
    }
  }
  async list(): Promise<{
    connections: Array<AgentConnection & HarnessAvailability>;
    defaultId: string | null;
    defaults?: Record<string, unknown>;
  }> {
    const state = await this.load();
    const connections = await Promise.all(
      state.connections.map(async (connection) => {
        let available = true;
        let reason: string | undefined;
        try {
          if (
            ["required", "managed"].includes(this.profile.authMethods[connection.auth]!.credential) &&
            !(await this.secretGet(connection.secretKey))
          ) {
            available = false;
            reason = "Connect this provider to continue.";
          }
          if (this.syncErrors.has(connection.id)) {
            available = false;
            reason = this.syncErrors.get(connection.id);
          }
        } catch {
          available = false;
          reason = "Core secret storage is unavailable.";
        }
        return { ...connection, available, ...(reason ? { reason } : {}) };
      }),
    );
    return { connections, defaultId: state.defaultId, defaults: this.connectionDefaults() };
  }
  async get(id: string): Promise<AgentConnection> {
    const connection = (await this.load()).connections.find((c) => c.id === id);
    if (!connection)
      throw new ConnectionError(
        404,
        "provider_not_found",
        "The provider connection no longer exists. Chat history is preserved.",
      );
    return connection;
  }
  async binding(id?: unknown): Promise<ConnectionBinding | null> {
    const selected = id === undefined ? (await this.load()).defaultId : id;
    if (selected === null || selected === undefined) return null;
    if (typeof selected !== "string")
      throw new ConnectionError(
        400,
        "provider_invalid",
        "Choose a provider connection.",
      );
    const connection = await this.get(selected);
    const identity = await this.connectionIdentity(connection);
    return {
      connectionId: connection.id,
      connectionRevision: connection.revision,
      harnessKind: connection.kind,
      ...(identity ? { connectionIdentity: identity } : {}),
    };
  }
  async reserve(binding: ConnectionBinding): Promise<() => void> {
    return this.serialize(async () => {
      await this.diagnosticDone.get(binding.connectionId);
      const connection = await this.get(binding.connectionId);
      if (
        connection.revision !== binding.connectionRevision ||
        connection.kind !== binding.harnessKind
      )
        throw new ConnectionError(
          409,
          "provider_credentials_changed",
          "The connection changed. Start a new chat with the updated account.",
        );
      this.active.set(connection.id, (this.active.get(connection.id) ?? 0) + 1);
      return () =>
        this.active.set(
          connection.id,
          Math.max(0, (this.active.get(connection.id) ?? 1) - 1),
        );
    });
  }
  async update(input: Record<string, unknown>, id?: string, importSource?: string): Promise<AgentConnection> {
    return this.serialize(async () => {
      if (id) this.changing.add(id);
      try {
        const state = await this.load(), previous = id ? await this.get(id) : null;
        const name = typeof input.name === "string" ? input.name.trim() : previous?.name;
        const kind = input.kind ?? previous?.kind ?? this.profile.kind, auth = input.auth ?? previous?.auth;
        if (!name || name.length > 100 || kind !== this.profile.kind || typeof auth !== "string" || !Object.hasOwn(this.profile.authMethods, auth))
          throw new ConnectionError(400, "provider_invalid", "Choose a name, provider type and supported authentication method.");
        if (previous && (kind !== previous.kind || auth !== previous.auth))
          throw new ConnectionError(400, "provider_type_fixed", "Create another connection to change its type or authentication method.");
        if (input.secret !== undefined && (typeof input.secret !== "string" || !input.secret.trim() || Buffer.byteLength(input.secret) > 16000))
          throw new ConnectionError(400, "provider_secret_invalid", "Enter a non-empty credential of at most 16,000 bytes.");
        const policy = this.profile.authMethods[auth]!.credential;
        if (input.secret !== undefined && policy !== "required")
          throw new ConnectionError(400, "provider_secret_invalid", "Use this authentication method's supported account setup.");
        if (previous && input.expectedSettingsRevision !== undefined && input.expectedSettingsRevision !== String(previous.settingsRevision ?? previous.revision))
          throw new ConnectionError(409, "connection_changed", "Refresh this connection before changing its settings.");
        const fields = await this.connectionFields(input, previous);
        const changed = input.secret !== undefined || previous !== null && (fields.hostDirectory !== previous.hostDirectory || fields.baseUrl !== previous.baseUrl);
        if (changed && previous) this.assertInactive(previous.id);
        const connection: AgentConnection = { id: previous?.id ?? randomUUID(), name, kind: this.profile.kind, auth,
          revision: (previous?.revision ?? 0) + (!previous || changed ? 1 : 0),
          secretKey: policy === "none" ? "" : changed || !previous ? `agent.${randomUUID()}` : previous.secretKey,
          ...fields, ...(fields.publishedInterfaces !== undefined ? { settingsRevision: (previous?.settingsRevision ?? previous?.revision ?? 0) + 1 } : {}), ...((previous?.importSource ?? importSource) ? { importSource: previous?.importSource ?? importSource } : {}) };
        if (!previous && policy === "required" && input.secret === undefined)
          throw new ConnectionError(400, "provider_secret_required", "Enter the provider credential.");
        if (typeof input.secret === "string") {
          await this.save({ ...state, retiredKeys: [...(state.retiredKeys ?? []), connection.secretKey] });
          await this.secrets.set(connection.secretKey, input.secret.trim());
        }
        // Retain the old credential until its replacement and connection revision are durable.
        await this.save({ ...state, retiredKeys: [...(state.retiredKeys ?? []), ...(changed && previous?.secretKey ? [previous.secretKey] : [])],
          defaultId: !previous && !importSource && state.connections.length === 0 ? connection.id : state.defaultId,
          connections: [...state.connections.filter(c => c.id !== connection.id), connection] });
        if (changed && previous) await this.removeManagedHome(previous);
        await this.cleanupSecrets(); this.syncErrors.delete(connection.id); return connection;
      } finally { if (id) this.changing.delete(id); }
    });
  }
  async setDefault(id: unknown): Promise<void> {
    await this.serialize(async () => {
      if (id !== null && typeof id !== "string")
        throw new ConnectionError(
          400,
          "provider_invalid",
          "Choose a provider or clear the default.",
        );
      if (typeof id === "string") await this.get(id);
      await this.save({ ...(await this.load()), defaultId: id });
    });
  }
  async remove(id: string): Promise<void> {
    await this.serialize(async () => {
      const connection = await this.get(id);
      this.assertInactive(id);
      this.changing.add(id);
      try {
        await this.cancelConnectionLogins(id);
        if (connection.secretKey) await this.secrets.delete(connection.secretKey);
        await this.removeManagedHome(connection);
        const state = await this.load();
        await this.save({
          ...state,
          defaultId: state.defaultId === id ? null : state.defaultId,
          connections: state.connections.filter((c) => c.id !== id),
        });
        this.syncErrors.delete(id);
        this.usageCache.invalidate(id);
      } finally {
        this.changing.delete(id);
      }
    });
  }
  protected home(connection: AgentConnection, docker = false): string {
    if (!this.cacheDir)
      throw new ConnectionError(
        503,
        "provider_cache_required",
        "Core-managed cache storage is required for provider credentials.",
      );
    return path.join(
      this.cacheDir,
      docker ? "agent-docker-providers" : "agent-providers",
      connection.id,
      String(connection.revision),
    );
  }
  protected async removeManagedHome(connection: AgentConnection): Promise<void> {
    if (this.cacheDir) for (const directory of ["agent-providers", "agent-docker-providers"])
      await rm(path.join(this.cacheDir, directory, connection.id), { recursive: true, force: true });
  }
  protected async nativeHome(connection: AgentConnection, docker = false): Promise<string> {
    const home = this.home(connection, docker);
    await mkdir(home, { recursive: true, mode: 0o700 });
    if ((await realpath(home)) !== path.join(await realpath(this.cacheDir!), path.relative(this.cacheDir!, home))) throw new ConnectionError(409, "provider_storage_conflict", "The managed provider home redirects through a symbolic link.");
    await chmod(home, 0o700);
    // Only conversation directories enter backups. Native credential/config files stay in cache.
    for (const directory of this.profile.historyDirectories ?? []) {
      const durable = path.join(
        this.dataDir,
        "provider-sessions",
        connection.id,
        String(connection.revision),
        directory,
      );
      await mkdir(durable, { recursive: true, mode: 0o700 });
      const link = path.join(home, directory);
      const info = await lstat(link).catch(() => null);
      // Windows directory symlinks require elevation or Developer Mode; junctions do not.
      if (!info)
        await symlink(
          path.resolve(durable),
          link,
          os.platform() === "win32" ? "junction" : "dir",
        );
      else if (
        !info.isSymbolicLink() ||
        (await realpath(link)) !== (await realpath(durable))
      )
        throw new ConnectionError(
          409,
          "provider_storage_conflict",
          "The managed provider session directory has an unexpected location.",
        );
    }
    return docker ? await realpath(home) : home;
  }
  async executionHome(binding: ConnectionBinding): Promise<string> {
    const connection = await this.get(binding.connectionId);
    if (connection.revision !== binding.connectionRevision) throw new ConnectionError(409, "provider_credentials_changed", "Select the current connection.");
    return this.nativeHome(connection, this.applicationMode === "docker");
  }
  async adapter(binding: ConnectionBinding, docker = false): Promise<HarnessAdapter> {
    docker = this.applicationMode === "docker" || docker;
    const adapter = await this.serialize(async () => {
      const connection = await this.get(binding.connectionId);
      if (connection.kind !== binding.harnessKind || connection.revision !== binding.connectionRevision)
        throw new ConnectionError(409, "provider_credentials_changed", "This connection's credentials changed. Start a new chat to use the updated account.");
      return this.createAdapter(connection, binding, docker);
    });
    const usageIdentity = await this.usageKey(binding).catch(() => null);
    return {
      name: adapter.name,
      capabilities: adapter.capabilities,
      models: adapter.models ? () => adapter.models!() : undefined,
      readUsage: adapter.readUsage ? () => adapter.readUsage!() : undefined,
      probe: () => docker && this.profile.deferContainerProbe ? Promise.resolve({ available: true }) : adapter.probe(),
      start: (options) => {
        if (this.diagnosing.has(binding.connectionId))
          throw new ConnectionError(409, "provider_in_use", "This connection is reading account usage. Retry after it finishes.");
        const current = this.state?.connections.find(
          (c) => c.id === binding.connectionId,
        );
        if (this.changing.has(binding.connectionId))
          throw new ConnectionError(
            409,
            "provider_changing",
            "The connection is being updated. Retry after saving finishes.",
          );
        if (!current || current.revision !== binding.connectionRevision)
          throw new ConnectionError(
            409,
            "provider_credentials_changed",
            "The connection changed. Select it again in a new chat.",
          );
        this.active.set(current.id, (this.active.get(current.id) ?? 0) + 1);
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            this.active.set(
              current.id,
              Math.max(0, (this.active.get(current.id) ?? 1) - 1),
            );
          }
        };
        try {
          const run = adapter.start({ ...options, onEvent: event => {
            if (event.type === "provider_usage") {
              if (!released && usageIdentity) {
                const update = this.acceptUsage(binding, usageIdentity, event.usage);
                this.usageUpdates.add(update); void update.finally(() => this.usageUpdates.delete(update));
              }
              return;
            }
            options.onEvent(event);
          } });
          const runs = this.usageRuns.get(current.id) ?? new Set<HarnessRun>();
          runs.add(run); this.usageRuns.set(current.id, runs);
          const removeRun = () => { runs.delete(run); if (!runs.size) this.usageRuns.delete(current.id); };

          return {
            readUsage: run.readUsage ? () => run.readUsage!() : undefined,
            send: (text) => run.send(text),
            resolveApproval: (id, decision, message) =>
              run.resolveApproval(id, decision, message),
            resolveQuestion: (id, answers) => run.resolveQuestion(id, answers),
            interrupt: () => run.interrupt(),
            setMcpServers: (servers) => run.setMcpServers(servers),
            ...(run.stopAndWait ? { stopAndWait: async () => {
              await run.stopAndWait!();
              removeRun(); release();
            } } : {}),
            stop: async () => {
              await run.stop();
              removeRun(); release();
            },
          };
        } catch (error) {
          release();
          throw error;
        }
      },
    };
  }
  protected async usageKey(binding: ConnectionBinding): Promise<string> {
    const current = await this.binding(binding.connectionId);
    if (JSON.stringify(current) !== JSON.stringify(binding)) throw new Error("Connection changed");
    const connection = await this.get(binding.connectionId), policy = this.profile.authMethods[connection.auth]!.credential;
    const identity = policy === "none" || policy === "external" ? binding.connectionIdentity : await this.secretGet(connection.secretKey);
    if (policy !== "none" && policy !== "external" && !identity) throw new Error("Credential unavailable");
    return createHash("sha256").update(JSON.stringify([binding, identity])).digest("hex");
  }
  protected async acceptUsage(binding: ConnectionBinding, identity: string, usage: ProviderUsage) {
    try { const key = await this.usageKey(binding); if (key === identity) { await this.usageCache.cached(binding.connectionId, key); this.usageCache.accept(binding.connectionId, key, usage); } }
    catch { /* An old process cannot publish observations for a replacement account. */ }
  }
  async usage(id: string, refresh = false): Promise<ProviderUsage> {
    const connection = await this.get(id);
    const unavailable = await this.unavailableUsage(connection, "before_identity");
    if (unavailable) return { ...unavailable, connectionRevision: connection.revision };
    try {
      const binding = await this.binding(id); if (!binding) return absentUsage();
      const key = await this.usageKey(binding);
      const unsupported = await this.unavailableUsage(connection, "after_identity");
      if (unsupported) return { ...unsupported, connectionRevision: binding.connectionRevision };
      const result = await this.usageCache.read(id, key, refresh, async () => {
        const run = [...(this.usageRuns.get(id) ?? [])].find(candidate => candidate.readUsage);
        if (run?.readUsage) return run.readUsage();
        if (this.active.get(id)) return absentUsage("unavailable", "busy");
        const adapter = await this.adapter(binding);
        let finish!: () => void;
        const claimed = await this.serialize(async () => {
          if (this.active.get(id) || this.diagnosing.has(id) || this.diagnosing.size >= (this.applicationMode === "docker" ? 1 : 2) || this.changing.has(id) || key !== await this.usageKey(binding)) return false;
          this.diagnosing.add(id);
          this.diagnosticDone.set(id, new Promise<void>(resolve => { finish = resolve; })); return true;
        });
        if (!claimed) return absentUsage("unavailable", "busy");
        try { return await adapter.readUsage?.() ?? absentUsage("unsupported", "unsupported_sdk"); }
        finally { this.diagnosing.delete(id); this.diagnosticDone.delete(id); finish(); await adapter.dispose?.(); }
      }, async () => key === await this.usageKey(binding));
      if (key !== await this.usageKey(binding)) return absentUsage();
      return { ...result, connectionRevision: binding.connectionRevision };
    } catch { this.usageCache.invalidate(id); return absentUsage("unavailable", "temporarily_unavailable"); }
  }

  protected modelCatalogs = new Map<string, { expires: number; value: Promise<import("../worker/contracts.js").ModelCatalog> }>();
  async models(id: string) {
    const binding = await this.binding(id);
    if (!binding) throw new ConnectionError(404, "provider_not_found", "Provider not found.");
    const key = JSON.stringify(binding), cached = this.modelCatalogs.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = (async () => {
      const adapter = await this.adapter(binding);
      if (!adapter.models) throw new ConnectionError(503, "catalog_unavailable", "Provider does not expose a model catalog.");
      return adapter.models();
    })();
    if (this.modelCatalogs.size >= 100) this.modelCatalogs.clear();
    this.modelCatalogs.set(key, { expires: Date.now() + 60000, value });
    try { return await value; } catch (error) { this.modelCatalogs.delete(key); throw error; }
  }
  async summary() {
    const defaultHealth = await this.health();
    if (defaultHealth.available) return defaultHealth;
    for (const connection of (await this.load()).connections) {
      // Resolving a host login can fail before health() gets a binding. Treat that
      // connection as unavailable and keep checking the remaining providers.
      const binding = await this.binding(connection.id).catch(() => null);
      const health = await this.health(binding);
      if (health.available) return { ...health, name: "Agent providers" };
    }
    return defaultHealth;
  }
  async health(binding?: ConnectionBinding | null, docker = false): Promise<
    HarnessAvailability & {
      name: string;
      capabilities: HarnessAdapter["capabilities"] & { appContext: boolean };
    }
  > {
    const missing = {
      name: "Agent providers",
      available: false,
      reason: "Choose a provider for this chat. Add a connection in Hosty Harness settings if none is available.",
      capabilities: {
        appContext: true,
        questions: false,
        appMcp: false,
        liveReconfigure: false,
        autoAllow: false,
        denyReason: false,
      },
    };
    try {
      const selected = binding === undefined ? await this.binding() : binding;
      if (!selected) return missing;
      const adapter = await this.adapter(selected, docker);
      return {
        name: adapter.name,
        capabilities: { ...adapter.capabilities, appContext: true },
        ...(await adapter.probe()),
      };
    } catch (error) {
      const adapter = { name: this.profile.name, capabilities: this.profile.capabilities };
      return {
        ...missing,
        ...(adapter
          ? {
              name: adapter.name,
              capabilities: { ...adapter.capabilities, appContext: true },
            }
          : {}),
        reason:
          error instanceof ConnectionError
            ? error.message
            : error instanceof Error && "code" in error &&
                ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EROFS"].includes(String(error.code))
              ? `Provider storage setup failed (${String(error.code)}). Check Gateway data/cache directory access and free disk space.`
              : "Provider setup failed. Check the Gateway installation and provider configuration.",
      };
    }
  }
  protected async cleanupSecrets(): Promise<void> {
    const state = await this.load();
    const remaining: string[] = [];
    for (const key of state.retiredKeys ?? []) {
      if (state.connections.some((c) => c.secretKey === key)) continue;
      try {
        await this.secrets.delete(key);
      } catch {
        remaining.push(key);
      }
    }
    if (remaining.length !== (state.retiredKeys?.length ?? 0))
      await this.save({ ...state, retiredKeys: remaining });
  }
  protected validConnection(_connection: AgentConnection): boolean { return true; }
  protected connectionDefaults(): Record<string, unknown> { return {}; }
  protected async connectionFields(_input: Record<string, unknown>, _previous: AgentConnection | null): Promise<Pick<AgentConnection, "hostDirectory" | "baseUrl" | "publishedInterfaces">> { return {}; }
  protected async connectionIdentity(_connection: AgentConnection): Promise<string | undefined> { return undefined; }
  protected abstract createAdapter(connection: AgentConnection, binding: ConnectionBinding, docker: boolean): Promise<HarnessAdapter>;
  async prepareAdapter(binding: ConnectionBinding, _context: AdapterPreparation): Promise<HarnessAdapter> { return this.adapter(binding); }
  protected async unavailableUsage(_connection: AgentConnection, _phase: "before_identity" | "after_identity"): Promise<ProviderUsage | undefined> { return undefined; }
  protected async cancelConnectionLogins(_id: string): Promise<void> {}
  protected async closeConnections(): Promise<void> {}
  async syncCredentials(): Promise<void> { await this.serialize(() => this.cleanupSecrets()).catch(() => {}); }
  async startLogin(_id: string): Promise<ConnectionLogin> { throw new ConnectionError(400, "provider_login_invalid", "This connection does not use browser sign-in."); }
  async fetchLogin(_id: string): Promise<ConnectionLogin> { throw new ConnectionError(404, "login_not_found", "This login attempt expired. Start sign-in again."); }
  async cancelLogin(_id: string): Promise<void> { throw new ConnectionError(404, "login_not_found", "This login attempt expired. Start sign-in again."); }
  async shutdown(): Promise<void> {
    clearInterval(this.syncTimer); await Promise.allSettled([...this.usageUpdates]); await this.usageCache.close();
    await this.closeConnections(); await this.syncCredentials();
  }
}
/** The execution runtime depends only on this structural application-owned connection surface. */
export type ProviderConnections = Pick<AgentConnections, "list" | "binding" | "reserve" | "adapter" | "prepareAdapter" | "models" | "usage" | "shutdown"> & {
  inspectNativeContext?(sessionId: string, nativeId: string): Promise<"available" | "missing">;
};
