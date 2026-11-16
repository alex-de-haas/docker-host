/** Own-app return target is explicit for both initial sign-in and activity renewal. */
export function providerSignInUrl(recovery, appOrigin) {
  const url = new URL(`/api/apps/${encodeURIComponent(recovery.appId)}/open`, recovery.corePublicOrigin);
  url.searchParams.set('redirectUri', new URL('/settings', appOrigin).href);
  return url.href;
}
