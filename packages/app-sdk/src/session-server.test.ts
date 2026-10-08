import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostySessionResponse } from "./session-server";
import { createHostySessionRouteHandler, clearRevalidationCache } from "./server";

const recovery = { appId: "sample", corePublicOrigin: "https://core.test", appAuthProtocol: 2 as const };
const identity = { userId: "alice", hostRole: "host.user", activeUntil: null, activityRequired: false };
const options = { coreOrigin: "https://core.test", serviceToken: "private-service" };
afterEach(() => { clearRevalidationCache(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("standard overlay server adapter", () => {
  it("does not read permissions or disclose identity before authentication and app access checks", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await (await createHostySessionResponse({ status: "expired" }, recovery, options)).json()).toEqual({ status: "expired", recovery });
    expect(await (await createHostySessionResponse({ status: "active", identity }, recovery, { ...options, administratorOnly: true })).json()).toEqual({ status: "forbidden", recovery });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["host.user", "host.admin"])("reports required setup to %s without granting approval authority", async hostRole => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ required: ["apps.read"], optional: ["apps.logs"], granted: [] }));
    vi.stubGlobal("fetch", fetcher);
    const response = await createHostySessionResponse({ status: "active", identity: { ...identity, hostRole } }, recovery, options);
    const body = await response.json();
    expect(body.hosty.setup).toBe("missing");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Boolean(body.hosty.notice)).toBe(hostRole === "host.admin");
    expect(JSON.stringify(body)).not.toContain("private-service");
    if (hostRole === "host.user") expect(JSON.stringify(body)).not.toContain("apps.read");
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer private-service");
  });
  it.each([
    [{ required: [], optional: ["apps.logs"], granted: [] }, "ready"],
    [{ required: ["apps.read"], optional: [], granted: ["apps.read"] }, "ready"],
    [{ required: ["new.right"], optional: [], granted: [], unsupportedRequired: ["new.right"] }, "unsupported"],
    [{ required: [], optional: [], granted: "invalid" }, "unavailable"],
  ])("classifies required and optional declarations", async (permissions, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(permissions)));
    const body = await (await createHostySessionResponse({ status: "active", identity }, recovery, options)).json();
    expect(body.hosty.setup).toBe(expected);
  });
  it.each([[404, "incompatible"], [503, "unavailable"]])("does not treat HTTP %s as successful readiness", async (status, setup) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: Number(status) })));
    const body = await (await createHostySessionResponse({ status: "active", identity }, recovery, options)).json();
    expect(body.status).toBe("active"); expect(body.hosty.setup).toBe(setup);
  });
  it("uses the app bearer before a stale cookie through the Next/Web handler", async () => {
    vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.test"); vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", recovery.corePublicOrigin);
    vi.stubEnv("HOSTY_APP_ID", "sample"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "private-service");
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/protocol")) return Response.json({ version: 2 });
      if (String(input).endsWith("/revalidate")) {
        expect(JSON.parse(init?.body as string).accessToken).toBe("hostyg_current");
        return Response.json({ active: true, appId: "sample", ...identity, expiresAt: new Date(Date.now() + 60000).toISOString() });
      }
      return Response.json({ required: [], optional: [], granted: [] });
    }); vi.stubGlobal("fetch", fetcher);
    const handler = createHostySessionRouteHandler({ appIdFallback: "sample", identityCookieName: "identity" });
    const response = await handler(new Request("https://app.test/api/hosty/session", { headers: { authorization: "Bearer hostyg_current", cookie: "identity=hostyg_old" } }));
    expect(await response.json()).toMatchObject({ status: "active", userId: "alice", hosty: { version: 1, setup: "ready" } });
  });
});
