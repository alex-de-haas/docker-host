import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, realpath, readFile, writeFile } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import { ClaudeConnections as AgentConnections } from "./connections.js";
vi.mock("node:fs/promises", async importOriginal => { const actual = await importOriginal<typeof import("node:fs/promises")>(); return { ...actual, symlink: vi.fn(actual.symlink) }; });
let root: string, data: string, cache: string, registry: AgentConnections;
let values = new Map<string, string>();
const secrets = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
const api = () => ({ name: "Fixture", kind: "claude", auth: "api-key", secret: "synthetic" });
beforeEach(async () => { values = new Map(); root=await mkdtemp(path.join(os.tmpdir(), "claude-connection-history-"));data=path.join(root,"data");cache=path.join(root,"cache");registry=new AgentConnections(data,cache,secrets); });
afterEach(async () => { await registry.shutdown();await rm(root,{recursive:true,force:true});vi.restoreAllMocks(); });
  it.each(["claude"] as const)("prepares %s storage without Windows symlink privileges and preserves history after cache removal", async (kind) => {
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

  it.each(["claude"] as const)("preserves %s managed history across application profile switches", async kind => {
    const connection = await registry.update({ name: "Portable", kind, auth: "api-key", secret: "synthetic-key" });
    const binding = (await registry.binding(connection.id))!;
    await registry.adapter(binding);
    const directory = "projects";
    const native = path.join(cache, "agent-providers", connection.id, "1", directory);
    await writeFile(path.join(native, "existing-conversation.jsonl"), "existing provider history");
    const dockerRegistry = new AgentConnections(data, cache, secrets, "docker");
    try {
      await dockerRegistry.adapter(binding);
      const container = path.join(cache, "agent-docker-providers", connection.id, "1", directory);
      expect(await readFile(path.join(container, "existing-conversation.jsonl"), "utf8")).toBe("existing provider history");
      await writeFile(path.join(container, "existing-conversation.jsonl"), "resumed provider history");
      await registry.adapter(binding);
      expect(await readFile(path.join(native, "existing-conversation.jsonl"), "utf8")).toBe("resumed provider history");
      expect(await dockerRegistry.binding(connection.id)).toEqual(binding);
    } finally { await dockerRegistry.shutdown(); }
  });


it("imports only its own legacy environment once and retries failed persistence without duplicate accounts", async () => {
  const original = secrets.set.bind(secrets); let failed = false;
  vi.spyOn(secrets, "set").mockImplementation(async (key, value) => { if (!failed) { failed = true; throw new Error("Core unavailable"); } await original(key, value); });
  const env = { ANTHROPIC_API_KEY: "synthetic-claude-environment", CODEX_API_KEY: "unrelated-account" };
  await expect(registry.importEnvironment(env)).rejects.toThrow();
  await registry.importEnvironment(env); await registry.importEnvironment({ ANTHROPIC_API_KEY: "ignored" });
  const result = await registry.list(); expect(result.connections).toHaveLength(1);
  expect(result.connections[0]).toMatchObject({kind:"claude",auth:"api-key",importSource:"claude-env"});
  expect(result.defaultId).toBe(result.connections[0]!.id);
  expect(values.get(result.connections[0]!.secretKey)).toBe("synthetic-claude-environment");
});
