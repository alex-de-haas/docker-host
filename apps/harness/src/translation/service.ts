import { ProviderError, type TranslationCapabilities, type TranslationRequest, type TranslationResult } from "@hosty-sdk/app/providers";
import { ConnectionError, type AgentConnections, type AgentKind } from "../connections/registry.js";
import type { SettingsStore } from "../settings/store.js";
import { MAX_OUTPUT_BYTES, runTranslation } from "./native.js";
import { markdownParts, validateMarkdownTranslation } from "./markdown.js";
import { isTranslationModel, TRANSLATION_MODELS } from "./models.js";

export const MAX_CHARACTERS = 128_000;
export const MAX_BODY_BYTES = 1_048_576;
export const TIMEOUT_SECONDS = 600;
export const MAX_SEGMENT_CHARACTERS = 16_000;
const MAX_DOCUMENT_OUTPUT_BYTES = 1_048_576;
export const isTranslationKind = (value: string): value is AgentKind => value === "codex" || value === "claude";

export function parseTranslation(value: unknown): Required<TranslationRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError("translation_invalid", "Send a translation object.", 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["text", "targetLanguage", "sourceLanguage", "format"].includes(key))
    || typeof input.text !== "string" || !input.text.trim())
    throw new ProviderError("translation_invalid", "Supply non-empty text and language tags.", 400);
  if ([...input.text].length > MAX_CHARACTERS)
    throw new ProviderError("translation_too_large", `Text may contain up to ${MAX_CHARACTERS} characters.`, 413);
  const language = (value: unknown) => typeof value === "string" && value.length <= 63 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value);
  const source = input.sourceLanguage ?? "auto", format = input.format ?? "text";
  if (!language(input.targetLanguage) || String(input.targetLanguage).toLowerCase() === "auto" || (source !== "auto" && !language(source))
    || !["text", "markdown"].includes(String(format)))
    throw new ProviderError("translation_invalid", "Use language tags such as en, ru or zh-Hant and text or markdown format.", 400);
  if (format === "text" && [...input.text].length > MAX_SEGMENT_CHARACTERS)
    throw new ProviderError("translation_too_large", "Plain text may contain up to 16000 characters. Use markdown format for a plan.", 413);
  return { text: input.text, targetLanguage: input.targetLanguage as string, sourceLanguage: source as string, format: format as "text" | "markdown" };
}

export class TranslationService {
  private active = new Set<AgentKind>();
  constructor(private readonly connections: AgentConnections, private readonly settings: SettingsStore,
    private readonly run = runTranslation) {}

  async configure(kind: AgentKind, connectionId: unknown, model?: unknown) {
    if (model !== undefined && !isTranslationModel(model))
      throw new ProviderError("translation_model_invalid", "Choose the agent default or a model ID of up to 128 letters, numbers, dots, underscores or hyphens.", 400);
    if (connectionId !== null && (typeof connectionId !== "string" || !connectionId))
      throw new ProviderError("translation_connection_invalid", `Choose a ${kind} connection or disable this variant.`, 400);
    const binding = connectionId === null ? null : await this.connections.binding(connectionId);
    if (binding && binding.harnessKind !== kind)
      throw new ProviderError("translation_connection_invalid", `Choose a ${kind} connection or disable this variant.`, 400);
    await this.settings.transform(current => ({
      translationConnections: { ...current.translationConnections, [kind]: binding },
      ...(model !== undefined ? { translationModels: { ...current.translationModels, [kind]: model as string | null } } : {}),
    }));
    return this.configuration();
  }

  async configuration() {
    const settings = await this.settings.read();
    const selected = settings.translationConnections ?? {};
    return { variants: await Promise.all((["codex", "claude"] as const).map(async key => ({
      key, connectionId: selected[key]?.connectionId ?? null, connectionRevision: selected[key]?.connectionRevision ?? null,
      model: settings.translationModels?.[key] ?? null, suggestedModels: TRANSLATION_MODELS[key],
      ...await this.capabilities(key),
    }))) };
  }

