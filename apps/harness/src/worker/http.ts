import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_COMMAND_BYTES, WORKER_PROTOCOL, WorkerApiError, terminal, type WorkerControl } from "./contracts.js";
import { authorizeService, type ServiceIdentity } from "./auth.js";
import type { WorkerEngine } from "./engine.js";

export async function readCommand(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > MAX_COMMAND_BYTES) throw new WorkerApiError(413, "command_limit", "Command exceeds the worker limit.");
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WorkerApiError(400, "invalid_json", "Send a JSON command."); }
}
export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
export type WorkerControlPlane = {
  capabilities(): Promise<object>;
  connection(operation: string, args: unknown[]): Promise<unknown>;
  models(connectionId: string): Promise<unknown>;
  configure(value: unknown): Promise<unknown>;
  attachment?(id: string, name: string, request: IncomingMessage): Promise<unknown>;
};
export function createWorkerServer(engine: WorkerEngine, identity: () => Promise<ServiceIdentity>, control: WorkerControlPlane) {
  return createServer((request, response) => {
    void route(request, response).catch(error => {
      if (response.headersSent) { response.end(); return; }
      const known = error instanceof WorkerApiError || error && typeof error.status === "number" && typeof error.code === "string";
      json(response, known ? error.status : 500, { code: known ? error.code : "worker_error",
        message: known ? error.message : "Worker operation failed. Check service logs." });
    });
  });
  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://worker"), method = request.method;
    if (method === "GET" && url.pathname === "/healthz") { json(response, 200, { status: "ok", protocol: WORKER_PROTOCOL }); return; }
    authorizeService(request, await identity());
    if (method === "GET" && url.pathname === "/v1/capabilities") { json(response, 200, { protocol: WORKER_PROTOCOL, ...await control.capabilities() }); return; }
    if (method === "PUT" && url.pathname === "/v1/coordinator") { json(response, 200, await control.configure(await readCommand(request))); return; }
    const attachment = url.pathname.match(/^\/v1\/conversations\/([A-Za-z0-9-]+)\/attachments\/([^/]+)$/);
    if (method === "PUT" && attachment && control.attachment) {
      json(response, 200, await control.attachment(attachment[1]!, decodeURIComponent(attachment[2]!), request)); return;
    }
    const provider = url.pathname.match(/^\/v1\/connections\/operations\/([a-z-]+)$/);
    if (method === "POST" && provider) {
      const value = await readCommand(request) as { args?: unknown };
      if (!Array.isArray(value?.args) || value.args.length > 4) throw new WorkerApiError(400, "invalid_arguments", "Invalid connection operation.");
      json(response, 200, await control.connection(provider[1]!, value.args)); return;
    }
    const models = url.pathname.match(/^\/v1\/connections\/([A-Za-z0-9-]+)\/models$/);
    if (method === "GET" && models) { json(response, 200, await control.models(models[1]!)); return; }
    const match = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9-]+)(?:\/(events|responses|cancel|configuration))?$/);
    if (!match) throw new WorkerApiError(404, "not_found", "Unknown worker route.");
    const id = match[1]!;
    if (method === "PUT" && !match[2]) { json(response, 202, await engine.submit(id, await readCommand(request))); return; }
    if (method === "GET" && !match[2]) { json(response, 200, (await engine.journal.load(id)).receipt); return; }
    if (method === "POST" && match[2] === "configuration") {
      const input = await readCommand(request) as { servers?: Record<string, unknown>; autoAllowedPrefixes?: string[] };
      if (!input?.servers || typeof input.servers !== "object" || Array.isArray(input.servers)) throw new WorkerApiError(400, "invalid_configuration", "Invalid MCP configuration.");
      json(response, 200, await engine.configure(id, input.servers, input.autoAllowedPrefixes)); return;
    }
    if (method === "POST" && match[2] === "responses") { json(response, 200, await engine.respond(id, await readCommand(request) as WorkerControl)); return; }
    if (method === "POST" && match[2] === "cancel") {
      const input = await readCommand(request) as { controlId: string };
      json(response, 200, await engine.cancel(id, input?.controlId)); return;
    }
    if (method === "GET" && match[2] === "events") {
      let cursor = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new WorkerApiError(400, "invalid_cursor", "Invalid event cursor.");
      await engine.journal.load(id);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      let dirty = true, draining = false, closed = false;
      const flush = async () => {
        dirty = true; if (draining) return; draining = true;
        try {
          while (dirty && !closed) {
            dirty = false;
            const record = await engine.journal.load(id);
            if (cursor > record.receipt.revision || cursor < record.receipt.revision && record.replayExpired) {
              response.write(`event: resync\ndata: ${JSON.stringify(record.receipt)}\n\n`); response.end(); return;
            }
            for (const frame of record.events.filter(frame => frame.sequence > cursor)) {
              cursor = frame.sequence;
              if (!response.write(`id: ${frame.sequence}\nevent: run\ndata: ${JSON.stringify(frame)}\n\n`)) {
                // Reconnect replays durable frames; do not buffer arbitrary output for a slow client.
                response.end(); return;
              }
            }
            if (terminal(record.receipt.state)) {
              response.write(`event: state\ndata: ${JSON.stringify(record.receipt)}\n\n`); response.end(); return;
            }
          }
        } finally { draining = false; }
      };
      const unsubscribe = engine.journal.subscribe(id, () => { void flush().catch(() => response.end()); });
      const timer = setInterval(() => response.write(": keep-alive\n\n"), 15000); timer.unref();
      response.on("close", () => { closed = true; clearInterval(timer); unsubscribe(); });
      await flush(); return;
    }
    throw new WorkerApiError(405, "method_not_allowed", "Unsupported worker operation.");
  }
}
