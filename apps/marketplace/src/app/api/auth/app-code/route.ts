import { createAppCodeRouteHandler } from "@hosty-sdk/app/server";
import { appIdentityCookieName } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Exchanges the one-time Shell/Core launch code for the app identity cookie. The cookie
// name and app id stay this app's own — parameterized in the SDK, never unified.
export const POST = createAppCodeRouteHandler({
  appIdFallback: "hosty.marketplace",
  identityCookieName: appIdentityCookieName,
});
