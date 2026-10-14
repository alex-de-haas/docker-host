import { getAppId, getCoreOrigin } from "@hosty-sdk/app/server";
import { config, requireAdministrator, errorResponse, WorkspacesError } from "@/lib/auth";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const token = await requireAdministrator(request.headers);
    const origin = getCoreOrigin(); const service = process.env.HOSTY_APP_SERVICE_TOKEN;
    if (!origin || !service || !getAppId(config)) throw new WorkspacesError("Core is unavailable.");
    const response = await fetch(new URL("/api/sandbox-instances", origin), { cache: "no-store", redirect: "error", signal: request.signal,
      headers: { Authorization: `Bearer ${service}`, "X-Hosty-App-Identity": token } });
    const data = await response.json();
    if (!response.ok) throw new WorkspacesError(data.message ?? "Sandbox inspection is unavailable.", response.status, data.code);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
