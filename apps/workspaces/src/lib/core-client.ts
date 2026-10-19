import { getAppId, getCoreOrigin } from "@hosty-sdk/app/server";
import { config, WorkspacesError } from "./auth";

export async function coreRead(path: string, credential: string, signal: AbortSignal, query = new URLSearchParams()) {
  const origin = getCoreOrigin();
  const service = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  if (!origin || !service) throw new WorkspacesError("Start Workspaces through Hosty to inspect source.", 503, "core_unconfigured");
  const url = new URL(`/api/internal/apps/${encodeURIComponent(getAppId(config))}/workspace-inspection${path}`, origin);
  url.search = query.toString();
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${service}`, "X-Hosty-User-Token": credential },
      cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  } catch { throw new WorkspacesError("Core could not complete this read. Refresh to try again."); }
  const value = await response.json();
  if (!response.ok) throw new WorkspacesError(value.message ?? "Core refused workspace access.", response.status, value.code);
  return value;
}

export async function coreEvents(credential: string, signal: AbortSignal): Promise<Response> {
  const origin = getCoreOrigin(), service = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  if (!origin || !service) throw new WorkspacesError("Start Workspaces through Hosty to inspect source.", 503, "core_unconfigured");
  const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(getAppId(config))}/workspace-inspection/events`, origin), {
    headers: { Authorization: `Bearer ${service}`, "X-Hosty-User-Token": credential, Accept: "text/event-stream" },
    cache: "no-store", redirect: "error", signal });
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
    throw new WorkspacesError("Core could not open workspace updates.", response.ok ? 502 : response.status, "workspace_stream_unavailable");
  return new Response(response.body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
