import { NextResponse } from "next/server";

// Server-side client for the sibling telemetry backend's query API. The backend runs as the `backend`
// service of the same hosty.telemetry app; Core injects its intra-app URL as HOSTY_SERVICE_BACKEND_URL
// (from the ui service's `dependsOn: [backend]`).
//
// The query API is authenticated as of docs/features/telemetry-mcp/plan.md, so every call carries this
// app's own identity token — the one Core mints at start and injects as HOSTY_APP_IDENTITY_TOKEN. The
// backend verifies it with Core's public key, which means neither side needs Core in the request path.
// Being on the app's internal network is no longer the argument for reaching it; the credential is.
const backendTimeoutMs = 8_000;

export class BackendUnavailableError extends Error {
  constructor(message = "The telemetry backend is not reachable.") {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

export function backendBaseUrl(): string | null {
  // HOSTY_SERVICE_BACKEND_URL is the Core-injected sibling URL; HOSTY_TELEMETRY_BACKEND_URL is a manual
  // override for standalone dev (`npm run dev` against a backend on localhost).
  const raw = process.env.HOSTY_SERVICE_BACKEND_URL?.trim() || process.env.HOSTY_TELEMETRY_BACKEND_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : null;
}

export async function backendGet(path: string): Promise<Response> {
  const base = backendBaseUrl();
  if (!base) {
    throw new BackendUnavailableError("HOSTY_SERVICE_BACKEND_URL is not configured.");
  }

  const identity = process.env.HOSTY_APP_IDENTITY_TOKEN?.trim();
  if (!identity) {
    // Named as its own failure rather than left to surface as a 401 from the backend. A missing token
    // means Core did not inject one — an old Core, or the app started outside it — and "restart it
    // through Core" is a different instruction from anything an authorization error would suggest.
    throw new BackendUnavailableError(
      "This telemetry UI has no identity token from Hosty Core, so the backend will not answer it. "
        + "Restart the app through Core.",
    );
  }

  return fetch(`${base}${path}`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${identity}` },
    signal: AbortSignal.timeout(backendTimeoutMs),
  });
}

// Uniform 503 for a backend that is down/unreachable so the client shows a real error instead of a
// blank view.
export function backendErrorResponse(error: unknown): NextResponse {
  const message =
    error instanceof BackendUnavailableError
      ? error.message
      : error instanceof Error
        ? error.message
        : "The telemetry backend request failed.";
  return NextResponse.json(
    { code: "telemetry_backend_unavailable", message },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

// Forwards a non-OK backend response (rare — the query API answers 200 even for unknown apps) with its
// status and body so the client surfaces the real error.
export async function backendPassthroughError(response: Response): Promise<NextResponse> {
  const text = await response.text().catch(() => "");
  return new NextResponse(text || JSON.stringify({ message: `Telemetry backend returned ${response.status}.` }), {
    status: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
