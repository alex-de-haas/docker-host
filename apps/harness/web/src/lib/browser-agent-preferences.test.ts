import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantSession } from "./assistant-api";
import { loadBrowserAgentDefaults, readBrowserAgentDefaults, rememberAutonomy, rememberManualModel } from "./browser-agent-preferences";

const { appFetch } = vi.hoisted(() => ({ appFetch: vi.fn() }));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch }));

function installStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
  };
  vi.stubGlobal("window", { localStorage: storage });
  return { data, storage };
}
function record(values: Partial<AssistantSession> = {}): AssistantSession {
  return { id: "chat-private", title: null, status: "idle", createdAt: "2026-11-05T00:00:00Z",
    createdBy: "owner-a", connectionId: "connection-a", executionSelection: { model: "model-a", reasoningEffort: "high" },
    autonomy: "normal", ...values };
}
let browser: ReturnType<typeof installStorage>;
beforeEach(() => { browser = installStorage(); appFetch.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });
const onlyKey = () => [...browser.data.keys()][0]!;

describe("browser agent defaults", () => {
  it("round-trips model/effort per owner and connection, including explicit provider defaults", () => {
    rememberManualModel(record());
    rememberManualModel(record({ connectionId: "connection-b", executionSelection: { model: null, reasoningEffort: null } }));
    rememberManualModel(record({ createdBy: "owner-b", executionSelection: { model: "other-account", reasoningEffort: "low" } }));
    expect(readBrowserAgentDefaults("owner-a")).toEqual({ models: {
      "connection-a": { model: "model-a", reasoningEffort: "high" },
      "connection-b": { model: null, reasoningEffort: null },
    } });
    expect(readBrowserAgentDefaults("owner-b")).toEqual({ models: { "connection-a": { model: "other-account", reasoningEffort: "low" } } });
    expect(readBrowserAgentDefaults("unknown-owner")).toBeUndefined();
    installStorage(); // Another origin has its own browser storage.
    expect(readBrowserAgentDefaults("owner-a")).toBeUndefined();
  });

  it("merges fresh other-tab data and preserves model pairs when saving autonomy", () => {
    rememberManualModel(record());
    browser.data.set(onlyKey(), JSON.stringify({ models: {
      "connection-a": { model: "from-other-tab", reasoningEffort: null },
      "connection-b": { model: null, reasoningEffort: "medium" },
    }, autonomy: "autonomous" }));
    rememberManualModel(record({ connectionId: "connection-c" }));
    expect(readBrowserAgentDefaults("owner-a")).toEqual({ models: {
      "connection-a": { model: "from-other-tab", reasoningEffort: null },
      "connection-b": { model: null, reasoningEffort: "medium" },
      "connection-c": { model: "model-a", reasoningEffort: "high" },
    }, autonomy: "autonomous" });
    rememberAutonomy(record({ autonomy: "normal" }));
    expect(readBrowserAgentDefaults("owner-a")?.autonomy).toBe("normal");
    expect(Object.keys(readBrowserAgentDefaults("owner-a")!.models!)).toHaveLength(3);
    browser.data.delete(onlyKey());
    expect(readBrowserAgentDefaults("owner-a")).toBeUndefined();
  });

  it("stores manual profile overrides without persisting profiles, session fields or credentials", () => {
    const saved = { ...record(), agentProfile: { id: "private-profile", model: "profile-model", secret: "credential-value" },
      token: "credential-value", context: { sessionId: "private-session" } } as unknown as AssistantSession;
    rememberManualModel(saved);
    rememberAutonomy(saved);
    expect(JSON.parse(browser.data.get(onlyKey())!)).toEqual({ models: {
      "connection-a": { model: "model-a", reasoningEffort: "high" },
    }, autonomy: "normal" });
    expect(browser.data.get(onlyKey())).not.toMatch(/profile|private|credential|token|session/i);
  });

  it.each([
    { taskExecutionId: "task-execution" }, { createdBy: undefined }, { createdBy: "" },
  ])("does not remember task or unattributed selections: %j", values => {
    rememberManualModel(record(values));
    rememberAutonomy(record(values));
    expect(browser.storage.setItem).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("stores autonomy without a provider but skips its model: %j", connectionId => {
    rememberManualModel(record({ connectionId }));
    expect(browser.storage.setItem).not.toHaveBeenCalled();
    rememberAutonomy(record({ connectionId }));
    expect(readBrowserAgentDefaults("owner-a")).toEqual({ autonomy: "normal" });
  });

  it.each([
    "{bad", "null", "[]", '{"models":[]}', '{"models":{"connection-a":{"model":7,"reasoningEffort":null}}}',
    '{"models":{"connection-a":{"model":null}}}', '{"autonomy":"unexpected"}',
    '{"models":{"connection-a":{"model":"model with spaces","reasoningEffort":null}}}',
    JSON.stringify({ models: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), { model: null, reasoningEffort: null }])) }),
    JSON.stringify({ models: { connection: { model: "m".repeat(513), reasoningEffort: null } } }),
    JSON.stringify({ irrelevant: "x".repeat(41 * 1024) }),
  ])("ignores malformed or oversized storage without breaking chat", raw => {
    rememberManualModel(record());
    browser.data.set(onlyKey(), raw);
    expect(readBrowserAgentDefaults("owner-a")).toBeUndefined();
    expect(() => rememberAutonomy(record())).not.toThrow();
  });

  it("ignores extra storage fields rather than returning or retaining them", () => {
    rememberManualModel(record());
    browser.data.set(onlyKey(), JSON.stringify({ autonomy: "normal", ownerId: "other-owner", token: "private", profile: { id: "private" } }));
    expect(readBrowserAgentDefaults("owner-a")).toEqual({ autonomy: "normal" });
    rememberManualModel(record());
    expect(JSON.parse(browser.data.get(onlyKey())!)).toEqual({ autonomy: "normal", models: {
      "connection-a": { model: "model-a", reasoningEffort: "high" },
    } });
  });

  it("bounds stored connections and keeps the most recent choice", () => {
    for (let i = 0; i < 65; i++) rememberManualModel(record({ connectionId: `connection-${i}` }));
    const models = readBrowserAgentDefaults("owner-a")!.models!;
    expect(Object.keys(models)).toHaveLength(64);
    expect(models["connection-0"]).toBeUndefined();
    expect(models["connection-64"]).toEqual({ model: "model-a", reasoningEffort: "high" });
  });

  it("survives denied reads, quota failures and an absent browser without a memory fallback", () => {
    browser.storage.getItem.mockImplementation(() => { throw new Error("blocked"); });
    expect(() => rememberManualModel(record())).not.toThrow();
    expect(() => rememberAutonomy(record())).not.toThrow();
    expect(browser.storage.setItem).not.toHaveBeenCalled();
    expect(readBrowserAgentDefaults("owner-a")).toBeUndefined();
    browser.storage.getItem.mockReturnValue(null);
    browser.storage.setItem.mockImplementation(() => { throw new Error("quota"); });
    expect(() => rememberManualModel(record())).not.toThrow();
    expect(readBrowserAgentDefaults("owner-a")).toBeUndefined();
    vi.stubGlobal("window", undefined);
    expect(() => rememberAutonomy(record())).not.toThrow();
    expect(readBrowserAgentDefaults("owner-a")).toBeUndefined();
  });

  it("loads the authenticated owner's latest preferences on every request", async () => {
    rememberManualModel(record());
    rememberAutonomy(record({ createdBy: "owner-b", autonomy: "autonomous" }));
    appFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "active", userId: "owner-a" })));
    expect(await loadBrowserAgentDefaults()).toEqual({ ...readBrowserAgentDefaults("owner-a"), ownerId: "owner-a" });
    appFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "active", userId: "owner-b" })));
    expect(await loadBrowserAgentDefaults()).toEqual({ autonomy: "autonomous", ownerId: "owner-b" });
    expect(appFetch.mock.calls).toEqual([["/api/auth/identity"], ["/api/auth/identity"]]);
  });

  it("binds creation hints to the authenticated owner and never trusts or persists a stored owner ID", async () => {
    rememberAutonomy(record());
    browser.data.set(onlyKey(), JSON.stringify({ autonomy: "autonomous", ownerId: "owner-b" }));
    appFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "active", userId: "owner-a" })));
    expect(await loadBrowserAgentDefaults()).toEqual({ autonomy: "autonomous", ownerId: "owner-a" });
    expect(readBrowserAgentDefaults("owner-a")).toEqual({ autonomy: "autonomous" });
    rememberManualModel(record());
    expect(browser.data.get(onlyKey())).not.toContain("ownerId");
  });

  it.each([{ status: "inactive", userId: "owner-a" }, { status: "active" }, null])("does not reuse preferences without a current authenticated owner: %j", async identity => {
    rememberManualModel(record());
    appFetch.mockResolvedValueOnce(new Response(JSON.stringify(identity)));
    expect(await loadBrowserAgentDefaults()).toBeUndefined();
  });

  it("tolerates identity failures and inaccessible storage", async () => {
    appFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await loadBrowserAgentDefaults()).toBeUndefined();
    appFetch.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    expect(await loadBrowserAgentDefaults()).toBeUndefined();
    appFetch.mockResolvedValueOnce(new Response("invalid-json"));
    expect(await loadBrowserAgentDefaults()).toBeUndefined();
    browser.storage.getItem.mockImplementation(() => { throw new Error("blocked"); });
    appFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "active", userId: "owner-a" })));
    expect(await loadBrowserAgentDefaults()).toBeUndefined();
  });
});
