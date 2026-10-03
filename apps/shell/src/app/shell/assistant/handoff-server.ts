import "server-only";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";
import { AssistantError } from "@hosty-sdk/app/assistant";
import { requireAppMutation } from "../app-auth-server";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function createAssistantHandoff(request: Request): Promise<Response> {
  const actor = requireAppMutation(request);
  if (actor instanceof Response) return actor;
  try {
    const body = await request.json();
    if (!body || typeof body.providerAppId !== "string" || body.providerAppId.length > 256 ||
        typeof body.key !== "string" || body.key.length > 100 || typeof body.requestId !== "string" || body.requestId.length > 100 ||
        typeof body.prompt !== "string" || body.prompt.length > 100000 || !Array.isArray(body.appIds) ||
        body.appIds.length > 100 || !body.appIds.every((id: unknown) => typeof id === "string" && id.length <= 256))
      return Response.json({ message: "Invalid assistant request." }, { status: 400, headers });
    // Core selects the provider endpoint and validates this app's optional permission and the
    // user's access. A browser-supplied URL or credential never reaches the provider.
    const client = await new ProviderClient().assistant({ appId: body.providerAppId, key: body.key }, async () => actor.token);
    const prepared = await client.prepare({ requestId: body.requestId, prompt: body.prompt, appIds: body.appIds });
    const finalized = await client.finalize(prepared.handoffId, []);
    if (!finalized.result) throw new Error("The assistant did not return a finalized handoff.");
    return Response.json({ id: finalized.conversationId, result: finalized.result }, { headers });
  } catch (cause) {
    const serviceError = cause instanceof ProviderError || cause instanceof AssistantError;
    return Response.json({ code: serviceError ? cause.code : "assistant_failed",
      message: cause instanceof Error ? cause.message : "The assistant could not be reached." },
      { status: serviceError ? cause.status : cause instanceof SyntaxError ? 400 : 502, headers });
  }
}
