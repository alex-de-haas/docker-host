import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRevalidationCache } from "@hosty-sdk/app/server";
import { POST } from "@/app/api/auth/app-code/route";

const codeVerifier = "v".repeat(43);

afterEach(() => {
  clearRevalidationCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Marketplace app-code exchange", () => {
  it("rejects a missing authorization code", async () => {
    const response = await POST(new Request("http://marketplace.local/api/auth/app-code", {
      method: "POST", headers: { "sec-fetch-site": "same-origin" },
      body: "{}",
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "app_auth_code_required" });
  });

  it.each([undefined, "", "short", "v".repeat(129), "!".repeat(43)])("rejects an invalid proof before contacting Core (%s)", async codeVerifier => {
    const coreFetch = vi.fn();
    vi.stubGlobal("fetch", coreFetch);
    const response = await POST(new Request("http://marketplace.local/api/auth/app-code", {
      method: "POST", headers: { "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ code: "code", codeVerifier }),
    }));
    expect(response.status).toBe(400);
    expect(coreFetch).not.toHaveBeenCalled();
  });

  it("exchanges through Core and establishes an app-origin HttpOnly cookie", async () => {
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-token");
    vi.stubEnv("HOSTY_APP_ID", "hosty.marketplace");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.local:7070");
    const coreFetch = vi.fn(async () => new Response(JSON.stringify({
      active: true, appId: "hosty.marketplace", userId: "operator", hostRole: "host.admin",
      accessToken: "app-identity-token",
      expiresInSeconds: 600,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", coreFetch);

    const response = await POST(new Request("http://marketplace.local/api/auth/app-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ code: " one-time-code ", codeVerifier }),
    }));

    expect(response.status).toBe(200);
    expect(coreFetch).toHaveBeenCalledWith("http://core.local:7070/api/auth/apps/token", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer service-token" }),
      body: JSON.stringify({ code: "one-time-code", codeVerifier }),
    }));
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("hosty_marketplace_identity=app-identity-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
  });

  it("uses SameSite=None and Secure behind an HTTPS gateway", async () => {
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-token");
    vi.stubEnv("HOSTY_APP_ID", "hosty.marketplace");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.example");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accessToken: "token", active: true, appId: "hosty.marketplace", userId: "operator", hostRole: "host.admin" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const response = await POST(new Request("http://marketplace.local/api/auth/app-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ code: "code", codeVerifier }),
    }));

    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
  });
});
