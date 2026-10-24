"use client";
import { appFetch } from "@hosty-sdk/app/browser-auth";

const PROTOCOL = "hosty-events-v1";
const SOCKET_PATH = "/api/event-stream";
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

/** Keep live event readers off the browser's limited same-origin HTTP/1 connection pool. */
export async function openEventStream(path: string, init: { signal?: AbortSignal } = {}): Promise<Response> {
  const { signal } = init;
  if (signal?.aborted) throw new DOMException("Event stream aborted.", "AbortError");
  if (typeof location === "undefined" || typeof WebSocket === "undefined")
    throw new Error("Live updates require a browser WebSocket connection.");
  // The short, authenticated request binds a one-use ticket to this view's exact stream and actor.
  // App credentials stay in appFetch and the server; they never enter a socket URL or another tab.
  const response = await appFetch("/api/event-stream-tickets", {
    method: "POST", signal, cache: "no-store", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) return response;
  const ticket = await response.json() as { ticket?: unknown; protocol?: unknown; path?: unknown } | null;
  if (signal?.aborted) throw new DOMException("Event stream aborted.", "AbortError");
  if (!ticket || ticket.protocol !== PROTOCOL || ticket.path !== SOCKET_PATH || typeof ticket.ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket.ticket))
    throw new Error("Hosty returned an invalid live-update ticket. Reload Harness to reconnect.");
  const url = new URL(SOCKET_PATH, location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise<Response>((resolve, reject) => {
    let reader!: ReadableStreamDefaultController<Uint8Array>;
    let socket: WebSocket | undefined;
    let opened = false, ended = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const finish = (error?: Error, cancelled = false) => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (socket) {
        socket.removeEventListener("open", open); socket.removeEventListener("message", message);
        socket.removeEventListener("error", failed); socket.removeEventListener("close", closed);
        try { socket.close(1000, "Stream closed"); } catch { /* Already disconnected. */ }
      }
      if (!cancelled) { if (error) reader.error(error); else reader.close(); }
      if (!opened) reject(error ?? new Error("Live updates disconnected before connecting. Retry to reconnect."));
    };
    const abort = () => finish(new DOMException("Event stream aborted.", "AbortError"));
    const open = () => {
      if (ended) return;
      if (socket?.protocol !== PROTOCOL) { finish(new Error("Hosty could not negotiate live updates. Reload Harness to reconnect.")); return; }
      opened = true;
      clearTimeout(timeout);
      resolve(new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } }));
    };
    const message = (event: MessageEvent) => {
      if (ended) return;
      if (typeof event.data !== "string") { finish(new Error("Hosty returned an invalid live-update frame.")); return; }
      // WebSocket has no receive backpressure. Close a stalled reader before its local queue
      // grows without bound; the existing sequence cursor recovers missed events on reconnect.
      if (event.data.length > MAX_BUFFER_BYTES) { finish(new Error("Live updates exceeded their receive buffer. Reconnecting…")); return; }
      const bytes = encoder.encode(event.data);
      if (bytes.byteLength > MAX_BUFFER_BYTES || bytes.byteLength > (reader.desiredSize ?? 0)) {
        finish(new Error("Live updates exceeded their receive buffer. Reconnecting…")); return;
      }
      reader.enqueue(bytes);
    };
    const failed = () => finish(new Error("Live updates disconnected. Retry to reconnect."));
    const closed = (event: CloseEvent) => finish(event.code === 1000 ? undefined : new Error("Live updates disconnected. Retry to reconnect."));
    const body = new ReadableStream<Uint8Array>({ start(controller) { reader = controller; }, cancel() { finish(undefined, true); } },
      { highWaterMark: MAX_BUFFER_BYTES, size: chunk => chunk.byteLength });
    try {
      socket = new WebSocket(url.href, [PROTOCOL, `ticket.${ticket.ticket}`]);
      socket.addEventListener("open", open); socket.addEventListener("message", message);
      socket.addEventListener("error", failed); socket.addEventListener("close", closed);
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => finish(new Error("Live updates could not connect. Retry to reconnect.")), CONNECT_TIMEOUT_MS);
      if (signal?.aborted) abort();
    } catch { finish(new Error("Live updates could not connect. Retry to reconnect.")); }
  });
}
