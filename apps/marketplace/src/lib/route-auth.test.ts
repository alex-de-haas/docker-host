import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeMarketplaceRequest } from "@/lib/route-auth";
import { appIdentityCookieName } from "@/lib/host-auth";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("authorizeMarketplaceRequest", () => {
  it("requires an app-origin session", async () => {
    await expect(authorizeMarketplaceRequest(new Headers())).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "app_identity_required",
    });
  });

  it("permits only an active Host administrator", async () => {
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      active: true,
      appId: "hosty.marketplace",
      userId: "admin@example.test",
      hostRole: "host.admin",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const decision = await authorizeMarketplaceRequest(new Headers({
      cookie: `${appIdentityCookieName}=identity-token`,
    }));

    expect(decision).toMatchObject({
      ok: true,
      identity: { userId: "admin@example.test", hostRole: "host.admin" },
    });
  });

  it("rejects an active non-admin identity defensively", async () => {
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      active: true,
      appId: "hosty.marketplace",
      userId: "user@example.test",
      hostRole: "host.user",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(authorizeMarketplaceRequest(new Headers({
      cookie: `${appIdentityCookieName}=identity-token`,
    }))).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: "system_app_admin_required",
    });
  });
});
