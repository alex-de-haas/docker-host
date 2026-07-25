import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRevalidationCache } from "@hosty-sdk/app/server";
import { GET as getInstalledApps } from "@/app/api/installed-apps/route";
import { GET as getUpdateStatus } from "@/app/api/installed-apps/[id]/update-status/route";
import { appIdentityCookieName } from "@/lib/host-auth";

beforeEach(() => {
  clearRevalidationCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Marketplace installed-apps routes", () => {
  it("does not expose the installed-app roster without an app-origin session", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await getInstalledApps(new Request("http://marketplace.local/api/installed-apps"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ code: "app_identity_required" });
    // The gate has to run before the service-token call, or the roster leaves Core regardless.
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not expose update availability without an app-origin session", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await getUpdateStatus(
      new Request("http://marketplace.local/api/installed-apps/com.example.notes/update-status"),
      { params: Promise.resolve({ id: "com.example.notes" }) },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ code: "app_identity_required" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an active non-admin identity on the roster route", async () => {
    const upstream = stubNonAdminIdentity();

    const response = await getInstalledApps(new Request("http://marketplace.local/api/installed-apps", {
      headers: { cookie: `${appIdentityCookieName}=identity-token` },
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "system_app_admin_required" });
    // Only the identity revalidation — the roster call never follows a failed gate.
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects an active non-admin identity on the update-status route", async () => {
    const upstream = stubNonAdminIdentity();

    const response = await getUpdateStatus(
      new Request("http://marketplace.local/api/installed-apps/com.example.notes/update-status", {
        headers: { cookie: `${appIdentityCookieName}=identity-token` },
      }),
      { params: Promise.resolve({ id: "com.example.notes" }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "system_app_admin_required" });
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

/** An active session whose Host role is below the administrator gate. */
function stubNonAdminIdentity() {
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-token");
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.local:7070");
  const upstream = vi.fn(async () => new Response(JSON.stringify({
    active: true,
    appId: "hosty.marketplace",
    userId: "user@example.test",
    hostRole: "host.user",
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  return upstream;
}
