import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, expect, it, vi } from "vitest";
import { speechRoute } from "./speech.js";

const api = vi.hoisted(() => ({ permissions: vi.fn(), list: vi.fn(), speechCapabilities: vi.fn(), transcribe: vi.fn() }));
vi.mock("@hosty-sdk/app/providers/server", () => ({
  ProviderClient: class { permissions = api.permissions; list = api.list; speechCapabilities = api.speechCapabilities; transcribe = api.transcribe; },
}));

const capabilities = { version: 1, mediaTypes: ["audio/wav"], ready: true, maxDurationSeconds: 600, maxBytes: 19_204_096 };
beforeEach(() => { vi.resetAllMocks(); api.list.mockResolvedValue([]); api.speechCapabilities.mockResolvedValue(capabilities); api.transcribe.mockResolvedValue({ text: "recognized" }); });

it.each([
  [[], [], false, false],
  [["providers.speech-to-text"], [], true, false],
  [["providers.speech-to-text"], ["providers.speech-to-text"], true, true],
])("reports persisted optional consent separately from grants (%j, %j)", async (optional, granted, requestable, allowed) => {
  api.permissions.mockResolvedValue({ required: [], optional, granted });
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() });
  await speechRoute({ method: "GET" } as IncomingMessage, response as unknown as ServerResponse,
    new URL("http://harness.test/api/speech/providers"));
  expect(JSON.parse(response.end.mock.calls[0]![0])).toEqual({ granted: allowed, requestable, providers: [] });
  expect(api.list).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

function response() { return Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() }); }
function upload(chunks: Buffer[], contentLength?: number) {
  return Object.assign(Readable.from(chunks), { method: "POST", headers: { "content-type": "audio/wav", ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }) } });
}
const speechUrl = new URL("http://harness.test/api/speech/transcriptions?appId=speech&key=local");

it("returns limits only for an available, authorized selected provider", async () => {
  api.list.mockResolvedValue([{ appId: "speech", key: "local", available: true }]);
  const result = response();
  await speechRoute({ method: "GET" } as IncomingMessage, result as unknown as ServerResponse, new URL("http://harness.test/api/speech/capabilities?appId=speech&key=local"));
  expect(JSON.parse(result.end.mock.calls[0]![0])).toEqual(capabilities);
  expect(api.speechCapabilities).toHaveBeenCalledWith({ appId: "speech", key: "local" }, expect.any(AbortSignal));
  api.list.mockResolvedValue([]); api.speechCapabilities.mockClear();
  await expect(speechRoute(upload([]) as IncomingMessage, response() as unknown as ServerResponse, speechUrl)).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(api.speechCapabilities).not.toHaveBeenCalled();
});

it.each(["header", "stream"])("rejects provider-specific byte overflow from the %s before transcription", async mode => {
  api.list.mockResolvedValue([{ appId: "speech", key: "local", available: true }]);
  api.speechCapabilities.mockResolvedValue({ ...capabilities, maxDurationSeconds: 120, maxBytes: 3_844_096 });
  const bytes = 44 + 120 * 16000 * 2;
  const request = mode === "header" ? upload([], bytes + 1) : upload([Buffer.alloc(bytes), Buffer.alloc(1)]);
  await expect(speechRoute(request as IncomingMessage, response() as unknown as ServerResponse, speechUrl))
    .rejects.toMatchObject({ status: 413, code: "speech_audio_too_large", message: expect.stringContaining("2:00") });
  expect(api.transcribe).not.toHaveBeenCalled();
});

it("transfers a ten-minute payload with the extended deadline and propagates disconnects", async () => {
  api.list.mockResolvedValue([{ appId: "speech", key: "local", available: true }]);
  const result = response();
  api.transcribe.mockImplementation(async (_provider, audio: Blob, options: { timeoutMs: number; signal: AbortSignal }) => {
    expect(audio.size).toBe(44 + 600 * 16000 * 2); expect(options.timeoutMs).toBe(930_000);
    result.emit("close"); expect(options.signal.aborted).toBe(true);
    throw options.signal.reason;
  });
  await expect(speechRoute(upload([Buffer.alloc(44 + 600 * 16000 * 2)]) as IncomingMessage, result as unknown as ServerResponse, speechUrl)).rejects.toMatchObject({ name: "AbortError" });
  expect(result.listenerCount("close")).toBe(0);
});

it.each([null, { ...capabilities, ready: false }, { ...capabilities, maxBytes: 40 }, { ...capabilities, version: 2 }])("refuses unavailable or invalid limits without buffering/transcribing", async value => {
  api.list.mockResolvedValue([{ appId: "speech", key: "local", available: true }]); api.speechCapabilities.mockResolvedValue(value);
  await expect(speechRoute(upload([]) as IncomingMessage, response() as unknown as ServerResponse, speechUrl)).rejects.toMatchObject({ code: "speech_limits_unavailable", status: 503 });
  expect(api.transcribe).not.toHaveBeenCalled();
});

it("advertises manifest review on a capable Core even for legacy declarations", async () => {
  api.permissions.mockResolvedValue({ required: [], optional: [], granted: [], reviewAvailable: true });
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() });
  await speechRoute({ method: "GET" } as IncomingMessage, response as unknown as ServerResponse, new URL("http://harness.test/api/speech/providers"));
  expect(JSON.parse(response.end.mock.calls[0]![0])).toMatchObject({ granted: false, requestable: false, reviewAvailable: true });
});
