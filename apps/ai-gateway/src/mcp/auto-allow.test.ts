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

// Whether an app's tool runs without an approval card. The operator decides per app; the app's own
// `readOnlyHint` only selects which of its tools the decision covers.
//
// The distinction under test is the whole design: the harness auto-allows Read/Grep because the
// gateway KNOWS what they are, while an app tool is read-only because the app SAID so — so the
// second needs someone to vouch for the app, and that someone is the operator.

const APP = "com-example-notes";
const TOOL = `mcp__${APP}__list_people`;

describe("per-app auto-allow", () => {
  let dataDir: string;
  let store: SessionStore;
  let settings: SettingsStore;
  let manager: SessionManager;

  const providers = {
    read: async () => ({
      providers: [{ appId: APP, displayName: "Notes", url: `http://${APP}/api/mcp`, running: true }],
      installedAppIds: [APP],
    }),
    // Declares no skill: these tests are about the approval gate, and a skill would only add prose to
    // a system prompt none of them read.
    readSkill: async () => null,
  } as unknown as ProviderDirectory;

  /** Core issues tokens; the app lists one read-only tool and one that declares nothing. */
  function stubNetwork(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/delegated-token")) {
        return new Response(
          JSON.stringify({ token: "app-token", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [
                { name: "list_people", annotations: { readOnlyHint: true } },
                { name: "delete_person" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-auto-allow-"));
    store = new SessionStore(dataDir);
    settings = new SettingsStore(dataDir);
    const exchange = new TokenExchange("http://core.test", "hosty.ai-gateway");
    const proxy = new McpProxy((sessionId, appId) => manager.mintAppToken(sessionId, appId));
    manager = new SessionManager(
      store,
      new FakeHarnessAdapter(),
      new AuditReporter(null, null, "hosty.ai-gateway"),
      dataDir,
      settings,
      providers,
      exchange,
      proxy,
      "http://127.0.0.1:3400",
    );
    stubNetwork();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The grants a live session currently holds. Reached through the private map on purpose: this is
   * the state the predicate consults, and asserting on anything else would test a copy. */
  function granted(sessionId: string): Set<string> {
    return (manager as unknown as { live: Map<string, { autoAllowed: Set<string> }> })
      .live.get(sessionId)!.autoAllowed;
  }

  async function run(text: string): Promise<string[]> {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, text, "seed-credential");
    // The fake harness answers on a microtask; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return (await store.readEvents(record.id)).map((event) => event.type);
  }

  it("asks when the operator has not vouched for the app", async () => {
    // The provider is enabled — the app may reach the assistant — but nobody has said its own word
    // about read-only counts. Enabling and trusting are two decisions, not one.
    await settings.update({ mcpProviders: { [APP]: true } });

    expect(await run("apptool please")).toContain("approval_request");
  });

  it("runs a read-only tool unprompted once the operator has", async () => {
    await settings.update({ mcpProviders: { [APP]: true }, mcpAutoAllow: { [APP]: true } });

    const events = await run("apptool please");

    // The pair: the same call, the same tool, the only difference being the operator's decision.
    expect(events).not.toContain("approval_request");
    expect(events).toContain("assistant_text");
  });

  it("covers only the tools the app declared, not everything it offers", async () => {
    await settings.update({ mcpProviders: { [APP]: true }, mcpAutoAllow: { [APP]: true } });
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "apptool", "seed-credential");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // `delete_person` declares nothing, so it is absent from the grant even though its app is
    // trusted — trust is in the app's declarations, not a blanket pass for its whole surface.
    expect([...granted(record.id)]).toEqual([TOOL]);
  });

  it("revoking trust takes effect on the running session, not the next one", async () => {
    // The settings page says "applied to running sessions", and for a withdrawn grant that has to be
    // true the moment the operator sees it — a grant that lingered would be the worst kind of stale.
    await settings.update({ mcpProviders: { [APP]: true }, mcpAutoAllow: { [APP]: true } });
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "apptool", "seed-credential");
    await new Promise((resolve) => setTimeout(resolve, 20));

    await settings.update({ mcpAutoAllow: { [APP]: false } });
    await manager.applyProviderPolicy();

    expect(granted(record.id).size).toBe(0);
  });

  it("clears the grant when every provider is switched off", async () => {
    // The path that leaves buildMcpServers with nothing to offer takes an early return, and an early
    // return that skipped the rebuild would leave a grant outliving the policy that justified it.
    await settings.update({ mcpProviders: { [APP]: true }, mcpAutoAllow: { [APP]: true } });
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "apptool", "seed-credential");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(granted(record.id).size).toBe(1);

    await settings.update({ mcpProviders: { [APP]: false } });
    await manager.applyProviderPolicy();

    expect(granted(record.id).size).toBe(0);
  });

  it("grants nothing when the app's tool list cannot be read", async () => {
    // "We do not know" must not collapse into "nothing is read-only" — it has to keep asking.
    await settings.update({ mcpProviders: { [APP]: true }, mcpAutoAllow: { [APP]: true } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/delegated-token")
        ? new Response(
            JSON.stringify({ token: "app-token", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("stopped", { status: 503 }),
    );

    expect(await run("apptool please")).toContain("approval_request");
  });
});
