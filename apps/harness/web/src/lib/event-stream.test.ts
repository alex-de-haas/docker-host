import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { openEventStream } from "./event-stream";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn() }));
const ticket = "a".repeat(64), protocol = "hosty-events-v1";
const sockets: TestSocket[] = [];
class TestSocket extends EventTarget {
  protocol = protocol;
  readyState = 0;
  readonly close = vi.fn(() => { this.readyState = 3; });
  constructor(readonly url: string, readonly protocols: string[]) { super(); sockets.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(data: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data })); }
  end(code = 1000) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code })); }
}
const accepted = (value: unknown = { ticket, protocol, path: "/api/event-stream" }) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers(); sockets.length = 0;
  vi.stubGlobal("location", new URL("http://harness.hosty.localhost:22311/development?session=private"));
  vi.stubGlobal("WebSocket", TestSocket);
  vi.mocked(appFetch).mockReset().mockImplementation(async () => accepted());
});
afterEach(() => {
  for (const socket of sockets) socket.end();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

it("uses one authenticated ticket request and feeds raw SSE text through a same-origin socket", async () => {
  const pending = openEventStream("/api/sessions/one/events?after=7");
  await settle(); const socket = sockets[0]!;
  expect(appFetch).toHaveBeenCalledWith("/api/event-stream-tickets", expect.objectContaining({ method: "POST", cache: "no-store", body: JSON.stringify({ path: "/api/sessions/one/events?after=7" }) }));
  expect(socket.url).toBe("ws://harness.hosty.localhost:22311/api/event-stream");
  expect(socket.protocols).toEqual([protocol, `ticket.${ticket}`]);
  expect(socket.url).not.toContain(ticket); expect(socket.url).not.toContain("private");
  socket.open(); const response = await pending;
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  socket.message("event: stream.ready\ndata: {}\n\n");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: stream.ready\ndata: {}\n\n");
  await reader.cancel(); reader.releaseLock();
  expect(socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("opens eight independent view streams without holding any HTTP event request", async () => {
  const pending = Array.from({ length: 8 }, (_, index) => openEventStream(`/api/sessions/view-${index}/events?after=${index}`));
  await settle(); expect(sockets).toHaveLength(8);
  for (const socket of sockets) socket.open();
  const responses = await Promise.all(pending);
  expect(appFetch).toHaveBeenCalledTimes(8);
  for (const [url, init] of vi.mocked(appFetch).mock.calls) {
    expect(url).toBe("/api/event-stream-tickets"); expect(init?.method).toBe("POST");
  }
  expect(new Set(vi.mocked(appFetch).mock.calls.map(([, init]) => init?.body)).size).toBe(8);
  await Promise.all(responses.map(response => response.body!.cancel()));
  expect(sockets.every(socket => socket.close.mock.calls.length === 1)).toBe(true);
});

it("uses wss on an HTTPS app origin", async () => {
  vi.stubGlobal("location", new URL("https://harness.example/development"));
  const pending = openEventStream("/api/development-workspaces/events");
  await settle(); const socket = sockets[0]!; expect(socket.url).toBe("wss://harness.example/api/event-stream");
  socket.open(); await (await pending).body!.cancel();
});

it.each([401, 403, 404, 410])("returns the original terminal HTTP refusal without opening a socket (%i)", async status => {
  const response = new Response("refused", { status }); vi.mocked(appFetch).mockResolvedValueOnce(response);
  expect(await openEventStream("/api/sessions/one/events?after=0")).toBe(response);
  expect(sockets).toHaveLength(0); expect(appFetch).toHaveBeenCalledOnce(); await response.body!.cancel();
});

it.each([
  null,
  {},
  { ticket: "not-valid", protocol, path: "/api/event-stream" },
  { ticket, protocol: "other", path: "/api/event-stream" },
  { ticket, protocol, path: "https://foreign.example/api/event-stream" },
  { ticket, protocol, path: "/api/event-stream?ticket=secret" },
])("rejects an invalid or foreign ticket response", async value => {
  vi.mocked(appFetch).mockResolvedValueOnce(accepted(value));
  await expect(openEventStream("/api/development-workspaces/events")).rejects.toThrow("invalid live-update ticket");
  expect(sockets).toHaveLength(0); expect(appFetch).toHaveBeenCalledOnce();
});

it("does not spend a ticket whose request completes after caller abort", async () => {
  let finish!: (response: Response) => void;
  vi.mocked(appFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const abort = new AbortController(), pending = openEventStream("/api/development-workspaces/events", { signal: abort.signal });
  const refused = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  abort.abort(); finish(accepted()); await refused;
  expect(sockets).toHaveLength(0); expect(vi.mocked(appFetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("closes a connecting socket and removes all handlers when aborted", async () => {
  const abort = new AbortController(), pending = openEventStream("/api/development-workspaces/events", { signal: abort.signal });
  const refused = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await settle(); const socket = sockets[0]!;
  const remove = vi.spyOn(socket, "removeEventListener");
  abort.abort(); await refused;
  expect(socket.close).toHaveBeenCalledOnce(); expect(remove.mock.calls.map(([name]) => name).sort()).toEqual(["close", "error", "message", "open"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("aborts a connected reader without waiting for another frame", async () => {
  const abort = new AbortController(), pending = openEventStream("/api/development-workspaces/events", { signal: abort.signal });
  await settle(); const socket = sockets[0]!; socket.open(); const reader = (await pending).body!.getReader();
  const read = expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  abort.abort(); await read; reader.releaseLock();
  expect(socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("ends cleanly on a normal server close and errors on abnormal close without SSE fallback", async () => {
  const first = openEventStream("/api/development-workspaces/events"); await settle(); sockets[0]!.open();
  const reader = (await first).body!.getReader(); sockets[0]!.end(); expect((await reader.read()).done).toBe(true); reader.releaseLock();
  const second = openEventStream("/api/development-workspaces/events"); await settle(); sockets[1]!.open();
  const failed = (await second).body!.getReader(); sockets[1]!.end(1006); await expect(failed.read()).rejects.toThrow("Live updates disconnected"); failed.releaseLock();
  expect(appFetch).toHaveBeenCalledTimes(2); expect(sockets).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
});

it("bounds a stalled handshake without falling back to a long-lived HTTP fetch", async () => {
  const pending = openEventStream("/api/development-workspaces/events");
  const refused = expect(pending).rejects.toThrow("Live updates could not connect");
  await settle(); await vi.advanceTimersByTimeAsync(10_000); await refused;
  expect(sockets[0]!.close).toHaveBeenCalledOnce(); expect(appFetch).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("rejects an unexpected socket protocol or binary frame", async () => {
  const first = openEventStream("/api/development-workspaces/events"), refusal = expect(first).rejects.toThrow("negotiate live updates");
  await settle(); sockets[0]!.protocol = "unexpected"; sockets[0]!.open(); await refusal;
  const second = openEventStream("/api/development-workspaces/events"); await settle(); sockets[1]!.open();
  const reader = (await second).body!.getReader(); sockets[1]!.message(new Uint8Array([1]));
  await expect(reader.read()).rejects.toThrow("invalid live-update frame"); reader.releaseLock();
  expect(sockets.every(socket => socket.close.mock.calls.length === 1)).toBe(true);
});

it("fails explicitly outside a browser instead of opening an HTTP stream", async () => {
  vi.stubGlobal("WebSocket", undefined);
  await expect(openEventStream("/api/development-workspaces/events")).rejects.toThrow("browser WebSocket");
  expect(appFetch).not.toHaveBeenCalled();
});


it("bounds a stalled reader's byte queue and closes before a second frame overflows it", async () => {
  const pending = openEventStream("/api/development-workspaces/events"); await settle(); const socket = sockets[0]!; socket.open();
  const response = await pending;
  socket.message("x".repeat(1024 * 1024)); socket.message("overflow");
  const reader = response.body!.getReader(); await expect(reader.read()).rejects.toThrow("receive buffer"); reader.releaseLock();
  expect(socket.close).toHaveBeenCalledOnce(); expect(appFetch).toHaveBeenCalledOnce();
});

it.each(["x".repeat(1024 * 1024 + 1), "é".repeat(600_000)])("bounds an individual frame by encoded bytes", async frame => {
  const pending = openEventStream("/api/development-workspaces/events"); await settle(); const socket = sockets[0]!; socket.open();
  const reader = (await pending).body!.getReader(), read = expect(reader.read()).rejects.toThrow("receive buffer");
  socket.message(frame); await read; reader.releaseLock(); expect(socket.close).toHaveBeenCalledOnce();
});
