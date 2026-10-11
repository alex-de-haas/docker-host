import { LAUNCH_MODE_PARAM } from "@hosty-sdk/app";

/** Legacy launch/auth hint for older apps. HostyAppFrame also supplies explicit navigation and
 * tool policy; current SDK clients do not infer their chrome policy from being in a frame.
 * Separate-opening links omit all launch and composition hints.
 */
export function appendHostyLaunchParam(redirectUri: string) {
  const url = new URL(redirectUri);
  url.searchParams.set(LAUNCH_MODE_PARAM, "embedded");
  return url.toString();
}
