import { afterEach, describe, expect, it, vi } from "vitest";
import { appIdentityCookieName, getMarketplaceIdentity, getRecoveryParams } from "@/lib/host-auth";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getMarketplaceIdentity", () => {
  it("reports a missing app-origin session without calling Core", async () => {
    const coreFetch = vi.fn();
    vi.stubGlobal("fetch", coreFetch);

    const identity = await getMarketplaceIdentity(new Headers());

    expect(identity).toMatchObject({ status: "not-present", tokenPresent: false, appId: "hosty.marketplace" });
    expect(coreFetch).not.toHaveBeenCalled();
  });

  it("revalidates the cookie with the app service token", async () => {
    vi.stubEnv("HOSTY_APP_ID", "hosty.marketplace");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.local:7070");
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-token");
    const coreFetch = vi.fn(async () => new Response(JSON.stringify({
      active: true,
      appId: "hosty.marketplace",
      userId: "admin@example.test",
      displayName: "Host Admin",
      hostRole: "host.admin",
      expiresAt: "2030-01-01T00:00:00Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", coreFetch);
    const headers = new Headers({ cookie: `${appIdentityCookieName}=identity-token` });

    const identity = await getMarketplaceIdentity(headers);

    expect(identity).toMatchObject({
      status: "active",
      userId: "admin@example.test",
      displayName: "Host Admin",
      hostRole: "host.admin",
    });
    expect(coreFetch).toHaveBeenCalledWith("http://core.local:7070/api/auth/apps/revalidate", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer service-token" }),
      body: JSON.stringify({ accessToken: "identity-token" }),
    }));
  });

  it("fails closed when Core returns identity for another app", async () => {
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      active: true,
      appId: "com.example.other",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const identity = await getMarketplaceIdentity(new Headers({
      cookie: `${appIdentityCookieName}=identity-token`,
    }));

    expect(identity).toMatchObject({
      status: "forbidden",
      error: { code: "app_identity_app_mismatch" },
    });
  });
});

describe("getRecoveryParams", () => {
  it("prefers the browser-reachable Core origin over the server origin", () => {
    vi.stubEnv("HOSTY_APP_ID", "hosty.marketplace");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://hosty-core:7070");
    vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "https://hosty.example.test");

    expect(getRecoveryParams()).toEqual({
      appId: "hosty.marketplace",
      corePublicOrigin: "https://hosty.example.test",
    });
  });

  it("falls back to the server origin, then to the local default", () => {
    vi.stubEnv("HOSTY_APP_ID", "");
    vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://hosty-core:7070");
    expect(getRecoveryParams()).toEqual({
      appId: "hosty.marketplace",
      corePublicOrigin: "http://hosty-core:7070",
    });

    vi.stubEnv("HOSTY_CORE_ORIGIN", "");
    expect(getRecoveryParams()).toEqual({
      appId: "hosty.marketplace",
      corePublicOrigin: "http://localhost:7070",
    });
  });
});
