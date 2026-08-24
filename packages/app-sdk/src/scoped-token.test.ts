import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasScope, introspectScopedToken, SCOPE_MCP_READ } from "./scoped-token";

const ENV_KEYS = ["HOSTY_CORE_ORIGIN", "HOSTY_APP_ID", "HOSTY_APP_SERVICE_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOSTY_CORE_ORIGIN = "http://127.0.0.1:7070";
  process.env.HOSTY_APP_ID = "com.example.app";
  process.env.HOSTY_APP_SERVICE_TOKEN = "hosty_app_service.1.x.y";
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

describe("introspectScopedToken", () => {
  it("asks Core for its own app and passes the tool through for the audit line", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { active: true, sub: "user_1", role: "host.admin", scopes: [SCOPE_MCP_READ] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await introspectScopedToken("hostyat_value", { tool: "list_people" });

    expect(result).toEqual({ active: true, sub: "user_1", role: "host.admin", scopes: [SCOPE_MCP_READ] });
    expect(hasScope(result, SCOPE_MCP_READ)).toBe(true);
    expect(hasScope(result, "mcp:write")).toBe(false);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7070/api/internal/apps/com.example.app/token/introspect");
    // The service token authenticates the app; the credential under test travels in the body, never
    // as this request's own bearer.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer hosty_app_service.1.x.y");
    expect(JSON.parse(init.body as string)).toEqual({ token: "hostyat_value", tool: "list_people" });
  });

  it("omits the tool when the call is protocol traffic rather than an action", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { active: true, sub: "user_1", role: null, scopes: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await introspectScopedToken("hostyat_value");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ token: "hostyat_value" });
  });

  it("treats an inactive credential as an answer and an unreachable Core as a failure", async () => {
    // The pair that matters to a caller: one is a 401 to the client, the other a 503. Collapsing
    // them would tell a legitimate client its credential is bad whenever Core is restarting.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { active: false, sub: null, role: null, scopes: [] })));
    const inactive = await introspectScopedToken("hostyat_value");
    expect(inactive).toEqual({ active: false });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const unreachable = await introspectScopedToken("hostyat_value");
    expect(unreachable.active).toBe(false);
    expect(unreachable.active === false && unreachable.error?.code).toBe("introspection_unavailable");
  });

  it("fails closed on every answer that is not a literal active:true with a subject", async () => {
    // The hint being optional elsewhere in this platform is exactly why: a truthy-looking value, a
    // missing subject, or an unreadable body all mean "we could not establish this", never a grant.
    for (const body of [
      { active: "true", sub: "user_1" },
      { active: true },
      { active: true, sub: 42 },
      {},
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, body)));
      expect((await introspectScopedToken("hostyat_value")).active).toBe(false);
    }

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    expect((await introspectScopedToken("hostyat_value")).active).toBe(false);
  });

  it("refuses to guess a Core origin when the environment has none", async () => {
    // Core injects the origin already resolved for this app's runtime; a guessed localhost would be
    // right for a host process and silently wrong inside a container.
    delete process.env.HOSTY_CORE_ORIGIN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await introspectScopedToken("hostyat_value");

    expect(result.active).toBe(false);
    expect(result.active === false && result.error?.code).toBe("introspection_unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
