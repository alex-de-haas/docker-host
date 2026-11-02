/** Interoperable speech v1 baseline: mono PCM16 WAV at 16 kHz. */
export function pcmWave(samples: Float32Array): Blob {
  if (!samples.length || samples.length > 120 * 16000) throw new Error("Record between a moment and 120 seconds of audio.");
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); });
  return new Blob([bytes], { type: "audio/wav" });
}

export async function recordingWave(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    if (decoded.duration > 120.1) throw new Error("Recordings may be up to 120 seconds.");
    const offline = new OfflineAudioContext(1, Math.min(120 * 16000, Math.ceil(decoded.duration * 16000)), 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    return pcmWave((await offline.startRendering()).getChannelData(0));
  } finally { await context.close(); }
}
