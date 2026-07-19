import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_REQUIRED_INTENT_TYPE,
  buildCoreOpenUrl,
  classifyRevalidationHttpStatus,
  decideRecoveryAction,
  detectLaunchMode,
  isLoopbackHost,
  readRecoveryParams,
} from "./index";
import { createReissueRateLimiter, parseActiveFrameAuthRequired } from "./embedder";
import {
  clearRevalidationCache,
  createAppCodeRouteHandler,
  identityCookieAttributes,
  readAppIdentityToken,
  resolveAppSession,
  type HostyAppConfig,
} from "./server";

const config: HostyAppConfig = {
  appIdFallback: "com.example.app",
  identityCookieName: "hosty_example_identity",
};

const ENV_KEYS = ["HOSTY_CORE_ORIGIN", "HOSTY_CORE_PUBLIC_ORIGIN", "HOSTY_APP_ID", "HOSTY_APP_SERVICE_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

const activePayload = {
  active: true,
  appId: "com.example.app",
  userId: "user_1",
  email: "user@example.com",
  displayName: "User",
  hostRole: "host.admin",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOSTY_CORE_ORIGIN = "http://core.test";
  process.env.HOSTY_APP_ID = "com.example.app";
  process.env.HOSTY_APP_SERVICE_TOKEN = "hosty_app_service.1.x.y";
  clearRevalidationCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  vi.unstubAllGlobals();
});

describe("classifyRevalidationHttpStatus", () => {
  it("maps the Core contract: 401 recoverable, 403 terminal, else transient", () => {
    expect(classifyRevalidationHttpStatus(401)).toBe("expired");
    expect(classifyRevalidationHttpStatus(403)).toBe("forbidden");
    expect(classifyRevalidationHttpStatus(500)).toBe("unavailable");
    expect(classifyRevalidationHttpStatus(503)).toBe("unavailable");
  });
});

