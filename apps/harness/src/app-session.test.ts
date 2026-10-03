import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeLaunchCode, readAppCredential } from "./app-session.js";
import { resolveAdminActor } from "./auth.js";
import { delegationCredential } from "./session-delegation.js";

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
    const result = await exchangeLaunchCode("one-use-code", false);
    expect(result).toMatchObject({ ok: false, code: "app_identity_rejected", status: status === 503 ? 503 : 403 });
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("setCookie");
  });

  it("returns only the validated app grant with its bounded host-only cookie", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ accessToken: "hostyg_own", expiresInSeconds: 120 }))
      .mockResolvedValueOnce(Response.json({ active: true, userId: "user", hostRole: "host.admin" })));
    const result = await exchangeLaunchCode("one-use-code", true);
    expect(result).toMatchObject({ ok: true, accessToken: "hostyg_own", expiresInSeconds: 120 });
    if (!result.ok) throw new Error("exchange failed");
    expect(result.setCookie).toBe("hosty_harness_identity=hostyg_own; HttpOnly; Path=/; Max-Age=120; SameSite=None; Secure");
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
