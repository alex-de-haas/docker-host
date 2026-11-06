import type { ProviderServerOptions } from "@hosty-sdk/app/providers/server";
import { DecisionClient, DecisionError } from "@hosty-sdk/app/decisions";

/** App-server transport. Resolve a fresh user identity for each request; never persist it with a wait. */
export class DecisionServerClient extends DecisionClient {
  constructor(userToken: () => string | Promise<string>, options: ProviderServerOptions = {}) {
    const appId = options.appId ?? process.env.HOSTY_APP_ID ?? "";
    const origin = new URL(options.coreOrigin ?? process.env.HOSTY_CORE_ORIGIN ?? "http://127.0.0.1:7070");
    const service = options.serviceToken ?? process.env.HOSTY_APP_SERVICE_TOKEN ?? "";
    if (!appId || !service) throw new DecisionError("hosty_misconfigured", "Hosty application credentials are unavailable.", 503);
    super(async (route, method, body, signal) => {
      const token = await userToken();
      if (!token) throw new DecisionError("identity_required", "Sign in to use Decisions.", 401);
      return fetch(new URL("/api/internal/apps/" + encodeURIComponent(appId) + "/decisions/v1" + route, origin), {
        method, redirect: "error", cache: "no-store", signal: route === "/events" ? signal : signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { authorization: "Bearer " + service, "X-Hosty-User-Token": token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    });
  }
}
