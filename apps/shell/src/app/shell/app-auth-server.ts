import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { exchangeAppCode, getCoreOrigin as getCoreTransport, getServiceToken } from "@hosty-sdk/app/server";
import { getCoreOrigin, getShellAppId } from "./server-env";

export const appCookie = "hosty_shell_identity";
const stateCookie = "hosty_shell_auth_state";
const returnCookie = "hosty_shell_auth_return";
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

export async function startAppLogin(request: Request): Promise<Response> {
  const origin = ownOrigin(request);
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("returnTo"));
  if (!hasOwnHost(request, origin)) {
    return new Response(null, { status: 302, headers: { ...privateHeaders,
      Location: `${origin}/auth/start?returnTo=${encodeURIComponent(returnTo)}` } });
  }
  const state = randomBytes(32).toString("hex");
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("state", state);
  const target = new URL(`/api/apps/${encodeURIComponent(getShellAppId())}/open`, getCoreOrigin());
  target.searchParams.set("redirectUri", callback.toString());
  const response = new Response(null, { status: 302, headers: { ...privateHeaders, Location: target.toString() } });
  response.headers.append("Set-Cookie", serializeCookie(stateCookie, state, origin, 300, "/auth"));
  response.headers.append("Set-Cookie", serializeCookie(returnCookie, returnTo, origin, 300, "/auth"));
  return response;
}

export async function finishAppLogin(request: Request): Promise<Response> {
  const origin = ownOrigin(request);
  if (!hasOwnHost(request, origin)) return error(403, "callback_origin_invalid", "Open Shell on its configured address.");
  const params = new URL(request.url).searchParams;
  const expected = cookie(request, stateCookie);
  const supplied = params.get("state");
  const code = params.get("code");
  if (!expected || !supplied || !/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) || !code)
    return error(403, "callback_state_invalid", "This sign-in did not start in this browser. Open Shell and sign in again.");
  const exchange = await exchangeAppCode(code);
  if (!exchange.ok) return error(exchange.status, exchange.code, exchange.message);
  // Exchanging a code alone does not prove its audience. Revalidate for this service before
  // creating the browser cookie, and never return the token to page script.
  const validated = await callCore("/api/auth/apps/revalidate", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${getServiceToken() ?? ""}` },
    body: JSON.stringify({ accessToken: exchange.accessToken }),
  });
  if (!validated.ok) return error(validated.status, "app_login_denied", "Core did not authorize this Shell session.");
  const response = new Response(null, { status: 302, headers: { ...privateHeaders,
    Location: new URL(safeReturnPath(cookie(request, returnCookie)), origin).toString() } });
  response.headers.append("Set-Cookie", serializeCookie(appCookie, exchange.accessToken, origin, exchange.expiresInSeconds ?? 3600));
  response.headers.append("Set-Cookie", serializeCookie(stateCookie, "", origin, 0, "/auth"));
  response.headers.append("Set-Cookie", serializeCookie(returnCookie, "", origin, 0, "/auth"));
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
  for (const name of [stateCookie, returnCookie]) response.headers.append("Set-Cookie", serializeCookie(name, "", origin, 0, "/auth"));
  return response;
}

async function callCore(path: string, init: RequestInit): Promise<Response> {
  const transport = getCoreTransport();
  if (!transport || !getServiceToken()) return error(503, "app_auth_misconfigured", "Shell must run through Core with its app credentials.");
  // Bound connection setup; streaming responses remain open until the browser disconnects.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(new URL(path, transport), { ...init, cache: "no-store", redirect: "manual",
      signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  } catch {
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
  });
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
  const body = await request.json().catch(() => null) as { code?: unknown } | null;
  if (typeof body?.code !== "string" || !body.code) return error(400, "code_required", "A Core authorization code is required.");
  const exchange = await exchangeAppCode(body.code);
  if (!exchange.ok) return error(exchange.status, exchange.code, exchange.message);
  const validation = await callCore("/api/auth/apps/revalidate", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getServiceToken() ?? ""}` },
    body: JSON.stringify({ accessToken: exchange.accessToken }) });
  if (!validation.ok) return error(validation.status, "app_login_denied", "Core did not authorize this Shell session.");
  const response = Response.json({ activeUntil: exchange.activeUntil }, { headers: privateHeaders });
  response.headers.append("Set-Cookie", serializeCookie(appCookie, exchange.accessToken, origin, exchange.expiresInSeconds ?? 3600));
  return response;
}
