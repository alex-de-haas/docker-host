import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getCoreOrigin, getServiceToken, readAppIdentityToken } from "@hosty-sdk/app/server";
import { authConfig } from "./auth";

const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const csrfCookie = "hosty_desktop_csrf";
const refusal = (status: number, code: string, message: string) => Response.json({ code, message }, { status, headers: privateHeaders });

export function permittedRoute(method: string, path: string[]): boolean {
  if (path.some(segment => !segment || segment === "." || segment === ".." || /[\\/?#%\x00-\x1f]/.test(segment))) return false;
  const route = path.join("/");
  if (method === "GET") return ["api/auth/session", "api/auth/csrf", "api/apps", "api/events"].includes(route)
    || /^api\/apps\/[^/]+\/assets\/.+/.test(route);
  return method === "POST" && /^api\/apps\/[^/]+\/(start|stop|restart)$/.test(route);
}

function readCookie(request: Request, name: string) {
  const entry = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  try { return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null; } catch { return null; }
}

export async function proxyCore(request: Request, path: string[]): Promise<Response> {
  if (!permittedRoute(request.method, path)) return refusal(403, "route_denied", "This route is not available through Desktop.");
  const token = readAppIdentityToken(request.headers, authConfig);
  const transport = getCoreOrigin(), service = getServiceToken();
  if (!transport || !service) return refusal(503, "core_unavailable", "Desktop must run through Hosty Core.");
  if (!token) return refusal(401, "app_session_missing", "Sign in through Hosty to open your desktop.");
  const ownOrigin = new URL(process.env.HOSTY_PUBLIC_ORIGIN_WEB?.trim() || request.url).origin;
  if (request.method === "POST") {
    const actor = requireDesktopMutation(request);
    if (actor instanceof Response) return actor;
  }
  if (path.join("/") === "api/auth/csrf") {
    const csrf = randomBytes(32).toString("hex");
    const response = Response.json({ token: csrf }, { headers: privateHeaders });
    response.headers.append("Set-Cookie", `${csrfCookie}=${csrf}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${ownOrigin.startsWith("https:") ? "; Secure" : ""}`);
    return response;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.method === "POST" ? 10 * 60_000 : 15_000);
  try {
    const headers = new Headers({ Authorization: `Bearer ${service}`, "X-Hosty-App-Identity": token });
    for (const name of ["Content-Type", "If-None-Match"]) {
      const value = request.headers.get(name); if (value) headers.set(name, value);
    }
    const url = new URL("/" + path.map(encodeURIComponent).join("/"), transport);
    // The desktop does not subscribe to host resources or source/workspace topics.
    if (path.join("/") !== "api/events") url.search = new URL(request.url).search;
    const response = await fetch(url, { method: request.method, headers, cache: "no-store", redirect: "manual",
      signal: AbortSignal.any([request.signal, controller.signal]),
      body: request.method === "POST" ? await request.arrayBuffer() : undefined });
    const outgoing = new Headers(privateHeaders);
    for (const name of ["Content-Type", "ETag"]) {
      const value = response.headers.get(name); if (value) outgoing.set(name, value);
    }
    if (path.join("/") === "api/events") outgoing.set("X-Accel-Buffering", "no");
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch {
    return refusal(controller.signal.aborted ? 504 : 503, "core_unavailable", "Core could not finish the request. Check the current app state before trying again.");
  } finally { clearTimeout(timer); }
}

/** Reuse the same origin, identity and double-submit boundary for local Desktop actions. */
export function requireDesktopMutation(request: Request): { token: string } | Response {
  const token = readAppIdentityToken(request.headers, authConfig);
  if (!token) return refusal(401, "app_session_missing", "Sign in through Hosty to use Desktop.");
  const ownOrigin = new URL(process.env.HOSTY_PUBLIC_ORIGIN_WEB?.trim() || request.url).origin;
  const saved = readCookie(request, csrfCookie), supplied = request.headers.get("X-Hosty-CSRF");
  if (request.headers.get("origin") !== ownOrigin || !saved || !supplied || !/^[a-f0-9]{64}$/.test(saved) || !/^[a-f0-9]{64}$/.test(supplied)
    || !timingSafeEqual(Buffer.from(saved), Buffer.from(supplied)))
    return refusal(403, "csrf_invalid", "Use this Desktop session to perform this action.");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return refusal(415, "json_required", "Desktop actions require JSON.");
  return { token };
}
