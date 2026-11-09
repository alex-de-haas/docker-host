/** Chat's bounded, interoperable mono PCM16 WAV contract. Feedback retains its own limits. */
export const SPEECH_SAMPLE_RATE = 16000;
export const CHAT_SPEECH_MAX_SECONDS = 600;
export const CHAT_SPEECH_TIMEOUT_MS = 930_000;
export const WAV_HEADER_BYTES = 44;
export type SpeechLimits = { maxDurationSeconds: number; maxBytes: number };

export function chatSpeechLimits(value: unknown): SpeechLimits {
  const capabilities = value as Record<string, unknown> | null;
  if (!capabilities || capabilities.version !== 1 || capabilities.ready !== true
    || !Array.isArray(capabilities.mediaTypes) || !capabilities.mediaTypes.includes("audio/wav")
    || typeof capabilities.maxDurationSeconds !== "number" || !Number.isFinite(capabilities.maxDurationSeconds)
    || typeof capabilities.maxBytes !== "number" || !Number.isSafeInteger(capabilities.maxBytes))
    throw new Error("The speech provider's recording limits are unavailable. Try again after the provider is ready.");
  const samples = Math.floor(Math.min(CHAT_SPEECH_MAX_SECONDS * SPEECH_SAMPLE_RATE,
    capabilities.maxDurationSeconds * SPEECH_SAMPLE_RATE, (capabilities.maxBytes - WAV_HEADER_BYTES) / 2));
  if (samples < SPEECH_SAMPLE_RATE) throw new Error("The speech provider does not support a usable recording length.");
  // Chat creates a canonical 44-byte header. Bound uploads to this actual duration as well as bytes.
  return { maxDurationSeconds: samples / SPEECH_SAMPLE_RATE, maxBytes: WAV_HEADER_BYTES + samples * 2 };
}

export function speechDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
