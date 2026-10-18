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
import { ruleKey } from "./policy.js";
import type { ProviderDirectory } from "../settings/providers.js";

// Whether an app's tool runs without an approval card. The operator decides per app; the app's own
// `readOnlyHint` only selects which of its tools the decision covers.
//
// The distinction under test is the whole design: the harness auto-allows Read/Grep because the
// gateway KNOWS what they are, while an app tool is read-only because the app SAID so — so the
// second needs someone to vouch for the app, and that someone is the operator.

const APP = "com-example-notes";
const TOOL = `mcp__${APP}__list_people`;
const CORE_URL = "http://core.test/api/mcp";
const CORE_TOOL = "mcp__hosty-core__list_apps";

let offered = true;
let directoryRevision = "one";
let providerUrl = `http://${APP}/api/mcp`;

// Shared by both suites below: the directory stubs and the network stub they run against.
const providers = {
  get revision() { return directoryRevision; },
  read: async () => ({
    providers: [{ appId: APP, displayName: "Notes", url: providerUrl, running: true, offered }],
    installedAppIds: [APP],
  }),
  // No Core row here: these tests are about an app the operator has to vouch for, and Core's
  // default grant would put a second, unasked-for name into every grant set they inspect.
  core: () => null,
  // Declares no skill: these tests are about the approval gate, and a skill would only add prose to
  // a system prompt none of them read.
  readSkill: async () => null,
  approvedSkills: () => ({}),
} as unknown as ProviderDirectory;

/** The same directory with Core offered beside the app, for the default-grant suite below. */
const providersWithCore = {
  ...providers,
  core: () => ({
    appId: "hosty:core",
    displayName: "Hosty Core",
    url: CORE_URL,
    running: true, offered: true,
    interfaces: [{ key: "default", url: CORE_URL }],
  }),
} as unknown as ProviderDirectory;

/** Core issues tokens; the app lists one read-only tool and one that declares nothing, and Core's
 * own endpoint lists one read-only tool — told apart by URL, as the real servers would be. */
