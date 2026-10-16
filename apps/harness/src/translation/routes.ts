import type { IncomingMessage, ServerResponse } from "node:http";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError } from "@hosty-sdk/app/providers";
import { isTranslationKind, MAX_BODY_BYTES, TIMEOUT_SECONDS, type TranslationService } from "./service.js";

export async function translationRoute(request: IncomingMessage, response: ServerResponse, url: URL, service: TranslationService | null): Promise<boolean> {
  if (!url.pathname.startsWith("/api/translation/")) return false;
  response.setHeader("cache-control", "no-store");
  const match = url.pathname.match(/^\/api\/translation\/v1\/(codex|claude)\/(capabilities|translations)$/);
  if (!match || !isTranslationKind(match[1]!)) throw new ProviderError("translation_route_missing", "Unknown translation route.", 404);
  const kind = match[1], action = match[2];
  const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!bearer) throw new ProviderError("token_required", "A translation provider credential is required.", 401);
  await new ProviderClient().validate(bearer, "translation", kind);
  if (!service) throw new ProviderError("translation_unavailable", "Translation connections are unavailable.", 503);
  if (!((request.method === "GET" && action === "capabilities") || (request.method === "POST" && action === "translations")))
    throw new ProviderError("method_not_allowed", "Use GET capabilities or POST translations.", 405);
  let result: unknown;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once("close", cancel);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_SECONDS * 1000)]);
  try {
    if (action === "capabilities") result = await service.capabilities(kind);
    else {
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
        throw new ProviderError("translation_media_type", "Send application/json.", 415);
      let body: unknown;
      const bytes = await readBody(request, response, signal);
      try { body = JSON.parse(bytes.toString("utf8")); }
      catch { throw new ProviderError("translation_invalid", "Send valid JSON.", 400); }
      result = await service.translate(kind, body, signal);
    }
    if (!response.destroyed) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    }
    return true;
  } finally { response.off("close", cancel); }
}

function readBody(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => {
      request.off("data", data); request.off("end", end); request.off("error", fail); request.off("aborted", aborted);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error: unknown) => { cleanup(); request.pause(); response.setHeader("connection", "close"); reject(error); };
    const aborted = () => fail(new ProviderError("translation_cancelled", "Translation upload was cancelled or exceeded its time limit.", 408));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { fail(new ProviderError("translation_too_large", "Translation request exceeds its byte limit.", 413)); return; }
      chunks.push(Buffer.from(chunk));
    };
    request.on("data", data); request.once("end", end); request.once("error", fail); request.once("aborted", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
