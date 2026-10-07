// Read-only consumer selection. Account management and installation review belong to Shell.
export function isSourceConnectionRoute(method: string, path: string): boolean {
  return method === "GET" && (path === "/api/source-connections" || /^\/api\/apps\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/source-access$/.test(path));
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
