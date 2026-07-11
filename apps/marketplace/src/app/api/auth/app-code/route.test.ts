import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/app-code/route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Marketplace app-code exchange", () => {
  it("rejects a missing authorization code", async () => {
    const response = await POST(new Request("http://marketplace.local/api/auth/app-code", {
      method: "POST",
      body: "{}",
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "app_auth_code_required" } });
  });

  it("exchanges through Core and establishes an app-origin HttpOnly cookie", async () => {
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.local:7070");
    const coreFetch = vi.fn(async () => new Response(JSON.stringify({
      accessToken: "app-identity-token",
      expiresInSeconds: 600,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", coreFetch);

    const response = await POST(new Request("http://marketplace.local/api/auth/app-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: " one-time-code " }),
    }));

    expect(response.status).toBe(200);
    expect(coreFetch).toHaveBeenCalledWith("http://core.local:7070/api/auth/apps/token", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ code: "one-time-code" }),
    }));
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("hosty_marketplace_identity=app-identity-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).not.toContain("Secure");
  });

  it("uses SameSite=None and Secure behind an HTTPS gateway", async () => {
    vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.example");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accessToken: "token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const response = await POST(new Request("http://marketplace.local/api/auth/app-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ code: "code" }),
    }));

    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("SameSite=none");
    expect(cookie).toContain("Secure");
  });
});
