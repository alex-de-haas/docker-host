import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";
import { ConnectionError } from "@hosty/agent-provider-runtime/connections/registry";
import { json } from "@hosty/agent-provider-runtime/server";
import { type CodexConnections, type SpeechKind } from "./connections.js";
import { SpeechCatalog } from "./speech-catalog.js";
import * as openai from "./openai-speech.js";

const inputError = (message: string) => new ProviderError("speech_input_invalid", message, 400);
function validateRecording(bytes: Buffer) {
  const invalid = () => inputError("Send a complete 16 kHz mono PCM16 WAV recording.");
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.readUInt32LE(4) + 8 !== bytes.length ||
      bytes.toString("ascii", 8, 12) !== "WAVE") throw invalid();
  let format = false, samples = false, offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + size > bytes.length) throw invalid();
    if (type === "fmt ") {
      if (format || size < 16 || bytes.readUInt16LE(offset) !== 1 || bytes.readUInt16LE(offset + 2) !== 1 ||
          bytes.readUInt32LE(offset + 4) !== 16000 || bytes.readUInt32LE(offset + 8) !== 32000 ||
          bytes.readUInt16LE(offset + 12) !== 2 || bytes.readUInt16LE(offset + 14) !== 16) throw invalid();
      format = true;
    } else if (type === "data") {
      if (!format || samples || !size || size % 2 || size > openai.maxDurationSeconds * 32000) throw invalid();
      samples = true;
    }
    offset += size + size % 2;
  }
  if (!samples || offset !== bytes.length) throw invalid();
}

async function body(request: IncomingMessage, limit: number, signal: AbortSignal) {
  const tooLarge = () => new ProviderError("speech_input_too_large", "The speech input exceeds the provider's limit.", 413);
  if (Number(request.headers["content-length"]) > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = () => request.destroy();
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      total += chunk.length;
      if (total > limit) throw tooLarge();
      chunks.push(chunk);
    }
  } finally { signal.removeEventListener("abort", abort); }
  return Buffer.concat(chunks, total);
}

export function openSpeech(accounts: CodexConnections, data: string) {
  const client = new ProviderClient(), catalog = new SpeechCatalog(accounts, data, client);
  const stop = new AbortController();
  return { route: speechRoutes(accounts, client, openai, stop.signal), close() { stop.abort(); catalog.close(); } };
}

export function speechRoutes(accounts: Pick<CodexConnections, "speechCredential">, core: Pick<ProviderClient, "validate">,
  adapter: Pick<typeof openai, "transcribe" | "synthesize">, stopping: AbortSignal) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = /^\/api\/(speech-to-text|text-to-speech)\/v1\/(capabilities|transcriptions|speech)$/.exec(url.pathname);
    if (!match) return false;
    const kind = match[1] as SpeechKind, action = match[2], isTranscription = kind === "speech-to-text";
    const cancel = new AbortController();
    const disconnect = () => cancel.abort();
    response.once("close", disconnect);
    const deadline = AbortSignal.timeout(isTranscription ? 930_000 : 300_000);
    const signal = AbortSignal.any([deadline, stopping, cancel.signal]);
    try {
      const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
      if (!token) throw new ProviderError("token_required", "A Hosty speech provider credential is required.", 401);
      const authorize = async () => {
        const { implementationId } = await core.validate(token, kind, "default", signal);
        if (!implementationId) throw new ProviderError("implementation_required", "Select an exact speech implementation.", 403);
        return implementationId;
      };
      const id = await authorize();
      if (action === "capabilities" && request.method === "GET") {
        let ready = true;
        try { await accounts.speechCredential(id, kind); }
        catch (error) { if (!(error instanceof ConnectionError) || error.code !== "credential_unavailable") throw error; ready = false; }
        json(response, 200, { version: 1, ready, backend: "OpenAI", ...(isTranscription
          ? { mediaTypes: ["audio/wav"], maxBytes: openai.maxWavBytes, maxDurationSeconds: openai.maxDurationSeconds }
          : { mediaTypes: ["audio/pcm"], maxCharacters: openai.maxCharacters }) });
        return true;
      }
      if (request.method !== "POST" || action !== (isTranscription ? "transcriptions" : "speech"))
        throw new ProviderError("method_not_allowed", "Unsupported speech operation.", 405);
      const expected = isTranscription ? "audio/wav" : "application/json";
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== expected)
        throw new ProviderError("speech_format_unsupported", "Unsupported speech input format.", 415);
      const language = isTranscription ? openai.transcriptionLanguage(url.searchParams.get("language")) : null;
      const bytes = await body(request, isTranscription ? openai.maxWavBytes : openai.maxCharacters * 6 + 64, signal);
      let text: string | undefined;
      if (isTranscription) {
        validateRecording(bytes);
      } else {
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw inputError("Send valid UTF-8 JSON."); }
        if (!value || typeof value !== "object" || !("text" in value) || Object.keys(value).length !== 1 ||
            typeof value.text !== "string" || !value.text.trim() || value.text.length > openai.maxCharacters)
          throw inputError("Send a nonempty passage of up to 4000 UTF-16 code units.");
        text = value.text;
      }
      // Grants or the exact billing credential may have changed while the caller uploaded the body.
      if (await authorize() !== id) throw new ProviderError("implementation_changed", "The selected speech implementation changed.", 409);
      const key = await accounts.speechCredential(id, kind);
      signal.throwIfAborted();
      if (text === undefined) {
        json(response, 200, await adapter.transcribe(key, bytes, language, signal));
      } else {
        const audio = adapter.synthesize(key, text, signal);
        for await (const chunk of audio) {
          if (!response.headersSent) response.writeHead(200, { "content-type": "audio/pcm;rate=24000", "cache-control": "no-store", "x-accel-buffering": "no" });
          if (!response.write(chunk)) await once(response, "drain", { signal });
        }
        response.end();
      }
    } catch (error) {
      if (response.headersSent) response.destroy();
      else if (!response.destroyed) {
        response.setHeader("connection", "close");
        const known = error instanceof ProviderError || error instanceof ConnectionError;
        json(response, deadline.aborted ? 504 : known ? error.status : 502, { code: deadline.aborted ? "speech_timeout" : known ? error.code : "speech_unavailable",
          message: deadline.aborted ? "Speech processing timed out." : known ? error.message : "The speech provider is unavailable." });
      }
    } finally { response.off("close", disconnect); }
    return true;
  };
}
