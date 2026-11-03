// Named localhost origins have separate host-only Core and app cookies.
const isBareLoopback = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());

/** Preserve Core's canonical origin; only legacy bare loopback aliases share the page host. */
export function contextIconUrl(value: string | undefined, appId: string, pageHostname?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    if (pageHostname && isBareLoopback(pageHostname) && isBareLoopback(url.hostname)
      && url.pathname.startsWith(`/api/apps/${encodeURIComponent(appId)}/assets/`)) {
      // Change only the alias, never the scheme, port, asset path or external image destination.
      url.hostname = pageHostname;
    }
    return url.href;
  } catch { return undefined; }
}
