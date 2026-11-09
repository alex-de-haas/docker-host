import { ConnectionUsage } from "./usage.js";
import { absentUsage, type ProviderUsage } from "../harness/provider-usage.js";
import type { HarnessRun } from "../harness/adapter.js";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  open,
  cp,
  lstat,
  mkdir,
  mkdtemp,
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
import { OllamaHarnessAdapter, OLLAMA_CAPABILITIES } from "../harness/ollama/index.js";
import { ollamaUrl } from "../harness/ollama/client.js";
import type { ConnectionSecrets } from "./secrets.js";
import { cleanAgentEnvironment, CodexLogin } from "./codex-login.js";
import { translationEnvironment, type TranslationRuntime } from "../translation/native.js";

export type AgentKind = "claude" | "codex" | "ollama";
export type AuthMethod = "api-key" | "claude-token" | "chatgpt" | "host-login" | "none";
export interface AgentConnection {
  id: string;
  name: string;
  kind: AgentKind;
  auth: AuthMethod;
  revision: number;
  secretKey: string;
  hostDirectory?: string;
  baseUrl?: string;
  importSource?: string;
  dockerImportIdentity?: string;
}
interface RegistryState {
  version: 1;
  connections: AgentConnection[];
  defaultId: string | null;
  imported: boolean;
  retiredKeys?: string[];
}
import { ConnectionError } from "./errors.js";
export { ConnectionError } from "./errors.js";
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
  private readonly usageCache: ConnectionUsage;
  private readonly usageRuns = new Map<string, Set<HarnessRun>>();
  private readonly diagnosing = new Set<string>();
  private readonly diagnosticDone = new Map<string, Promise<void>>();
  private readonly usageUpdates = new Set<Promise<void>>();
  private state: RegistryState | null = null;
  private active = new Map<string, number>();
  private translationActive = new Set<string>();
  private changing = new Set<string>();
  private assertInactive(id: string): void {
    if (this.active.get(id) || this.diagnosing.has(id))
      throw new ConnectionError(
        409,
        "provider_in_use",
        "Stop this provider’s open chats before replacing credentials, signing in again or removing the connection.",
      );
  }
  private queue: Promise<unknown> = Promise.resolve();
  private logins = new Map<string, LoginState>();
  private syncErrors = new Map<string, string>();
  private syncedAuth = new Map<string, string>();
  private syncTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly dataDir: string,
    private readonly cacheDir: string | null,
    private readonly secrets: ConnectionSecrets,
    private readonly applicationMode?: "native" | "docker",
  ) {
    this.usageCache = new ConnectionUsage(path.join(dataDir, "connection-usage"));
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
            !(c.kind === "ollama" ? c.secretKey === "" : /^agent\.[a-z0-9-]+$/.test(c.secretKey)) ||
            !Number.isSafeInteger(c.revision) ||
            c.revision < 1 ||
            !["claude", "codex", "ollama"].includes(c.kind) ||
            !(
              c.kind === "ollama" ? ["none"] : c.kind === "claude"
                ? ["api-key", "claude-token"]
                : ["api-key", "host-login", "chatgpt"]
            ).includes(c.auth) ||
            (c.baseUrl !== undefined && (c.kind !== "ollama" || typeof c.baseUrl !== "string" || ollamaUrl(c.baseUrl) !== c.baseUrl)) ||
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
    ollamaDefaultUrl: string;
  }> {
    const state = await this.load();
    const connections = await Promise.all(
      state.connections.map(async (connection) => {
        let available = true;
        let reason: string | undefined;
        try {
          if (
            connection.auth !== "host-login" && connection.auth !== "none" &&
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
    return { connections, defaultId: state.defaultId, ollamaDefaultUrl: ollamaUrl(undefined, this.applicationMode === "docker") };
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
    const portable = this.applicationMode === "docker" ? await this.secretGet(connection.secretKey) : null;
    if (this.applicationMode === "docker" && (!connection.dockerImportIdentity || !portable))
      throw new ConnectionError(409, "provider_import_required", "This host login has no portable authorization. Import the selected login in Local or connect a managed account in Harness settings.");
    let identity: string | undefined;
    try {
      const auth = JSON.parse(
        portable ?? await readFile(
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
    if (!identity && this.applicationMode !== "docker") {
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
    const fingerprint = createHash("sha256").update(identity).digest("hex");
    if (this.applicationMode === "docker" && fingerprint !== connection.dockerImportIdentity)
      throw new ConnectionError(409, "provider_host_account_changed", "The imported account changed. Prepare the selected host login again in Local.");
    return fingerprint;
  }
  async reserve(binding: ConnectionBinding): Promise<() => void> {
    return this.serialize(async () => {
      await this.diagnosticDone.get(binding.connectionId);
      if (this.translationActive.has(binding.connectionId))
        throw new ConnectionError(409, "provider_in_use", "This connection is translating. Retry after it finishes.");
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
          !["claude", "codex", "ollama"].includes(String(kind)) ||
          !(
            kind === "ollama" ? ["none"] : kind === "claude"
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
        if (auth === "none" && input.secret !== undefined) throw new ConnectionError(400, "provider_secret_invalid", "Ollama connections do not use credentials.");
        let baseUrl: string | undefined;
        if (kind === "ollama") {
          try { const value = input.baseUrl ?? previous?.baseUrl; baseUrl = value === "" || value === undefined ? undefined : ollamaUrl(value); }
          catch (error) { throw new ConnectionError(400, "provider_url_invalid", (error as Error).message); }
        }
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
          (previous !== null && (hostDirectory !== previous.hostDirectory || baseUrl !== previous.baseUrl));
        if (changed && previous) this.assertInactive(previous.id);
        const connection: AgentConnection = {
          id: previous?.id ?? randomUUID(),
          name,
          kind: kind as AgentKind,
          auth: auth as AuthMethod,
          revision: (previous?.revision ?? 0) + (!previous || changed ? 1 : 0),
          secretKey:
            auth === "none" ? "" : changed || !previous ? `agent.${randomUUID()}` : previous.secretKey,
          ...(hostDirectory ? { hostDirectory } : {}),
          ...(baseUrl ? { baseUrl } : {}),
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
            ...(changed && previous?.secretKey ? [previous.secretKey] : []),
          ],
          defaultId: !previous && !importSource && state.connections.length === 0 ? connection.id : state.defaultId,
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
  private home(connection: AgentConnection, docker = false): string {
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
  private async removeManagedHome(connection: AgentConnection): Promise<void> {
    if (this.cacheDir) for (const directory of ["agent-providers", "agent-docker-providers"])
      await rm(path.join(this.cacheDir, directory, connection.id), { recursive: true, force: true });
  }
  private async nativeHome(connection: AgentConnection, docker = false): Promise<string> {
    const home = this.home(connection, docker);
    await mkdir(home, { recursive: true, mode: 0o700 });
    if ((await realpath(home)) !== path.join(await realpath(this.cacheDir!), path.relative(this.cacheDir!, home))) throw new ConnectionError(409, "provider_storage_conflict", "The managed provider home redirects through a symbolic link.");
    await chmod(home, 0o700);
    // Only conversation directories enter backups. Native credential/config files stay in cache.
    for (const directory of connection.kind === "codex"
      ? ["sessions", "archived_sessions"]
      : connection.kind === "claude" ? ["projects"] : []) {
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
  /** Explicit operator action while Local can read the selected host login. */
  async prepareDockerAuthorization(id: string): Promise<void> {
    if (this.applicationMode === "docker")
      throw new ConnectionError(409, "host_login_unavailable", "Select Local in Core to import this host login, or connect a managed account here.");
    const connection = await this.get(id);
    if (connection.auth !== "host-login")
      throw new ConnectionError(400, "provider_import_unneeded", "Managed provider connections already work in both runtimes.");
    this.assertInactive(id);
    const binding = (await this.binding(id))!;
    this.changing.add(id);
    try { await this.adapter(binding, true); }
    finally { this.changing.delete(id); }
  }

  async adapter(binding: ConnectionBinding, docker = false): Promise<HarnessAdapter> {
    docker = this.applicationMode === "docker" || docker;
    const adapter = await this.serialize(async () => {
      if (this.translationActive.has(binding.connectionId))
        throw new ConnectionError(409, "provider_in_use", "This connection is translating. Retry after it finishes.");
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
      if (connection.kind === "ollama") return new OllamaHarnessAdapter({
        url: ollamaUrl(connection.baseUrl, docker),
        directory: path.join(this.dataDir, "provider-sessions", connection.id, String(connection.revision), "ollama"),
      });
      if (connection.auth === "host-login") {
        if (
          binding.connectionIdentity !== (await this.hostIdentity(connection))
        )
          throw new ConnectionError(
            409,
            "provider_host_account_changed",
            "The account in this host login changed. Start a new chat to use the current account.",
          );
        if (docker) {
          const home = await this.nativeHome(connection, docker);
          const stored = await this.secretGet(connection.secretKey);
          const importedIdentity = connection.dockerImportIdentity;
          if (!stored && importedIdentity === binding.connectionIdentity)
            throw new ConnectionError(409, "provider_reconnect_required", "The imported authorization was revoked. Reconnect this host login in Harness settings.");
          if (!stored || importedIdentity !== binding.connectionIdentity) {
            // Import authorization only. Never copy host config, hooks, MCP entries or histories.
            const raw = await readFile(path.join(connection.hostDirectory!, "auth.json"), "utf8").catch(() => null);
            if (!raw || Buffer.byteLength(raw) > 16000) throw new ConnectionError(409, "provider_import_required", "This host login cannot be imported. Sign in through Harness.");
            const auth = JSON.parse(raw) as Record<string, unknown>;
            const tokens = auth.tokens as Record<string, unknown> | undefined;
            const selected = auth.OPENAI_API_KEY ? { OPENAI_API_KEY: auth.OPENAI_API_KEY } : {
              auth_mode: "chatgpt", tokens: tokens && Object.fromEntries(["access_token", "refresh_token", "id_token", "account_id"].map(key => [key, tokens[key]])),
              ...(typeof auth.last_refresh === "string" ? { last_refresh: auth.last_refresh } : {}),
            };
            if (typeof auth.OPENAI_API_KEY !== "string" && (typeof tokens?.access_token !== "string" || typeof tokens?.refresh_token !== "string"))
              throw new ConnectionError(409, "provider_import_required", "This host login has no portable authorization. Sign in through Harness.");
            await this.secrets.set(connection.secretKey, JSON.stringify(selected));
            await this.writeAuth(home, JSON.stringify(selected));
            connection.dockerImportIdentity = binding.connectionIdentity;
            await this.save(await this.load());
          }
          await this.synchronizeAuth(connection, home);
          return new CodexHarnessAdapter({ dataDir: this.dataDir, codexHome: home, managedHome: home, isolated: true });
        }
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
          "Reconnect this provider in Hosty Harness settings. Its credential is missing.",
        );
      }
      const home = await this.nativeHome(connection, docker);
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
        await this.synchronizeAuth(connection, home);
        this.syncErrors.delete(connection.id);
      }
      if (docker && connection.auth === "api-key") await this.writeAuth(home, JSON.stringify({ OPENAI_API_KEY: secret }));
      return new CodexHarnessAdapter({
        dataDir: this.dataDir,
        codexHome: home,
        managedHome: home,
        isolated: true,
        ...(connection.auth === "api-key" ? { apiKey: secret } : {}),
      });
    });
    const usageIdentity = await this.usageKey(binding).catch(() => null);
    return {
      name: adapter.name,
      capabilities: adapter.capabilities,
      models: adapter.models ? () => adapter.models!() : undefined,
      readUsage: adapter.readUsage ? () => adapter.readUsage!() : undefined,
      probe: () => docker && adapter.name !== "ollama" ? Promise.resolve({ available: true }) : adapter.probe(),
      start: (options) => {
        if (this.translationActive.has(binding.connectionId) || this.diagnosing.has(binding.connectionId))
          throw new ConnectionError(409, "provider_in_use", "This connection is translating. Retry after it finishes.");
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
  /** Translation has an isolated native profile and an exclusive credential lease.
   * Native renewal must not race an operator chat or overwrite a replacement account. */
  async withTranslationRuntime<T>(binding: ConnectionBinding, action: (runtime: TranslationRuntime) => Promise<T>): Promise<T> {
    const connection = await this.serialize(async () => {
      const current = await this.get(binding.connectionId);
      if (current.revision !== binding.connectionRevision || current.kind !== binding.harnessKind)
        throw new ConnectionError(409, "translation_connection_changed", "Select the translation connection again after changing its credentials.");
      if (current.kind === "ollama") throw new ConnectionError(400, "translation_unsupported", "Select Codex or Claude for translation.");
      if (this.active.get(current.id) || this.translationActive.has(current.id) || this.diagnosing.has(current.id))
        throw new ConnectionError(429, "translation_busy", "This connection is in use. Stop its open chat or choose a dedicated translation connection.");
      if (this.syncErrors.has(current.id))
        throw new ConnectionError(503, "translation_unavailable", "Reconnect this account before using translation.");
      this.translationActive.add(current.id);
      this.active.set(current.id, 1);
      return current;
    });
    let root: string | undefined;
    let sourceAuth: string | undefined;
    let originalAuth: string | undefined;
    let home: string | undefined;
    try {
      if (!this.cacheDir) throw new ConnectionError(503, "translation_unavailable", "Core-managed cache storage is required for translation.");
      const parent = path.join(this.cacheDir, "translation-runs");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      root = await mkdtemp(path.join(parent, "run-"));
      home = path.join(root, "profile");
      const cwd = path.join(root, "work");
      await mkdir(home, { mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
      const env = translationEnvironment();
      // Numeric container identities need a home even when /etc/passwd has no matching user.
      // Keep incidental provider files inside the disposable translation profile on both runtimes.
      env.HOME = home;
      if (connection.auth === "host-login") {
        if (binding.connectionIdentity !== await this.hostIdentity(connection))
          throw new ConnectionError(409, "translation_connection_changed", "Select the current host account again in translation settings.");
        if (this.applicationMode === "docker") {
          originalAuth = await this.secretGet(connection.secretKey) ?? undefined;
        } else {
          sourceAuth = path.join(connection.hostDirectory!, "auth.json");
          originalAuth = await readFile(sourceAuth, "utf8").catch(() => undefined);
        }
        if (!originalAuth) throw new ConnectionError(503, "translation_unavailable", "Translation requires a file-backed Codex login. Select a managed connection for keychain-only logins.");
      } else {
        const secret = await this.secretGet(connection.secretKey);
        if (!secret) throw new ConnectionError(503, "translation_unavailable", "Reconnect this account in Harness settings.");
        if (connection.kind === "claude") env[connection.auth === "api-key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"] = secret;
        else if (connection.auth === "api-key") originalAuth = JSON.stringify({ OPENAI_API_KEY: secret });
        else {
          const native = await this.nativeHome(connection);
          sourceAuth = path.join(native, "auth.json");
          originalAuth = await readFile(sourceAuth, "utf8").catch(() => secret);
          await this.persistNativeAuth(connection, originalAuth);
          await writeFile(sourceAuth, originalAuth, { mode: 0o600 });
        }
      }
      if (connection.kind === "codex") {
        if (!originalAuth || Buffer.byteLength(originalAuth) > 16_000)
          throw new ConnectionError(503, "translation_unavailable", "The Codex credential cannot be used for translation.");
        await writeFile(path.join(home, "auth.json"), originalAuth, { mode: 0o600 });
        env.CODEX_HOME = home;
      } else env.CLAUDE_CONFIG_DIR = home;
      if (connection.kind === "ollama") throw new Error("Ollama translation is unsupported.");
      return await action({ kind: connection.kind, cwd, home, env });
    } finally {
      try {
        if (home && originalAuth && connection.auth === "host-login" && this.applicationMode === "docker") {
          const refreshed = await readFile(path.join(home, "auth.json"), "utf8").catch(() => originalAuth);
          if (refreshed !== originalAuth) await this.serialize(async () => {
            if (await this.secretGet(connection.secretKey) !== originalAuth)
              throw new ConnectionError(409, "translation_connection_changed", "The imported authorization changed during translation.");
            await this.secrets.set(connection.secretKey, refreshed!);
          });
        }
        if (home && sourceAuth && originalAuth) {
          const refreshed = await readFile(path.join(home, "auth.json"), "utf8").catch(() => originalAuth);
          if (refreshed !== originalAuth) {
            await this.serialize(async () => {
              if (await readFile(sourceAuth!, "utf8") !== originalAuth)
                throw new ConnectionError(409, "translation_connection_changed", "The native account changed during translation. Reconnect it before continuing.");
              if (connection.auth === "chatgpt") {
                if (!await this.secretGet(connection.secretKey)) throw new Error("Credential removed.");
                await this.persistNativeAuth(connection, refreshed!);
              }
              const temporary = `${sourceAuth}.${randomUUID()}.tmp`;
              await writeFile(temporary, refreshed!, { mode: 0o600 });
              await rename(temporary, sourceAuth!);
            });
          }
        }
      } catch {
        this.syncErrors.set(connection.id, "Translation credential renewal could not be saved. Reconnect this account.");
        throw new ConnectionError(503, "translation_credentials_unavailable", "Credential renewal could not be saved. Reconnect the translation account.");
      } finally {
        try { if (root) await rm(root, { recursive: true, force: true }); }
        finally { this.translationActive.delete(connection.id); this.active.delete(connection.id); }
      }
    }
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
      if (connection.kind === "ollama") throw new ConnectionError(400, "provider_legacy_invalid", "Ollama cannot adopt a native Codex or Claude session.");
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
  private async usageKey(binding: ConnectionBinding): Promise<string> {
    const source = await this.get(binding.connectionId);
    if (source.kind === "ollama") return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
    // The existing host-login fallback identifies only an email and starts another helper.
    // Account telemetry needs file-backed stable identity while a chat owns that login.
    if (source.auth === "host-login" && this.applicationMode !== "docker") {
      const auth = JSON.parse(await readFile(path.join(source.hostDirectory!, "auth.json"), "utf8"));
      if (!auth.OPENAI_API_KEY && (!auth.tokens?.account_id || !auth.tokens?.id_token)) throw new Error("Stable account identity unavailable");
    }
    const current = await this.binding(binding.connectionId);
    if (JSON.stringify(current) !== JSON.stringify(binding)) throw new Error("Connection changed");
    const connection = await this.get(binding.connectionId);
    const secret = connection.auth === "host-login" ? null : await this.secretGet(connection.secretKey);
    if (connection.auth !== "host-login" && !secret) throw new Error("Credential unavailable");
    let identity = secret ?? binding.connectionIdentity;
    if (connection.auth === "chatgpt" && secret) {
      try {
        const tokens = JSON.parse(secret).tokens;
        const subject = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")).sub;
        if (typeof tokens.account_id === "string" && typeof subject === "string") identity = JSON.stringify([tokens.account_id, subject]);
      } catch { /* An opaque authorization change conservatively invalidates the snapshot. */ }
    }
    return createHash("sha256").update(JSON.stringify([binding, identity])).digest("hex");
  }
  private async acceptUsage(binding: ConnectionBinding, identity: string, usage: ProviderUsage) {
    try { const key = await this.usageKey(binding); if (key === identity) { await this.usageCache.cached(binding.connectionId, key); this.usageCache.accept(binding.connectionId, key, usage); } }
    catch { /* An old process cannot publish observations for a replacement account. */ }
  }
  async usage(id: string, refresh = false): Promise<ProviderUsage> {
    const connection = await this.get(id);
    if (connection.kind === "ollama") return { ...absentUsage("not_applicable", "local"), connectionRevision: connection.revision };
    try {
      if (connection.auth === "host-login" && this.applicationMode !== "docker" && !await lstat(path.join(connection.hostDirectory!, "auth.json")).catch(() => null))
        return { ...absentUsage("unsupported", "unsupported_auth"), connectionRevision: connection.revision };
      const binding = await this.binding(id); if (!binding) return absentUsage();
      const key = await this.usageKey(binding);
      if (connection.auth === "api-key") return { ...absentUsage("unsupported", "unsupported_auth"), connectionRevision: binding.connectionRevision };
      const result = await this.usageCache.read(id, key, refresh, async () => {
        const run = [...(this.usageRuns.get(id) ?? [])].find(candidate => candidate.readUsage);
        if (run?.readUsage) return run.readUsage();
        if (this.active.get(id) || this.translationActive.has(id)) return absentUsage("unavailable", "busy");
        const adapter = await this.adapter(binding);
        let finish!: () => void;
        const claimed = await this.serialize(async () => {
          if (this.active.get(id) || this.translationActive.has(id) || this.diagnosing.has(id) || this.diagnosing.size >= (this.applicationMode === "docker" ? 1 : 2) || this.changing.has(id) || key !== await this.usageKey(binding)) return false;
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

  async fetchLogin(id: string) { return this.loginView(id); }
  private modelCatalogs = new Map<string, { expires: number; value: Promise<import("../worker/contracts.js").ModelCatalog> }>();
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
      const adapter =
        binding?.harnessKind === "claude"
          ? new ClaudeHarnessAdapter({})
          : binding?.harnessKind === "codex"
            ? new CodexHarnessAdapter({ dataDir: this.dataDir })
            : binding?.harnessKind === "ollama" ? { name: "ollama", capabilities: OLLAMA_CAPABILITIES } : null;
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
  private async writeAuth(home: string, raw: string): Promise<void> {
    const temporary = path.join(home, `.hosty-auth-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(raw); } finally { await handle.close(); }
    await rename(temporary, path.join(home, "auth.json"));
  }
  private async synchronizeAuth(connection: AgentConnection, home: string): Promise<void> {
    let secret = await this.secretGet(connection.secretKey);
    if (!secret) throw new ConnectionError(409, "provider_reconnect_required", "Reconnect this provider: its Core authorization is missing.");
    let current: string | null = null;
    const handle = await open(path.join(home, "auth.json"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(error => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if (handle) {
      try { if ((await handle.stat()).size > 16000) throw new Error("Provider authorization exceeds its size limit."); current = await handle.readFile("utf8"); }
      finally { await handle.close(); }
    }
    const previous = this.syncedAuth.get(home);
    const refreshedAt = (raw: string) => { const value = JSON.parse(raw).last_refresh; return typeof value === "string" ? Date.parse(value) || 0 : 0; };
    // A local refresh wins only when this process observed the old value, or its provider timestamp
    // is newer after restart. An unchanged stale home never overwrites a refreshed Core secret.
    if (current && current !== secret && (previous !== undefined && current !== previous || refreshedAt(current) > refreshedAt(secret))) {
      await this.persistNativeAuth(connection, current); secret = current;
    }
    if (current !== secret) await this.writeAuth(home, secret);
    this.syncedAuth.set(home, secret);
  }
  async syncCredentials(): Promise<void> {
    await this.serialize(async () => {
      await this.cleanupSecrets();
      for (const connection of (await this.load()).connections.filter(
        (c) => c.auth === "chatgpt" || c.auth === "host-login",
      )) {
        if (this.translationActive.has(connection.id) || this.diagnosing.has(connection.id)) continue;
        try {
          // Missing Core secret is revocation/reconnect, never an invitation to recreate it from cache.
          if (!(await this.secretGet(connection.secretKey))) {
            await this.removeManagedHome(connection);
            continue;
          }
          for (const docker of connection.auth === "host-login" ? [true] : [false, true]) {
            const home = this.home(connection, docker);
            if (await lstat(home).catch(() => null)) await this.synchronizeAuth(connection, home);
          }
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
      else if (env.CODEX_HOME || env.HOSTY_HARNESS_HARNESS === "codex")
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
            (env.HOSTY_HARNESS_HARNESS === "codex" ? "codex" : "claude"),
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
    await Promise.allSettled([...this.usageUpdates]);
    await this.usageCache.close();
    for (const login of this.logins.values()) await this.cancelLogin(login.id);
    await this.syncCredentials();
  }
}
