import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { speechRoute as handleSpeech } from "./speech.js";
import { SpeechPreferences } from "./speech-preferences.js";
let temp: string, preferences: SpeechPreferences;
beforeEach(async () => { temp = await mkdtemp(path.join(os.tmpdir(), "harness-speech-")); preferences = new SpeechPreferences(temp); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
function speechRoute(request: IncomingMessage, response: ServerResponse, url: URL, userId = "alice", body = {}) {
  return handleSpeech(request, response, url, { preferences, userId, readJson: async () => body, ownsSession: async id => id === "owned" });
}

const api = vi.hoisted(() => ({ permissions: vi.fn(), list: vi.fn(), textToSpeechCapabilities: vi.fn(), synthesize: vi.fn(), speechCapabilities: vi.fn(), transcribe: vi.fn() }));
vi.mock("@hosty-sdk/app/providers/server", () => ({
  ProviderClient: class { permissions = api.permissions; listImplementations = api.list; textToSpeechCapabilities = api.textToSpeechCapabilities; synthesize = api.synthesize; speechCapabilities = api.speechCapabilities; transcribe = api.transcribe; },
}));

const capabilities = { version: 1, mediaTypes: ["audio/wav"], ready: true, maxDurationSeconds: 600, maxBytes: 19_204_096 };
beforeEach(() => { vi.resetAllMocks(); api.permissions.mockResolvedValue({ granted: ["providers.speech-to-text", "providers.text-to-speech"], optional: [] }); api.list.mockResolvedValue([]); api.speechCapabilities.mockResolvedValue(capabilities); api.transcribe.mockResolvedValue({ text: "recognized" }); });

it.each([
  [[], [], false, false],
  [["providers.speech-to-text"], [], true, false],
  [["providers.speech-to-text"], ["providers.speech-to-text"], true, true],
])("reports persisted optional consent separately from grants (%j, %j)", async (optional, granted, requestable, allowed) => {
  api.permissions.mockResolvedValue({ required: [], optional, granted });
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() });
  await speechRoute({ method: "GET" } as IncomingMessage, response as unknown as ServerResponse,
    new URL("http://harness.test/api/speech/providers"));
  expect(JSON.parse(response.end.mock.calls[0]![0])).toMatchObject({ granted: allowed, requestable, providers: [] });
  expect(api.list).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

function response() { return Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() }); }
function upload(chunks: Buffer[], contentLength?: number) {
  return Object.assign(Readable.from(chunks), { method: "POST", headers: { "content-type": "audio/wav", ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }) } });
}
const speechUrl = new URL("http://harness.test/api/speech/transcriptions?appId=speech&key=local");

it("returns limits only for an available, authorized selected provider", async () => {
  api.list.mockResolvedValue([{ appId: "speech", key: "local", installationId: "one", version: 1, displayName: "Speech", available: true }]);
  const result = response();
  await speechRoute({ method: "GET" } as IncomingMessage, result as unknown as ServerResponse, new URL("http://harness.test/api/speech/capabilities?appId=speech&key=local"));
  expect(JSON.parse(result.end.mock.calls[0]![0])).toEqual(capabilities);
  expect(api.speechCapabilities).toHaveBeenCalledWith(expect.objectContaining({ appId: "speech", key: "local", installationId: "one" }), expect.any(AbortSignal));
  api.list.mockResolvedValue([]); api.speechCapabilities.mockClear();
  await expect(speechRoute(upload([]) as IncomingMessage, response() as unknown as ServerResponse, speechUrl)).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(api.speechCapabilities).not.toHaveBeenCalled();
});

it.each(["header", "stream"])("rejects provider-specific byte overflow from the %s before transcription", async mode => {
  api.list.mockResolvedValue([{ appId: "speech", key: "local", installationId: "one", version: 1, displayName: "Speech", available: true }]);
  api.speechCapabilities.mockResolvedValue({ ...capabilities, maxDurationSeconds: 120, maxBytes: 3_844_096 });
  const bytes = 44 + 120 * 16000 * 2;
  const request = mode === "header" ? upload([], bytes + 1) : upload([Buffer.alloc(bytes), Buffer.alloc(1)]);
  await expect(speechRoute(request as IncomingMessage, response() as unknown as ServerResponse, speechUrl))
    .rejects.toMatchObject({ status: 413, code: "speech_audio_too_large", message: expect.stringContaining("2:00") });
  expect(api.transcribe).not.toHaveBeenCalled();
});

