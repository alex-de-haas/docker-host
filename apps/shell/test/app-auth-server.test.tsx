// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const exchange = vi.hoisted(() => vi.fn());
vi.mock("@hosty-sdk/app/server", () => ({ exchangeAppCode: exchange,
  getCoreOrigin: () => "http://core.transport:7070", getServiceToken: () => "service-secret" }));
import { appCookie, finishAppLogin, proxyCore, safeReturnPath, startAppLogin } from "../src/app/shell/app-auth-server";
const origin = "http://console.hosty.localhost:7171";
const state = "a".repeat(64);
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("HOSTY_PUBLIC_ORIGIN_WEB", origin);
  vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "http://core.hosty.localhost:7070");
  vi.stubEnv("HOSTY_APP_ID", "example.console");
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); exchange.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function callback(supplied = state) {
  return new Request(`${origin}/auth/callback?code=one-time-code&state=${supplied}`, {
    headers: { cookie: `hosty_shell_auth_state=${state}; hosty_shell_auth_return=%2Fapps` },
  });
}
it("starts at Core with a callback for this app and private state cookies", async () => {
  const response = await startAppLogin(new Request(`${origin}/auth/start?returnTo=%2Fapps`));
  const target = new URL(response.headers.get("location")!);
  expect(target.origin).toBe("http://core.hosty.localhost:7070");
  expect(target.pathname).toBe("/api/apps/example.console/open");
  const callback = new URL(target.searchParams.get("redirectUri")!);
  expect(callback.origin).toBe(origin);
  expect(callback.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(response.headers.getSetCookie().every(c => c.includes("HttpOnly") && c.includes("SameSite=Lax"))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("rejects callback substitution before code exchange", async () => {
  expect((await finishAppLogin(callback("b".repeat(64)))).status).toBe(403);
  expect(exchange).not.toHaveBeenCalled();
});
it("validates the audience, sets only the app cookie and returns no bearer to script", async () => {
  exchange.mockResolvedValue({ ok: true, accessToken: "own-grant", expiresInSeconds: 600 });
  fetchMock.mockResolvedValue(new Response('{"active":true}'));
  const response = await finishAppLogin(callback());
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${origin}/apps`);
  expect(await response.text()).toBe("");
  expect(response.headers.getSetCookie()).toContainEqual(expect.stringContaining(`${appCookie}=own-grant; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`));
  expect(String(fetchMock.mock.calls[0][0])).toBe("http://core.transport:7070/api/auth/apps/revalidate");
  expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
});
it("does not install a cookie for another app's code", async () => {
  exchange.mockResolvedValue({ ok: true, accessToken: "foreign-grant", expiresInSeconds: 600 });
  fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
  const response = await finishAppLogin(callback());
  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie")).toBeNull();
});
it.each(["https://evil.test", "//evil.test", "/\\evil.test", "/auth/start", "/api/control", "/\nattack"])(
  "rejects unsafe continuation %s", value => expect(safeReturnPath(value)).toBe("/"));
it("forwards only server-held credentials, never client bearer or Core cookies", async () => {
  fetchMock.mockResolvedValue(new Response('{"apps":[]}', { headers: { "Content-Type": "application/json", "Set-Cookie": "hosty_session=private" } }));
  const response = await proxyCore(new Request(`${origin}/api/core/api/apps`, { headers: {
    cookie: `${appCookie}=own-grant; hosty_session=private`, Authorization: "Bearer spoofed", "X-Hosty-App-Identity": "spoofed",
  } }), ["api", "apps"]);
  const sent = fetchMock.mock.calls[0][1].headers as Headers;
  expect(sent.get("authorization")).toBe("Bearer service-secret");
  expect(sent.get("X-Hosty-App-Identity")).toBe("own-grant");
  expect(sent.get("cookie")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
});
it.each(["https://evil.test", null])("rejects mutation origin %s", async incoming => {
  const headers = new Headers({ cookie: `${appCookie}=own-grant; hosty_shell_csrf=csrf`, "X-Hosty-CSRF": "csrf" });
  if (incoming) headers.set("Origin", incoming);
  const response = await proxyCore(new Request(`${origin}/api/core/api/apps/a/stop`, { method: "POST", headers }), ["api", "apps", "a", "stop"]);
  expect(response.status).toBe(403); expect(fetchMock).not.toHaveBeenCalled();
});
it("allows same-origin mutations with session and CSRF", async () => {
  fetchMock.mockResolvedValue(new Response("{}"));
  const response = await proxyCore(new Request(`${origin}/api/core/api/apps/a/stop`, { method: "POST",
    headers: { cookie: `${appCookie}=own-grant; hosty_shell_csrf=csrf`, "X-Hosty-CSRF": "csrf", Origin: origin }, body: "{}",
  }), ["api", "apps", "a", "stop"]);
  expect(response.status).toBe(200); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([{ path: ["control", "v1", "core", "stop"] }, { path: ["api", "internal", "apps"] },
  { path: ["api", "..", "control"] }, { path: ["api", "%2e%2e", "control"] }])("refuses privileged/traversal path $path", async ({ path }) => {
  const response = await proxyCore(new Request(`${origin}/api/core/test`, { headers: { cookie: `${appCookie}=own-grant` } }), path);
  expect(response.status).toBe(403); expect(fetchMock).not.toHaveBeenCalled();
});
it("clears an expired app cookie", async () => {
  fetchMock.mockResolvedValue(new Response('{"code":"token_expired"}', { status: 401 }));
  const response = await proxyCore(new Request(`${origin}/api/core/api/apps`, { headers: { cookie: `${appCookie}=expired` } }), ["api", "apps"]);
  expect(response.status).toBe(401); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});
it("uses the browser Host when Next constructs Request.url from the server listen address", async () => {
  const response = await startAppLogin(new Request("http://127.0.0.1:7171/auth/start?returnTo=%2Fdashboard", {
    headers: { host: new URL(origin).host },
  }));
  expect(new URL(response.headers.get("location")!).origin).toBe("http://core.hosty.localhost:7070");
  expect(response.headers.getSetCookie()).toHaveLength(2);
});

function startRequest(signal?: AbortSignal) {
  return new Request(`${origin}/api/core/api/apps/hosty.harness/start`, { method: "POST", signal,
    headers: { cookie: `${appCookie}=own-grant; hosty_shell_csrf=csrf`, "X-Hosty-CSRF": "csrf", Origin: origin }, body: "{}" });
}

function pendingCoreResponse() {
  fetchMock.mockImplementation((_url: URL, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    setTimeout(() => resolve(Response.json({ state: "running" })), 45_000);
  }));
}

it("lets app startup finish after setup exceeds the short read timeout, without replaying it", async () => {
  vi.useFakeTimers();
  pendingCoreResponse();
  const pending = proxyCore(startRequest(), ["api", "apps", "hosty.harness", "start"]);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(29_000);
  const response = await pending;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "running" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps reads bounded and reports timeout without suggesting a mutation retry", async () => {
  vi.useFakeTimers();
  pendingCoreResponse();
  const pending = proxyCore(new Request(`${origin}/api/core/api/apps`, {
    headers: { cookie: `${appCookie}=own-grant` },
  }), ["api", "apps"]);
  await vi.advanceTimersByTimeAsync(15_000);
  const response = await pending;
  expect(response.status).toBe(504);
  expect((await response.json()).code).toBe("core_request_timeout");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("still cancels a long operation when its browser request disconnects", async () => {
  vi.useFakeTimers();
  pendingCoreResponse();
  const controller = new AbortController();
  const pending = proxyCore(startRequest(controller.signal), ["api", "apps", "hosty.harness", "start"]);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await pending;
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("bounds stalled mutations with the operation deadline and never replays them", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const pending = proxyCore(startRequest(), ["api", "apps", "hosty.harness", "start"]);
  await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const response = await pending;
  expect(response.status).toBe(504);
  expect((await response.json()).code).toBe("core_request_timeout");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
