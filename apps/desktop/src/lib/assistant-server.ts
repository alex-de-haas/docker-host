import "server-only";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";
import { AssistantError, resolveAssistantPresentation } from "@hosty-sdk/app/assistant";
import { UiServerClient } from "@hosty-sdk/app/ui/server";
import { UiError } from "@hosty-sdk/app/ui";
import { proxyCore, requireDesktopMutation } from "./core-proxy";
import { visibleApps, type App, type User } from "./model";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function createWindowDiscussion(request: Request): Promise<Response> {
  const actor = requireDesktopMutation(request);
  if (actor instanceof Response) return actor;
  try {
    const input = await request.json();
    const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256;
    if (!input || ![input.providerAppId, input.installationId, input.key, input.contextAppId, input.contextInstallationId].every(validId)
      || typeof input.requestId !== "string" || !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.requestId))
      return Response.json({ message: "Invalid window discussion." }, { status: 400, headers });
    const get = new Request(request.url, { headers: request.headers });
    const [session, apps] = await Promise.all([
      proxyCore(get, ["api", "auth", "session"]), proxyCore(get, ["api", "apps"]),
    ]);
    if (!session.ok) return session;
    if (!apps.ok) return apps;
    const { user } = await session.json() as { user?: User };
    const { apps: catalog } = await apps.json() as { apps: App[] };
    if (!user || !visibleApps(catalog, user, process.env.HOSTY_APP_ID || "hosty.desktop").some(app => app.id === input.contextAppId && app.installationId === input.contextInstallationId))
      return Response.json({ message: "This application is no longer available to your desktop." }, { status: 403, headers });
    const providers = new ProviderClient();
    const expectedProvider = { appId: input.providerAppId, installationId: input.installationId, key: input.key };
    const bootstrap = await new UiServerClient().bootstrap({}, actor.token);
    if (!bootstrap.pinnedOpen) throw new UiError("unsupported_core", "Update Core to open assistant panels.");
    // Endpoint discovery and delegation stay server-side; Core authorizes both consumer and actor.
    const client = await providers.assistant(expectedProvider, async () => actor.token);
    const prepared = await client.prepare({ requestId: input.requestId, prompt: "", appIds: [input.contextAppId] });
    const finalized = await client.finalize(prepared.handoffId, []);
    if (!finalized.result) throw new Error("The assistant did not return a discussion.");
    const provider = (await providers.list("assistant")).find(item => item.appId === input.providerAppId && item.key === input.key);
    if (!provider) throw new ProviderError("provider_changed", "The selected assistant was removed.", 409);
    const presentation = resolveAssistantPresentation(provider, finalized.result, { expectedProvider });
    if (!presentation.target) throw new UiError("panel_required", "This assistant does not declare an embeddable panel.");
    return Response.json({ target: presentation.target }, { headers });
  } catch (cause) {
    const known = cause instanceof ProviderError || cause instanceof AssistantError || cause instanceof UiError;
    return Response.json({ code: known ? cause.code : "assistant_failed", message: cause instanceof Error ? cause.message : "Could not open the assistant." },
      { status: known ? cause.status : cause instanceof SyntaxError ? 400 : 502, headers });
  }
}
