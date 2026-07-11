import { NextResponse } from "next/server";
import { getMarketplaceIdentity, type HeaderReader, type MarketplaceIdentity } from "@/lib/host-auth";

export type MarketplaceAuthorization =
  | { ok: true; identity: MarketplaceIdentity }
  | { ok: false; status: number; code: string; message: string };

export async function authorizeMarketplaceRequest(headers: HeaderReader): Promise<MarketplaceAuthorization> {
  const identity = await getMarketplaceIdentity(headers);
  if (identity.status === "active" && identity.hostRole === "host.admin") {
    return { ok: true, identity };
  }

  if (identity.status === "not-present") {
    return {
      ok: false,
      status: 401,
      code: "app_identity_required",
      message: "Open Marketplace through Hosty Shell to establish an administrator session.",
    };
  }

  if (identity.status === "unavailable" || identity.status === "error") {
    return {
      ok: false,
      status: 503,
      code: identity.error?.code ?? "app_identity_unavailable",
      message: identity.error?.message ?? "Marketplace could not revalidate the Hosty session.",
    };
  }

  return {
    ok: false,
    status: 403,
    code: identity.hostRole && identity.hostRole !== "host.admin"
      ? "system_app_admin_required"
      : identity.error?.code ?? "app_identity_forbidden",
    message: identity.hostRole && identity.hostRole !== "host.admin"
      ? "Marketplace is available only to Host administrators."
      : identity.error?.message ?? "The Marketplace app session is not active.",
  };
}

export function marketplaceAuthorizationError(
  decision: Exclude<MarketplaceAuthorization, { ok: true }>,
): NextResponse {
  return NextResponse.json({ code: decision.code, message: decision.message }, {
    status: decision.status,
    headers: { "Cache-Control": "no-store" },
  });
}