  async capabilities(kind: AgentKind): Promise<TranslationCapabilities> {
    const binding = (await this.settings.read()).translationConnections?.[kind];
    let ready = false, reason: string | undefined;
    if (!binding) reason = "Choose a connection in Harness translation settings.";
    else {
      const entry = (await this.connections.list()).connections.find(c => c.id === binding.connectionId);
      ready = Boolean(entry?.available && entry.kind === kind && entry.revision === binding.connectionRevision);
      if (!ready) reason = "The selected account is unavailable or changed. Select it again in Harness translation settings.";
    }
    return { version: 1, formats: ["text", "markdown"], maxCharacters: MAX_CHARACTERS, maxBytes: MAX_BODY_BYTES,
      maxSegmentCharacters: MAX_SEGMENT_CHARACTERS, maxOutputBytes: MAX_DOCUMENT_OUTPUT_BYTES, timeoutSeconds: TIMEOUT_SECONDS, backend: kind, ready, ...(reason ? { reason } : {}) };
  }

  async translate(kind: AgentKind, value: unknown, signal: AbortSignal): Promise<TranslationResult> {
    const input = parseTranslation(value);
    const parts = input.format === "markdown" ? markdownParts(input.text) : [{ text: input.text, translate: true }];
    const settings = await this.settings.read();
    const binding = settings.translationConnections?.[kind];
    const model = settings.translationModels?.[kind] ?? null;
    if (!binding) throw new ProviderError("translation_unavailable", "Configure this translation variant in Harness settings.", 503);
    if (this.active.has(kind)) throw new ProviderError("translation_busy", "This translation variant is busy. Retry later.", 429);
    this.active.add(kind);
    try {
      const text = await this.connections.withTranslationRuntime(binding, async runtime => {
        let result = "";
        for (const part of parts) {
          signal.throwIfAborted();
          // Preserve exact boundary whitespace when models omit trailing newlines.
          const leading = part.text.match(/^\s*/)?.[0] ?? "", trailing = part.text.match(/\s*$/)?.[0] ?? "";
          const source = part.text.slice(leading.length, part.text.length - trailing.length);
          const segmentSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
          let translated = part.text;
          if (part.translate) {
            try { translated = await this.run(runtime, JSON.stringify({ ...input, text: source }), segmentSignal, { model }); }
            catch (error) {
              if (segmentSignal.aborted && !signal.aborted)
                throw new ProviderError("translation_timeout", "A translation segment exceeded its time limit.", 504);
              throw error;
            }
          }
          if (part.translate && Buffer.byteLength(translated) > MAX_OUTPUT_BYTES)
            throw new ProviderError("translation_result_invalid", "A translated segment exceeded its output limit.", 502);
          result += part.translate ? leading + translated.trim() + trailing : translated;
          if (Buffer.byteLength(result) > MAX_DOCUMENT_OUTPUT_BYTES)
            throw new ProviderError("translation_result_invalid", "The translated document exceeded its output limit.", 502);
        }
        return result;
      });
      signal.throwIfAborted();
      if (input.format === "markdown") validateMarkdownTranslation(input.text, text);
      return { text, targetLanguage: input.targetLanguage, sourceLanguage: input.sourceLanguage };
    } catch (error) {
      if (signal.aborted) throw new ProviderError(signal.reason?.name === "TimeoutError" ? "translation_timeout" : "translation_cancelled",
        signal.reason?.name === "TimeoutError" ? "Translation exceeded its time limit." : "Translation was cancelled.", signal.reason?.name === "TimeoutError" ? 504 : 499);
      if (error instanceof ProviderError || error instanceof ConnectionError) throw error;
      throw new ProviderError("translation_failed", "The selected agent could not complete this translation.", 502);
    } finally { this.active.delete(kind); }
  }
}
