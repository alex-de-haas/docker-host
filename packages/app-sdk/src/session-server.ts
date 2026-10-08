import { ProviderClient, type ProviderServerOptions } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";
import type { AppSessionStatus, SessionRecoveryParams } from "./session-types.js";
import type { PermissionNoticeState } from "./permission-types.js";

/** Framework-neutral server adapter. Call with an already authenticated app session, never request data. */
export type HostySessionInput = {
  status: AppSessionStatus;
  identity?: { userId: string; hostRole: string | null; activeUntil?: string | null; activityRequired?: boolean };
  error?: { code: string; message: string; status: number | null };
};

export async function createHostySessionResponse(session: HostySessionInput, recovery: SessionRecoveryParams,
  options: ProviderServerOptions & { administratorOnly?: boolean; signal?: AbortSignal } = {}): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (session.status !== "active" || !session.identity)
    return Response.json({ status: session.status, error: session.error, recovery }, { headers });
  const identity = session.identity;
  if (options.administratorOnly && identity.hostRole !== "host.admin")
    return Response.json({ status: "forbidden", recovery }, { headers });
  let setup: "ready" | "missing" | "unsupported" | "unavailable" | "incompatible" = "unavailable";
  let notice: PermissionNoticeState | undefined;
  try {
    const permissions = await new ProviderClient({ ...options, appId: recovery.appId ?? undefined }).permissions(options.signal);
    if (![permissions.required, permissions.optional, permissions.granted, permissions.unsupportedRequired ?? []].every(list => Array.isArray(list) && list.every(name => typeof name === "string")))
      throw new Error("Invalid permission state.");
    setup = permissions.unsupportedRequired?.length ? "unsupported"
      : permissions.required.some(name => !permissions.granted.includes(name)) ? "missing" : "ready";
    if (identity.hostRole === "host.admin") notice = { hostRole: identity.hostRole, appId: recovery.appId ?? "",
      corePublicOrigin: recovery.corePublicOrigin, permissions };
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) setup = "incompatible";
  }
  return Response.json({ status: "active", ...identity, recovery, hosty: { version: 1, setup, notice } }, { headers });
}
