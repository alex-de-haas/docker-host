import type { ApiError } from "@/lib/types";

// The identity cookie expired, or the app was opened outside Shell. Unlike the Shell pages (which
// redirect the top window to Core's /login), an embedded system-app iframe must never navigate the
// frame away — surface a 401 as a throwable the caller swallows. AppIdentityBridge re-runs the SSO
// handshake on the next full (re)load, restoring the session.
export class AuthRequiredError extends Error {
  constructor() {
    super("Administrator session required. Reopen Telemetry from Hosty Shell.");
    this.name = "AuthRequiredError";
  }
}

export function isAuthRequiredError(error: unknown): boolean {
  return error instanceof AuthRequiredError;
}

export function throwIfAuthRequired(response: Response): void {
  if (response.status === 401) {
    throw new AuthRequiredError();
  }
}

export async function readApiError(response: Response): Promise<string> {
  try {
    const error = (await response.json()) as ApiError;
    return error.message || error.code || `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}
