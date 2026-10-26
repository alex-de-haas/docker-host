import { ProviderError, type TranslationCapabilities, type TranslationRequest, type TranslationResult } from '@hosty-sdk/app/providers';
import { prepareDocument, restoreDocument } from './markdown.js';
import type { TranslationEngine } from './worker.js';
export const MAX_BYTES = 1_048_576;
export const MAX_CHARACTERS = 128_000;
export const TIMEOUT_SECONDS = 600;

export function parseTranslation(value: unknown): Required<TranslationRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('translation_invalid', 'Supply a translation object.', 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !['text', 'sourceLanguage', 'targetLanguage', 'format'].includes(k)) || typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0'))
    throw new ProviderError('translation_invalid', 'Supply nonempty text and language tags.', 400);
  const source = input.sourceLanguage ?? 'auto', target = input.targetLanguage, format = input.format ?? 'text';
  const tag = (v: unknown) => typeof v === 'string' && v.length <= 63 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(v);
  if ((source !== 'auto' && !tag(source)) || !tag(target) || (typeof format !== 'string' || !['text', 'markdown'].includes(format)))
    throw new ProviderError('translation_invalid', 'Use language tags and text or markdown format.', 400);
  if ((source !== 'auto' && String(source).split('-')[0]!.toLowerCase() !== 'en') || String(target).split('-')[0]!.toLowerCase() !== 'ru')
    throw new ProviderError('translation_language_unsupported', 'OPUS Translate supports English to Russian. Automatic source uses English.', 400);
  if ([...input.text].length > (format === 'markdown' ? MAX_CHARACTERS : 16_000) || Buffer.byteLength(input.text) > MAX_BYTES)
    throw new ProviderError('translation_too_large', 'Text exceeds this format’s translation limit.', 413);
  return { text: input.text, sourceLanguage: source as string, targetLanguage: target as string, format: format as 'text' | 'markdown' };
}

export class TranslationService {
  private active = false;
  constructor(private readonly engine: TranslationEngine) {}
  capabilities(): TranslationCapabilities & { sourceLanguages: string[]; targetLanguages: string[]; autoSourceLanguage: string } {
    return { version: 1, formats: ['text', 'markdown'], maxCharacters: MAX_CHARACTERS, maxBytes: MAX_BYTES, maxOutputBytes: MAX_BYTES,
      maxSegmentCharacters: 16_000, timeoutSeconds: TIMEOUT_SECONDS, backend: 'ctranslate2/opus-mt-tc-big-en-zle/int8/cpu',
      ready: this.engine.ready, ...(this.engine.reason ? { reason: this.engine.reason } : {}), sourceLanguages: ['en'], targetLanguages: ['ru'], autoSourceLanguage: 'en' };
  }
  async translate(value: unknown, signal: AbortSignal): Promise<TranslationResult> {
    const input = parseTranslation(value);
    if (!this.engine.ready) throw new ProviderError('translation_not_ready', this.engine.reason ?? 'The model is loading.', 503);
    if (this.active) throw new ProviderError('translation_busy', 'Local translation is busy. Try again later.', 429);
    this.active = true;
    try {
      signal.throwIfAborted();
      const document = prepareDocument(input.text, input.format === 'markdown');
      const translations: string[] = [];
      let bytes = 0;
      for (let index = 0; index < document.fragments.length; index += 32) {
        const batch = await this.engine.translate(document.fragments.slice(index, index + 32), signal);
        bytes += batch.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
        if (bytes > MAX_BYTES) throw new ProviderError('translation_result_too_large', 'Translation output exceeded its byte limit.', 502);
        translations.push(...batch);
      }
      signal.throwIfAborted();
      const text = restoreDocument(document, translations);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new ProviderError('translation_result_too_large', 'Translation output exceeded its byte limit.', 502);
      return { text, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage };
    } finally { this.active = false; }
  }
}
