import type { IncomingMessage, ServerResponse } from "node:http";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";
import { CHAT_SPEECH_TIMEOUT_MS, chatSpeechLimits, speechDuration } from "../shared/speech.js";

/** Called only after the Harness administrator and same-origin checks. */
export async function speechRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/speech/")) return false;
  const client = new ProviderClient();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once("close", cancel);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CHAT_SPEECH_TIMEOUT_MS)]);
  try {
    if (request.method === "GET" && url.pathname === "/api/speech/providers") {
      const permissions = await client.permissions(signal);
      const granted = permissions.granted.includes("providers.speech-to-text");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ granted, reviewAvailable: permissions.reviewAvailable, requestable: permissions.optional.includes("providers.speech-to-text"), providers: granted ? await client.list("speech-to-text", signal) : [] }));
      return true;
    }
    const capabilitiesRequest = request.method === "GET" && url.pathname === "/api/speech/capabilities";
    if (!capabilitiesRequest && (request.method !== "POST" || url.pathname !== "/api/speech/transcriptions")) return false;
    const appId = url.searchParams.get("appId"), key = url.searchParams.get("key");
    if (!appId || !key) throw new ProviderError("provider_required", "Choose a speech provider.", 400);
    // Reject before buffering audio when the caller has no grant.
    const roster = await client.list("speech-to-text", signal);
    if (!roster.some(p => p.appId === appId && p.key === key && p.available))
      throw new ProviderError("provider_unavailable", "The selected speech provider is unavailable.", 503);
    const capabilities = await client.speechCapabilities({ appId, key }, signal);
    let limits;
    try { limits = chatSpeechLimits(capabilities); }
    catch (error) { throw new ProviderError("speech_limits_unavailable", error instanceof Error ? error.message : "Recording limits are unavailable.", 503); }
    if (capabilitiesRequest) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(capabilities));
      return true;
    }
    if (request.headers["content-type"]?.split(";")[0] !== "audio/wav") throw new ProviderError("speech_format_unsupported", "Use a WAV recording.", 415);
    const tooLarge = () => new ProviderError("speech_audio_too_large", `Recordings may be up to ${speechDuration(limits.maxDurationSeconds)} for this provider.`, 413);
    if (Number(request.headers["content-length"]) > limits.maxBytes) throw tooLarge();
    const buffers: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      signal.throwIfAborted();
      length += chunk.length;
      if (length > limits.maxBytes) throw tooLarge();
      buffers.push(Buffer.from(chunk));
    }
    const result = await client.transcribe({ appId, key }, new Blob([Buffer.concat(buffers)], { type: "audio/wav" }), { signal, timeoutMs: CHAT_SPEECH_TIMEOUT_MS });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
    return true;
  } finally { response.off("close", cancel); }
}
