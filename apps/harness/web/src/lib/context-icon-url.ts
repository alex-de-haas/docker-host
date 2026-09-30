import { isLoopbackHost } from "@hosty-sdk/app";

/** Core's local assets must use the browser's loopback alias to retain its host-only session cookie. */
export function contextIconUrl(value: string | undefined, appId: string, pageHostname?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    if (pageHostname && isLoopbackHost(pageHostname) && isLoopbackHost(url.hostname)
      && url.pathname.startsWith(`/api/apps/${encodeURIComponent(appId)}/assets/`)) {
      // Change only the alias, never the scheme, port, asset path or external image destination.
      url.hostname = pageHostname;
    }
    return url.href;
  } catch { return undefined; }
}
