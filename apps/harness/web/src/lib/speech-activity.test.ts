import { afterEach, expect, it, vi } from "vitest";
import { createSpeechActivityDetector, startSpeechActivity } from "./speech-activity";

const rate = 48000, size = 1024;
function signal(amplitude: number, frequency = 700) {
  return Float32Array.from({ length: size }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * index / rate));
}
function spectrum(frequency = 700) {
  const bins = new Float32Array(size / 2).fill(-Infinity);
  bins[Math.round(frequency * size / rate)] = -20;
  return bins;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps silence quiet with a bounded level", () => {
  const detect = createSpeechActivityDetector(rate, size);
  for (let time = 0; time < 1000; time += 50)
    expect(detect(signal(0), new Float32Array(size / 2).fill(-Infinity), time)).toEqual({ level: 0, speaking: false });
});

it("activates for modulated speech-band energy and releases after silence", () => {
  const detect = createSpeechActivityDetector(rate, size);
  let voiced = false;
  for (let time = 0; time < 1600; time += 50) {
    const result = detect(signal(time % 200 < 100 ? 0.12 : 0.02), spectrum(), time);
    voiced ||= result.speaking; expect(result.level).toBeGreaterThanOrEqual(0); expect(result.level).toBeLessThanOrEqual(1);
  }
  expect(voiced).toBe(true);
  let final;
  for (let time = 1600; time < 2400; time += 50) final = detect(signal(0), spectrum(), time);
  expect(final?.speaking).toBe(false); expect(final!.level).toBeLessThan(0.01);
});

it("suppresses steady noise and out-of-band rumble while still measuring their real energy", () => {
  const detect = createSpeechActivityDetector(rate, size);
  const broadNoise = new Float32Array(size / 2).fill(-40);
  let result;
  for (let time = 0; time < 5000; time += 50) result = detect(signal(0.06), broadNoise, time);
  expect(result?.speaking).toBe(false); expect(result!.level).toBeGreaterThan(0);
  for (let time = 5000; time < 7000; time += 50) result = detect(signal(time % 200 < 100 ? 0.2 : 0.03, 60), spectrum(60), time);
  expect(result?.speaking).toBe(false);
  const steadyTone = createSpeechActivityDetector(rate, size);
  for (let time = 0; time < 5000; time += 50) expect(steadyTone(signal(0.1), spectrum(), time).speaking).toBe(false);
});

it("bounds loud, empty and invalid input without emitting non-finite levels", () => {
  const detect = createSpeechActivityDetector(rate, size);
  for (let time = 0; time < 500; time += 50) expect(detect(signal(20), spectrum(), time).level).toBeLessThanOrEqual(1);
  const result = detect(new Float32Array([NaN, Infinity]), new Float32Array([NaN, Infinity]), 550);
  expect(Number.isFinite(result.level)).toBe(true); expect(result.level).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(detect(new Float32Array(), new Float32Array(), 600).level)).toBe(true);
});

