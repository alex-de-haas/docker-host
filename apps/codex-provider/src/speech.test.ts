import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { EventEmitter, once } from "node:events";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import type WebSocket from "ws";
import { ProviderError, type ProviderInvocation, type ProviderKind, type ProviderImplementationSnapshot } from "@hosty-sdk/app/providers";
import { CodexConnections, speechKinds } from "./connections.js";
import { SpeechCatalog } from "./speech-catalog.js";
import { speechRoutes } from "./speech.js";
import { transcribe, synthesize, transcriptionLanguage } from "./openai-speech.js";

let root: string, accounts: CodexConnections, catalog: SpeechCatalog | undefined, server: Server | undefined;
const secrets = new Map<string, string>();
const secretStore = { get: async (key: string) => secrets.get(key) ?? null, set: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "codex-speech-"));
  accounts = new CodexConnections(root, null, secretStore);
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server!.close(resolve)); server = undefined; }
  catalog?.close(); catalog = undefined;
  await accounts.shutdown(); secrets.clear(); await rm(root, { recursive: true, force: true });
});
const add = (name: string, key: string, roles?: readonly string[]) => accounts.update({ auth: "api-key", name, secret: key, ...(roles ? { publishedInterfaces: roles } : {}) });

it("keeps old connections off, validates choices, and identifies the exact paid credential", async () => {
  const a = await add("Work", "synthetic-a");
  const b = await add("Work", "synthetic-b");
  const statePath = path.join(root, "connections.json");
  const old = JSON.parse(await readFile(statePath, "utf8"));
  for (const account of old.connections) { delete account.publishedInterfaces; delete account.settingsRevision; }
  await accounts.shutdown();
  await writeFile(statePath, JSON.stringify(old));
  accounts = new CodexConnections(root, null, secretStore);
  expect(await accounts.speechImplementations()).toEqual([]);
  await expect(accounts.update({ auth: "chatgpt", name: "ChatGPT", publishedInterfaces: ["speech-to-text"] })).rejects.toMatchObject({ status: 400 });
  await expect(accounts.update({ auth: "host-login", name: "Host", hostDirectory: "/external", publishedInterfaces: [] })).rejects.toMatchObject({ status: 400 });
  await expect(accounts.update({ publishedInterfaces: ["unknown"] }, a.id)).rejects.toMatchObject({ status: 400 });
  await expect(accounts.update({ name: "Multiline\nlabel", publishedInterfaces: [speechKinds[0]] }, a.id)).rejects.toMatchObject({ code: "provider_name_invalid" });
  await accounts.update({ publishedInterfaces: [speechKinds[0]] }, a.id);
  await accounts.update({ publishedInterfaces: [speechKinds[1]] }, b.id);
  const [first, second] = await accounts.speechImplementations();
  expect(first!.roles).toEqual([speechKinds[0]]); expect(second!.roles).toEqual([speechKinds[1]]);
  await Promise.all([accounts.update({ publishedInterfaces: speechKinds }, a.id), accounts.update({ publishedInterfaces: speechKinds }, b.id)]);
  await accounts.setDefault(b.id);
  for (const role of speechKinds) {
    expect(await accounts.speechCredential(first!.id, role)).toBe("synthetic-a");
    expect(await accounts.speechCredential(second!.id, role)).toBe("synthetic-b");
    await expect(accounts.speechCredential(null, role)).rejects.toMatchObject({ code: "implementation_unavailable" });
  }
  await accounts.update({ name: "Renamed", publishedInterfaces: [speechKinds[1]] }, a.id);
  await expect(accounts.speechCredential(first!.id, speechKinds[0])).rejects.toMatchObject({ status: 409 });
  expect(await accounts.speechCredential(first!.id, speechKinds[1])).toBe("synthetic-a");
  await accounts.update({ secret: "synthetic-c" }, a.id);
  await expect(accounts.speechCredential(first!.id, speechKinds[1])).rejects.toMatchObject({ status: 409 });
  const replacement = (await accounts.speechImplementations()).find(entry => entry.displayName === "Renamed")!;
  expect(await accounts.speechCredential(replacement.id, speechKinds[1])).toBe("synthetic-c");
  await accounts.remove(b.id); await add("Work", "synthetic-d", speechKinds);
  await expect(accounts.speechCredential(second!.id, speechKinds[1])).rejects.toMatchObject({ status: 409 });
});

