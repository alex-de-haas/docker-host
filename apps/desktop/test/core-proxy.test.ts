// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@hosty-sdk/app/server", () => ({ getCoreOrigin: () => "http://core.transport:7070", getServiceToken: () => "private-service-token", readAppIdentityToken: (headers: Headers) => headers.get("x-test-identity") }));
import { permittedRoute, proxyCore } from "../src/lib/core-proxy";
const origin = "http://desktop.hosty.localhost:7123", csrf = "a".repeat(64);
beforeEach(() => { vi.stubEnv("HOSTY_PUBLIC_ORIGIN_WEB", origin); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("restricts the proxy to Desktop's public API operations", () => {
  expect(permittedRoute("GET", ["api", "apps"])).toBe(true);
  expect(permittedRoute("POST", ["api", "apps", "example.notes", "start"])).toBe(true);
  for (const path of [["control", "v1", "core", "stop"], ["api", "internal", "secret"], ["api", "apps", "..", "start"], ["api", "apps", "%2e%2e", "start"]])
    expect(permittedRoute("POST", path)).toBe(false);
  expect(permittedRoute("POST", ["api", "users"])).toBe(false);
});
it("requires a live app identity and blocks cross-origin or malformed CSRF mutations", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect((await proxyCore(new Request(`${origin}/api/core/api/apps`), ["api", "apps"])).status).toBe(401);
  for (const [suppliedOrigin, value] of [["https://evil.example", csrf], [origin, "b".repeat(64)], [origin, "é".repeat(64)]]) {
    const response = await proxyCore(new Request(`${origin}/api/core/api/apps/notes/stop`, { method: "POST", headers: {
      origin: suppliedOrigin, "x-test-identity": "app-identity", cookie: `hosty_desktop_csrf=${csrf}`, "X-Hosty-CSRF": value, "Content-Type": "application/json" }, body: "{}" }), ["api", "apps", "notes", "stop"]);
    expect(response.status).toBe(403);
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("forwards only server-held service authority and the app identity; Core enforces the user role", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ code: "admin_required" }, { status: 403 })); vi.stubGlobal("fetch", fetch);
  const response = await proxyCore(new Request(`${origin}/api/core/api/apps/notes/stop`, { method: "POST", headers: {
    origin, "x-test-identity": "ordinary-user-identity", cookie: `hosty_desktop_csrf=${csrf}`, "X-Hosty-CSRF": csrf,
    "Content-Type": "application/json", Authorization: "Bearer attacker", "X-Hosty-Control-Secret": "forged" }, body: "{}" }), ["api", "apps", "notes", "stop"]);
  expect(response.status).toBe(403);
  const headers = fetch.mock.calls[0][1].headers as Headers;
  expect(headers.get("authorization")).toBe("Bearer private-service-token");
  expect(headers.get("X-Hosty-App-Identity")).toBe("ordinary-user-identity");
  expect(headers.has("X-Hosty-Control-Secret")).toBe(false);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