it("transfers a ten-minute payload with the extended deadline and propagates disconnects", async () => {
  api.list.mockResolvedValue([{ appId: "speech", key: "local", installationId: "one", version: 1, displayName: "Speech", available: true }]);
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
  api.list.mockResolvedValue([{ appId: "speech", key: "local", installationId: "one", version: 1, displayName: "Speech", available: true }]); api.speechCapabilities.mockResolvedValue(value);
  await expect(speechRoute(upload([]) as IncomingMessage, response() as unknown as ServerResponse, speechUrl)).rejects.toMatchObject({ code: "speech_limits_unavailable", status: 503 });
  expect(api.transcribe).not.toHaveBeenCalled();
});

it("advertises manifest review on a capable Core even for legacy declarations", async () => {
  api.permissions.mockResolvedValue({ required: [], optional: [], granted: [], reviewAvailable: true });
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() });
  await speechRoute({ method: "GET" } as IncomingMessage, response as unknown as ServerResponse, new URL("http://harness.test/api/speech/providers"));
  expect(JSON.parse(response.end.mock.calls[0]![0])).toMatchObject({ granted: false, requestable: false, reviewAvailable: true });
});

it("isolates settings by signed-in user and binds each role to the exact installed implementation", async () => {
  const work = { appId: "vendor", key: "api", installationId: "one", implementationId: "work", version: 1, displayName: "Vendor · Work", available: true };
  const local = { appId: "other", key: "local", installationId: "two", version: 1, displayName: "Local", available: true };
  const roster = [work, { ...work, implementationId: "personal", displayName: "Vendor · Personal" }];
  api.list.mockImplementation(async kind => kind === "text-to-speech" ? roster : [local]);
  async function request(method: string, path: string, userId: string, body = {}) {
    const result = response();
    await speechRoute({ method } as IncomingMessage, result as unknown as ServerResponse, new URL("http://test/api/speech/" + path), userId, body);
    return JSON.parse(result.end.mock.calls[0]![0]);
  }
  const initial = await request("GET", "settings", "alice");
  expect(initial.roles["speech-to-text"].selected.appId).toBe("other");
  expect(initial.roles["text-to-speech"].selected).toBeNull();
  const patch = { account: initial.account, revision: initial.revision, kind: "text-to-speech", choice: work };
  await expect(request("PUT", "settings", "bob", patch)).rejects.toMatchObject({ status: 409 });
  await request("PUT", "settings", "alice", patch);
  await expect(request("PUT", "settings", "alice", patch)).rejects.toMatchObject({ code: "preference_changed" });
  preferences = new SpeechPreferences(temp);
  const saved = await request("GET", "providers?kind=text-to-speech", "alice");
  expect(saved.selected.implementationId).toBe("work");
  expect((await request("GET", "providers?kind=text-to-speech", "bob")).selected).toBeNull();
  await expect(request("POST", "synthesis?binding=" + saved.binding, "bob", { sessionId: "owned", text: "Привет" })).rejects.toMatchObject({ code: "provider_unavailable" });
  api.textToSpeechCapabilities.mockResolvedValue({ ready: true, version: 1, mediaTypes: ["audio/pcm"], maxCharacters: 4000 });
  await expect(request("POST", "synthesis?binding=" + saved.binding, "alice", { sessionId: "other", text: "Привет" })).rejects.toMatchObject({ code: "session_unavailable" });
  expect(api.synthesize).not.toHaveBeenCalled();
  work.displayName = "Vendor · Renamed";
  expect((await request("GET", "providers?kind=text-to-speech", "alice")).selected.displayName).toBe("Vendor · Renamed");
  roster.splice(0, 1, { ...work, installationId: "reinstalled" });
  const removed = await request("GET", "providers?kind=text-to-speech", "alice");
  expect(removed.selected.installationId).toBe("one");
  await expect(request("POST", "synthesis?binding=" + saved.binding, "alice", { sessionId: "owned", text: "Привет" })).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(api.synthesize).not.toHaveBeenCalled();
});

it("never implicitly selects a sole named dictation provider or sends audio on a stale binding", async () => {
  const named = { appId: "speech", installationId: "one", key: "local", implementationId: "work", version: 1, displayName: "Speech · Work", available: true };
  api.list.mockResolvedValue([named]);
  const result = response();
  await speechRoute({ method: "GET" } as IncomingMessage, result as unknown as ServerResponse, new URL("http://test/api/speech/providers"));
  expect(JSON.parse(result.end.mock.calls[0]![0]).selected).toBeNull();
  await expect(speechRoute(upload([]) as IncomingMessage, response() as unknown as ServerResponse, speechUrl)).rejects.toMatchObject({ code: "provider_unavailable" });
  await preferences.save("alice", 0, "speech-to-text", named);
  await expect(speechRoute(upload([]) as IncomingMessage, response() as unknown as ServerResponse, speechUrl)).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(api.transcribe).not.toHaveBeenCalled();
});