it("republishes the same snapshot across uncertainty and restart, then advances only the changed interface", async () => {
  const sent = new Map<ProviderKind, ProviderImplementationSnapshot>();
  let refuse = true;
  const core = { async publishImplementations(kind: ProviderKind, _key: string, snapshot: ProviderImplementationSnapshot) {
    sent.set(kind, structuredClone(snapshot));
    if (refuse) throw Error("Core offline");
    return { revision: snapshot.revision };
  } };
  await add("Personal", "synthetic-private", [speechKinds[0]]);
  catalog = new SpeechCatalog(accounts, root, core);
  await expect(catalog.refresh()).rejects.toThrow("Core offline");
  const previous = Object.fromEntries(sent);
  expect(JSON.stringify(previous)).not.toContain("synthetic-private");
  catalog.close(); refuse = false;
  catalog = new SpeechCatalog(accounts, root, core);
  await catalog.refresh();
  expect(Object.fromEntries(sent)).toEqual(previous);
  await add("Second", "synthetic-other", [speechKinds[1]]);
  await catalog.refresh();
  expect(sent.get(speechKinds[0])).toEqual(previous[speechKinds[0]]);
  expect(sent.get(speechKinds[1])!.revision).toBe(previous[speechKinds[1]]!.revision + 1);
});

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}

