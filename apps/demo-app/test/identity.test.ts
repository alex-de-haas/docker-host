// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/lib/app-roles", async original => ({ ...await original<typeof import("../src/lib/app-roles")>(), readDemoAppRoleAssignments: async () => [] }));
import { GET } from "../src/app/api/auth/identity/route";
import { getDemoAuthSnapshot } from "../src/lib/host-auth";
import { getDemoConfig } from "../src/lib/demo-config";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("uses a scoped app administrator without a global host role or global directory", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://sandbox-core:8090"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "sandbox-service");
  vi.stubEnv("HOSTY_SANDBOX_PROTOCOL", "hosty-sandbox-v1");
  vi.stubEnv("HOSTY_SANDBOX_INSTANCE_ID", "a".repeat(32)); vi.stubEnv("HOSTY_SANDBOX_GENERATION", "b".repeat(32)); vi.stubEnv("HOSTY_SANDBOX_DATA_REVISION", "c".repeat(32));
  const fetch = vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith("/directory")
    ? Response.json({ users: [{ userId: "sandbox-admin", identityRealm: "sandbox", appRole: "admin", displayName: "Test admin", enabled: true }] })
    : Response.json({ appId: "com.haas.demo-app", active: true, userId: "sandbox-admin", hostRole: null, appRole: "admin", identityRealm: "sandbox",
      runtimeInstanceId: "a".repeat(32), generation: "b".repeat(32), dataRevision: "c".repeat(32), permissions: [] }));
  vi.stubGlobal("fetch", fetch);
  const snapshot = await getDemoAuthSnapshot(new Headers({ "x-docker-host-identity": "hostysb_grant_test" }));
  expect(snapshot.appSession.hostRole).toBeNull();
  expect(snapshot.appPermissions.role).toBe("admin"); expect(snapshot.appPermissions.canManageRoles).toBe(true);
  expect(snapshot.appPermissions.source).toBe("sandbox-scenario");
  expect(snapshot.directory.users[0]?.hostRole).toBeNull();
  expect(snapshot.directory.users[0]?.sandboxRole).toBe("admin");
  expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-Hosty-User-Token": "hostysb_grant_test" });
});
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

it("uses Core's allocated data directory ahead of app defaults and overrides", () => {
  vi.stubEnv("HOSTY_APP_DATA_DIR", "/sandbox/owned-data");
  vi.stubEnv("DEMO_DATA_DIR", "/legacy/demo-data");
  expect(getDemoConfig().paths.data).toBe("/sandbox/owned-data");
});
