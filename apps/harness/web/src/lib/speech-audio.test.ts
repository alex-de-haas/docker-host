import { afterEach, expect, it, vi } from "vitest";
import { chatSpeechLimits } from "../../../shared/speech";
import { pcmWave, recordingWave } from "./speech-audio";
import { pcmWave as feedbackWave } from "../components/feedback-composer/feedback-audio";

const capabilities = { version: 1, mediaTypes: ["audio/wav"], ready: true, maxDurationSeconds: 600, maxBytes: 19_204_096 };
afterEach(() => vi.unstubAllGlobals());

it("encodes the full ten-minute baseline, preserving signed samples and the WAV length", async () => {
  const samples = new Float32Array(600 * 16000); samples[0] = -1; samples[samples.length - 1] = 1;
  const wave = pcmWave(samples, chatSpeechLimits(capabilities));
  expect(wave.size).toBe(19_200_044);
  const bytes = new DataView(await wave.arrayBuffer());
  expect(bytes.getUint32(4, true)).toBe(wave.size - 8);
  expect(bytes.getInt16(44, true)).toBe(-32768); expect(bytes.getInt16(wave.size - 2, true)).toBe(32767);
  expect(() => pcmWave(new Float32Array(samples.length + 1))).toThrow("10:00");
  expect(() => pcmWave(new Float32Array())).toThrow();
  expect(() => feedbackWave(new Float32Array(120 * 16000 + 1))).toThrow("120 seconds");
});

it("takes the lowest safe duration from the app, provider duration and canonical WAV byte cap", () => {
  expect(chatSpeechLimits({ ...capabilities, maxDurationSeconds: 120 })).toEqual({ maxDurationSeconds: 120, maxBytes: 3_840_044 });
  expect(chatSpeechLimits({ ...capabilities, maxBytes: 44 + 75 * 16000 * 2 })).toEqual({ maxDurationSeconds: 75, maxBytes: 2_400_044 });
  expect(chatSpeechLimits({ ...capabilities, maxDurationSeconds: 3600 })).toEqual({ maxDurationSeconds: 600, maxBytes: 19_200_044 });
  expect(() => pcmWave(new Float32Array(76 * 16000), chatSpeechLimits({ ...capabilities, maxDurationSeconds: 75 }))).toThrow("1:15");
});

it.each([null, {}, { ...capabilities, maxBytes: Infinity }, { ...capabilities, maxDurationSeconds: NaN },
  { ...capabilities, maxDurationSeconds: -1 }, { ...capabilities, ready: false }, { ...capabilities, mediaTypes: ["audio/mp3"] }])("rejects unusable provider capabilities %j", value => {
  expect(() => chatSpeechLimits(value)).toThrow();
});

it("converts a long decoded recording at the selected limit and closes audio resources on failure", async () => {
  const close = vi.fn(), startRendering = vi.fn(async () => ({ getChannelData: () => new Float32Array(180 * 16000) }));
  let duration = 180;
  vi.stubGlobal("AudioContext", class { decodeAudioData = vi.fn(async () => ({ duration })); close = close; });
  const offline = vi.fn();
  vi.stubGlobal("OfflineAudioContext", class {
    destination = {}; startRendering = startRendering;
    constructor(...args: unknown[]) { offline(...args); }
    createBufferSource() { return { connect: vi.fn(), start: vi.fn(), buffer: null }; }
  });
  expect((await recordingWave(new Blob(["recording"]), chatSpeechLimits(capabilities))).size).toBe(44 + 180 * 16000 * 2);
  expect(offline).toHaveBeenCalledWith(1, 180 * 16000, 16000); expect(close).toHaveBeenCalledOnce();
  duration = 601;
  await expect(recordingWave(new Blob(["recording"]), chatSpeechLimits(capabilities))).rejects.toThrow("10:00");
  expect(close).toHaveBeenCalledTimes(2); expect(offline).toHaveBeenCalledTimes(1);
});
