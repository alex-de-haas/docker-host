import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  symlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentConnections } from "./registry.js";
import type { ConnectionSecrets } from "./secrets.js";
import { cleanAgentEnvironment } from "./codex-login.js";
import { captureEnv } from "../test-env.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, symlink: vi.fn(actual.symlink) };
});

class MemorySecrets implements ConnectionSecrets {
  values = new Map<string, string>();
  failWrite = false;
  failDelete = false;
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    if (this.failWrite) throw new Error("Core unavailable");
    this.values.set(key, value);
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error("Core unavailable");
    this.values.delete(key);
  }
}
async function waitFor(action: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for provider state");
}
async function allContents(root: string): Promise<string> {
  let result = "";
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result += await allContents(file);
    else if (entry.isFile()) result += await readFile(file, "utf8");
  }
  return result;
}

describe("provider connections", () => {
  let root: string, data: string, cache: string;
  let secrets: MemorySecrets, registry: AgentConnections;
  let restore: () => void;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hosty-connections-"));
    data = path.join(root, "data");
    cache = path.join(root, "cache");
    secrets = new MemorySecrets();
    registry = new AgentConnections(data, cache, secrets);
    restore = captureEnv({
      HOSTY_AI_GATEWAY_CODEX_COMMAND: path.resolve(
        "test/fake-codex-server.mjs",
      ),
      HOSTY_TEST_LOGIN_MODE: "complete",
    });
  });
  afterEach(async () => {
    await registry.shutdown();
    restore();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const api = (name = "Codex") => ({
    name,
    kind: "codex",
    auth: "api-key",
    secret: `synthetic-${name}`,
  });

  it("stores only metadata in backup data; isolates native homes and recreates credentials after cache loss", async () => {
    const first = await registry.update(api("one"));
    const second = await registry.update(api("two"));
    await registry.setDefault(first.id);
    for (const c of [first, second])
      expect(
        (await registry.health(await registry.binding(c.id))).available,
      ).toBe(true);
    expect(await allContents(data)).not.toContain("synthetic-");
    for (const c of [first, second]) {
      const home = path.join(cache, "agent-providers", c.id, "1");
      expect(await readFile(path.join(home, "auth.json"), "utf8")).toContain(
        `synthetic-${c.name}`,
      );
      await writeFile(
        path.join(home, "sessions", "resume.jsonl"),
        "conversation",
      );
    }
    await rm(cache, { recursive: true });
    expect(
      (await registry.health(await registry.binding(first.id))).available,
    ).toBe(true);
    expect(
      await readFile(
        path.join(
          cache,
          "agent-providers",
          first.id,
          "1",
          "sessions",
          "resume.jsonl",
        ),
        "utf8",
      ),
    ).toBe("conversation");
    expect((await registry.list()).defaultId).toBe(first.id);
    expect(JSON.stringify(await registry.list())).not.toContain("synthetic-");
  });

  it.each(["claude", "codex"] as const)("prepares %s storage without Windows symlink privileges and preserves history after cache removal", async (kind) => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(symlink).mockImplementation(async (target, link, type) => {
      if (type !== "junction") throw Object.assign(new Error("Symlink privilege is not held"), { code: "EPERM" });
      // Exercise real directory linkage and cleanup on this host while modelling Windows permissions.
      await actual.symlink(target, link, type);
    });
    const c = await registry.update({ ...api(), kind });
    const binding = (await registry.binding(c.id))!;
    await registry.adapter(binding);
    const directory = kind === "claude" ? "projects" : "sessions";
    const link = path.join(cache, "agent-providers", c.id, "1", directory);
    const durable = path.join(data, "provider-sessions", c.id, "1", directory);
    expect(await realpath(link)).toBe(await realpath(durable));
    await writeFile(path.join(link, "history.jsonl"), "conversation");
    await rm(cache, { recursive: true });
    expect(await readFile(path.join(durable, "history.jsonl"), "utf8")).toBe("conversation");
    await registry.adapter(binding);
    expect(await readFile(path.join(link, "history.jsonl"), "utf8")).toBe("conversation");
    vi.mocked(symlink).mockImplementation(actual.symlink);
  });

  it("reports storage failures without exposing paths or secrets", async () => {
    const c = await registry.update(api());
    vi.mocked(symlink).mockRejectedValueOnce(Object.assign(new Error("EPERM private-path synthetic-Codex"), { code: "EPERM" }));
    const health = await registry.health(await registry.binding(c.id));
    expect(health.available).toBe(false);
    expect(health.reason).toContain("storage setup failed (EPERM)");
    expect(health.reason).not.toContain("private-path");
    expect(health.reason).not.toContain("synthetic-Codex");
  });

  it("rotates revisions only for credentials and leaves the last working secret on write failure", async () => {
    const c = await registry.update(api());
    const binding = (await registry.binding(c.id))!;
    expect((await registry.update({ name: "Renamed" }, c.id)).revision).toBe(
      c.revision,
    );
    secrets.failWrite = true;
    await expect(
      registry.update({ secret: "replacement" }, c.id),
    ).rejects.toThrow();
    expect((await registry.get(c.id)).secretKey).toBe(c.secretKey);
    expect(await secrets.get(c.secretKey)).toBe("synthetic-Codex");
    secrets.failWrite = false;
    secrets.failDelete = true;
    const replaced = await registry.update({ secret: "replacement" }, c.id);
    expect(replaced.revision).toBe(2);
    await expect(registry.adapter(binding)).rejects.toMatchObject({
      code: "provider_credentials_changed",
    });
    secrets.failDelete = false;
    await registry.syncCredentials();
    expect(await secrets.get(c.secretKey)).toBeNull();
    expect(secrets.values.size).toBe(1);
  });

  it("refuses rotation/removal while a native run is open; deletion keeps native history but no usable secret", async () => {
    const c = await registry.update(api());
    const adapter = await registry.adapter((await registry.binding(c.id))!);
    await adapter.probe();
    const run = adapter.start({ sessionId: "s", cwd: root, onEvent() {} });
    await expect(
      registry.update({ secret: "rotated" }, c.id),
    ).rejects.toMatchObject({ code: "provider_in_use" });
    await expect(registry.remove(c.id)).rejects.toMatchObject({
      code: "provider_in_use",
    });
    await run.stop();
    await registry.setDefault(c.id);
    await registry.remove(c.id);
    expect((await registry.list()).defaultId).toBeNull();
    expect(secrets.values.size).toBe(0);
    expect(
      await stat(path.join(cache, "agent-providers", c.id)).catch(() => null),
    ).toBeNull();
    expect(await stat(path.join(data, "provider-sessions", c.id))).toBeTruthy();
  });

  it("never revives missing Core credentials from cached auth or restored old metadata", async () => {
    const c = await registry.update(api());
    const binding = (await registry.binding(c.id))!;
    await registry.health(binding);
    const backup = path.join(root, "backup");
    await cp(data, backup, { recursive: true });
    await registry.remove(c.id);
    await registry.shutdown();
    await rm(data, { recursive: true });
    await cp(backup, data, { recursive: true });
    registry = new AgentConnections(data, cache, secrets);
    expect((await registry.health(binding)).available).toBe(false);
    expect((await registry.list()).connections[0]?.available).toBe(false);
    expect(secrets.values.size).toBe(0);
  });

  it("imports legacy settings once, migrates native history, and retries a partial import without duplicates", async () => {
    const legacy = path.join(data, "codex-home");
    await mkdir(path.join(legacy, "sessions"), { recursive: true });
    await writeFile(path.join(legacy, "auth.json"), "synthetic-legacy-key");
    await writeFile(path.join(legacy, "sessions", "thread.jsonl"), "history");
    const original = secrets.set.bind(secrets);
    let failed = false;
    vi.spyOn(secrets, "set").mockImplementation(async (key, value) => {
      if (value === "codex-env" && !failed) {
        failed = true;
        throw new Error("offline");
      }
      await original(key, value);
    });
    const env = {
      ANTHROPIC_API_KEY: "claude-env",
      CODEX_API_KEY: "codex-env",
      HOSTY_AI_GATEWAY_HARNESS: "codex",
    };
    await expect(registry.importEnvironment(env)).rejects.toThrow();
    await registry.importEnvironment(env);
    await registry.importEnvironment({ ...env, CODEX_API_KEY: "ignored" });
    const list = await registry.list();
    expect(list.connections).toHaveLength(2);
    const c = list.connections.find((c) => c.kind === "codex")!;
    expect(list.defaultId).toBe(c.id);
    expect(await stat(legacy).catch(() => null)).toBeNull();
    expect(
      await readFile(
        path.join(
          data,
          "provider-sessions",
          c.id,
          "1",
          "sessions",
          "thread.jsonl",
        ),
        "utf8",
      ),
    ).toBe("history");
    expect(await allContents(data)).not.toContain("synthetic-legacy-key");
    expect(await secrets.get(c.secretKey)).toBe("codex-env");
  });

  it("uses official device RPC, persists and refreshes auth in Core, and survives cache loss", async () => {
    const c = await registry.update({
      name: "ChatGPT",
      kind: "codex",
      auth: "chatgpt",
    });
    const login = await registry.startLogin(c.id);
    expect(login).toMatchObject({
      status: "pending",
      userCode: "FAKE-CODE",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    await waitFor(() => registry.loginView(login.id).status === "complete");
    const updated = await registry.get(c.id);
    expect(await secrets.get(updated.secretKey)).toContain("synthetic-refresh");
    const binding = (await registry.binding(c.id))!;
    expect((await registry.health(binding)).available).toBe(true);
    const authFile = path.join(
      cache,
      "agent-providers",
      c.id,
      String(updated.revision),
      "auth.json",
    );
    const rotated = JSON.stringify({
      tokens: {
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
      },
    });
    await writeFile(authFile, rotated);
    secrets.failWrite = true;
    await registry.syncCredentials();
    expect((await registry.health(binding)).available).toBe(false);
    secrets.failWrite = false;
    await registry.syncCredentials();
    expect(await secrets.get(updated.secretKey)).toBe(rotated);
    expect(await allContents(data)).not.toContain("synthetic-refresh");
    await rm(cache, { recursive: true });
    await registry.health(binding);
    expect(await readFile(authFile, "utf8")).toBe(rotated);
    await secrets.delete(updated.secretKey);
    await registry.syncCredentials();
    expect((await registry.health(binding)).available).toBe(false);
    expect(await stat(authFile).catch(() => null)).toBeNull();
  });

  it("deduplicates pending login, supports cancellation, and never replaces a working login on failure", async () => {
    const c = await registry.update({
      name: "ChatGPT",
      kind: "codex",
      auth: "chatgpt",
    });
    process.env.HOSTY_TEST_LOGIN_MODE = "pending";
    const [a, b] = await Promise.all([
      registry.startLogin(c.id),
      registry.startLogin(c.id),
    ]);
    expect(a.id).toBe(b.id);
    await registry.cancelLogin(a.id);
    expect(registry.loginView(a.id).status).toBe("cancelled");
    expect(secrets.values.size).toBe(0);
    process.env.HOSTY_TEST_LOGIN_MODE = "complete";
    const success = await registry.startLogin(c.id);
    await waitFor(() => registry.loginView(success.id).status === "complete");
    const previous = await registry.get(c.id);
    process.env.HOSTY_TEST_LOGIN_MODE = "fail";
    const fail = await registry.startLogin(c.id);
    await waitFor(() => registry.loginView(fail.id).status === "failed");
    expect((await registry.get(c.id)).secretKey).toBe(previous.secretKey);
    expect(await secrets.get(previous.secretKey)).toContain(
      "synthetic-refresh",
    );
  });

  it("detects host-login account changes, including different members of the same workspace", async () => {
    const home = path.join(root, "external-identity");
    await mkdir(home);
    const nativeAuth = (subject: string) =>
      JSON.stringify({
        tokens: {
          account_id: "workspace",
          id_token: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`,
        },
      });
    await writeFile(path.join(home, "auth.json"), nativeAuth("member-one"));
    const c = await registry.update({
      name: "Host",
      kind: "codex",
      auth: "host-login",
      hostDirectory: home,
    });
    const binding = (await registry.binding(c.id))!;
    expect((await registry.health(binding)).available).toBe(true);
    await writeFile(path.join(home, "auth.json"), nativeAuth("member-two"));
    await expect(registry.adapter(binding)).rejects.toMatchObject({
      code: "provider_host_account_changed",
    });
    const replacement = (await registry.binding(c.id))!;
    expect(replacement.connectionIdentity).not.toBe(binding.connectionIdentity);
    expect((await registry.health(replacement)).available).toBe(true);
  });

  it("reserves a connection across dispatch preparation so a concurrent edit cannot race it", async () => {
    const c = await registry.update(api());
    const release = await registry.reserve((await registry.binding(c.id))!);
    await expect(
      registry.update({ secret: "new-secret" }, c.id),
    ).rejects.toMatchObject({ code: "provider_in_use" });
    release();
    expect(
      (await registry.update({ secret: "new-secret" }, c.id)).revision,
    ).toBe(2);
  });

  it("leaves external login homes alone and scrubs other providers' inherited credentials", async () => {
    const home = path.join(root, "external");
    await mkdir(home);
    await writeFile(path.join(home, "auth.json"), "external");
    const c = await registry.update({
      name: "Host",
      kind: "codex",
      auth: "host-login",
      hostDirectory: home,
    });
    await registry.remove(c.id);
    expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(
      "external",
    );
    const restoreSecrets = captureEnv({
      ANTHROPIC_API_KEY: "wrong",
      OPENAI_API_KEY: "wrong",
      CLAUDE_CODE_OAUTH_TOKEN: "wrong",
      HOSTY_APP_SERVICE_TOKEN: "wrong",
      CODEX_HOME: "wrong",
    });
    try {
      const env = cleanAgentEnvironment();
      for (const key of [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "HOSTY_APP_SERVICE_TOKEN",
        "CODEX_HOME",
      ])
        expect(env[key]).toBeUndefined();
    } finally {
      restoreSecrets();
    }
  });
});
