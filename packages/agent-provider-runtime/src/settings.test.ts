import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderSettings, type ProviderSettingsOptions } from "./settings.js";
import { absentUsage, type ProviderUsage } from "./internal/harness/provider-usage.js";

const definition = { kind: "sample", name: "Example", authentication: [{ id: "browser", label: "Example account", browserLogin: true }] };
const sampleUsage = (): ProviderUsage => ({ state: "available", observedAt: new Date().toISOString(), rows: [{ id:"account", group:"account", label:"Account", kind:"quota", used:25, observedAt:new Date().toISOString() }] });
const appId = "org.example.independent-engine", connections = () => ({
  list: vi.fn(async () => ({ defaultId: "account-1", defaults: {}, connections: [{ id: "account-1", name: "Personal", kind: "sample" as const, auth: "browser" as const, revision: 1, secretKey: "must-not-be-public", available: true }] })),
  get: vi.fn(async () => ({ id: "account-1", name: "Personal", kind: "sample" as const, auth: "browser" as const, revision: 1, secretKey: "private-key" })),
  update: vi.fn(async () => ({ id: "account-1", name: "Personal", kind: "sample" as const, auth: "browser" as const, revision: 2, secretKey: "private-key" })),
  remove: vi.fn(async () => {}), setDefault: vi.fn(async () => {}), startLogin: vi.fn(async () => ({ id: "login-1", connectionId: "account-1", status: "pending" as const, message: "Continue account sign-in." })),
  fetchLogin: vi.fn(async () => ({ id: "login-1", connectionId: "account-1", status: "pending" as const, message: "Continue account sign-in." })), cancelLogin: vi.fn(async () => {}),
  usage: vi.fn(async (_id: string, _refresh = false): Promise<ProviderUsage> => absentUsage()),
});
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(options: Partial<ProviderSettingsOptions> = {}) {
  const registry = connections(), isConnectionInUse = vi.fn(async () => false), coreFetch = vi.fn(async () => Response.json({ active: true, appId, userId: "user-1", hostRole: "host.admin" }));
  const settings = createProviderSettings({ definition, connections: registry, isConnectionInUse, env: { HOSTY_APP_ID: appId, HOSTY_CORE_ORIGIN: "http://core.test", HOSTY_APP_SERVICE_TOKEN: "synthetic-test-service" }, fetch: coreFetch as typeof fetch, ...options });
  const server = createServer((request, response) => { void settings(request, response, new URL(request.url!, "http://test").pathname).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("No test listener");
  const origin = `http://127.0.0.1:${address.port}`;
  return { registry, isConnectionInUse, coreFetch, request: (route: string, method = "GET", body?: unknown, headers: Record<string, string> = { authorization: "Bearer hostyg_synthetic" }) => fetch(origin + route, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }) };
}
describe("independent provider settings", () => {
  it("serves a credential-free settings shell without importing accounts or requiring Harness", async () => {
    const f = await fixture(); const page = await f.request("/settings", "GET", undefined, {});
    expect(page.status).toBe(200); expect(await page.text()).toContain("Sign in through Hosty"); expect(f.registry.list).not.toHaveBeenCalled(); expect(f.coreFetch).not.toHaveBeenCalled();
  });
  it("loads canonical theme before content and uses the former compact provider dialog structure", async () => {
    const f = await fixture(), html = await (await f.request("/settings", "GET", undefined, {})).text();
    expect(html.indexOf('src="/settings-bootstrap.js"')).toBeLessThan(html.indexOf('href="/hosty-theme.css"'));
    expect(html).toContain('id="editor"'); expect(html).toContain('+ Add provider');
    expect(html).not.toContain('background:#10151d');
    const css = await f.request("/settings.css", "GET", undefined, {});
    expect(css.status).toBe(200); expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toContain("var(--background)");
    expect(f.registry.list).not.toHaveBeenCalled(); expect(f.coreFetch).not.toHaveBeenCalled();
  });
  it("acknowledges the exact saved connection without exposing native credential references", async () => {
    const f = await fixture(), response = await f.request("/api/settings/connections", "POST", { name: "New", auth: "browser" });
    const value = await response.json() as { saved: Record<string, unknown>; connections: unknown[] };
    expect(response.status).toBe(200); expect(value.saved).toEqual({ id: "account-1", revision: "2" });
    expect(value.connections).toHaveLength(1); expect(JSON.stringify(value)).not.toContain("secretKey");
  });
  it("revalidates the own-app user and strips private credential lookup keys", async () => {
    const f = await fixture(); const result = await f.request("/api/settings/connections"); const value = await result.json() as { connections: Record<string, unknown>[] };
    expect(result.status).toBe(200); expect(value.connections[0]).not.toHaveProperty("secretKey");
    expect(f.coreFetch).toHaveBeenCalledWith(new URL("http://core.test/api/auth/apps/revalidate"), expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ authorization: "Bearer synthetic-test-service" }), body: JSON.stringify({ accessToken: "hostyg_synthetic" }) }));
  });
  it("rejects an anonymous or cross-app identity before accessing account data", async () => {
    const f = await fixture({ fetch: vi.fn(async () => Response.json({ active: true, appId: "another-app", userId: "user-1", hostRole: "host.admin" })) as typeof fetch });
    expect((await f.request("/api/settings/connections", "GET", undefined, {})).status).toBe(401);
    expect((await f.request("/api/settings/connections")).status).toBe(503); expect(f.registry.list).not.toHaveBeenCalled();
  });
  it("refuses non-administrators and does not turn provider access into account-management access", async () => {
    const f = await fixture({ fetch: vi.fn(async () => Response.json({ active: true, appId, userId: "user-1", hostRole: "host.user" })) as typeof fetch });
    expect((await f.request("/api/settings/connections")).status).toBe(403); expect(f.registry.list).not.toHaveBeenCalled();
  });
  it.each(["PUT", "DELETE", "LOGIN"])("blocks %s against durable active/unconfirmed connection ownership", async method => {
    const inUse = vi.fn(async () => true), f = await fixture({ isConnectionInUse: inUse });
    const result = await f.request("/api/settings/connections/account-1" + (method === "LOGIN" ? "/login" : ""), method === "LOGIN" ? "POST" : method, { expectedRevision: "1", ...(method === "PUT" ? { name: "Rename" } : {}) });
    expect(result.status).toBe(409); expect(f.registry.update).not.toHaveBeenCalled(); expect(f.registry.remove).not.toHaveBeenCalled(); expect(f.registry.startLogin).not.toHaveBeenCalled();
  });
  it("fixes provider kind and rejects stale connection revisions", async () => {
    const f = await fixture();
    expect((await f.request("/api/settings/connections", "POST", { name: "Other", kind: "other", auth: "api-key", secret: "synthetic" })).status).toBe(400);
    expect((await f.request("/api/settings/connections/account-1", "PUT", { name: "New", expectedRevision: "0" })).status).toBe(409); expect(f.registry.update).not.toHaveBeenCalled();
    expect((await f.request("/api/settings/connections", "POST", { name: "New", auth: "browser" })).status).toBe(200);
    expect(f.registry.update).toHaveBeenCalledWith({ name: "New", auth: "browser", kind: "sample" }, undefined);
  });
  it("requires same-origin provenance for cookie mutations", async () => {
    const f = await fixture(), cookie = "hosty_provider_" + createHash("sha256").update(appId).digest("hex").slice(0, 12);
    const result = await f.request("/api/settings/connections/account-1", "DELETE", { expectedRevision: "1" }, { cookie: `${cookie}=hostyg_synthetic`, origin: "https://attacker.invalid" });
    expect(result.status).toBe(403); expect(f.registry.remove).not.toHaveBeenCalled();
  });
  it("preserves identity on a temporary Core outage", async () => {
    const f = await fixture({ fetch: vi.fn(async () => Response.json({}, { status: 503 })) as typeof fetch });
    const result = await f.request("/api/settings/connections"); expect(result.status).toBe(503); expect(result.headers.get("set-cookie")).toBeNull();
  });
  it("reads account usage only for an authenticated own-app administrator and fixes the provider kind", async () => {
    const f = await fixture();
    expect((await f.request("/api/settings/connections/account-1/usage?refresh=true", "GET", undefined, {})).status).toBe(401);
    expect(f.registry.usage).not.toHaveBeenCalled();
    const member = await fixture({ fetch: vi.fn(async () => Response.json({ active: true, appId, userId: "member", hostRole: "host.user" })) as typeof fetch });
    expect((await member.request("/api/settings/connections/account-1/usage?refresh=true")).status).toBe(403);
    expect(member.registry.usage).not.toHaveBeenCalled();
    const anotherKind = await fixture({ definition: { ...definition, kind: "other" } });
    expect((await anotherKind.request("/api/settings/connections/account-1/usage?refresh=true")).status).toBe(404);
    expect(anotherKind.registry.usage).not.toHaveBeenCalled();
  });
  it("returns normalized account usage with a string revision and refreshes only on an explicit true query", async () => {
    const f = await fixture(), sample = { ...sampleUsage(), connectionRevision: 1 };
    f.registry.usage.mockResolvedValue(sample);
    const response = await f.request("/api/settings/connections/account-1/usage?refresh=true");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...sample, connectionRevision: "1" });
    expect(f.registry.usage).toHaveBeenLastCalledWith("account-1", true);
    await f.request("/api/settings/connections/account-1/usage"); expect(f.registry.usage).toHaveBeenLastCalledWith("account-1", false);
    await f.request("/api/settings/connections/account-1/usage?refresh=false"); expect(f.registry.usage).toHaveBeenLastCalledWith("account-1", false);
    const calls = f.registry.usage.mock.calls.length;
    expect((await f.request("/api/settings/connections/account-1/usage?refresh=1")).status).toBe(400);
    expect((await f.request("/api/settings/connections/account-1/usage?refresh=true&refresh=false")).status).toBe(400);
    expect(f.registry.usage).toHaveBeenCalledTimes(calls);
  });
  it("does not attach old account usage to a connection changed during the diagnostic", async () => {
    const f = await fixture(), original = await f.registry.get();
    f.registry.get.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, revision: 2 });
    f.registry.usage.mockResolvedValue({ ...sampleUsage(), connectionRevision: 1 });
    const response = await f.request("/api/settings/connections/account-1/usage?refresh=true");
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "connection_changed" });
  });
});
