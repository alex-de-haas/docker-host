import type { ProviderSettingsDefinition } from "@hosty/agent-provider-runtime/settings";
import type { AgentCapabilities } from "@hosty-sdk/app/agent";
import { skillAdapter } from "@hosty/agent-provider-runtime/worker/skills";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentConnections, ConnectionError, type AgentConnection, type ConnectionBinding, type AdapterPreparation, type ConnectionLogin } from "@hosty/agent-provider-runtime/connections/registry";
import type { ConnectionSecrets } from "@hosty/agent-provider-runtime/connections/secrets";
import type { HarnessAdapter } from "@hosty/agent-provider-runtime/harness/adapter";
import { absentUsage, type ProviderUsage } from "@hosty/agent-provider-runtime/harness/provider-usage";
import { CodexHarnessAdapter } from "./adapter/codex.js";
import { CodexLogin, CodexLoginError, codexLoginFailure } from "./connections/codex-login.js";
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
export class CodexConnections extends AgentConnections {
  private logins = new Map<string, LoginState>();
  private syncedAuth = new Map<string, string>();
  constructor(data: string, cache: string | null, secrets: ConnectionSecrets, mode?: "native" | "docker") {
    super(data, cache, secrets, { kind: "codex", name: "codex-app-server", deferContainerProbe: true,
      capabilities: { promptSuggestions: true, usage: { snapshots: true, events: true, kinds: ["quota", "credits"] }, questions: true, appMcp: true, liveReconfigure: false, autoAllow: true, denyReason: false },
      authMethods: { "api-key": { credential: "required" }, chatgpt: { credential: "managed" }, "host-login": { credential: "external" } }, historyDirectories: ["sessions", "archived_sessions"] }, mode);
  }
  protected override validConnection(connection: AgentConnection): boolean {
    return connection.auth !== "host-login" || typeof connection.hostDirectory === "string" && path.isAbsolute(connection.hostDirectory);
  }
  protected override async connectionFields(input: Record<string, unknown>, previous: AgentConnection | null) {
    const auth = input.auth ?? previous?.auth;
    const hostDirectory = auth === "host-login" ? typeof input.hostDirectory === "string" ? input.hostDirectory.trim() : previous?.hostDirectory : undefined;
    if (auth === "host-login" && (!hostDirectory || !path.isAbsolute(hostDirectory)))
      throw new ConnectionError(400, "provider_home_invalid", "Enter the absolute Codex home directory used for the existing host login.");
    if (hostDirectory && !path.relative(path.resolve(this.dataDir), path.resolve(hostDirectory)).startsWith(".."))
      throw new ConnectionError(400, "provider_home_invalid", "The existing login directory must be outside the provider's backed-up data directory.");
    return hostDirectory ? { hostDirectory } : {};
  }
  protected override async connectionIdentity(connection: AgentConnection): Promise<string | undefined> {
    return connection.auth === "host-login" ? this.hostIdentity(connection) : undefined;
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
  protected override async createAdapter(connection: AgentConnection, binding: ConnectionBinding, docker: boolean): Promise<HarnessAdapter> {
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
  }
  protected override async usageKey(binding: ConnectionBinding): Promise<string> {
    const source = await this.get(binding.connectionId);
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
  protected override async unavailableUsage(connection: AgentConnection, phase: "before_identity" | "after_identity"): Promise<ProviderUsage | undefined> {
    if (phase === "after_identity" && connection.auth === "api-key") return absentUsage("unsupported", "unsupported_auth");
    if (phase === "before_identity" && connection.auth === "host-login" && this.applicationMode !== "docker" && !await lstat(path.join(connection.hostDirectory!, "auth.json")).catch(() => null)) return absentUsage("unsupported", "unsupported_auth");
    return undefined;
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
  override async syncCredentials(): Promise<void> {
    await this.serialize(async () => {
      await this.cleanupSecrets();
      for (const connection of (await this.load()).connections.filter(
        (c) => c.auth === "chatgpt" || c.auth === "host-login",
      )) {
        if (this.diagnosing.has(connection.id)) continue;
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
  override async startLogin(
    id: string,
  ): Promise<ConnectionLogin> {
    return this.serialize(() => this.startLoginNow(id));
  }
  private async startLoginNow(
    id: string,
  ): Promise<ConnectionLogin> {
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
      let verificationUrl: string | undefined;
      try {
        if (typeof response.verificationUrl === "string" &&
          new URL(response.verificationUrl).origin === "https://auth.openai.com")
          verificationUrl = response.verificationUrl;
      } catch { /* An invalid native URL is a protocol failure, never browser navigation. */ }
      if (!verificationUrl || typeof response.userCode !== "string" || !response.userCode.trim())
        throw new CodexLoginError({ code: "invalid_response", phase: "device-code", method: "account/login/start" });
      login.verificationUrl = verificationUrl;
      login.userCode = response.userCode;
      login.nativeLoginId =
        typeof response.loginId === "string" ? response.loginId : undefined;
      return this.loginView(loginId);
    } catch (error) {
      const failure = codexLoginFailure(error);
      login.status = "failed";
      login.message = failure.message;
      // Only closed categories and validated numeric/enum facts leave the native protocol.
      console.warn("[codex-login] " + JSON.stringify(failure.diagnostic));
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
    try { await login.worker.closeAndWait(); }
    catch (error) {
      const warning = "Temporary sign-in storage is retained until process shutdown is confirmed. (codex_login_cleanup_pending)";
      if (!login.message?.includes("codex_login_cleanup_pending"))
        login.message = [login.message, warning].filter(Boolean).join(" ");
      console.warn("[codex-login] " + JSON.stringify(codexLoginFailure(error).diagnostic));
      return; // Retain the worker and its private home for a later confirmed cleanup.
    }
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
  override async cancelLogin(id: string): Promise<void> {
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
  override async fetchLogin(id: string): Promise<ConnectionLogin> { return this.loginView(id); }
  protected override async cancelConnectionLogins(id: string) { for (const login of this.logins.values()) if (login.connectionId === id) await this.cancelLoginNow(login.id); }
  protected override async closeConnections() {
    for (const login of this.logins.values()) {
      if (login.status === "pending") await this.cancelLogin(login.id);
      else await this.finishLogin(login);
    }
  }
  async importEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
    if (!(await this.load()).imported) {
      const sources: Array<Record<string, unknown> & { importSource: string }> =
        [];
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
            "codex",
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
  override async prepareAdapter(binding: ConnectionBinding, context: AdapterPreparation): Promise<HarnessAdapter> {
    const adapter = await this.adapter(binding), home = await this.executionHome(binding);
    const copyAuthorization = async (source: string, target: string) => {
      const info = await lstat(source).catch(() => null);
      if (!info) return;
      if (!info.isFile() || info.size > 64000) throw new Error("Invalid native authorization file.");
      JSON.parse(await readFile(source, "utf8")); await copyFile(source, target);
    };
    return skillAdapter(adapter, { selected: context.skillPath, relativePath: ".agents/skills", directory: context.sessionDirectory,
      prepare: async root => ({ nativeConfigHome: root }),
      beforeProbe: root => copyAuthorization(path.join(home, "auth.json"), path.join(root, "auth.json")),
      close: root => copyAuthorization(path.join(root, "auth.json"), path.join(home, "auth.json")) });
  }
  async adoptLegacySession(binding: ConnectionBinding, nativeId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(nativeId)) throw new ConnectionError(400, "provider_legacy_invalid", "The native session id is invalid.");
    const connection = await this.get(binding.connectionId); if (connection.auth !== "host-login") await this.nativeHome(connection);
  }
}

export const codexCapabilities: AgentCapabilities = {
  version: 1, eventVersions: ["agent-event.1"],
  capabilities: ["installation-history", "installation-history.live", "session.resume", "configuration.resume-compatible", "configuration.approval-mode", "skills.catalog", "skills.exclusive-selection", "mcp.core", "mcp.apps", "mcp.policy-update", "workflow.consumer", "model.change-on-resume", "decisions.questions", "decisions.auto-allow", "connections.usage", "runs.park", "runs.barrier", "runs.reconcile", "decisions.next-turn", "predictions", "subagents.native"],
  limits: { maxCommandBytes: 1024 * 1024, maxEventBytes: 1024 * 1024, maxSnapshotBytes: 1024 * 1024, maxReplayBytes: 64 * 1024 * 1024, replayRetentionMs: 7 * 24 * 60 * 60 * 1000, maxControls: 10000, maxPageSize: 100, maxDurationMs: 24 * 60 * 60 * 1000  },
  configuration: { resumeCompatible: ["instructions", "systemPrompt", "skills", "nativeTools", "approvalMode", "predictions"] },
  nativeTools: { default: "provider_default", none: false },
  subagents: { defaultEnabled: true, policy: "observed", observation: "summary" },
};

export const codexSettings: ProviderSettingsDefinition = {
  kind: "codex", name: "Codex", authentication: [
    { id: "chatgpt", label: "ChatGPT sign-in", browserLogin: true },
    { id: "api-key", label: "API key", credential: true },
    { id: "host-login", label: "Existing Codex login on this host", hostDirectory: true }],
  hostDirectory: { label: "Codex home on the Hosty server", placeholder: "/home/hosty/.codex", description: "Use an existing signed-in Codex directory accessible to this provider. Removing the connection leaves that directory and its session files in place." },
  login: { name: "ChatGPT", description: "Open ChatGPT in your browser, sign in, and enter this one-time code. You do not need the ChatGPT app." },
  usage: { grouping: "model", resetLabels: true },
};
