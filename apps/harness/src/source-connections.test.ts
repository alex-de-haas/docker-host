import { afterEach, expect, it, vi } from "vitest";
import { isSourceConnectionRoute, requestSourceConnection } from "./source-connections.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("allows read-only source selection and rejects account management or installation", () => {
  expect(isSourceConnectionRoute("GET", "/api/source-connections")).toBe(true);
  expect(isSourceConnectionRoute("POST", "/api/installations")).toBe(false);
  expect(isSourceConnectionRoute("POST", "/api/installations/abc123/submit")).toBe(false);
  expect(isSourceConnectionRoute("GET", "/api/apps/example.private/source-access")).toBe(true);
  expect(isSourceConnectionRoute("POST", "/api/apps/install")).toBe(false);
  expect(isSourceConnectionRoute("POST", "/install/confirm/abc123")).toBe(false);
  expect(isSourceConnectionRoute("POST", "/api/source-connections/device/attempt/poll")).toBe(false);
  for (const path of ["/api/profile", "/api/auth/credentials", "/api/source-connections/../../auth/credentials", "/api/source-connections/%2e%2e", "/api/source-connections/identity?url=https://evil.test"]) {
    expect(isSourceConnectionRoute("PUT", path)).toBe(false);
  }
  expect(isSourceConnectionRoute("GET", "/api/source-connections/pat")).toBe(false);
});
it("forwards only the Harness service credential and its user grant, retaining Core's denial", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.test"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  const fetcher = vi.fn(async () => Response.json({ code: "app_permission_required" }, { status: 403 })); vi.stubGlobal("fetch", fetcher);
  const result = await requestSourceConnection("GET", "/api/source-connections", "hostyg_session");
  expect(result.status).toBe(403); expect(result.body).toEqual({ code: "app_permission_required" });
  expect(fetcher).toHaveBeenCalledWith(new URL("https://core.test/api/source-connections"), expect.objectContaining({
    method: "GET", redirect: "error", headers: { "content-type": "application/json", authorization: "Bearer service", "X-Hosty-App-Identity": "hostyg_session" },
  }));
});
it("does not call Core without app identity or for unknown routes and sanitizes failures", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.test"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  const fetcher = vi.fn(async () => { throw new Error("secret-provider-token"); }); vi.stubGlobal("fetch", fetcher);
  expect((await requestSourceConnection("GET", "/api/source-connections", null)).status).toBe(401);
  expect((await requestSourceConnection("POST", "/api/auth/credentials", "hostyg_session")).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
  const result = await requestSourceConnection("GET", "/api/source-connections", "hostyg_session");
  expect(result.status).toBe(503); expect(JSON.stringify(result)).not.toContain("secret-provider-token");
});
