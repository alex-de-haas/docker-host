import { loginContinuation } from "./shell-routes";
import type { CoreAppFeedsResponse, CoreError } from "./types";

export class AuthRequiredRedirectError extends Error {
  constructor() {
    super("Authentication is required.");
    this.name = "AuthRequiredRedirectError";
  }
}

export function isAuthRequiredRedirectError(error: unknown) {
  return error instanceof AuthRequiredRedirectError;
}

export function isAuthRequiredResponse(response: Response) {
  return response.status === 401;
}

export function redirectToCoreLogin(coreOrigin: string): never {
  const continuation = loginContinuation(window.location.pathname, window.location.search);
  window.location.assign(`${coreOrigin}/login${continuation}`);
  throw new AuthRequiredRedirectError();
}

export function redirectToCoreLoginIfAuthRequired(response: Response, coreOrigin: string) {
  if (isAuthRequiredResponse(response)) {
    redirectToCoreLogin(coreOrigin);
  }
}

// A Core error with its machine-readable parts kept. Most callers only ever read `message` — that is why
// this stays an ordinary Error — but a few need to branch on the code and act on the rest of the body:
// an ambiguity that carries its candidates, a hostname conflict that can be adopted.
export class CoreRequestError<TBody = unknown> extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number, readonly body: TBody | null) {
    super(message);
    this.name = "CoreRequestError";
  }
}

export function coreErrorCode(error: unknown) {
  return error instanceof CoreRequestError ? error.code : null;
}

export function coreErrorBody<TBody>(error: unknown) {
  return error instanceof CoreRequestError ? (error.body as TBody | null) : null;
}

export async function readCoreError(response: Response) {
  return (await readCoreErrorDetail(response)).message;
}

export async function readCoreErrorDetail(response: Response) {
  try {
    const body = (await response.json()) as CoreError;
    return {
      message: body.message || body.code || `Core returned ${response.status}.`,
      code: body.code ?? null,
      body: body as unknown,
    };
  } catch {
    return { message: `Core returned ${response.status}.`, code: null, body: null };
  }
}

export async function getAppFeeds(coreOrigin: string, appId: string, signal?: AbortSignal): Promise<CoreAppFeedsResponse> {
  const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/feeds`, {
    credentials: "include",
    signal,
  });
  redirectToCoreLoginIfAuthRequired(response, coreOrigin);
  if (!response.ok) {
    throw new Error(await readCoreError(response));
  }

  return (await response.json()) as CoreAppFeedsResponse;
}
