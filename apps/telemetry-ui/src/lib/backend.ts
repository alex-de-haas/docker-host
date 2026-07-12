import { NextResponse } from "next/server";

// Server-side client for the sibling telemetry backend's query API. The backend runs as the `backend`
// service of the same hosty.telemetry app; Core injects its intra-app URL as HOSTY_SERVICE_BACKEND_URL
// (from the ui service's `dependsOn: [backend]`). The query API carries no auth of its own — it is
// reachable only over the app's internal network, and every UI route in front of it is admin-gated.
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
  return fetch(`${base}${path}`, {
    cache: "no-store",
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
