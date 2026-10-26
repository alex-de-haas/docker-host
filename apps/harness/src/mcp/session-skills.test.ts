import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../sessions/store.js";
import { SettingsStore } from "../settings/store.js";
import { DEFAULT_WORKFLOW_PROMPT } from "../settings/workflow.js";
import { HOST_SYSTEM_PROMPT } from "../sessions/host-prompt.js";
import { SessionManager } from "../sessions/manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";
import { TokenExchange } from "./exchange.js";
import { McpProxy } from "./proxy.js";
import type { ProviderDirectory } from "../settings/providers.js";
import { createHash } from "node:crypto";

const APP = "com-example-notes";

describe("native skills in a session", () => {
  let dataDir: string;
  let settings: SettingsStore;
  let manager: SessionManager;
  let adapter: FakeHarnessAdapter;
  let offered = true;
  const exports: { contextId: string; skillIds: string[] }[] = [];
  const skillId = "a".repeat(64), exportId = "e".repeat(64);

  const providers = {
    read: async () => ({
      providers: [{ appId: APP, displayName: "Notes", url: `http://${APP}/api/mcp`, running: true, offered }],
      installedAppIds: [APP],
    }),
    // No Core row: these tests are about app skills, and Core declares none.
    core: () => null,
    migrateInstructions: async () => undefined,

    readSkill: async (appId: string) =>
      appId === APP ? { appId: APP, displayName: "Notes", markdown: "Call list_people first." } : null,
  } as unknown as ProviderDirectory;

  beforeEach(() => {
    offered = true; exports.length = 0;
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test");
    vi.stubEnv("HOSTY_APP_ID", "hosty.harness");
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-session-skills-"));
    settings = new SettingsStore(dataDir);
    adapter = new FakeHarnessAdapter();
    const exchange = new TokenExchange("http://core.test", "hosty.harness", "service");
    const proxy = new McpProxy((sessionId, appId) => manager.mintAppToken(sessionId, appId));
    manager = new SessionManager(
      new SessionStore(dataDir),
      adapter,
      new AuditReporter(null, null, "hosty.harness"),
      dataDir,
      settings,
      providers,
      exchange,
      proxy,
      "http://127.0.0.1:3400",
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/skills/exports")) {
        exports.push(JSON.parse(String(init?.body)));
        return Response.json({ id: exportId, path: "/core/export", skills: [] });
      }
    if (url.includes("/api/auth/apps/revalidate")) return Response.json({ active: true, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
      if (url.includes("/mcp/token")) {
        return new Response(
          JSON.stringify({ token: "app-token", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function startSession(): Promise<string | undefined> {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "hello", "hostyg_seed");
    return adapter.lastStart?.systemPrompt;
  }

  it("exports selected packages while keeping standing instructions separate", async () => {
    await settings.update({ systemPrompt: "Be brief.", skillIds: [skillId], mcpProviders: { [APP]: true } });
    const prompt = await startSession();
    expect(prompt).toBe(`${HOST_SYSTEM_PROMPT}\n\n${DEFAULT_WORKFLOW_PROMPT}\n\nBe brief.`);
    expect(prompt).not.toContain("Call list_people first.");
    expect(exports[0]?.skillIds).toEqual([skillId]);
    expect(adapter.lastStart?.skillExportId).toBe(exportId);
  });

  it("delivers edited or empty workflow guidance to new agent sessions", async () => {
    await settings.update({ workflowPrompt: "Test using my preferred process without a plan." });
    expect(await startSession()).toContain("Test using my preferred process without a plan.");
    await settings.update({ workflowPrompt: "" });
    expect(await startSession()).not.toContain(DEFAULT_WORKFLOW_PROMPT);
  });

  it("does not auto-select packages when no defaults were chosen", async () => {
    await startSession();
    expect(exports[0]?.skillIds).toEqual([]);
  });

  it("keeps skill selection independent of MCP provider access", async () => {
    offered = false;
    await settings.update({ skillIds: [skillId], mcpProviders: { [APP]: false } });
    await startSession();
    expect(exports[0]?.skillIds).toEqual([skillId]);
    expect(adapter.lastStart?.mcpServers ?? {}).not.toHaveProperty(APP);
  });

  it("uses an explicit per-session selection instead of defaults", async () => {
    await settings.update({ skillIds: [skillId] });
    const selected = "b".repeat(64);
    const record = await manager.createSession({ createdBy: "user_admin", skillIds: [selected] });
    await manager.postMessage(record.id, "hello", "hostyg_seed");
    expect(exports[0]?.skillIds).toEqual([selected]);
    expect((await settings.read()).skillIds).toEqual([skillId]);
  });

  it("migrates explicit old choices before the supplying app upgrades", async () => {
    await settings.update({ mcpSkillDigests: { [APP]: "old-digest" } });
    await startSession();
    const migrated = createHash("sha256").update(["app", APP, "default"].join("\n")).digest("hex");
    expect(exports[0]?.skillIds).toEqual([migrated]);
    expect((await settings.read()).skillIds).toEqual([migrated]);
  });

  it("rejects caller supplied paths as skill selections", async () => {
    await expect(manager.createSession({ createdBy: "user_admin", skillIds: ["../../private"] })).rejects.toThrow("stable skill IDs");
    expect(exports).toHaveLength(0);
  });
});