it("checks Core and the role at dispatch and routes Russian input to the selected account", async () => {
  const a = await add("One", "fixture-key-1", speechKinds);
  await add("Two", "fixture-key-2", speechKinds);
  const entries = await accounts.speechImplementations();
  let validations = 0, revoke = false, withdraw = false;
  const controller = new AbortController();
  const core = { validate: async (token: string, kind: ProviderKind) => {
    if (token === "first" && validations++ % 2 === 1) {
      if (revoke) throw new ProviderError("no_grant", "Grant revoked.", 403);
      if (withdraw) await accounts.update({ publishedInterfaces: [] }, a.id);
    }
    return { implementationId: token === "first" ? entries[0]!.id : token === "second" ? entries[1]!.id : undefined, kind } as ProviderInvocation;
  } };
  const adapter = { transcribe: vi.fn(async (_key: string, _bytes: Buffer, _lang: string | null, _signal: AbortSignal) => ({ text: "Привет" })),
    synthesize: vi.fn((_key: string, _text: string, _signal: AbortSignal) => Readable.from([Buffer.from([1, 0])])) };
  const route = speechRoutes(accounts, core, adapter, controller.signal);
  server = createServer((req, res) => { void route(req, res, new URL(req.url!, "http://test")); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/";
  const call = (token: string, kind: string, body: string | Buffer<ArrayBuffer>) => fetch(url + kind + "/v1/" + (kind === speechKinds[0] ? "transcriptions?language=ru-RU" : "speech"),
    { method: "POST", headers: { authorization: "Bearer " + token, "content-type": kind === speechKinds[0] ? "audio/wav" : "application/json" }, body });
  expect(await (await call("first", speechKinds[0], wav())).json()).toEqual({ text: "Привет" });
  expect(adapter.transcribe).toHaveBeenCalledWith("fixture-key-1", wav(), "ru", expect.any(AbortSignal));
  const malformed = await fetch(url + "speech-to-text/v1/transcriptions?language=ru--RU", {
    method: "POST", headers: { authorization: "Bearer second", "content-type": "audio/wav" }, body: wav(),
  });
  expect(malformed.status).toBe(400);
  expect(adapter.transcribe).toHaveBeenCalledTimes(1);
  const passage = "Двор № 17. Прочитайте: 32,5 километра.";
  const spoken = await call("second", speechKinds[1], JSON.stringify({ text: passage }));
  expect(spoken.headers.get("content-type")).toBe("audio/pcm;rate=24000");
  expect([...new Uint8Array(await spoken.arrayBuffer())]).toEqual([1, 0]);
  expect(adapter.synthesize).toHaveBeenCalledWith("fixture-key-2", passage, expect.any(AbortSignal));
  expect((await call("missing", speechKinds[0], wav())).status).toBe(403);
  revoke = true;
  expect((await call("first", speechKinds[0], wav())).status).toBe(403);
  withdraw = true; revoke = false;
  expect((await call("first", speechKinds[0], wav())).status).toBe(409);
  expect(adapter.transcribe).toHaveBeenCalledTimes(1);
});

it.each([
  ["ru-RU", "ru"], ["EN-us", "en"], ["es-419", "es"], ["cmn", "cmn"], ["yue-HK", "yue"],
  ["zh-CN", "zh-cn"], ["zh-Hant-TW", "zh-tw"], ["zh-HK", "zh-hk"], ["zh-SG", "zh"], [null, null],
])("normalizes the transcription hint %s to %s", (input, expected) => {
  expect(transcriptionLanguage(input)).toBe(expected);
});

it("uploads completed WAV with the current model and language hint; upstream errors expose no body", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ text: "тест" }))
    .mockResolvedValueOnce(new Response("private error detail", { status: 401 }))
    .mockResolvedValueOnce(new Response("private upstream input diagnosis", { status: 400 }));
  const signal = new AbortController().signal;
  expect(await transcribe("fixture", wav(), "ru", signal, fetcher)).toEqual({ text: "тест" });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/audio/transcriptions"); expect(init?.signal).toBe(signal);
  const form = init?.body as FormData;
  expect(form.get("model")).toBe("gpt-transcribe"); expect(form.get("languages[]")).toBe("ru");
  expect(Buffer.from(await (form.get("file") as Blob).arrayBuffer())).toEqual(wav());
  await expect(transcribe("fixture", wav(), null, signal, fetcher)).rejects.toMatchObject({ code: "speech_upstream_failed" });
  await expect(transcribe("fixture", wav(), "qq", signal, fetcher)).rejects.toMatchObject({ status: 400, code: "speech_input_invalid" });
});

class FakeSocket extends EventEmitter {
  sent: Record<string, any>[] = [];
  paused = false; stopped = false;
  send(json: string) { this.sent.push(JSON.parse(json)); }
  resume() { this.paused = false; } pause() { this.paused = true; }
  terminate() { this.stopped = true; } close() { this.stopped = true; }
  event(type: string, data: object = {}) { this.emit("message", Buffer.from(JSON.stringify({ type, ...data }))); }
}
it("streams only the chosen passage with PCM output and terminates the upstream socket on cancellation", async () => {
  const socket = new FakeSocket(), controller = new AbortController(), text = "Адрес: улица Мира, 21.";
  const open = vi.fn(() => socket as unknown as WebSocket);
  const audio = synthesize("fake-billing-project", text, controller.signal, open);
  expect(open).toHaveBeenCalledWith("fake-billing-project");
  socket.event("session.created"); socket.event("session.updated");
  expect(socket.sent[0]!.session.audio.output.format).toEqual({ type: "audio/pcm", rate: 24000 });
  expect(socket.sent[1]!.response.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text }] }]);
  const chunk = once(audio, "data");
  socket.event("response.output_audio.delta", { delta: "AQA=" });
  expect((await chunk)[0]).toEqual(Buffer.from([1, 0]));
  const error = once(audio, "error");
  controller.abort(); expect((await error)[0]).toMatchObject({ code: "speech_cancelled" });
  expect(socket.stopped).toBe(true);
});