function stubNetwork(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/api/auth/apps/revalidate")) return Response.json({ active: true, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    if (url.includes("/mcp/token")) {
      return new Response(
        JSON.stringify({ token: "app-token", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "tools/list") {
      const tools = url.startsWith(CORE_URL)
        ? [{ name: "list_apps", annotations: { readOnlyHint: true } }, { name: "stop_app" }]
        : [{ name: "list_people", annotations: { readOnlyHint: true } }, { name: "delete_person" }];
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("per-app auto-allow", () => {
  let dataDir: string;
  let store: SessionStore;
  let settings: SettingsStore;
  let manager: SessionManager;
  let exchange: TokenExchange;

  beforeEach(async () => {
    offered = true;
    directoryRevision = "one";
    providerUrl = `http://${APP}/api/mcp`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-auto-allow-"));
    store = new SessionStore(dataDir);
    settings = new SettingsStore(dataDir);
    exchange = new TokenExchange("http://core.test", "hosty.harness", "service");
    const proxy = new McpProxy((sessionId, appId) => manager.mintAppToken(sessionId, appId));
    manager = new SessionManager(
      store,
      new FakeHarnessAdapter(),
      new AuditReporter(null, null, "hosty.harness"),
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

  async function run(text: string, expectedEvent: "approval_request" | "assistant_text"): Promise<string[]> {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, text, "hostyg_seed");
    // Harness callbacks also persist asynchronously; a fixed delay races filesystem I/O in CI.
    return vi.waitFor(async () => {
      const events = (await store.readEvents(record.id)).map((event) => event.type);
      expect(events).toContain(expectedEvent);
      return events;
    });
  }

  it("ignores unrelated fleet revisions but reconfigures a changed upstream behind the stable proxy", async () => {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "hello", "hostyg_seed");
    await vi.waitFor(async () => expect((await store.readEvents(record.id)).some(event => event.type === "result")).toBe(true));
    const live = (manager as unknown as { live: Map<string, { run: { setMcpServers: () => Promise<boolean> } }> }).live.get(record.id)!;
    const reconfigure = vi.spyOn(live.run, "setMcpServers").mockResolvedValue(false);
    const renewRequests = vi.spyOn(manager.mcpPolicy, "cancel");
    directoryRevision = "unrelated-app-stopped";
    await manager.postMessage(record.id, "next turn", "hostyg_seed");
    expect(reconfigure).not.toHaveBeenCalled();
    expect(renewRequests).not.toHaveBeenCalled();
    expect((await store.readEvents(record.id)).filter(event => event.type === "notice")).toHaveLength(0);

    providerUrl = `http://${APP}:9999/api/mcp`;
    directoryRevision = "target-url-changed";
    await manager.postMessage(record.id, "another turn", "hostyg_seed");
    expect(reconfigure).toHaveBeenCalledTimes(1);
    expect(renewRequests).toHaveBeenCalledWith(record.id);
    expect((await store.readEvents(record.id)).filter(event => event.type === "notice")).toHaveLength(1);
  });

  it.each([[false, false], [true, false], [true, true]])("preserves development approvals during credential refresh with app MCP offered=%s expired=%s", async (initiallyOffered, expired) => {
    offered = initiallyOffered;
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "hello", "hostyg_seed");
    await vi.waitFor(async () => expect((await manager.getSession(record.id))?.status).toBe("idle"));
    const live = (manager as unknown as { live: Map<string, { run: { setMcpServers: () => Promise<boolean> } }> }).live.get(record.id)!;
    const reconfigure = vi.spyOn(live.run, "setMcpServers").mockResolvedValue(false);
    await manager.mcpPolicy.catalog("hosty:development", "v1", [{ name: "environment_create" }]);
    const pending = manager.mcpPolicy.authorize(record.id, "hosty:development", "v1", "create", "environment_create", {}, new AbortController().signal).catch(error => error);
    const approval = await vi.waitFor(async () => {
      const event = (await store.readEvents(record.id)).find(e => e.type === "approval_request");
      expect(event).toBeDefined(); return event!;
    });
    if (expired) vi.spyOn(exchange, "refreshSelf").mockResolvedValue(null);
    // Browser focus renews credentials; disabling the last app also removes proxy routes.
    offered = false;
    await manager.refreshSessionCredentials(record.id, "user_admin", "hostyg_fresh");
    await manager.refreshSessionCredentials(record.id, "user_admin", "hostyg_fresher");
    expect(reconfigure).not.toHaveBeenCalled();
    expect(await manager.resolveApproval(record.id, approval.approvalId as string, "allow")).toBe(true);
    const guard = await pending;
    expect(guard).toBeTypeOf("function");
    await guard();
    expect((await store.readEvents(record.id)).filter(e => e.type === "approval_decision").map(e => e.decision)).toEqual(["allow"]);
  });

  it("versions automatic status recovery even when its timestamp matches the prior record", async () => {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.shutdown();
    record.status = "awaiting_approval";
    await store.saveRecord(record);
    manager = new SessionManager(store, new FakeHarnessAdapter(), new AuditReporter(null, null, "hosty.harness"), dataDir, settings);
    await manager.mcpPolicy.catalog("hosty:development", "v1", [{ name: "status" }]);
    await manager.mcpPolicy.update({ [ruleKey("hosty:development", "status")]: { identity: "v1", mode: "run" } });
    const seen: import("../sessions/store.js").StoredEvent[] = [];
    const subscription = await manager.subscribe(record.id, record.lastEventSeq, event => seen.push(event));
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(record.updatedAt);

    const guard = await manager.mcpPolicy.authorize(record.id, "hosty:development", "v1", "recover", "status", {}, new AbortController().signal);
    await guard();
    const current = (await manager.getSession(record.id))!;
    expect(current.status).toBe("running");
    expect(current.updatedAt).toBe(record.updatedAt);
    expect(current.lastEventSeq).toBeGreaterThan(record.lastEventSeq);
    expect(seen).toContainEqual(expect.objectContaining({ type: "session_status", status: "running", seq: current.lastEventSeq, ts: current.updatedAt }));
    expect(await store.readEvents(record.id, record.lastEventSeq)).toEqual([
      expect.objectContaining({ type: "session_status", status: "running", seq: current.lastEventSeq }),
    ]);
    expect((await store.readRecord(record.id))?.lastEventSeq).toBe(current.lastEventSeq);
    subscription.unsubscribe();
  });

  it("resets development RPC identity when an expired delegation replaces an idle client", async () => {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "hello", "hostyg_seed");
    await vi.waitFor(async () => expect((await manager.getSession(record.id))?.status).toBe("idle"));
    await manager.mcpPolicy.catalog("hosty:development", "v1", [{ name: "status" }]);
    await manager.mcpPolicy.update({ [ruleKey("hosty:development", "status")]: { identity: "v1", mode: "run" } });
    const call = () => manager.mcpPolicy.authorize(record.id, "hosty:development", "v1", "1", "status", {}, new AbortController().signal);
    const old = await call();
    vi.spyOn(exchange, "refreshSelf").mockResolvedValue(null);
    await manager.refreshSessionCredentials(record.id, "user_admin", "hostyg_fresh");
    await expect(old()).rejects.toThrow("canceled");
    const replacement = await call(); await replacement();
  });

  it("delegates app MCP prompting to the shared broker", async () => {
    // The provider is enabled — the app may reach the assistant — but nobody has said its own word
    // about read-only counts. Enabling and trusting are two decisions, not one.
    await settings.update({ mcpProviders: { [APP]: true } });

    expect(await run("apptool please", "assistant_text")).not.toContain("approval_request");
  });

  it("runs a read-only tool unprompted once the operator has", async () => {
    await settings.update({ mcpProviders: { [APP]: true }, mcpAutoAllow: { [APP]: true } });

    const events = await run("apptool please", "assistant_text");

    // The pair: the same call, the same tool, the only difference being the operator's decision.
    expect(events).not.toContain("approval_request");
    expect(events).toContain("assistant_text");
  });

  it("covers only the tools the app declared, not everything it offers", async () => {
    await settings.update({ mcpProviders: { [APP]: true }, mcpAutoAllow: { [APP]: true } });
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "apptool", "hostyg_seed");
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
    await manager.postMessage(record.id, "apptool", "hostyg_seed");
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
    await manager.postMessage(record.id, "apptool", "hostyg_seed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(granted(record.id).size).toBe(1);

    offered = false;
    await manager.applyProviderPolicy();

    expect(granted(record.id).size).toBe(0);
  });

  it("grants nothing when the app's tool list cannot be read", async () => {
    // "We do not know" must not collapse into "nothing is read-only" — it has to keep asking.
    await settings.update({ mcpProviders: { [APP]: true }, mcpAutoAllow: { [APP]: true } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/mcp/token")
        ? new Response(
            JSON.stringify({ token: "app-token", expiresAt: new Date(Date.now() + 300_000).toISOString() }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("stopped", { status: 503 }),
    );

    expect(await run("apptool please", "assistant_text")).not.toContain("approval_request");
  });
});

describe("Core's default grant", () => {
  // The pair with the suite above: the same shape of call, aimed at Core instead of an app, runs
  // with no operator decision on record at all. Core's annotations are the platform's own word about
  // its own tools, which is the standing the gateway's built-in read-only set already has.
  let dataDir: string;
  let store: SessionStore;
  let settings: SettingsStore;
  let manager: SessionManager;

  beforeEach(async () => {
    offered = true;
    directoryRevision = "one";
    providerUrl = `http://${APP}/api/mcp`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-auto-allow-core-"));
    store = new SessionStore(dataDir);
    settings = new SettingsStore(dataDir);
    const exchange = new TokenExchange("http://core.test", "hosty.harness", "service");
    const proxy = new McpProxy((sessionId, appId) => manager.mintAppToken(sessionId, appId));
    manager = new SessionManager(
      store,
      new FakeHarnessAdapter(),
      new AuditReporter(null, null, "hosty.harness"),
      dataDir,
      settings,
      providersWithCore,
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

  function granted(sessionId: string): Set<string> {
    return (manager as unknown as { live: Map<string, { autoAllowed: Set<string> }> })
      .live.get(sessionId)!.autoAllowed;
  }

  it("runs Core's read-only tools unprompted with nothing written to settings", async () => {
    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "coretool please", "hostyg_seed");
    const events = await vi.waitFor(async () => {
      const events = (await store.readEvents(record.id)).map((event) => event.type);
      expect(events).toContain("assistant_text");
      return events;
    });
    expect(events).not.toContain("approval_request");
    // Only what Core declared read-only: `stop_app` declares nothing and stays behind the card, the
    // app's tools are absent because the app was never enabled.
    expect([...granted(record.id)]).toEqual([CORE_TOOL]);
  });

  it("delegates Core prompting to the same broker without a native duplicate", async () => {
    await settings.update({ mcpAutoAllow: { "hosty:core": false } });

    const record = await manager.createSession({ createdBy: "user_admin" });
    await manager.postMessage(record.id, "coretool please", "hostyg_seed");
    await vi.waitFor(async () => {
      expect((await store.readEvents(record.id)).map((event) => event.type)).toContain("assistant_text");
    });
  });
});
