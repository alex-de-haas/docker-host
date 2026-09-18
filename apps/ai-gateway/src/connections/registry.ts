import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  HarnessAdapter,
  HarnessAvailability,
} from "../harness/adapter.js";
import { ClaudeHarnessAdapter } from "../harness/claude.js";
import { CodexHarnessAdapter } from "../harness/codex.js";
import type { ConnectionSecrets } from "./secrets.js";
import { cleanAgentEnvironment, CodexLogin } from "./codex-login.js";

export type AgentKind = "claude" | "codex";
export type AuthMethod = "api-key" | "claude-token" | "chatgpt" | "host-login";
export interface AgentConnection {
  id: string;
  name: string;
  kind: AgentKind;
  auth: AuthMethod;
  revision: number;
  secretKey: string;
  hostDirectory?: string;
  importSource?: string;
}
interface RegistryState {
  version: 1;
  connections: AgentConnection[];
  defaultId: string | null;
  imported: boolean;
  retiredKeys?: string[];
}
export class ConnectionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type ConnectionBinding = {
  connectionId: string;
  connectionRevision: number;
  harnessKind: AgentKind;
  connectionIdentity?: string;
};
type LoginState = {
  id: string;
  connectionId: string;
  revision: number;
  status: "pending" | "complete" | "failed" | "cancelled";
  verificationUrl?: string;
  userCode?: string;
  nativeLoginId?: string;
  message?: string;
  worker: CodexLogin;
  home: string;
  timer: ReturnType<typeof setTimeout>;
};
const empty = (): RegistryState => ({
  version: 1,
  connections: [],
  defaultId: null,
  imported: false,
});
const safeId = (id: string): boolean => /^[a-zA-Z0-9-]{1,80}$/.test(id);

