import { NextResponse } from "next/server";
import { buildProtectedResourceMetadata } from "@hosty-sdk/app/oauth-resource";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// RFC 9728: the metadata for this app's MCP endpoint, at the well-known path derived from the
// resource's own path. This is the whole of the app's role in the OAuth flow — a pointer at Core,
// which is the authorization server. 404 when the app is not published to a public origin: no
// metadata means the manual token path, which always works, rather than a guessed identity that
// would have clients requesting tokens for a URL nothing serves.
export function GET() {
  const metadata = buildProtectedResourceMetadata();
  if (!metadata) {
    return NextResponse.json(
      { error: "This app is not published to a public origin, so it has no OAuth resource identity." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(metadata, { headers: { "Cache-Control": "no-store" } });
}
