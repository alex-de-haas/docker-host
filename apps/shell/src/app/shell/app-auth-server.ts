import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { exchangeAppCode, getAppAuthProtocol, isValidCodeVerifier, getCoreOrigin as getCoreTransport, getServiceToken } from "@hosty-sdk/app/server";
import { getCoreOrigin, getShellAppId } from "./server-env";

export const appCookie = "hosty_shell_identity";
const stateCookie = "hosty_shell_auth_state";
const returnCookie = "hosty_shell_auth_return";
const verifierCookie = "hosty_shell_auth_verifier";
const attemptCookies = [stateCookie, returnCookie, verifierCookie];
const statePattern = /^[a-f0-9]{64}$/;
const csrfCookie = "hosty_shell_csrf";
const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function cookie(request: Request, name: string): string | null {
  for (const item of request.headers.get("cookie")?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(parts.join("=")); } catch { return null; }
    }
  }
  return null;
}

function ownOrigin(request: Request): string {
  return new URL(process.env.HOSTY_PUBLIC_ORIGIN_WEB?.trim() || request.url).origin;
}

function hasOwnHost(request: Request, origin: string): boolean {
  // Next constructs Request.url from its listen address. Host still identifies the browser's
  // destination. Compare it only to the configured origin; never build a redirect from this header.
  return (request.headers.get("host") ?? new URL(request.url).host).toLowerCase() === new URL(origin).host.toLowerCase();
}

function serializeCookie(name: string, value: string, origin: string, seconds: number, path = "/"): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}${origin.startsWith("https:") ? "; Secure" : ""}`;
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: privateHeaders });
}

export function safeReturnPath(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(value)) return "/";
  const parsed = new URL(value, "https://shell.invalid");
  if (parsed.origin !== "https://shell.invalid" || parsed.pathname.startsWith("/auth/") || parsed.pathname.startsWith("/api/")) return "/";
  return parsed.pathname + parsed.search;
}

function attemptCookieName(prefix: string, state: string): string { return `${prefix}_${state}`; }

function clearAttempt(response: Response, origin: string, state: string): void {
  for (const prefix of attemptCookies)
    response.headers.append("Set-Cookie", serializeCookie(attemptCookieName(prefix, state), "", origin, 0, "/auth"));
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

function signInForm(target: URL, fields: Record<string, string>): Response {
  const nonce = randomBytes(16).toString("base64");
  // The parsed, configured IPv6 target keeps its exact form action without a CSP host source.
  const formAction = target.hostname.startsWith("[") ? "" : `form-action ${target.origin} 'self'; `;
  const inputs = Object.entries(fields).map(([name, value]) =>
    `<input type="hidden" name="${html(name)}" value="${html(value)}">`).join("");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="origin"><title>Sign in to Hosty</title></head><body><p>Opening Hosty sign-in…</p><form id="hosty-sign-in" method="post" action="${html(target.href)}">${inputs}<noscript><button type="submit">Continue to sign in</button></noscript></form><script nonce="${nonce}">document.getElementById("hosty-sign-in").requestSubmit();</script></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "origin",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; ${formAction}base-uri 'none'; frame-ancestors 'none'` },
  });
}

export async function startAppLogin(request: Request): Promise<Response> {
  const origin = ownOrigin(request);
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("returnTo"));
  if (!hasOwnHost(request, origin)) {
    return new Response(null, { status: 302, headers: { ...privateHeaders,
      Location: `${origin}/auth/start?returnTo=${encodeURIComponent(returnTo)}` } });
  }
  const liveStates = (request.headers.get("cookie") ?? "").split(";").filter(item =>
    new RegExp(`^${stateCookie}_[a-f0-9]{64}=`).test(item.trim()));
  if (liveStates.length >= 16) return error(429, "app_sign_in_limit", "Finish or cancel an existing sign-in before starting another.");
  const protocol = await getAppAuthProtocol();
  if (protocol === null) return error(503, "app_auth_protocol_unavailable", "Core sign-in capabilities are unavailable. Try again shortly.");
  // Always generate here. A public start URL cannot supply a proof for another browser.
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("state", state);
  const fields = { redirectUri: callback.toString(), state, codeChallenge: challenge, codeChallengeMethod: "S256" };
  const target = new URL(`/api/apps/${encodeURIComponent(getShellAppId())}/${protocol === 2 ? "sign-in-intent" : "open"}`, getCoreOrigin());
  let response: Response;
  if (protocol === 2) response = signInForm(target, fields);
  else {
    for (const [name, value] of Object.entries(fields)) target.searchParams.set(name, value);
    response = new Response(null, { status: 302, headers: { ...privateHeaders, Location: target.href } });
  }
  response.headers.append("Set-Cookie", serializeCookie(attemptCookieName(stateCookie, state), `${state}:${protocol}`, origin, 300, "/auth"));
  response.headers.append("Set-Cookie", serializeCookie(attemptCookieName(returnCookie, state), returnTo, origin, 300, "/auth"));
  response.headers.append("Set-Cookie", serializeCookie(attemptCookieName(verifierCookie, state), verifier, origin, 300, "/auth"));
  return response;
}

