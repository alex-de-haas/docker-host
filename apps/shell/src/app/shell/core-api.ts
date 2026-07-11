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
  window.location.assign(`${coreOrigin}/login`);
  throw new AuthRequiredRedirectError();
}

export function redirectToCoreLoginIfAuthRequired(response: Response, coreOrigin: string) {
  if (isAuthRequiredResponse(response)) {
    redirectToCoreLogin(coreOrigin);
  }
}

export async function readCoreError(response: Response) {
  try {
    const error = (await response.json()) as CoreError;
    return error.message || error.code || `Core returned ${response.status}.`;
  } catch {
    return `Core returned ${response.status}.`;
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
