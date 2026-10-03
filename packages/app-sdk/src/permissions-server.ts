import { ProviderClient, type ProviderServerOptions } from "@hosty-sdk/app/providers/server";
import type { PermissionNoticeState } from "./permission-types.js";

/** Server-only: pass the role from an authenticated session, never from request input. */
export async function readOwnPermissionNotice(hostRole: string | null, options: ProviderServerOptions & { corePublicOrigin?: string | null } = {}, signal?: AbortSignal): Promise<PermissionNoticeState> {
  const state: PermissionNoticeState = {
    hostRole,
    appId: options.appId ?? process.env.HOSTY_APP_ID ?? "",
    corePublicOrigin: options.corePublicOrigin ?? process.env.HOSTY_CORE_PUBLIC_ORIGIN ?? null,
    permissions: null,
  };
  if (hostRole === "host.admin") state.permissions = await new ProviderClient(options).permissions(signal);
  return state;
}