function audioMock(resume: () => Promise<void> = () => Promise.resolve()) {
  const analyser = { fftSize: size, frequencyBinCount: size / 2, smoothingTimeConstant: 0,
    disconnect: vi.fn(), getFloatTimeDomainData: vi.fn((wave: Float32Array) => wave.set(signal(0.1))),
    getFloatFrequencyData: vi.fn((bins: Float32Array) => bins.set(spectrum())) };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = { sampleRate: rate, state: "running", createAnalyser: vi.fn(() => analyser), createMediaStreamSource: vi.fn(() => source),
    resume: vi.fn(resume), close: vi.fn(() => Promise.resolve()), destination: {} };
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  const stopTrack = vi.fn(), stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  return { analyser, source, context, stream, stopTrack };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

it("samples the actual stream near 20 Hz and releases all analysis resources without stopping recorder tracks", async () => {
  vi.useFakeTimers();
  const mock = audioMock(), frame = vi.fn();
  const stop = startSpeechActivity(mock.stream, frame);
  await settle(); vi.advanceTimersByTime(200);
  expect(mock.context.createMediaStreamSource).toHaveBeenCalledWith(mock.stream);
  expect(mock.source.connect).toHaveBeenCalledExactlyOnceWith(mock.analyser);
  expect(frame).toHaveBeenCalledTimes(5);
  expect(frame.mock.calls.at(-1)![0].level).toBeGreaterThan(0);
  expect(frame.mock.calls.at(-1)![0].available).toBe(true);
  expect(mock.analyser.getFloatTimeDomainData).toHaveBeenCalledTimes(5);
  stop(); stop(); vi.advanceTimersByTime(500);
  expect(frame).toHaveBeenCalledTimes(5); expect(vi.getTimerCount()).toBe(0);
  expect(mock.source.disconnect).toHaveBeenCalledOnce(); expect(mock.analyser.disconnect).toHaveBeenCalledOnce(); expect(mock.context.close).toHaveBeenCalledOnce();
  expect(mock.stopTrack).not.toHaveBeenCalled();
});

it("does not emit or start sampling when stopped before asynchronous resume completes", async () => {
  vi.useFakeTimers(); let resume!: () => void;
  const mock = audioMock(() => new Promise<void>(resolve => { resume = resolve; })), frame = vi.fn();
  const stop = startSpeechActivity(mock.stream, frame); stop(); resume();
  await settle(); vi.advanceTimersByTime(500);
  expect(frame).not.toHaveBeenCalled(); expect(mock.context.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("falls back when startup remains suspended and ignores a late resume", async () => {
  vi.useFakeTimers(); let resume!: () => void;
  const mock = audioMock(() => new Promise<void>(resolve => { resume = resolve; })), frame = vi.fn();
  startSpeechActivity(mock.stream, frame);
  vi.advanceTimersByTime(1499); expect(frame).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(frame).toHaveBeenCalledExactlyOnceWith({ level: 0, speaking: false, available: false });
  expect(mock.context.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  resume(); await settle(); vi.advanceTimersByTime(500);
  expect(frame).toHaveBeenCalledOnce(); expect(mock.analyser.getFloatTimeDomainData).not.toHaveBeenCalled();
});

it("reports unavailable when resume resolves without a running context", async () => {
  vi.useFakeTimers();
  const mock = audioMock(), frame = vi.fn(); mock.context.state = "suspended";
  startSpeechActivity(mock.stream, frame); await settle();
  expect(frame).toHaveBeenCalledExactlyOnceWith({ level: 0, speaking: false, available: false });
  expect(mock.context.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("cleans up resume rejection and sampling failure without affecting recording", async () => {
  vi.useFakeTimers();
  const failed = audioMock(() => Promise.reject(new Error("Audio is unavailable"))), first = vi.fn();
  expect(() => startSpeechActivity(failed.stream, first)).not.toThrow();
  await settle(); expect(first).toHaveBeenCalledExactlyOnceWith({ level: 0, speaking: false, available: false }); expect(failed.context.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  const broken = audioMock(), second = vi.fn();
  broken.analyser.getFloatTimeDomainData.mockImplementation(() => { throw new Error("Analyzer closed"); });
  startSpeechActivity(broken.stream, second); await settle();
  expect(second).toHaveBeenCalledExactlyOnceWith({ level: 0, speaking: false, available: false }); expect(broken.context.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("is optional when Web Audio is unavailable and closes a partially constructed graph on failure", async () => {
  vi.stubGlobal("AudioContext", undefined); vi.stubGlobal("webkitAudioContext", undefined);
  const frame = vi.fn(); expect(() => startSpeechActivity({} as MediaStream, frame)()).not.toThrow();
  expect(frame).toHaveBeenCalledExactlyOnceWith({ level: 0, speaking: false, available: false });
  const mock = audioMock(); mock.context.createMediaStreamSource.mockImplementation(() => { throw new Error("Stream unavailable"); });
  expect(() => startSpeechActivity(mock.stream, frame)()).not.toThrow();
  await settle(); expect(mock.analyser.disconnect).toHaveBeenCalledOnce(); expect(mock.context.close).toHaveBeenCalledOnce();
});
