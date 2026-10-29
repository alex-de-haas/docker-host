// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/lib/app-roles", async original => ({ ...await original<typeof import("../src/lib/app-roles")>(), readDemoAppRoleAssignments: async () => [] }));
import { GET } from "../src/app/api/auth/identity/route";
import { getDemoAuthSnapshot } from "../src/lib/host-auth";
import { getDemoConfig } from "../src/lib/demo-config";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("uses ordinary child Core identity and its own user directory", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://child-core:8090"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "child-service");
  const fetch = vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith("/directory/users")
    ? Response.json({ users: [{ id: "child-admin", hostRole: "host.admin", displayName: "Test admin", enabled: true }] })
    : Response.json({ appId: "com.haas.demo-app", active: true, userId: "child-admin", hostRole: "host.admin" }));
  vi.stubGlobal("fetch", fetch);
  const snapshot = await getDemoAuthSnapshot(new Headers({ "x-docker-host-identity": "child-user-grant" }));
  expect(snapshot.appSession.hostRole).toBe("host.admin");
  expect(snapshot.appPermissions.role).toBe("admin"); expect(snapshot.appPermissions.canManageRoles).toBe(true);
  expect(snapshot.appPermissions.source).toBe("host-admin-bootstrap");
  expect(snapshot.directory.users[0]?.id).toBe("child-admin");
  expect(snapshot.directory.users[0]?.hostRole).toBe("host.admin");
  expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer child-service" });
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
