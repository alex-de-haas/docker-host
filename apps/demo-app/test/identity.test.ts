// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/lib/app-roles", async original => ({ ...await original<typeof import("../src/lib/app-roles")>(), readDemoAppRoleAssignments: async () => [] }));
import { GET } from "../src/app/api/auth/identity/route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("prefers an explicit app bearer to a stale cookie and never falls back after its rejection", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  const fetch = vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith("/api/auth/apps/protocol")
    ? Response.json({ version: 2 })
    : Response.json({ code: "token_expired", message: "Expired" }, { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  const result = await GET(new Request("http://demo.test/api/auth/identity", { headers: {
    authorization: "Bearer current-grant", cookie: "hosty_demo_app_identity=stale-grant",
  } }));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ accessToken: "current-grant" });
  expect(result.status).toBe(401);
  const body = await result.json();
  expect(body.appSession.tokenSource).toBe("authorization-header");
  expect(body.recovery.appAuthProtocol).toBe(2);
});
it("returns a recoverable missing-session response with browser recovery coordinates", async () => {
  vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "http://core.hosty.localhost:7070");
  const result = await GET(new Request("http://demo.test/api/auth/identity"));
  expect(result.status).toBe(401);
  expect((await result.json()).recovery.corePublicOrigin).toBe("http://core.hosty.localhost:7070");
});
