export const AUTH_REQUIRED_INTENT_TYPE = "hosty:auth-required";

// An embedded app whose Hosty session has expired cannot navigate the top window (the iframe
// sandbox forbids it), so it asks Shell to mint a fresh launch code by posting this message. Unlike
// the install intent, every embedded app may send it — recovery is universal — so the trust gate is
// the sender check (event.source === the active frame, event.origin === the frame origin) plus a
// match against the app currently mounted in the workspace. No credential crosses the iframe: the
// payload is only the app id, and Shell answers by reissuing a code through its own CSRF-guarded
// Core call.
export type AuthRequiredMessage = {
  data: unknown;
  origin: string;
  source: unknown;
};

export function parseActiveFrameAuthRequired(
  event: AuthRequiredMessage,
  activeFrameWindow: unknown,
  activeFrameUrl: string,
  expectedAppId: string,
): boolean {
  if (!activeFrameWindow || event.source !== activeFrameWindow) {
    return false;
  }

  try {
    if (event.origin !== new URL(activeFrameUrl).origin) {
      return false;
    }
  } catch {
    return false;
  }

  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    return false;
  }

  const candidate = event.data as { type?: unknown; appId?: unknown };
  return candidate.type === AUTH_REQUIRED_INTENT_TYPE &&
    typeof candidate.appId === "string" &&
    candidate.appId === expectedAppId;
}
