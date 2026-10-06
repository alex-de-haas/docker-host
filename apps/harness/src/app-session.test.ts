import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeLaunchCode, readAppCredential, getAppRecoveryParams } from "./app-session.js";
import { resolveAdminActor } from "./auth.js";
import { delegationCredential } from "./session-delegation.js";

const codeVerifier = "v".repeat(43);
const request = (headers: IncomingMessage["headers"]) => ({ headers }) as IncomingMessage;

describe("app-owned browser identity", () => {
  beforeEach(() => {
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test");
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "own-service");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("prefers the recovered frame grant over a stale browser cookie", () => {
    expect(readAppCredential(request({ authorization: "Bearer hostyg_fresh", cookie: "hosty_harness_identity=hostyg_stale" })))
      .toBe("hostyg_fresh");
  });
  it.each([undefined, "", "short", "=".repeat(43)])("refuses malformed proof %s before contacting Core", async proof => {
    const core = vi.fn(); vi.stubGlobal("fetch", core);
    expect(await exchangeLaunchCode("public-code", proof as string, false)).toMatchObject({ ok: false, status: 400, code: "app_auth_proof_required" });
    expect(core).not.toHaveBeenCalled();
  });
  it("exposes verified protocol metadata and refuses exchange after an observed Core downgrade", async () => {
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://harness-protocol.test");
    vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "https://core.public.test");
    const core = vi.fn().mockResolvedValueOnce(Response.json({ version: 2 })).mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", core);
    expect(await getAppRecoveryParams()).toMatchObject({ corePublicOrigin: "https://core.public.test", appAuthProtocol: 2 });
    expect(await exchangeLaunchCode("public-code", codeVerifier, false)).toMatchObject({ ok: false, status: 503, code: "app_auth_protocol_unavailable" });
    expect(core).toHaveBeenCalledTimes(2);
    expect(core.mock.calls.every(call => String(call[0]).endsWith("/api/auth/apps/protocol"))).toBe(true);
  });

  it.each(["host.admin", "host.user"])("uses the current Core role %s for API access", async role => {
    const core = vi.fn().mockResolvedValue(Response.json({ active: true, userId: "user", hostRole: role }));
    vi.stubGlobal("fetch", core);
    const actor = await resolveAdminActor(request({ authorization: "Bearer hostyg_browser" }));
    expect(actor).toEqual(role === "host.admin" ? { userId: "user", expiresAtSeconds: null, via: "app-session" } : null);
    expect(core.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: "Bearer own-service" }, body: JSON.stringify({ accessToken: "hostyg_browser" }) });
  });

  it.each([401, 403, 503])("rejects an exchanged grant that own-app revalidation rejects with %i", async status => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ accessToken: "hostyg_wrong", expiresInSeconds: 120 }))
      .mockResolvedValueOnce(Response.json({}, { status })));
    const result = await exchangeLaunchCode("one-use-code", codeVerifier, false);
    expect(result).toMatchObject({ ok: false, code: "app_identity_rejected", status: status === 503 ? 503 : 403 });
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("setCookie");
  });

  it("returns only the validated app grant with its bounded host-only cookie", async () => {
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "  own-service  ");
    const core = vi.fn()
      .mockResolvedValueOnce(Response.json({ accessToken: "hostyg_own", expiresInSeconds: 120 }))
      .mockResolvedValueOnce(Response.json({ active: true, userId: "user", hostRole: "host.admin" }));
    vi.stubGlobal("fetch", core);
    const result = await exchangeLaunchCode("one-use-code", codeVerifier, true);
    expect(result).toMatchObject({ ok: true, accessToken: "hostyg_own", expiresInSeconds: 120 });
    if (!result.ok) throw new Error("exchange failed");
    expect(result.setCookie).toBe("hosty_harness_identity=hostyg_own; HttpOnly; Path=/; Max-Age=120; SameSite=None; Secure");
    expect(core).toHaveBeenCalledTimes(2);
    expect(String(core.mock.calls[0]![0])).toBe("http://core.test/api/auth/apps/token");
    expect(core.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { "content-type": "application/json", authorization: "Bearer own-service" },
      body: JSON.stringify({ code: "one-use-code", codeVerifier }), cache: "no-store", redirect: "error" });
    expect(String(core.mock.calls[1]![0])).toBe("http://core.test/api/auth/apps/revalidate");
    expect(core.mock.calls[1]![1]).toMatchObject({ headers: { authorization: "Bearer own-service" }, body: JSON.stringify({ accessToken: "hostyg_own" }) });
  });

  it.each([undefined, "", "   "])("rejects missing service token (%s) before consuming the code", async token => {
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", token);
    const core = vi.fn(); vi.stubGlobal("fetch", core);
    expect(await exchangeLaunchCode("unconsumed-code", codeVerifier, false)).toEqual({ ok: false, status: 503,
      code: "app_service_token_missing", message: "HOSTY_APP_SERVICE_TOKEN is not configured." });
    expect(core).not.toHaveBeenCalled();
  });

  it("retains the Core refusal without granting a session or cookie", async () => {
    const core = vi.fn().mockResolvedValue(Response.json({ code: "invalid_code", message: "Authorization code is invalid." }, { status: 401 }));
    vi.stubGlobal("fetch", core);
    expect(await exchangeLaunchCode("wrong-app-code", codeVerifier, false)).toEqual({ ok: false, status: 401, code: "app_code_rejected", message: "Authorization code is invalid." });
    expect(core).toHaveBeenCalledOnce();
    expect(core.mock.calls[0]![1].headers.authorization).toBe("Bearer own-service");
  });

  it.each([
    { authorization: "Bearer hostyg_own" },
    { cookie: "hosty_harness_identity=hostyg_own" },
  ])("returns the app session for Core to check assistant-target grants", async headers => {
    const core = vi.fn(); vi.stubGlobal("fetch", core);
    expect(await delegationCredential(request(headers))).toBe("hostyg_own");
    expect(core).not.toHaveBeenCalled();
    expect(await delegationCredential(request(headers), false)).toBe("hostyg_own");
    expect(core).not.toHaveBeenCalled();
  });
});
