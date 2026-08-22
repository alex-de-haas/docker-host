import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../sessions/store.js";
import { SettingsStore } from "../settings/store.js";
import { SessionManager } from "../sessions/manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";
import { TokenExchange } from "./exchange.js";
import { McpProxy } from "./proxy.js";
import type { ProviderDirectory } from "../settings/providers.js";
import { skillDigest } from "./skills.js";

const APP = "com-example-notes";

// A skill reaches a session only through the app whose tools it describes. The pair that matters is
// the provider toggle: on, the prose arrives; off, the session must not carry instructions for tools
// it does not have.
describe("app skills in a session", () => {
  let dataDir: string;
  let settings: SettingsStore;
  let manager: SessionManager;
  let adapter: FakeHarnessAdapter;

  const providers = {
    read: async () => ({
      providers: [{ appId: APP, displayName: "Notes", url: `http://${APP}/api/mcp`, running: true }],
      installedAppIds: [APP],
    }),
    readSkill: async (appId: string) =>
      appId === APP ? { appId: APP, displayName: "Notes", markdown: "Call list_people first." } : null,
  } as unknown as ProviderDirectory;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-session-skills-"));
    settings = new SettingsStore(dataDir);
    adapter = new FakeHarnessAdapter();
    const exchange = new TokenExchange("http://core.test", "hosty.ai-gateway");
    const proxy = new McpProxy((sessionId, appId) => manager.mintAppToken(sessionId, appId));
    manager = new SessionManager(
      new SessionStore(dataDir),
      adapter,
      new AuditReporter(null, null, "hosty.ai-gateway"),
      dataDir,
      settings,
      providers,
      exchange,
      proxy,
      "http://127.0.0.1:3400",
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/delegated-token")) {
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
    vi.restoreAllMocks();
    await manager.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function startSession(): Promise<string | undefined> {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "hello", "seed-credential");
    return adapter.lastStart?.systemPrompt;
  }

  it("carries an approved app's skill, below the operator's own prompt", async () => {
    // The digest stands for the baseline the settings page records when the provider is enabled;
    // without one the skill is withheld, which the next test asserts.
    await settings.update({
      systemPrompt: "Be brief.",
      mcpProviders: { [APP]: true },
      mcpSkillDigests: { [APP]: skillDigest("Call list_people first.") },
    });

    const prompt = await startSession();

    expect(prompt).toContain("Call list_people first.");
    expect(prompt).toContain(`<app-skill app="${APP}"`);
    // The operator's instructions stay first: an app appearing above them would read as the operator.
    expect(prompt!.indexOf("Be brief.")).toBeLessThan(prompt!.indexOf("app-skill"));
  });

  it("withholds a skill that carries no approved digest", async () => {
    // Enabled, readable, and still withheld: text that arrived without the operator's decision must
    // not deliver itself. This is the hole the first version had.
    await settings.update({ systemPrompt: "Be brief.", mcpProviders: { [APP]: true } });

    const prompt = await startSession();

    expect(prompt).toBe("Be brief.");
  });

  it("carries no skill when the provider is off", async () => {
    // The half that matters. Without it, a manager that always folded in every declared skill would
    // pass the test above while ignoring the only decision the operator makes here.
    await settings.update({ systemPrompt: "Be brief.", mcpProviders: { [APP]: false } });

    const prompt = await startSession();

    expect(prompt).toBe("Be brief.");
    expect(prompt).not.toContain("app-skill");
  });
});
