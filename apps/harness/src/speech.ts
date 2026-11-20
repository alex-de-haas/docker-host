import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type AppPermissionState, type ProviderDescriptor } from "@hosty-sdk/app/providers";
import { CHAT_SPEECH_TIMEOUT_MS, chatSpeechLimits, speechDuration } from "../shared/speech.js";
import { currentSpeechOption, sameSpeechChoice, speechKinds, type SpeechChoice, type SpeechKind, type SpeechRoster } from "../shared/speech-selection.js";
import { accountScope, SpeechPreferences, type StoredSpeech } from "./speech-preferences.js";

type Context = {
  userId: string; preferences: SpeechPreferences; readJson: () => Promise<Record<string, unknown>>;
  ownsSession: (id: string) => Promise<boolean>;
};
const unavailable = () => new ProviderError("provider_unavailable", "Your speech selection is unavailable. Open Harness Settings → Speech.", 409);

function publicChoice(p: ProviderDescriptor): SpeechChoice {
  return { appId: p.appId, installationId: p.installationId!, key: p.key, implementationId: p.implementationId ?? null, displayName: p.displayName };
}

async function directory(client: ProviderClient, kind: SpeechKind, userId: string, saved: StoredSpeech,
  permissions: AppPermissionState, signal: AbortSignal): Promise<SpeechRoster> {
  const permission = "providers." + kind;
  const granted = permissions.granted.includes(permission);
  const list = granted ? await client.listImplementations(kind, signal) : [];
  const providers = list.filter(p => p.version === 1 && p.installationId).map(p => ({ ...publicChoice(p), available: p.available }));
  // Only an untouched dictation preference may inherit the original sole static provider.
  const stored = saved.choices[kind];
  const selected = stored ? providers.find(p => sameSpeechChoice(p, stored)) ?? stored
    : stored === undefined && kind === "speech-to-text" && providers.length === 1 && !providers[0]!.implementationId ? providers[0]! : null;
  const binding = selected ? createHash("sha256").update(JSON.stringify([userId, kind, selected.appId,
    selected.installationId, selected.key, selected.implementationId ?? null])).digest("hex") : null;
  return { granted, reviewAvailable: permissions.reviewAvailable, requestable: permissions.optional.includes(permission),
    providers, selected, binding };
}

function json(response: ServerResponse, value: unknown) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

