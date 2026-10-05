// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { exchange, protocol } = vi.hoisted(() => ({ exchange: vi.fn(), protocol: vi.fn() }));
vi.mock("@hosty-sdk/app/server", () => ({ exchangeAppCode: exchange,
  getAppAuthProtocol: protocol, isValidCodeVerifier: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value),
  getCoreOrigin: () => "http://core.transport:7070", getServiceToken: () => "service-secret" }));
import { appCookie, finishAppLogin, proxyCore, safeReturnPath, startAppLogin, renewAppLogin, logoutApp } from "../src/app/shell/app-auth-server";
const origin = "http://console.hosty.localhost:7171";
const state = "a".repeat(64);
const verifier = "v".repeat(43);
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("HOSTY_PUBLIC_ORIGIN_WEB", origin);
  vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "http://core.hosty.localhost:7070");
  vi.stubEnv("HOSTY_APP_ID", "example.console");
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); exchange.mockReset(); protocol.mockReset(); protocol.mockResolvedValue(2);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function callback(supplied = state) {
  return new Request(`${origin}/auth/callback?code=one-time-code&state=${supplied}`, {
    headers: { cookie: `hosty_shell_auth_state_${state}=${state}:2; hosty_shell_auth_return_${state}=%2Fapps; hosty_shell_auth_verifier_${state}=${verifier}` },
  });
}
it("starts a browser-bound Core intent with public form fields and a private verifier cookie", async () => {
  const response = await startAppLogin(new Request(`${origin}/auth/start?returnTo=%2Fapps`));
  expect(response.status).toBe(200);
  expect(response.headers.get("referrer-policy")).toBe("origin");
  const page = await response.text();
  expect(page).toContain('method="post" action="http://core.hosty.localhost:7070/api/apps/example.console/sign-in-intent"');
  expect(page).toContain('name="codeChallengeMethod" value="S256"');
  expect(page).toContain('name="codeChallenge"');
  expect(page).toContain('name="state"');
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(3);
  expect(cookies.every(c => c.includes("HttpOnly") && c.includes("SameSite=Lax") && c.includes("Path=/auth"))).toBe(true);
  const storedVerifier = cookies.find(c => c.startsWith("hosty_shell_auth_verifier_"))!.split("=")[1].split(";")[0];
  expect(storedVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(page).not.toContain(storedVerifier);
  expect(response.headers.get("content-security-policy")).toContain("form-action http://core.hosty.localhost:7070");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("uses additive proof fields only for a verified older Core", async () => {
  protocol.mockResolvedValue(1);
  const response = await startAppLogin(new Request(`${origin}/auth/start?returnTo=%2Fapps`));
  const target = new URL(response.headers.get("location")!);
  expect(response.status).toBe(302);
  expect(target.pathname).toBe("/api/apps/example.console/open");
  expect(target.searchParams.get("codeChallengeMethod")).toBe("S256");
  expect(target.searchParams.get("codeChallenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(new URL(target.searchParams.get("redirectUri")!).searchParams.get("state")).toBe(target.searchParams.get("state"));
  expect(target.searchParams.has("codeVerifier")).toBe(false);
});
it("fails closed when protocol discovery is unavailable", async () => {
  protocol.mockResolvedValue(null);
  const response = await startAppLogin(new Request(`${origin}/auth/start`));
  expect(response.status).toBe(503);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
});
it("generates fresh proof rather than laundering public start parameters", async () => {
  const response = await startAppLogin(new Request(`${origin}/auth/start?state=${state}&codeChallenge=attacker&codeVerifier=known`));
  const page = await response.text();
  expect(page).not.toContain(state);
  expect(page).not.toContain("attacker");
  expect(page).not.toContain("known");
});
it("keeps concurrent sign-in attempt cookies independent", async () => {
  const first = await startAppLogin(new Request(`${origin}/auth/start?returnTo=%2Fapps`));
  const second = await startAppLogin(new Request(`${origin}/auth/start?returnTo=%2Fdashboard`));
  const firstNames = first.headers.getSetCookie().map(c => c.split("=")[0]);
  expect(second.headers.getSetCookie().every(c => !firstNames.includes(c.split("=")[0]))).toBe(true);
});
it("requires the callback's private verifier before contacting Core", async () => {
  const request = new Request(`${origin}/auth/callback?code=one-time-code&state=${state}`, {
    headers: { cookie: `hosty_shell_auth_state_${state}=${state}` },
  });
  expect((await finishAppLogin(request)).status).toBe(403);
  expect(exchange).not.toHaveBeenCalled();
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
  expect(exchange).toHaveBeenCalledWith("one-time-code", verifier);
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
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("http://core.hosty.localhost:7070/api/apps/example.console/sign-in-intent");
  expect(response.headers.getSetCookie()).toHaveLength(3);
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

it.each([undefined, "", "short", "x".repeat(129)])("refuses public renewal without a valid proof (%s)", async codeVerifier => {
  const response = await renewAppLogin(new Request(`${origin}/api/auth/renew`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: "leaked-code", codeVerifier }) }));
  expect(response.status).toBe(400);
  expect(exchange).not.toHaveBeenCalled();
});
it("forwards renewal proof, installs only a cookie and never returns a grant", async () => {
  exchange.mockResolvedValue({ ok: true, accessToken: "renewed-grant", expiresInSeconds: 600, activeUntil: "2030-01-01T00:00:00Z" });
  fetchMock.mockResolvedValue(Response.json({ active: true }));
  const response = await renewAppLogin(new Request(`${origin}/api/auth/renew`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: "code", codeVerifier: verifier }) }));
  expect(exchange).toHaveBeenCalledWith("code", verifier);
  expect(await response.json()).toEqual({ activeUntil: "2030-01-01T00:00:00Z" });
  expect(response.headers.get("set-cookie")).toContain("renewed-grant");
});
it("clears every pending attempt at logout without publishing its verifier", () => {
  const response = logoutApp(new Request(`${origin}/auth/logout`, { headers: {
    cookie: `hosty_shell_auth_state_${state}=${state}; hosty_shell_auth_verifier_${state}=${verifier}` } }));
  expect(response.headers.getSetCookie()).toContainEqual(expect.stringContaining(`hosty_shell_auth_verifier_${state}=;`));
  expect(response.headers.get("set-cookie")).not.toContain(verifier);
});

it.each(["code=old-code", "error=protocol_required"])("restarts a correlated old-Core callback once after verified upgrade: %s", async result => {
  protocol.mockResolvedValue(2);
  const request = new Request(`${origin}/auth/callback?${result}&state=${state}`, { headers: {
    cookie: `hosty_shell_auth_state_${state}=${state}:1; hosty_shell_auth_verifier_${state}=${verifier}; hosty_shell_auth_return_${state}=%2Fapps`,
  } });
  const response = await finishAppLogin(request);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${origin}/auth/start?returnTo=%2Fapps`);
  expect(response.headers.getSetCookie()).toHaveLength(3);
  expect(response.headers.getSetCookie().every(value => value.includes("Max-Age=0"))).toBe(true);
  expect(exchange).not.toHaveBeenCalled();
  const restart = await startAppLogin(new Request(response.headers.get("location")!));
  expect(restart.status).toBe(200);
  expect(await restart.text()).toContain("sign-in-intent");
  expect(restart.headers.getSetCookie().some(value => value.includes(`${state}%3A`))).toBe(false);
  expect(restart.headers.getSetCookie()[0]).toContain("%3A2;");
});
it("does not loop a protocol-2 refusal or import an old proof from a public callback", async () => {
  const headers = { cookie: `hosty_shell_auth_state_${state}=${state}:2; hosty_shell_auth_verifier_${state}=${verifier}` };
  const response = await finishAppLogin(new Request(`${origin}/auth/callback?error=protocol_required&state=${state}`, { headers }));
  expect(response.status).toBe(403);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.getSetCookie()).toHaveLength(3);
  expect(protocol).not.toHaveBeenCalled();
  expect(exchange).not.toHaveBeenCalled();
});
it("refuses old-Core recovery when metadata is uncertain", async () => {
  protocol.mockResolvedValue(null);
  const response = await finishAppLogin(new Request(`${origin}/auth/callback?error=protocol_required&state=${state}`, { headers: {
    cookie: `hosty_shell_auth_state_${state}=${state}:1; hosty_shell_auth_verifier_${state}=${verifier}` } }));
  expect(response.status).toBe(503);
  expect(response.headers.get("location")).toBeNull();
  expect(exchange).not.toHaveBeenCalled();
});
it("does not inspect protocol or clear a valid attempt for substituted recovery state", async () => {
  const response = await finishAppLogin(new Request(`${origin}/auth/callback?error=protocol_required&state=${"b".repeat(64)}`, { headers: {
    cookie: `hosty_shell_auth_state_${state}=${state}:1; hosty_shell_auth_verifier_${state}=${verifier}` } }));
  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(protocol).not.toHaveBeenCalled();
});