export class AgentConnections {
  private state: RegistryState | null = null;
  private active = new Map<string, number>();
  private changing = new Set<string>();
  private assertInactive(id: string): void {
    if (this.active.get(id))
      throw new ConnectionError(
        409,
        "provider_in_use",
        "Stop this provider’s open chats before replacing credentials, signing in again or removing the connection.",
      );
  }
  private queue: Promise<unknown> = Promise.resolve();
  private logins = new Map<string, LoginState>();
  private syncErrors = new Map<string, string>();
  private syncTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly dataDir: string,
    private readonly cacheDir: string | null,
    private readonly secrets: ConnectionSecrets,
  ) {
    this.syncTimer = setInterval(() => {
      void this.syncCredentials();
    }, 5000);
    this.syncTimer.unref();
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(action);
    this.queue = result;
    return result;
  }
  private async load(): Promise<RegistryState> {
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
            !/^agent\.[a-z0-9-]+$/.test(c.secretKey) ||
            !Number.isSafeInteger(c.revision) ||
            c.revision < 1 ||
            !["claude", "codex"].includes(c.kind) ||
            !(
              c.kind === "claude"
                ? ["api-key", "claude-token"]
                : ["api-key", "host-login", "chatgpt"]
            ).includes(c.auth) ||
            (c.auth === "host-login" &&
              (typeof c.hostDirectory !== "string" ||
                !path.isAbsolute(c.hostDirectory))),
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
  private async save(state: RegistryState): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, "connections.json");
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, file);
    this.state = state;
  }
  private async secretGet(key: string): Promise<string | null> {
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
  }> {
    const state = await this.load();
    const connections = await Promise.all(
      state.connections.map(async (connection) => {
        let available = true;
        let reason: string | undefined;
        try {
          if (
            connection.auth !== "host-login" &&
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
    return { connections, defaultId: state.defaultId };
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
    return {
      connectionId: connection.id,
      connectionRevision: connection.revision,
      harnessKind: connection.kind,
      ...(connection.auth === "host-login"
        ? { connectionIdentity: await this.hostIdentity(connection) }
        : {}),
    };
  }
  private async hostIdentity(connection: AgentConnection): Promise<string> {
    let identity: string | undefined;
    try {
      const auth = JSON.parse(
        await readFile(
          path.join(connection.hostDirectory!, "auth.json"),
          "utf8",
        ),
      ) as {
        OPENAI_API_KEY?: string;
        tokens?: { account_id?: string; id_token?: string };
      };
      if (auth.OPENAI_API_KEY) identity = `api:${auth.OPENAI_API_KEY}`;
      else if (auth.tokens?.account_id) {
        // Workspace/account id alone can be shared by multiple members. Include the native
        // ID token's subject so signing in as another member cannot reuse this chat silently.
        let subject = "";
        if (auth.tokens.id_token) {
          const payload = JSON.parse(
            Buffer.from(
              auth.tokens.id_token.split(".")[1] ?? "",
              "base64url",
            ).toString("utf8"),
          ) as { sub?: string };
          subject = payload.sub ?? "";
        }
        identity = `chatgpt:${auth.tokens.account_id}:${subject}`;
      }
    } catch {
      /* Keychain-backed homes may have no auth.json. */
    }
    if (!identity) {
      const worker = new CodexLogin(connection.hostDirectory!, false);
      try {
        await worker.initialize();
        const response = await worker.request("account/read", {
          refreshToken: false,
        });
        const account = response.account as {
          type?: string;
          email?: string;
        } | null;
        if (account?.type === "chatgpt" && account.email)
          identity = `chatgpt-email:${account.email}`;
      } finally {
        worker.close();
      }
    }
    if (!identity)
      throw new ConnectionError(
        409,
        "provider_host_identity_unavailable",
        "Cannot identify the account in this Codex home. Sign in on the host or choose a managed connection.",
      );
    return createHash("sha256").update(identity).digest("hex");
  }
  async reserve(binding: ConnectionBinding): Promise<() => void> {
    return this.serialize(async () => {
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
  async update(
    input: Record<string, unknown>,
    id?: string,
    importSource?: string,
  ): Promise<AgentConnection> {
    return this.serialize(async () => {
      if (id) this.changing.add(id);
      try {
        const state = await this.load();
        const previous = id ? await this.get(id) : null;
        const name =
          typeof input.name === "string" ? input.name.trim() : previous?.name;
        const kind = input.kind ?? previous?.kind;
        const auth = input.auth ?? previous?.auth;
        if (
          !name ||
          name.length > 100 ||
          !["claude", "codex"].includes(String(kind)) ||
          !(
            kind === "claude"
              ? ["api-key", "claude-token"]
              : ["api-key", "chatgpt", "host-login"]
          ).includes(String(auth))
        )
          throw new ConnectionError(
            400,
            "provider_invalid",
            "Choose a name, provider type and supported authentication method.",
          );
        if (previous && (kind !== previous.kind || auth !== previous.auth))
          throw new ConnectionError(
            400,
            "provider_type_fixed",
            "Create another connection to change its type or authentication method.",
          );
        if (
          input.secret !== undefined &&
          (typeof input.secret !== "string" ||
            !input.secret.trim() ||
            Buffer.byteLength(input.secret) > 16000)
        )
          throw new ConnectionError(
            400,
            "provider_secret_invalid",
            "Enter a non-empty credential of at most 16,000 bytes.",
          );
        const hostDirectory =
          auth === "host-login"
            ? typeof input.hostDirectory === "string"
              ? input.hostDirectory.trim()
              : previous?.hostDirectory
            : undefined;
        if (
          auth === "host-login" &&
          (!hostDirectory || !path.isAbsolute(hostDirectory))
        )
          throw new ConnectionError(
            400,
            "provider_home_invalid",
            "Enter the absolute Codex home directory used for the existing host login.",
          );
        const changed =
          input.secret !== undefined ||
          (previous !== null && hostDirectory !== previous.hostDirectory);
        if (changed && previous) this.assertInactive(previous.id);
        const connection: AgentConnection = {
          id: previous?.id ?? randomUUID(),
          name,
          kind: kind as AgentKind,
          auth: auth as AuthMethod,
          revision: (previous?.revision ?? 0) + (!previous || changed ? 1 : 0),
          secretKey:
            changed || !previous ? `agent.${randomUUID()}` : previous.secretKey,
          ...(hostDirectory ? { hostDirectory } : {}),
          ...((previous?.importSource ?? importSource)
            ? { importSource: previous?.importSource ?? importSource }
            : {}),
        };
        if (
          !previous &&
          ["api-key", "claude-token"].includes(connection.auth) &&
          input.secret === undefined
        )
          throw new ConnectionError(
            400,
            "provider_secret_required",
            "Enter the provider credential.",
          );
        if (connection.auth === "chatgpt" && input.secret !== undefined)
          throw new ConnectionError(
            400,
            "provider_secret_invalid",
            "Use ChatGPT sign-in for this connection.",
          );
        if (connection.auth === "host-login" && input.secret !== undefined)
          throw new ConnectionError(
            400,
            "provider_secret_invalid",
            "Host login uses its existing credential directory.",
          );
        if (
          hostDirectory &&
          !path
            .relative(path.resolve(this.dataDir), path.resolve(hostDirectory))
            .startsWith("..")
        )
          throw new ConnectionError(
            400,
            "provider_home_invalid",
            "The existing login directory must be outside Gateway’s backed-up data directory.",
          );
        if (typeof input.secret === "string") {
          await this.save({
            ...state,
            retiredKeys: [...(state.retiredKeys ?? []), connection.secretKey],
          });
          await this.secrets.set(connection.secretKey, input.secret.trim());
        }
        // Journal unreferenced keys before writing them. Interrupted writes/rotations are retried
        // without losing the previous credential or leaving usable orphan secrets indefinitely.
        await this.save({
          ...state,
          retiredKeys: [
            ...(state.retiredKeys ?? []),
            ...(changed && previous ? [previous.secretKey] : []),
          ],
          connections: [
            ...state.connections.filter((c) => c.id !== connection.id),
            connection,
          ],
        });
        if (changed && previous) await this.removeManagedHome(previous);
        await this.cleanupSecrets();
        this.syncErrors.delete(connection.id);
        return connection;
      } finally {
        if (id) this.changing.delete(id);
      }
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
        for (const login of this.logins.values())
          if (login.connectionId === id) await this.cancelLoginNow(login.id);
        await this.secrets.delete(connection.secretKey);
        await this.removeManagedHome(connection);
        const state = await this.load();
        await this.save({
          ...state,
          defaultId: state.defaultId === id ? null : state.defaultId,
          connections: state.connections.filter((c) => c.id !== id),
        });
        this.syncErrors.delete(id);
      } finally {
        this.changing.delete(id);
      }
    });
  }
  private home(connection: AgentConnection): string {
    if (!this.cacheDir)
      throw new ConnectionError(
        503,
        "provider_cache_required",
        "Core-managed cache storage is required for provider credentials.",
      );
    return path.join(
      this.cacheDir,
      "agent-providers",
      connection.id,
      String(connection.revision),
    );
  }
  private async removeManagedHome(connection: AgentConnection): Promise<void> {
    if (this.cacheDir)
      await rm(path.join(this.cacheDir, "agent-providers", connection.id), {
        recursive: true,
        force: true,
      });
  }
  private async nativeHome(connection: AgentConnection): Promise<string> {
    const home = this.home(connection);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    // Only conversation directories enter backups. Native credential/config files stay in cache.
    for (const directory of connection.kind === "codex"
      ? ["sessions", "archived_sessions"]
      : ["projects"]) {
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
      if (!info) await symlink(durable, link, "dir");
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
    return home;
  }
  async adapter(binding: ConnectionBinding): Promise<HarnessAdapter> {
    const adapter = await this.serialize(async () => {
      const connection = await this.get(binding.connectionId);
      if (
        connection.kind !== binding.harnessKind ||
        connection.revision !== binding.connectionRevision
      )
        throw new ConnectionError(
          409,
          "provider_credentials_changed",
          "This connection's credentials changed. Start a new chat to use the updated account.",
        );
      if (connection.auth === "host-login") {
        if (
          binding.connectionIdentity !== (await this.hostIdentity(connection))
        )
          throw new ConnectionError(
            409,
            "provider_host_account_changed",
            "The account in this host login changed. Start a new chat to use the current account.",
          );
        return new CodexHarnessAdapter({
          dataDir: this.dataDir,
          codexHome: connection.hostDirectory,
          isolated: true,
        });
      }
      const secret = await this.secretGet(connection.secretKey);
      if (!secret) {
        await this.removeManagedHome(connection);
        throw new ConnectionError(
          409,
          "provider_reconnect_required",
          "Reconnect this provider in Gateway settings. Its credential is missing.",
        );
      }
      const home = await this.nativeHome(connection);
      if (connection.kind === "claude") {
        const env = cleanAgentEnvironment();
        env.CLAUDE_CONFIG_DIR = home;
        env[
          connection.auth === "api-key"
            ? "ANTHROPIC_API_KEY"
            : "CLAUDE_CODE_OAUTH_TOKEN"
        ] = secret;
        return new ClaudeHarnessAdapter(env);
      }
      if (connection.auth === "chatgpt") {
        const file = path.join(home, "auth.json");
        const current = await readFile(file, "utf8").catch(() => null);
        if (current) await this.persistNativeAuth(connection, current);
        else await writeFile(file, secret, { mode: 0o600 });
        this.syncErrors.delete(connection.id);
      }
      return new CodexHarnessAdapter({
        dataDir: this.dataDir,
        codexHome: home,
        managedHome: home,
        isolated: true,
        ...(connection.auth === "api-key" ? { apiKey: secret } : {}),
      });
    });
    return {
      name: adapter.name,
      capabilities: adapter.capabilities,
      probe: () => adapter.probe(),
      start: (options) => {
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
          const run = adapter.start(options);
          return {
            send: (text) => run.send(text),
            resolveApproval: (id, decision, message) =>
              run.resolveApproval(id, decision, message),
            resolveQuestion: (id, answers) => run.resolveQuestion(id, answers),
            interrupt: () => run.interrupt(),
            setMcpServers: (servers) => run.setMcpServers(servers),
            stop: async () => {
              try {
                await run.stop();
              } finally {
                release();
              }
            },
          };
        } catch (error) {
          release();
          throw error;
        }
      },
    };
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
      if (connection.auth === "host-login") return;
      const home = await this.nativeHome(connection);
      // Codex's legacy managed home is migrated at startup. Claude previously used its user's
      // native home; copy only this explicitly adopted session, never unrelated conversations.
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
  async health(binding?: ConnectionBinding | null): Promise<
    HarnessAvailability & {
      name: string;
      capabilities: HarnessAdapter["capabilities"] & { appContext: boolean };
    }
  > {
    const missing = {
      name: "Agent providers",
      available: false,
      reason: "Add and select a provider in Gateway settings.",
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
      const adapter = await this.adapter(selected);
      return {
        name: adapter.name,
        capabilities: { ...adapter.capabilities, appContext: true },
        ...(await adapter.probe()),
      };
    } catch (error) {
      const adapter =
        binding?.harnessKind === "claude"
          ? new ClaudeHarnessAdapter({})
          : binding?.harnessKind === "codex"
            ? new CodexHarnessAdapter({ dataDir: this.dataDir })
            : null;
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
            : "Provider setup failed. Check Core connectivity and reconnect the provider.",
      };
    }
  }
  private async cleanupSecrets(): Promise<void> {
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
  private async persistNativeAuth(
    connection: AgentConnection,
    raw: string,
  ): Promise<void> {
    if (Buffer.byteLength(raw) > 16000)
      throw new Error(
        "The native credential exceeds Core's secret size limit.",
      );
    const auth = JSON.parse(raw) as {
      tokens?: { access_token?: unknown; refresh_token?: unknown };
    };
    if (
      typeof auth.tokens?.access_token !== "string" ||
      typeof auth.tokens.refresh_token !== "string"
    )
      throw new Error("Codex did not return renewable ChatGPT credentials.");
    const stored = await this.secretGet(connection.secretKey);
    if (stored !== raw) await this.secrets.set(connection.secretKey, raw);
  }
  async syncCredentials(): Promise<void> {
    await this.serialize(async () => {
      await this.cleanupSecrets();
      for (const connection of (await this.load()).connections.filter(
        (c) => c.auth === "chatgpt",
      )) {
        try {
          // Missing Core secret is revocation/reconnect, never an invitation to recreate it from cache.
          if (!(await this.secretGet(connection.secretKey))) {
            await this.removeManagedHome(connection);
            continue;
          }
          const raw = await readFile(
            path.join(this.home(connection), "auth.json"),
            "utf8",
          ).catch(() => null);
          if (raw) await this.persistNativeAuth(connection, raw);
          this.syncErrors.delete(connection.id);
        } catch {
          this.syncErrors.set(
            connection.id,
            "Could not save refreshed credentials to Core. Restore Core connectivity before continuing.",
          );
        }
      }
    }).catch(() => {});
  }
  async startLogin(
    id: string,
  ): Promise<ReturnType<AgentConnections["loginView"]>> {
    return this.serialize(() => this.startLoginNow(id));
  }
  private async startLoginNow(
    id: string,
  ): Promise<ReturnType<AgentConnections["loginView"]>> {
    this.assertInactive(id);
    const connection = await this.get(id);
    if (connection.auth !== "chatgpt")
      throw new ConnectionError(
        400,
        "provider_login_invalid",
        "This connection does not use ChatGPT sign-in.",
      );
    for (const login of this.logins.values())
      if (login.connectionId === id && login.status === "pending")
        return this.loginView(login.id);
    const loginId = randomUUID();
    this.home(connection); // Require Core-managed cache before starting native authentication.
    const home = path.join(this.cacheDir!, "agent-logins", loginId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const worker = new CodexLogin(home);
    const timer = setTimeout(() => {
      void this.cancelLogin(loginId).catch(() => {});
    }, 15 * 60_000);
    timer.unref();
    const login: LoginState = {
      id: loginId,
      connectionId: id,
      revision: connection.revision,
      status: "pending",
      home,
      worker,
      timer,
    };
    this.logins.set(loginId, login);
    worker.onComplete = (success) => {
      void this.completeLogin(login, success).catch(() => {
        login.status = "failed";
        login.message =
          "Sign-in cleanup failed. Retry after checking local storage.";
      });
    };
    try {
      await worker.initialize();
      const response = await worker.request("account/login/start", {
        type: "chatgptDeviceCode",
      });
      if (
        typeof response.verificationUrl !== "string" ||
        typeof response.userCode !== "string" ||
        new URL(response.verificationUrl).origin !== "https://auth.openai.com"
      )
        throw new Error("Unexpected login response.");
      login.verificationUrl = response.verificationUrl;
      login.userCode = response.userCode;
      login.nativeLoginId =
        typeof response.loginId === "string" ? response.loginId : undefined;
      return this.loginView(loginId);
    } catch {
      login.status = "failed";
      login.message =
        "ChatGPT sign-in could not start. Check connectivity and whether device-code login is enabled for your account.";
      await this.finishLogin(login);
      return this.loginView(loginId);
    }
  }
  private async completeLogin(
    login: LoginState,
    success: boolean,
  ): Promise<void> {
    await this.serialize(async () => {
      if (login.status !== "pending") return;
      this.changing.add(login.connectionId);
      try {
        if (!success) throw new Error();
        const previous = await this.get(login.connectionId);
        if (previous.revision !== login.revision) throw new Error();
        this.assertInactive(previous.id);
        const raw = await readFile(path.join(login.home, "auth.json"), "utf8");
        const connection = {
          ...previous,
          secretKey: `agent.${randomUUID()}`,
          revision: previous.revision + 1,
        };
        const state = await this.load();
        await this.save({
          ...state,
          retiredKeys: [...(state.retiredKeys ?? []), connection.secretKey],
        });
        await this.persistNativeAuth(connection, raw);
        await this.save({
          ...state,
          retiredKeys: [...(state.retiredKeys ?? []), previous.secretKey],
          connections: state.connections.map((c) =>
            c.id === previous.id ? connection : c,
          ),
        });
        await this.cleanupSecrets();
        // Remove the previous revision's native credential copy as well as the temporary login.
        await rm(this.home(previous), { recursive: true, force: true });
        login.status = "complete";
      } catch {
        login.status = "failed";
        login.message =
          "Sign-in could not be saved. Check Core connectivity and retry.";
      }
      this.changing.delete(login.connectionId);
      await this.finishLogin(login);
    });
  }
  private async finishLogin(login: LoginState): Promise<void> {
    clearTimeout(login.timer);
    login.worker.close();
    await rm(login.home, { recursive: true, force: true });
    const cleanup = setTimeout(() => this.logins.delete(login.id), 10 * 60_000);
    cleanup.unref();
  }
  loginView(id: string) {
    const login = this.logins.get(id);
    if (!login)
      throw new ConnectionError(
        404,
        "login_not_found",
        "This login attempt expired. Start sign-in again.",
      );
    return {
      id: login.id,
      connectionId: login.connectionId,
      status: login.status,
      ...(login.status === "pending"
        ? { verificationUrl: login.verificationUrl, userCode: login.userCode }
        : {}),
      message: login.message,
    };
  }
  async cancelLogin(id: string): Promise<void> {
    await this.serialize(() => this.cancelLoginNow(id));
  }
  private async cancelLoginNow(id: string): Promise<void> {
    const login = this.logins.get(id);
    if (login?.status === "pending") {
      login.status = "cancelled";
      if (login.nativeLoginId)
        await login.worker
          .request("account/login/cancel", { loginId: login.nativeLoginId })
          .catch(() => {});
      await this.finishLogin(login);
    }
  }
  async importEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
    if (!(await this.load()).imported) {
      const sources: Array<Record<string, unknown> & { importSource: string }> =
        [];
      if (env.ANTHROPIC_API_KEY?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim())
        sources.push({
          importSource: "claude-env",
          name: "Claude",
          kind: "claude",
          auth: env.ANTHROPIC_API_KEY?.trim() ? "api-key" : "claude-token",
          secret:
            env.ANTHROPIC_API_KEY?.trim() ||
            env.CLAUDE_CODE_OAUTH_TOKEN?.trim(),
        });
      if (env.CODEX_API_KEY?.trim())
        sources.push({
          importSource: "codex-env",
          name: "Codex",
          kind: "codex",
          auth: "api-key",
          secret: env.CODEX_API_KEY.trim(),
        });
      else if (env.CODEX_HOME || env.HOSTY_AI_GATEWAY_HARNESS === "codex")
        sources.push({
          importSource: "codex-env",
          name: "Codex (host login)",
          kind: "codex",
          auth: "host-login",
          hostDirectory:
            env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
        });
      for (const source of sources) {
        if (
          (await this.load()).connections.some(
            (c) => c.importSource === source.importSource,
          )
        )
          continue;
        await this.update(source, undefined, source.importSource);
      }
      await this.serialize(async () => {
        const state = await this.load();
        const preferred = state.connections.find(
          (c) =>
            c.kind ===
            (env.HOSTY_AI_GATEWAY_HARNESS === "codex" ? "codex" : "claude"),
        );
        await this.save({
          ...state,
          imported: true,
          defaultId:
            state.defaultId ??
            preferred?.id ??
            state.connections[0]?.id ??
            null,
        });
      });
    }
    // Retire the managed legacy native home only after the new API connection is usable. Keep its
    // conversation files in durable storage; move auth/config files out of backup scope.
    const codex = (await this.load()).connections.find(
      (c) => c.importSource === "codex-env" && c.auth === "api-key",
    );
    const legacy = path.join(this.dataDir, "codex-home");
    if (codex && (await lstat(legacy).catch(() => null))) {
      const adapter = await this.adapter({
        connectionId: codex.id,
        connectionRevision: codex.revision,
        harnessKind: "codex",
      });
      if (!(await adapter.probe()).available)
        throw new ConnectionError(
          503,
          "provider_migration_pending",
          "Legacy Codex credentials could not be migrated. Check provider connectivity and restart Gateway.",
        );
      const home = await this.nativeHome(codex);
      for (const directory of ["sessions", "archived_sessions"]) {
        if (await lstat(path.join(legacy, directory)).catch(() => null))
          await cp(
            path.join(legacy, directory),
            path.join(
              this.dataDir,
              "provider-sessions",
              codex.id,
              String(codex.revision),
              directory,
            ),
            { recursive: true },
          );
      }
      const retired = path.join(home, "legacy-home");
      await cp(legacy, retired, { recursive: true });
      await rm(legacy, { recursive: true });
    }
  }
  async shutdown(): Promise<void> {
    clearInterval(this.syncTimer);
    for (const login of this.logins.values()) await this.cancelLogin(login.id);
    await this.syncCredentials();
  }
}
