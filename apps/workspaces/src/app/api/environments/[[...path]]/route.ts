import { getCoreOrigin } from "@hosty-sdk/app/server";
import { requireAdministrator, errorResponse, WorkspacesError } from "@/lib/auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  try {
    const parts = (await context.params).path ?? [];
    const read = request.method === "GET";
    const path = parts.join("/");
    if (!(read ? /^(?:[a-f0-9]{32}(?:\/apps)?)?$/.test(path) : /^(?:from-workspace|consents\/[a-f0-9]{32}\/revoke|[a-f0-9]{32}\/(?:setup|consent\/revoke|operations\/(?:start|stop|restart|finish)))$/.test(path)))
      throw new WorkspacesError("Unknown sandbox operation.", 404, "not_found");
    if (!read) {
      const origin = request.headers.get("origin"); const url = new URL(request.url);
      let same = false;
      try { const parsed = new URL(origin ?? ""); same = parsed.origin === origin && ["http:", "https:"].includes(parsed.protocol)
        && parsed.host.toLowerCase() === (request.headers.get("host") ?? url.host).toLowerCase()
        && (parsed.protocol === url.protocol || request.headers.get("sec-fetch-site") === "same-origin"); } catch { /* Missing/invalid origin. */ }
      if (!same || !request.headers.get("content-type")?.startsWith("application/json")) throw new WorkspacesError("Use this Workspaces page to manage sandboxes.", 403, "origin_denied");
    }
    const token = await requireAdministrator(request.headers);
    const origin = getCoreOrigin(); const service = process.env.HOSTY_APP_SERVICE_TOKEN;
    if (!origin || !service) throw new WorkspacesError("Start Workspaces through Core.");
    const body = read ? undefined : await request.text();
    if (body && body.length > 16_384) throw new WorkspacesError("Sandbox request is too large.", 413, "request_too_large");
    const response = await fetch(new URL(`/api/core-environments${path ? "/" + path : ""}`, origin), { method: request.method, body,
      headers: { Authorization: `Bearer ${service}`, "X-Hosty-App-Identity": token, "Content-Type": "application/json" },
      cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(read ? 15_000 : 490_000)]) });
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export { handle as GET, handle as POST };
