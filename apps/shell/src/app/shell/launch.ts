import { LAUNCH_MODE_PARAM } from "@hosty-sdk/app";

/**
 * Declares to an app that the Shell is presenting it, so it can drop the chrome the Shell already
 * renders: its own name, and the navigation between its manifest pages that the sidebar carries.
 *
 * Only the workspace URL carries this. The standalone href behind "open in a new tab" deliberately
 * does not — that link exists to leave the Shell, and an app on its own origin has nothing else
 * drawing its navigation.
 *
 * The frame heuristic in `@hosty-sdk/app` would reach the same verdict for an iframe on its own.
 * Sending it explicitly keeps one code path with the native client, where the heuristic cannot
 * work at all, and an app that ignores the parameter still behaves exactly as it did before.
 */
export function appendHostyLaunchParam(redirectUri: string) {
  const url = new URL(redirectUri);
  url.searchParams.set(LAUNCH_MODE_PARAM, "embedded");
  return url.toString();
}