/** The operator route authenticates the account and checks same-origin writes before entering. */
export async function speechRoute(request: IncomingMessage, response: ServerResponse, url: URL, context: Context): Promise<boolean> {
  const legacyFeedback = url.pathname === "/api/hosty/ui/feedback/speech";
  if (!legacyFeedback && !url.pathname.startsWith("/api/speech/")) return false;
  const client = new ProviderClient();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once("close", cancel);
  response.setHeader("cache-control", "no-store");
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CHAT_SPEECH_TIMEOUT_MS)]);
  const { userId, preferences } = context;
  const account = accountScope(userId);
  const fresh = async (kind: SpeechKind) => {
    const [state, permissions] = await Promise.all([preferences.read(userId), client.permissions(signal)]);
    return directory(client, kind, userId, state, permissions, signal);
  };
  try {
    if (url.pathname === "/api/speech/settings") {
      const [state, permissions] = await Promise.all([preferences.read(userId), client.permissions(signal)]);
      if (request.method === "GET") {
        const [dictation, reading] = await Promise.all(speechKinds.map(kind => directory(client, kind, userId, state, permissions, signal)));
        json(response, { account, revision: state.revision, roles: { "speech-to-text": dictation, "text-to-speech": reading } });
        return true;
      }
      if (request.method !== "PUT") return false;
      const body = await context.readJson();
      const kind = speechKinds.find(item => item === body.kind);
      if (!kind || body.account !== account) throw new ProviderError("speech_settings_changed", "Reopen your speech settings for this account.", 409);
      const roster = await directory(client, kind, userId, state, permissions, signal);
      const choice = body.choice === null ? null : roster.providers.find(p => body.choice && sameSpeechChoice(p, body.choice as SpeechChoice));
      if (body.choice !== null && !choice?.available) throw unavailable();
      const next = await preferences.save(userId, body.revision, kind, choice ?? null);
      json(response, { revision: next.revision }); return true;
    }
    const synth = url.pathname === "/api/speech/synthesis" && request.method === "POST";
    const capabilitiesRequest = url.pathname === "/api/speech/capabilities" && request.method === "GET";
    const feedback = (legacyFeedback || url.pathname === "/api/speech/feedback") && request.method === "POST";
    const transcription = url.pathname === "/api/speech/transcriptions" && request.method === "POST";
    const listing = (legacyFeedback || url.pathname === "/api/speech/providers") && request.method === "GET";
    if (!synth && !capabilitiesRequest && !feedback && !transcription && !listing) return false;
    const kind = synth || !legacyFeedback && (listing || capabilitiesRequest) && url.searchParams.get("kind") === "text-to-speech" ? "text-to-speech" : "speech-to-text";
    const roster = await fresh(kind);
    if (listing) {
      const selected = currentSpeechOption(roster);
      json(response, legacyFeedback ? { granted: roster.granted, providers: selected && !selected.implementationId ? [selected] : [] } : roster);
      return true;
    }
    let legacyAudio: Buffer | undefined;
    if (legacyFeedback) {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new ProviderError("speech_invalid", "Use a recorded WAV file.", 415);
      const body = await context.readJson();
      if (typeof body.audio !== "string" || typeof body.appId !== "string" || typeof body.key !== "string")
        throw new ProviderError("speech_invalid", "Choose a static speech provider and a recording.", 400);
      url.searchParams.delete("binding"); url.searchParams.set("appId", body.appId); url.searchParams.set("key", body.key);
      legacyAudio = Buffer.from(body.audio, "base64");
      if (legacyAudio.length < 44 || legacyAudio.toString("ascii", 0, 4) !== "RIFF" || legacyAudio.toString("ascii", 8, 12) !== "WAVE")
        throw new ProviderError("speech_invalid", "Use a recorded WAV file.", 400);
    }
    const assertTarget = (value: SpeechRoster) => {
      if (!value.granted) throw new ProviderError("app_permission_required", "Enable the " + kind + " permission for Harness in Hosty.", 403);
      const selected = currentSpeechOption(value);
      if (!selected?.available) throw unavailable();
      const stamp = url.searchParams.get("binding");
      // Legacy clients transmit the app/key pair. They can only address the exact static dictation destination.
      const legacy = !stamp && kind === "speech-to-text" && !selected.implementationId && url.searchParams.get("appId") === selected.appId && url.searchParams.get("key") === selected.key;
      if (!legacy && stamp !== value.binding) throw unavailable();
      return selected;
    };
    const provider = assertTarget(roster);
    if (kind === "text-to-speech") {
      const caps = await client.textToSpeechCapabilities(provider, signal);
      if (caps.version !== 1 || !caps.ready || !Number.isSafeInteger(caps.maxCharacters) || caps.maxCharacters < 1 ||
        !caps.mediaTypes.some(type => type === "audio/pcm" || type === "audio/pcm;rate=24000")) throw unavailable();
      const maximum = Math.min(caps.maxCharacters, 4000);
      if (capabilitiesRequest) { json(response, { ...caps, maxCharacters: maximum }); return true; }
      const body = await context.readJson();
      if (typeof body.sessionId !== "string" || !await context.ownsSession(body.sessionId))
        throw new ProviderError("session_unavailable", "Reopen your conversation before reading aloud.", 403);
      if (typeof body.text !== "string" || !body.text.trim())
        throw new ProviderError("speech_text_required", "Select the response or a section to read.", 400);
      if (body.text.length > maximum)
        throw new ProviderError("speech_text_too_long", "This selection exceeds the provider limit. Choose a shorter section.", 413);
      assertTarget(await fresh(kind));
      const upstream = await client.synthesize(provider, { text: body.text }, signal);
      if (!upstream.body || upstream.headers.get("content-type")?.replaceAll(" ", "").toLowerCase() !== "audio/pcm;rate=24000") {
        await upstream.body?.cancel(); throw new ProviderError("speech_format_unsupported", "The provider returned an unsupported audio format.", 502);
      }
      response.setHeader("content-type", "audio/pcm;rate=24000");
      response.flushHeaders();
      try { await pipeline(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>), response, { signal }); }
      catch { response.destroy(); }
      return true;
    }
    const capabilities = await client.speechCapabilities(provider, signal);
    let limits;
    try { limits = chatSpeechLimits(capabilities); }
    catch (error) { throw new ProviderError("speech_limits_unavailable", error instanceof Error ? error.message : "Recording limits are unavailable.", 503); }
    if (capabilitiesRequest) { json(response, capabilities); return true; }
    if (!legacyFeedback && request.headers["content-type"]?.split(";")[0] !== "audio/wav") throw new ProviderError("speech_format_unsupported", "Use a WAV recording.", 415);
    const seconds = Math.min(limits.maxDurationSeconds, feedback ? 60 : Infinity);
    const maxBytes = Math.min(limits.maxBytes, 44 + Math.floor(seconds * 16000) * 2);
    const tooLarge = () => new ProviderError("speech_audio_too_large", `Recordings may be up to ${speechDuration(seconds)} for this provider.`, 413);
    if ((legacyAudio?.length ?? Number(request.headers["content-length"])) > maxBytes) throw tooLarge();
    const buffers: Buffer[] = [];
    let length = 0;
    for await (const chunk of legacyAudio ? [legacyAudio] : request) {
      signal.throwIfAborted();
      length += chunk.length;
      if (length > maxBytes) throw tooLarge();
      buffers.push(Buffer.from(chunk));
    }
    assertTarget(await fresh(kind));
    const result = await client.transcribe(provider, new Blob([Buffer.concat(buffers)], { type: "audio/wav" }), { signal, timeoutMs: CHAT_SPEECH_TIMEOUT_MS });
    json(response, result);
    return true;
  } finally { response.off("close", cancel); }
}