describe("resolveAppSession", () => {
  it("classifies a missing token as not-present without calling Core", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveAppSession(null, config)).toEqual({ status: "not-present" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies missing service token or core origin as misconfigured", async () => {
    delete process.env.HOSTY_APP_SERVICE_TOKEN;
    expect(await resolveAppSession("hostyg_x", config)).toEqual({ status: "misconfigured" });
    process.env.HOSTY_APP_SERVICE_TOKEN = "t";
    delete process.env.HOSTY_CORE_ORIGIN;
    expect(await resolveAppSession("hostyg_x", config)).toEqual({ status: "misconfigured" });
  });

  it("maps Core statuses and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));
    expect((await resolveAppSession("hostyg_a", config)).status).toBe("expired");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, {})));
    expect((await resolveAppSession("hostyg_b", config)).status).toBe("forbidden");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect((await resolveAppSession("hostyg_c", config)).status).toBe("unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    expect((await resolveAppSession("hostyg_d", config)).status).toBe("unavailable");
  });

  it("treats an app-id mismatch as forbidden and a missing subject as expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ...activePayload, appId: "other.app" })));
    expect((await resolveAppSession("hostyg_e", config)).status).toBe("forbidden");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ...activePayload, userId: "" })));
    expect((await resolveAppSession("hostyg_f", config)).status).toBe("expired");
  });

  it("returns the identity, applying mapHostRole when configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, activePayload)));
    const mapped = await resolveAppSession("hostyg_g", {
      ...config,
      mapHostRole: (role) => (role === "host.admin" ? "admin" : "user"),
    });
    expect(mapped).toMatchObject({
      status: "active",
      identity: { userId: "user_1", hostRole: "host.admin", appRole: "admin" },
    });
  });

  it("caches a positive result (single Core call) but never caches failures", async () => {
    const okFetch = vi.fn(async () => jsonResponse(200, activePayload));
    vi.stubGlobal("fetch", okFetch);
    await resolveAppSession("hostyg_h", config);
    await resolveAppSession("hostyg_h", config);
    expect(okFetch).toHaveBeenCalledTimes(1);

    clearRevalidationCache();
    const failFetch = vi.fn(async () => jsonResponse(401, {}));
    vi.stubGlobal("fetch", failFetch);
    await resolveAppSession("hostyg_i", config);
    await resolveAppSession("hostyg_i", config);
    expect(failFetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent revalidations of the same token", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const gated = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => gated);
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = [resolveAppSession("hostyg_j", config), resolveAppSession("hostyg_j", config)];
    resolveFetch(jsonResponse(200, activePayload));
    expect((await first).status).toBe("active");
    expect((await second).status).toBe("active");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("readAppIdentityToken", () => {
  it("prefers the cookie, then bearer, then the legacy header", () => {
    expect(
      readAppIdentityToken(
        headers({ cookie: "a=1; hosty_example_identity=tok; b=2", authorization: "Bearer other" }),
        config,
      ),
    ).toBe("tok");
    expect(readAppIdentityToken(headers({ authorization: "Bearer btok" }), config)).toBe("btok");
    expect(readAppIdentityToken(headers({ "x-docker-host-identity": "htok" }), config)).toBe("htok");
    expect(readAppIdentityToken(headers({}), config)).toBeNull();
  });
});

describe("identityCookieAttributes", () => {
  it("derives SameSite/Secure from the protocol", () => {
    expect(identityCookieAttributes(true, 60)).toMatchObject({ secure: true, sameSite: "none" });
    expect(identityCookieAttributes(false, 60)).toMatchObject({ secure: false, sameSite: "lax" });
    expect(identityCookieAttributes(true, -5).maxAge).toBe(0);
  });
});

describe("createAppCodeRouteHandler", () => {
  it("rejects a missing code with 422", async () => {
    const handler = createAppCodeRouteHandler(config);
    const response = await handler(
      new Request("http://app.local/api/auth/app-code", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(422);
  });

  it("exchanges the code and sets the app identity cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { accessToken: "hostyg_new", expiresInSeconds: 3600 })),
    );
    const handler = createAppCodeRouteHandler(config);
    const response = await handler(
      new Request("http://app.local/api/auth/app-code", {
        method: "POST",
        body: JSON.stringify({ code: "one-time" }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hosty_example_identity=hostyg_new");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
    expect(await response.json()).toEqual({ accessToken: "hostyg_new", expiresInSeconds: 3600 });
  });

  it("uses SameSite=None; Secure behind an https ingress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { accessToken: "hostyg_new", expiresInSeconds: 3600 })),
    );
    const handler = createAppCodeRouteHandler(config);
    const response = await handler(
      new Request("http://app.local/api/auth/app-code", {
        method: "POST",
        headers: { "x-forwarded-proto": "https" },
        body: JSON.stringify({ code: "one-time" }),
      }),
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
  });
});

describe("core helpers", () => {
  const page = { origin: "http://127.0.0.1:61679", pathname: "/x", search: "", hostname: "127.0.0.1" };

  it("builds the /open URL and refuses known-impossible redirects", () => {
    expect(buildCoreOpenUrl("http://127.0.0.1:7070", "a.b", page)).toContain("/api/apps/a.b/open?redirectUri=");
    expect(buildCoreOpenUrl(null, "a.b", page)).toBeNull();
    expect(buildCoreOpenUrl("not a url", "a.b", page)).toBeNull();
    expect(
      buildCoreOpenUrl("http://127.0.0.1:7070", "a.b", { ...page, hostname: "192.168.1.5", origin: "http://192.168.1.5:61679" }),
    ).toBeNull();
  });

  it("recognizes loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("media.example.com")).toBe(false);
  });

  it("reads recovery params tolerantly", () => {
    expect(readRecoveryParams({ recovery: { appId: "a", corePublicOrigin: "http://c" } })).toEqual({
      appId: "a",
      corePublicOrigin: "http://c",
    });
    expect(readRecoveryParams({})).toEqual({ appId: null, corePublicOrigin: null });
    expect(readRecoveryParams(null)).toEqual({ appId: null, corePublicOrigin: null });
  });

  it("detects launch mode and treats a throwing top access as embedded", () => {
    const self = {} as Window;
    expect(detectLaunchMode({ self, top: self } as Pick<Window, "self" | "top">)).toBe("standalone");
    expect(detectLaunchMode({ self, top: {} as Window } as Pick<Window, "self" | "top">)).toBe("embedded");
  });

  it("decides recovery per the UX contract", () => {
    const base = { appId: "a.b", openUrl: "http://c/open", redirectAlreadyAttempted: false } as const;
    expect(decideRecoveryAction({ ...base, status: "active", mode: "standalone" })).toEqual({ kind: "none" });
    expect(decideRecoveryAction({ ...base, status: "forbidden", mode: "embedded" })).toEqual({
      kind: "card",
      card: "denied",
    });
    expect(decideRecoveryAction({ ...base, status: "expired", mode: "embedded" })).toEqual({
      kind: "post-auth-required",
      intent: { type: AUTH_REQUIRED_INTENT_TYPE, appId: "a.b" },
    });
    expect(decideRecoveryAction({ ...base, status: "expired", mode: "standalone" })).toEqual({
      kind: "redirect",
      openUrl: "http://c/open",
    });
    expect(
      decideRecoveryAction({ ...base, status: "expired", mode: "standalone", redirectAlreadyAttempted: true }),
    ).toEqual({ kind: "card", card: "signin" });
    expect(
      decideRecoveryAction({ ...base, status: "not-present", mode: "standalone", openUrl: null }),
    ).toEqual({ kind: "card", card: "signin" });
    expect(decideRecoveryAction({ ...base, status: "misconfigured", mode: "embedded" })).toEqual({
      kind: "card",
      card: "misconfigured",
    });
  });
});

describe("embedder", () => {
  const frameWindow = {};
  const message = (overrides: Partial<{ data: unknown; origin: string; source: unknown }> = {}) => ({
    data: { type: AUTH_REQUIRED_INTENT_TYPE, appId: "a.b" },
    origin: "http://app.local:3000",
    source: frameWindow,
    ...overrides,
  });

  it("accepts only the active frame's own verified intent", () => {
    expect(parseActiveFrameAuthRequired(message(), frameWindow, "http://app.local:3000/page?x=1", "a.b")).toBe(true);
    expect(parseActiveFrameAuthRequired(message({ source: {} }), frameWindow, "http://app.local:3000/", "a.b")).toBe(false);
    expect(parseActiveFrameAuthRequired(message({ origin: "http://evil.local" }), frameWindow, "http://app.local:3000/", "a.b")).toBe(false);
    expect(parseActiveFrameAuthRequired(message(), frameWindow, "http://app.local:3000/", "other.app")).toBe(false);
    expect(parseActiveFrameAuthRequired(message({ data: { type: "other" } }), frameWindow, "http://app.local:3000/", "a.b")).toBe(false);
    expect(parseActiveFrameAuthRequired(message(), null, "http://app.local:3000/", "a.b")).toBe(false);
  });

  it("rate-limits reissues per app", () => {
    let now = 0;
    const limiter = createReissueRateLimiter(3000, () => now);
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(false);
    expect(limiter.tryAcquire("b")).toBe(true);
    now = 3001;
    expect(limiter.tryAcquire("a")).toBe(true);
  });
});