export async function finishAppLogin(request: Request): Promise<Response> {
  const origin = ownOrigin(request);
  if (!hasOwnHost(request, origin)) return error(403, "callback_origin_invalid", "Open Shell on its configured address.");
  const params = new URL(request.url).searchParams;
  const supplied = params.get("state");
  if (!supplied || !statePattern.test(supplied) || params.getAll("state").length !== 1)
    return error(403, "callback_state_invalid", "This sign-in did not start in this browser. Open Shell and sign in again.");
  const saved = /^([a-f0-9]{64}):([12])$/.exec(cookie(request, attemptCookieName(stateCookie, supplied)) ?? "");
  const verifier = cookie(request, attemptCookieName(verifierCookie, supplied));
  if (!saved || !timingSafeEqual(Buffer.from(saved[1]), Buffer.from(supplied)) || !isValidCodeVerifier(verifier))
    return error(403, "callback_state_invalid", "This sign-in did not start in this browser. Open Shell and sign in again.");
  const code = params.get("code");
  const protocolRefusal = params.getAll("code").length === 0 && params.getAll("error").length === 1 && params.get("error") === "protocol_required";
  if (!(code && params.getAll("code").length === 1 && params.getAll("error").length === 0) && !protocolRefusal)
    return error(403, "callback_state_invalid", "This sign-in response is invalid. Open Shell and sign in again.");
  if (saved[2] === "1") {
    const current = await getAppAuthProtocol();
    if (current === null) return error(503, "app_auth_protocol_unavailable", "Core sign-in capabilities are unavailable. Try again shortly.");
    if (current === 2) {
      // The new attempt discovers protocol 2 and generates fresh proof; it cannot repeat this transition.
      const returnTo = safeReturnPath(cookie(request, attemptCookieName(returnCookie, supplied)));
      const response = new Response(null, { status: 302, headers: { ...privateHeaders,
        Location: `${origin}/auth/start?returnTo=${encodeURIComponent(returnTo)}` } });
      clearAttempt(response, origin, supplied);
      return response;
    }
  }
  if (protocolRefusal || !code) {
    const response = error(403, "app_auth_protocol_mismatch", "This sign-in no longer matches Core. Open Shell and sign in again.");
    clearAttempt(response, origin, supplied);
    return response;
  }
  const exchange = await exchangeAppCode(code, verifier);
  if (!exchange.ok) return error(exchange.status, exchange.code, exchange.message);
  const validated = await callCore("/api/auth/apps/revalidate", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${getServiceToken() ?? ""}` },
    body: JSON.stringify({ accessToken: exchange.accessToken }),
  });
  if (!validated.ok) return error(validated.status, "app_login_denied", "Core did not authorize this Shell session.");
  const response = new Response(null, { status: 302, headers: { ...privateHeaders,
    Location: new URL(safeReturnPath(cookie(request, attemptCookieName(returnCookie, supplied))), origin).toString() } });
  response.headers.append("Set-Cookie", serializeCookie(appCookie, exchange.accessToken, origin, exchange.expiresInSeconds ?? 3600));
  clearAttempt(response, origin, supplied);
  return response;
}

export function logoutApp(request: Request): Response {
  if (request.headers.get("sec-fetch-mode") && request.headers.get("sec-fetch-mode") !== "navigate")
    return error(403, "navigation_required", "Sign out through browser navigation.");
  const response = new Response(null, { status: 302, headers: {
    ...privateHeaders, Location: new URL("/logout", getCoreOrigin()).toString(),
  } });
  const origin = ownOrigin(request);
  for (const name of [appCookie, csrfCookie]) response.headers.append("Set-Cookie", serializeCookie(name, "", origin, 0));
  for (const prefix of attemptCookies) {
    response.headers.append("Set-Cookie", serializeCookie(prefix, "", origin, 0, "/auth"));
    for (const item of request.headers.get("cookie")?.split(";") ?? []) {
      const name = item.trim().split("=")[0];
      if (name.startsWith(`${prefix}_`) && statePattern.test(name.slice(prefix.length + 1)))
        response.headers.append("Set-Cookie", serializeCookie(name, "", origin, 0, "/auth"));
    }
  }
  return response;
}

async function callCore(path: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const transport = getCoreTransport();
  if (!transport || !getServiceToken()) return error(503, "app_auth_misconfigured", "Shell must run through Core with its app credentials.");
  // Fetch resolves after response headers, not after connecting. Lifecycle mutations can
  // spend minutes installing dependencies/building before sending those headers. Streaming
  // responses remain open until the browser disconnects.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(new URL(path, transport), { ...init, cache: "no-store", redirect: "manual",
      signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  } catch {
    if (controller.signal.aborted)
      return error(504, "core_request_timeout", "Core did not finish this request in time. Check the current state before trying again.");
    return error(503, "core_unavailable", "Core could not be reached. Try again shortly.");
  } finally { clearTimeout(timer); }
}

/** Shared by Shell-owned mutation handlers. Authority still comes from live Core validation. */
export function requireAppMutation(request: Request): { token: string } | Response {
  const token = cookie(request, appCookie);
  if (!token) return error(401, "app_session_missing", "Sign in through Core to use Shell.");
  const csrf = cookie(request, csrfCookie);
  if (request.headers.get("origin") !== ownOrigin(request) || !csrf || request.headers.get("X-Hosty-CSRF") !== csrf)
    return error(403, "csrf_invalid", "The request must originate from this Shell session.");
  return { token };
}

export async function proxyCore(request: Request, path: string[]): Promise<Response> {
  const origin = ownOrigin(request);
  const token = cookie(request, appCookie);
  if (!token) return error(401, "app_session_missing", "Sign in through Core to use Shell.");
  const pathname = "/" + path.join("/");
  // The proxy is fixed to Core's public API. It cannot address its control plane, internal
  // service APIs, arbitrary hosts or redirects, even with forged client headers.
  if (path[0] !== "api" || path[1] === "internal" || path.some(p => !p || p === "." || p === ".." || /[\\/?#%]/.test(p)))
    return error(403, "proxy_route_denied", "This Core route is not available through Shell.");
  if (!["GET", "HEAD"].includes(request.method)) {
    const csrf = cookie(request, csrfCookie);
    if (request.headers.get("origin") !== origin || !csrf || request.headers.get("X-Hosty-CSRF") !== csrf)
      return error(403, "csrf_invalid", "The request must originate from this Shell session.");
  }
  if (pathname === "/api/auth/csrf" && request.method === "GET") {
    const csrf = randomBytes(32).toString("hex");
    const response = Response.json({ token: csrf }, { headers: privateHeaders });
    response.headers.append("Set-Cookie", serializeCookie(csrfCookie, csrf, origin, 3600));
    return response;
  }
  const headers = new Headers({ Authorization: `Bearer ${getServiceToken() ?? ""}`, "X-Hosty-App-Identity": token });
  for (const name of ["Content-Type", "If-None-Match", "Range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = await callCore(pathname + new URL(request.url).search, {
    method: request.method, headers, signal: request.signal,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
  }, ["GET", "HEAD"].includes(request.method) ? 15_000 : 10 * 60_000);
  const outgoing = new Headers(privateHeaders);
  for (const name of ["Content-Type", "ETag", "Content-Range", "Accept-Ranges"]) {
    const value = response.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  const refusal = response.status === 401 ? await response.clone().json().catch(() => null) as { code?: string } | null : null;
  if (response.status === 401 && refusal?.code !== "reauth_required") outgoing.append("Set-Cookie", serializeCookie(appCookie, "", origin, 0));
  return new Response(response.body, { status: response.status, headers: outgoing });
}

/** Popup renewal updates only the app cookie. No navigation, CSRF rotation, or browser token. */
export async function renewAppLogin(request: Request): Promise<Response> {
  const origin = ownOrigin(request);
  if (request.headers.get("origin") !== origin || !request.headers.get("content-type")?.startsWith("application/json"))
    return error(403, "origin_denied", "Renew access from this Shell page.");
  const body = await request.json().catch(() => null) as { code?: unknown; codeVerifier?: unknown } | null;
  if (typeof body?.code !== "string" || !body.code) return error(400, "code_required", "A Core authorization code is required.");
  if (!isValidCodeVerifier(body.codeVerifier)) return error(400, "code_verifier_required", "A valid sign-in proof is required.");
  const exchange = await exchangeAppCode(body.code, body.codeVerifier);
  if (!exchange.ok) return error(exchange.status, exchange.code, exchange.message);
  const validation = await callCore("/api/auth/apps/revalidate", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getServiceToken() ?? ""}` },
    body: JSON.stringify({ accessToken: exchange.accessToken }) });
  if (!validation.ok) return error(validation.status, "app_login_denied", "Core did not authorize this Shell session.");
  const response = Response.json({ activeUntil: exchange.activeUntil }, { headers: privateHeaders });
  response.headers.append("Set-Cookie", serializeCookie(appCookie, exchange.accessToken, origin, exchange.expiresInSeconds ?? 3600));
  return response;
}
