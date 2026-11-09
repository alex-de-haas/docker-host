import { CHAT_SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE, speechDuration, type SpeechLimits } from "../../../shared/speech";

const CHAT_LIMITS = { maxDurationSeconds: CHAT_SPEECH_MAX_SECONDS, maxBytes: 44 + CHAT_SPEECH_MAX_SECONDS * SPEECH_SAMPLE_RATE * 2 };
/** Interoperable speech v1 baseline: mono PCM16 WAV at 16 kHz. */
export function pcmWave(samples: Float32Array, limits: SpeechLimits = CHAT_LIMITS): Blob {
  if (!samples.length || samples.length > Math.floor(Math.min(CHAT_SPEECH_MAX_SECONDS, limits.maxDurationSeconds) * SPEECH_SAMPLE_RATE)
    || 44 + samples.length * 2 > limits.maxBytes) throw new Error(`Record between a moment and ${speechDuration(limits.maxDurationSeconds)} of audio.`);
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); });
  return new Blob([bytes], { type: "audio/wav" });
}

export async function recordingWave(recording: Blob, limits: SpeechLimits = CHAT_LIMITS): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const maxSamples = Math.min(CHAT_SPEECH_MAX_SECONDS * SPEECH_SAMPLE_RATE, Math.floor(limits.maxDurationSeconds * SPEECH_SAMPLE_RATE), Math.floor((limits.maxBytes - 44) / 2));
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > maxSamples / SPEECH_SAMPLE_RATE + 0.1)
      throw new Error(`Recordings may be up to ${speechDuration(maxSamples / SPEECH_SAMPLE_RATE)}.`);
    const offline = new OfflineAudioContext(1, Math.min(maxSamples, Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE)), SPEECH_SAMPLE_RATE);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    return pcmWave((await offline.startRendering()).getChannelData(0), limits);
  } finally { await context.close(); }
}
