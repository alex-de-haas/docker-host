/** Only workspace-manifest confirmation is exposed here; installation/account management stays in Core. */
export function isWorkspaceAccessReviewRoute(method: string, path: string): boolean {
  return method === "POST" && (path === "/api/workspace-access-reviews" || /^\/api\/workspace-access-reviews\/[a-f0-9]{48}\/submit$/.test(path))
    || method === "GET" && /^\/api\/workspace-access-reviews\/[a-f0-9]{48}$/.test(path);
}
export async function requestWorkspaceAccessReview(method: string, path: string, credential: string | null, body?: unknown): Promise<{ status: number; body: unknown }> {
  if (!isWorkspaceAccessReviewRoute(method, path)) return { status: 404, body: { code: "not_found", message: "Unknown workspace access operation." } };
  if (!credential) return { status: 401, body: { code: "app_session_required", message: "Sign in through Core." } };
  if (method === "POST" && path === "/api/workspace-access-reviews" &&
      (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "workspaceManifest") ||
       !("workspaceManifest" in body) || !body.workspaceManifest || typeof body.workspaceManifest !== "object" || Array.isArray(body.workspaceManifest)))
    return { status: 400, body: { code: "workspace_review_required", message: "Supply only the concrete workspace access review returned by Core." } };
  const origin = process.env.HOSTY_CORE_ORIGIN?.trim(), service = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  if (!origin || !service) return { status: 503, body: { code: "core_unavailable", message: "Core connection is not configured." } };
  const suffix = path.slice("/api/workspace-access-reviews".length);
  const appId = process.env.HOSTY_APP_ID?.trim() || "hosty.harness";
  try {
    const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(appId)}/installations${suffix}`, origin), {
      method, redirect: "error", signal: AbortSignal.timeout(30_000), cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${service}`, "X-Hosty-App-Identity": credential },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: 503, body: { code: "core_unavailable", message: "Core could not complete the review request. Read its status before retrying." } };
  }
}
