export type SpeechActivityFrame = { level: number; speaking: boolean; available?: boolean };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** A local acoustic estimate, not semantic speech recognition. Steady tones/noise need not be speech. */
export function createSpeechActivityDetector(sampleRate: number, fftSize: number) {
  let level = 0, noiseFloor = 0.002, variation = 0, previousRms = 0;
  let previousTime: number | null = null, attack = 0, lastVoice = -Infinity, speaking = false;
  return (wave: Float32Array, spectrum: Float32Array, now: number): SpeechActivityFrame => {
    const elapsed = previousTime === null ? 50 : clamp(now - previousTime, 0, 200);
    let squares = 0;
    for (const sample of wave) if (Number.isFinite(sample)) squares += sample * sample;
    const rms = Math.sqrt(squares / Math.max(1, wave.length));
    const rawLevel = rms > 0 ? clamp((20 * Math.log10(rms) + 65) / 55, 0, 1) : 0;
    level += (rawLevel - level) * (1 - Math.exp(-elapsed / (rawLevel > level ? 65 : 140)));

    let totalPower = 0, speechPower = 0;
    for (let bin = 0; bin < spectrum.length; bin++) {
      const decibels = spectrum[bin]!;
      if (!Number.isFinite(decibels)) continue;
      const power = 10 ** (Math.min(0, decibels) / 10), frequency = bin * sampleRate / fftSize;
      totalPower += power;
      if (frequency >= 150 && frequency <= 4000) speechPower += power;
    }
    const change = previousTime === null ? 0 : Math.abs(rms - previousRms) / Math.max(rms, previousRms, 0.004);
    variation += (change - variation) * (1 - Math.exp(-elapsed / 200));
    // Learn the quiet envelope quickly and persistent background energy slowly. Combined with
    // modulation and speech-band energy, this avoids lighting the speech state for steady hum.
    noiseFloor += (rms - noiseFloor) * (1 - Math.exp(-elapsed / (rms < noiseFloor ? 250 : 3500)));
    noiseFloor = Math.max(0.0004, noiseFloor);
    const candidate = rms >= 0.003 && rms > noiseFloor * 2 && totalPower > 0
      && speechPower / totalPower >= 0.55 && variation >= 0.06;
    if (candidate) {
      attack += elapsed; lastVoice = now;
      if (attack >= 80) speaking = true;
    } else {
      attack = 0;
      if (now - lastVoice >= 220) speaking = false;
    }
    previousRms = rms; previousTime = now;
    return { level: clamp(level, 0, 1), speaking };
  };
}

/** Observe an already-authorized stream without playing it or owning its recording tracks. */
export function startSpeechActivity(stream: MediaStream, onFrame: (frame: SpeechActivityFrame) => void): () => void {
  let context: AudioContext | null = null, source: MediaStreamAudioSourceNode | null = null, analyser: AnalyserNode | null = null;
  let timer: ReturnType<typeof setInterval> | undefined, stopped = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); clearTimeout(startupTimer);
    try { source?.disconnect(); } catch { /* Best-effort activity must never interrupt recording. */ }
    try { analyser?.disconnect(); } catch { /* The context may already have closed. */ }
    try { void context?.close().catch(() => {}); } catch { /* Unsupported or already closed. */ }
  };
  const unavailable = () => {
    if (stopped) return;
    try { onFrame({ level: 0, speaking: false, available: false }); } catch { /* UI callbacks do not own the recorder. */ }
    stop();
  };
  try {
    const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) { unavailable(); return stop; }
    context = new Constructor();
    analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.1;
    source = context.createMediaStreamSource(stream); source.connect(analyser);
    // No node is connected to destination: microphone audio is never played back.
    const wave = new Float32Array(analyser.fftSize), spectrum = new Float32Array(analyser.frequencyBinCount);
    const detect = createSpeechActivityDetector(context.sampleRate, analyser.fftSize);
    const sample = () => {
      if (stopped) return;
      try {
        analyser!.getFloatTimeDomainData(wave); analyser!.getFloatFrequencyData(spectrum);
        if (!stopped) onFrame({ ...detect(wave, spectrum, performance.now()), available: true });
      } catch { unavailable(); }
    };
    startupTimer = setTimeout(unavailable, 1500);
    void context.resume().then(() => {
      if (stopped) return;
      clearTimeout(startupTimer);
      if (context!.state !== "running") { unavailable(); return; }
      sample(); if (!stopped) timer = setInterval(sample, 50);
    }).catch(unavailable);
  } catch { unavailable(); }
  return stop;
}
