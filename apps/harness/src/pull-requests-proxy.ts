import { AppContextError } from "./sessions/app-context.js";

const resource = /^\/api\/pull-requests\/[a-f0-9]{64}\/[1-9][0-9]{0,9}(?:\/(?:checks|review|diff|actions))?$/;
export function pullRequestsRoute(method: string, path: string): boolean {
  return method === "GET" && (path === "/api/pull-requests" || path === "/api/pull-requests/repositories" || resource.test(path)) ||
    method === "POST" && (["/api/pull-requests/refresh", "/api/pull-requests/subscriptions"].includes(path) || (resource.test(path) && path.endsWith("/actions") || path.endsWith("/actions/recover") && resource.test(path.slice(0, -8))));
}
function connection(credential: string) {
  const origin = process.env.HOSTY_CORE_ORIGIN?.trim(), token = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  if (!origin || !token) throw new AppContextError(503, "core_unavailable", "Pull requests require a Core connection.");
  return { origin, headers: { authorization: `Bearer ${token}`, "X-Hosty-App-Identity": credential } };
}
export async function requestPullRequests(method: string, path: string, credential: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const parsed = new URL(path, "http://harness.invalid");
  if (path.length > 4096 || !path.startsWith("/api/pull-requests") || parsed.origin !== "http://harness.invalid" || !pullRequestsRoute(method, parsed.pathname))
    throw new AppContextError(400, "pr_route_invalid", "Choose a supported PR operation.");
  const allowed = new Set(["repository", "app", "author", "bot", "draft", "ci", "review", "search", "limit", "cursor", "head", "base"]);
  if ([...parsed.searchParams.keys()].some(k => !allowed.has(k) || parsed.searchParams.getAll(k).length !== 1))
    throw new AppContextError(400, "pr_query_invalid", "Unsupported PR filter.");
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && Buffer.byteLength(encoded) > 32768) throw new AppContextError(413, "pr_request_limit", "PR request exceeds 32 KiB.");
  const core = connection(credential);
  const response = await fetch(new URL(path, core.origin), { method, redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(90_000), headers: { ...core.headers, "content-type": "application/json" }, body: encoded });
  return { status: response.status, body: await response.json() };
}
export async function pullRequestEvents(credential: string, subscriptionId: string, signal: AbortSignal): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(subscriptionId)) throw new AppContextError(400, "pr_subscription_invalid", "Invalid PR subscription.");
  const core = connection(credential);
  const response = await fetch(new URL(`/api/pull-requests/events?subscriptionId=${subscriptionId}`, core.origin), {
    redirect: "error", signal, cache: "no-store", headers: { ...core.headers, accept: "text/event-stream" },
  });
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppContextError(response.ok ? 502 : response.status, "pr_stream_unavailable", "Core could not open PR updates.");
  }
  return response;
}
