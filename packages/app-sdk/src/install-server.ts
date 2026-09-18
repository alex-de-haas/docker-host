import "server-only";
import { getAppId, getCoreOrigin, getServiceToken, readAppIdentityToken, type HostyAppConfig } from "./server";

/** App-local adapter. Core revalidates the app/user on every call; service credentials stay server-side. */
export function createInstallationRouteHandler(config: HostyAppConfig, options: { publicOrigin?: string | null } = {}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const match = /\/installations(?:\/([a-f0-9]{48})(\/submit)?)?$/.exec(url.pathname);
    const valid = match && ((request.method === "POST" && (!match[1] || match[2])) || (request.method === "GET" && match[1] && !match[2]));
    if (!valid) return Response.json({ message: "Unsupported installation route." }, { status: 404 });
    // Origin is browser-controlled; an installed hostile page cannot submit through the user's
    // app cookie. Do not trust a caller-supplied forwarded host to decide which origins are allowed.
    // Frameworks may expose an internal request URL behind a proxy or custom local hostname.
    // An explicit operator-configured origin is authoritative in that case.
    let expectedOrigin = url.origin;
    if (options.publicOrigin?.trim()) {
      try {
        const configured = new URL(options.publicOrigin);
        if (!["http:", "https:"].includes(configured.protocol)) throw new Error("Invalid origin");
        expectedOrigin = configured.origin;
      } catch {
        return Response.json({ code: "hosty_misconfigured", message: "Installation public origin is invalid." }, { status: 503 });
      }
    }
    if (request.method !== "GET" && (request.headers.get("origin") !== expectedOrigin ||
        !request.headers.get("content-type")?.startsWith("application/json")))
      return Response.json({ code: "origin_denied", message: "A same-origin JSON request is required." }, { status: 403 });
    const token = readAppIdentityToken(request.headers, config);
    if (!token) return Response.json({ code: "app_identity_required", message: "Sign in through Hosty." }, { status: 401 });
    const core = getCoreOrigin();
    const service = getServiceToken();
    if (!core || !service) return Response.json({ code: "hosty_misconfigured", message: "Core integration is not configured." }, { status: 503 });
    const suffix = match[1] ? `/${match[1]}${match[2] ?? ""}` : "";
    try {
      const body = request.method === "GET" ? undefined : await request.text();
      if (body && body.length > 65536) return Response.json({ message: "Request is too large." }, { status: 413 });
      const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(getAppId(config))}/installations${suffix}`, core), {
        method: request.method, redirect: "error", cache: "no-store", signal: request.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${service}`, "X-Hosty-App-Identity": token }, body,
      });
      return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ code: "core_unavailable", message: "Core could not be reached. Check the request status before trying again." }, { status: 503 });
    }
  };
}
