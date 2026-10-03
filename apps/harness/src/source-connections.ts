// This is a fixed set of source-provider and reviewed installation operations, not a general Core proxy. Core owns the
// credentials, checks apps.sources and resolves the current owner from Harness's live app grant.
export function isSourceConnectionRoute(method: string, path: string): boolean {
  if (path === "/api/installations") return method === "POST";
  if (/^\/api\/installations\/[a-f0-9]+(?:\/submit)?$/.test(path)) return path.endsWith("/submit") ? method === "POST" : method === "GET";
  if (/^\/api\/apps\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/source-access$/.test(path)) return method === "GET";
  if (path === "/api/source-connections") return method === "GET";
  if (path === "/api/source-connections/identity") return method === "PUT";
  if (path === "/api/source-connections/pat" || path === "/api/source-connections/device") return method === "POST";
  if (/^\/api\/source-connections\/device\/[a-zA-Z0-9_-]+\/poll$/.test(path)) return method === "POST";
  if (/^\/api\/source-connections\/device\/[a-zA-Z0-9_-]+$/.test(path)) return method === "DELETE";
  if (/^\/api\/source-connections\/[a-zA-Z0-9_-]+\/check$/.test(path)) return method === "POST";
  return /^\/api\/source-connections\/[a-zA-Z0-9_-]+$/.test(path) && (method === "PUT" || method === "DELETE");
}

export async function requestSourceConnection(method: string, path: string, credential: string | null, body?: unknown): Promise<{ status: number; body: unknown }> {
  if (!isSourceConnectionRoute(method, path)) return { status: 404, body: { code: "not_found", message: "Unknown source operation." } };
  if (!credential) return { status: 401, body: { code: "app_session_required", message: "Sign in through Core." } };
  const origin = process.env.HOSTY_CORE_ORIGIN?.trim();
  const service = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  if (!origin || !service) return { status: 503, body: { code: "core_unavailable", message: "Core connection is not configured." } };
  try {
    const response = await fetch(new URL(path, origin), {
      method, redirect: "error", signal: AbortSignal.timeout(30_000), cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${service}`, "X-Hosty-App-Identity": credential },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: 503, body: { code: "core_unavailable", message: "Core could not complete the source-provider request. Try again." } };
  }
}
