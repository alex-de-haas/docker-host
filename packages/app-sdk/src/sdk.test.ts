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
  clearAppSecretsCache,
  clearRevalidationCache,
  createAppCodeRouteHandler,
  deleteAppSecret,
  getAppSecret,
  HostySecretsError,
  identityCookieAttributes,
  listAppSecretKeys,
  readAppIdentityToken,
  resolveAppSession,
  setAppSecret,
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
  clearAppSecretsCache();
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
    expect(await resolveAppSession("hostyg_x", config)).toMatchObject({
      status: "misconfigured",
      error: { code: "app_service_token_missing" },
    });
    process.env.HOSTY_APP_SERVICE_TOKEN = "t";
    delete process.env.HOSTY_CORE_ORIGIN;
    expect(await resolveAppSession("hostyg_x", config)).toMatchObject({
      status: "misconfigured",
      error: { code: "core_origin_missing" },
    });
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

describe("resolution error detail", () => {
  it("passes Core's error code and HTTP status through on failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { code: "token_revoked", message: "App session has been revoked." })),
    );
    expect(await resolveAppSession("hostyg_detail_a", config)).toMatchObject({
      status: "expired",
      error: { status: 401, code: "token_revoked", message: "App session has been revoked." },
    });
  });

  it("labels network failures distinctly from Core-reported ones", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await resolveAppSession("hostyg_detail_b", config)).toMatchObject({
      status: "unavailable",
      error: { status: null, code: "app_session_revalidation_error" },
    });
  });

  it("marks a cross-app token with the mismatch code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { ...activePayload, appId: "other.app" })),
    );
    expect(await resolveAppSession("hostyg_detail_c", config)).toMatchObject({
      status: "forbidden",
      error: { code: "app_identity_app_mismatch" },
    });
  });
});

describe("app secrets", () => {
  it("reads a stored secret from the per-key route with the service token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { value: "token-payload" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getAppSecret("trakt.connection.1.tokens", config)).toBe("token-payload");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://core.test/api/internal/apps/com.example.app/secrets/trakt.connection.1.tokens");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer hosty_app_service.1.x.y");
  });

  it("returns null for an absent secret instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { code: "app_secret_not_found" })));
    expect(await getAppSecret("absent", config)).toBeNull();
  });

  it("serves repeat reads from the cache, including a miss", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { value: "cached" }))
      .mockResolvedValueOnce(jsonResponse(404, { code: "app_secret_not_found" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getAppSecret("present", config)).toBe("cached");
    expect(await getAppSecret("present", config)).toBe("cached");
    expect(await getAppSecret("absent", config)).toBeNull();
    expect(await getAppSecret("absent", config)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when refresh is requested", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { value: "first" }))
      .mockResolvedValueOnce(jsonResponse(200, { value: "second" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getAppSecret("key", config)).toBe("first");
    expect(await getAppSecret("key", config, { refresh: true })).toBe("second");
    expect(await getAppSecret("key", config)).toBe("second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves a value's significant whitespace rather than trimming it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { value: "  padded\n" })));
    expect(await getAppSecret("key", config)).toBe("  padded\n");
  });

  it("writes through the cache on set, so a later read needs no round-trip", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await setAppSecret("key", "written", config);
    expect(await getAppSecret("key", config)).toBe("written");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://core.test/api/internal/apps/com.example.app/secrets/key");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ value: "written" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the cached value on delete", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await setAppSecret("key", "written", config);
    await deleteAppSecret("key", config);

    expect(await getAppSecret("key", config)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method).toBe("DELETE");
  });

  it("lists key names live from the collection route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { keys: ["a.key", "b.key"] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listAppSecretKeys(config)).toEqual(["a.key", "b.key"]);
    await listAppSecretKeys(config);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "http://core.test/api/internal/apps/com.example.app/secrets",
    );
  });

  it("surfaces Core's rejection code and does not cache a failed write", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { code: "app_secret_value_invalid", message: "too big" }))
      .mockResolvedValueOnce(jsonResponse(404, { code: "app_secret_not_found" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(setAppSecret("key", "too-big", config)).rejects.toMatchObject({
      name: "HostySecretsError",
      status: 400,
      code: "app_secret_value_invalid",
    });
    expect(await getAppSecret("key", config)).toBeNull();
  });

  it("distinguishes a removed app from a missing secret on a per-key read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { code: "app_not_found" })));
    await expect(getAppSecret("key", config)).rejects.toMatchObject({
      status: 404,
      code: "app_not_found",
    });
  });

  it("treats a 404 on a mutation as an error, unlike a missing secret on read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { code: "app_not_found" })));
    await expect(deleteAppSecret("key", config)).rejects.toBeInstanceOf(HostySecretsError);
  });

  it("fails without calling Core when the service token is missing", async () => {
    delete process.env.HOSTY_APP_SERVICE_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAppSecret("key", config)).rejects.toMatchObject({ code: "app_service_token_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("labels a transport failure distinctly from a Core-reported one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(getAppSecret("key", config)).rejects.toMatchObject({
      status: null,
      code: "core_secrets_unavailable",
    });
  });

  it("namespaces cached values by app id, so one process cannot leak them across apps", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { value: "app-a-secret" }))
      .mockResolvedValueOnce(jsonResponse(200, { value: "app-b-secret" }));
    vi.stubGlobal("fetch", fetchMock);

    process.env.HOSTY_APP_ID = "com.example.app-a";
    expect(await getAppSecret("oauth.token", config)).toBe("app-a-secret");

    // Same process, same secret name, different identity: the cache must not answer for it.
    process.env.HOSTY_APP_ID = "com.example.app-b";
    expect(await getAppSecret("oauth.token", config)).toBe("app-b-secret");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    process.env.HOSTY_APP_ID = "com.example.app-a";
    expect(await getAppSecret("oauth.token", config)).toBe("app-a-secret");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a read that overlaps a write overwrite the newer cached value", async () => {
    let releaseRead: () => void = () => {};
    const readReachedCore = new Promise<void>((resolve) => {
      let firstGet = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          if (init.method === "GET" && firstGet) {
            firstGet = false;
            resolve();
            await new Promise<void>((release) => {
              releaseRead = release;
            });
            return jsonResponse(200, { value: "stale-from-core" });
          }
          return init.method === "GET"
            ? jsonResponse(404, { code: "app_secret_not_found" })
            : new Response(null, { status: 204 });
        }),
      );
    });

    const read = getAppSecret("key", config);
    await readReachedCore;
    await setAppSecret("key", "fresh", config);
    releaseRead();

    expect(await read).toBe("stale-from-core");
    // The later reader must see the write, not what the overlapping read observed.
    expect(await getAppSecret("key", config)).toBe("fresh");
  });

  it("treats a 200 without a usable value as a fault, not a missing secret", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { unexpected: "shape" })));
    await expect(getAppSecret("key", config)).rejects.toMatchObject({ code: "core_response_invalid" });
  });

  it("treats an unreadable 200 body as a fault rather than a reconnect-required state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })),
    );
    await expect(getAppSecret("key", config)).rejects.toMatchObject({ code: "core_response_invalid" });
  });

  it("treats a listing without a keys array as a fault rather than an empty store", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { unexpected: "shape" })));
    await expect(listAppSecretKeys(config)).rejects.toMatchObject({ code: "core_response_invalid" });
  });

  it("escapes the key in the request path", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { value: "v" }));
    vi.stubGlobal("fetch", fetchMock);

    await getAppSecret("weird key/with-slash", config);

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "http://core.test/api/internal/apps/com.example.app/secrets/weird%20key%2Fwith-slash",
    );
  });
});
