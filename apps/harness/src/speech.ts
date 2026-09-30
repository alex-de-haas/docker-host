import type { IncomingMessage, ServerResponse } from "node:http";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";

const MAX_BYTES = 120 * 16000 * 2 + 4096;
/** Called only after the Harness administrator and same-origin checks. */
export async function speechRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/speech/")) return false;
  const client = new ProviderClient();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once("close", cancel);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
  try {
    if (request.method === "GET" && url.pathname === "/api/speech/providers") {
      const permissions = await client.permissions(signal);
      const granted = permissions.granted.includes("providers.speech-to-text");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ granted, reviewAvailable: permissions.reviewAvailable, requestable: permissions.optional.includes("providers.speech-to-text"), providers: granted ? await client.list("speech-to-text", signal) : [] }));
      return true;
    }
    if (request.method !== "POST" || url.pathname !== "/api/speech/transcriptions") return false;
    const appId = url.searchParams.get("appId"), key = url.searchParams.get("key");
    if (!appId || !key) throw new ProviderError("provider_required", "Choose a speech provider.", 400);
    // Reject before buffering audio when the caller has no grant.
    const roster = await client.list("speech-to-text", signal);
    if (!roster.some(p => p.appId === appId && p.key === key && p.available))
      throw new ProviderError("provider_unavailable", "The selected speech provider is unavailable.", 503);
    if (request.headers["content-type"]?.split(";")[0] !== "audio/wav") throw new ProviderError("speech_format_unsupported", "Use a WAV recording.", 415);
    if (Number(request.headers["content-length"]) > MAX_BYTES) throw new ProviderError("speech_audio_too_large", "Recordings may be up to 120 seconds.", 413);
    const buffers: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      signal.throwIfAborted();
      length += chunk.length;
      if (length > MAX_BYTES) throw new ProviderError("speech_audio_too_large", "Recordings may be up to 120 seconds.", 413);
      buffers.push(Buffer.from(chunk));
    }
    const result = await client.transcribe({ appId, key }, new Blob([Buffer.concat(buffers)], { type: "audio/wav" }), { signal });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
    return true;
  } finally { response.off("close", cancel); }
}
