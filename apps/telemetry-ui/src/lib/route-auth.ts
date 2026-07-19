import { NextResponse } from "next/server";
import { getTelemetryIdentity, type HeaderReader, type TelemetryIdentity } from "@/lib/host-auth";

export type TelemetryAuthorization =
  | { ok: true; identity: TelemetryIdentity }
  | { ok: false; status: number; code: string; message: string };

export async function authorizeTelemetryRequest(headers: HeaderReader): Promise<TelemetryAuthorization> {
  const identity = await getTelemetryIdentity(headers);
  if (identity.status === "active" && identity.hostRole === "host.admin") {
    return { ok: true, identity };
  }

  if (identity.status === "not-present") {
    return {
      ok: false,
      status: 401,
      code: "app_identity_required",
      message: "Open Telemetry through Hosty Shell to establish an administrator session.",
    };
  }

  if (identity.status === "unavailable" || identity.status === "misconfigured") {
    return {
      ok: false,
      status: 503,
      code: identity.error?.code ?? "app_identity_unavailable",
      message: identity.error?.message ?? "Telemetry could not revalidate the Hosty session.",
    };
  }

  return {
    ok: false,
    status: 403,
    code: identity.hostRole && identity.hostRole !== "host.admin"
      ? "system_app_admin_required"
      : identity.error?.code ?? "app_identity_forbidden",
    message: identity.hostRole && identity.hostRole !== "host.admin"
      ? "Telemetry is available only to Host administrators."
      : identity.error?.message ?? "The Telemetry app session is not active.",
  };
}

export function telemetryAuthorizationError(
  decision: Exclude<TelemetryAuthorization, { ok: true }>,
): NextResponse {
  return NextResponse.json({ code: decision.code, message: decision.message }, {
    status: decision.status,
    headers: { "Cache-Control": "no-store" },
  });
}
