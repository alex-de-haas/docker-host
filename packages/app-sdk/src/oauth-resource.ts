// The resource-server half of the MCP authorization handshake (RFC 9728), for an app's MCP
// endpoint: the metadata document naming Core as the authorization server, and the 401 challenge
// header pointing at it.
//
// In its own entry like ./scoped-token, and for the same reason: an MCP endpoint is usually not a
// Next route, and the server slice pulls in "server-only".
//
// The app serves the *pointer*; Core is the authorization server and serves everything else. An app
// never mints, validates, or even sees an OAuth exchange — a client that follows this pointer comes
// back carrying an ordinary scoped access token, which the app validates through introspection
// exactly as if the operator had pasted one by hand.

/** The RFC 9728 document for one MCP endpoint. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

export interface ResourceMetadataOptions {
  /** The app's own MCP endpoint URL as clients reach it. Wins over any derivation. */
  resourceUrl?: string;
  /** The public origin of the endpoint serving MCP. Defaults to `HOSTY_PUBLIC_ORIGIN_API` — the
   * per-endpoint variable Core injects when an endpoint is published, for the reference layout
   * where the MCP interface rides the `api` endpoint. An app with a different layout passes its
   * own endpoint's origin (or the full resourceUrl). */
  publicOrigin?: string;
  /** The MCP endpoint's path under that origin. */
  resourcePath?: string;
  /** The authorization server's browser-reachable origin. Defaults to HOSTY_CORE_PUBLIC_ORIGIN —
   * the flow's whole point is a remote client and a browser completing it, so the loopback origin
   * this app dials Core on would send both to the wrong machine. */
  authorizationServerOrigin?: string;
}

/**
 * Builds the metadata document, or null when the environment cannot name the two URLs it consists
 * of — which is the ordinary state of an app that is not published to a public origin. Null rather
 * than a guess: a wrong resource identity here would have clients requesting tokens for a URL
 * nothing serves, and no metadata simply means the manual token path, which always works.
 */
export function buildProtectedResourceMetadata(options: ResourceMetadataOptions = {}): ProtectedResourceMetadata | null {
  const core = options.authorizationServerOrigin?.trim() || process.env.HOSTY_CORE_PUBLIC_ORIGIN?.trim();
  const publicOrigin = options.publicOrigin?.trim() || process.env.HOSTY_PUBLIC_ORIGIN_API?.trim();
  const path = options.resourcePath?.trim() || "/api/mcp";
  const resource = options.resourceUrl?.trim() || (publicOrigin ? `${publicOrigin.replace(/\/$/, "")}${path}` : undefined);
  if (!core || !resource) {
    return null;
  }

  return {
    resource,
    authorization_servers: [core.replace(/\/$/, "")],
    scopes_supported: ["mcp:read"],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The `WWW-Authenticate` value a 401 from the MCP endpoint should carry, pointing a stock client at
 * the metadata. The metadata URL is the RFC 9728 derivation: the well-known prefix inserted before
 * the resource's path.
 */
export function buildWwwAuthenticate(metadata: ProtectedResourceMetadata): string {
  const resource = new URL(metadata.resource);
  const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname.replace(/\/$/, "")}`;
  return `Bearer resource_metadata="${metadataUrl}"`;
}
