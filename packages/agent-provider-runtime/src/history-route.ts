import { sameProvider } from "./provider-ref.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { agentReplayCursor } from "@hosty-sdk/app/agent/server";
import type { ProviderController } from "./controller.js";
import type { HistoryAuthority } from "./history.js";

export async function serveHistory(controller: ProviderController, request: IncomingMessage, response: ServerResponse, url: URL) {
  const route = url.pathname.split("/").at(-1);
  const live = route === "live";
  controller.requireCapabilities(route === "events" ? ["installation-history"] : ["installation-history", "installation-history.live"]);
  if (request.method !== (route === "ack" ? "POST" : "GET")) throw new AgentApiError("method_not_allowed", "Unsupported history method.", 405);
  const paged = request.headers.accept?.split(",").some(value => value.split(";")[0]?.trim() === "application/json");
  const keys = Array.from(url.searchParams.keys());
  const allowed = route === "ack" ? ["sessionId", "epoch", "through"] : route === "states" ? ["through", "afterSession", "limit"]
    : route === "range" ? ["through", "epoch", "sessionId", "from", "to", "limit"]
    : paged && !live ? ["after", "through", "limit"] : ["after"];
  if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key)))
    throw new AgentApiError("invalid_input", "Unknown or duplicate history query parameter.", 400);
  const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer) throw new AgentApiError("token_required", "An installation history credential is required.", 401);
  const provider = controller.store.provider, history = controller.store.history;
  const authorize = async (expected?: HistoryAuthority) => {
    const actor = await controller.authority.history(bearer, provider.key), target = actor?.provider;
    if (!actor?.callerAppId || !actor.callerInstallation || !target || !sameProvider(target, provider) ||
        expected && (expected.callerAppId !== actor.callerAppId || expected.callerInstallation !== actor.callerInstallation))
      throw new AgentApiError("operation_mismatch", "This credential cannot observe this installation's provider history.", 403);
    if (!(Date.parse(actor.expiresAt) > Date.now())) throw new AgentApiError("token_expired", "Installation history authorization expired.", 401);
    return actor;
  };
  const actor = await authorize();
  let after = agentReplayCursor(url.searchParams.get("after"), typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined);
  const param = (name: string) => url.searchParams.get(name) ?? undefined;
  const positive = (name: string, fallback?: number) => {
    const value = param(name);
    if (value === undefined && fallback !== undefined) return fallback;
    if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new AgentApiError("invalid_input", "Invalid numeric history parameter.", 400);
    return Number(value);
  };
  if (route === "ack") {
    if (!actor.acknowledge) throw new AgentApiError("permission_denied", "The history credential does not authorize acknowledgement.", 403);
    const sessionId = param("sessionId"), epoch = param("epoch"), through = positive("through");
    if (!sessionId || sessionId.length > 512 || !epoch || epoch.length > 512)
      throw new AgentApiError("invalid_input", "Invalid durable history receipt.", 400);
    history.acknowledgeThrough(actor, sessionId, epoch, through);
    return { through };
  }
  const limit = positive("limit", 32);
  if (limit > 100) throw new AgentApiError("invalid_input", "Invalid history page size.", 400);
  if (route === "states") return history.states(actor, param("through"), param("afterSession"), limit);
  if (route === "range") {
    const sessionId = param("sessionId"), epoch = param("epoch"), through = param("through"), from = positive("from"), to = positive("to");
    if (!sessionId || sessionId.length > 512 || !epoch || !through || to < from)
      throw new AgentApiError("invalid_input", "Invalid session history range.", 400);
    return history.range(actor, through, sessionId, epoch, from, to, limit);
  }
  if (paged && !live) return history.page(actor, after, param("through"), limit);
  // The live mode validates the previous ancestry receipt but always starts at the current boundary.
  const boundary = history.currentBoundary(actor, after);
  if (live) after = boundary;
  const abort = new AbortController();
  const close = () => { abort.abort(); if (!response.destroyed) response.end(); };
  const send = async (chunk: string) => {
    if (abort.signal.aborted || Date.now() >= Date.parse(actor.expiresAt)) throw new Error("History subscription ended.");
    if (!response.write(chunk)) await once(response, "drain", { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]) });
  };
  let busy = false, pending = false, ready = false;
  const drain = async () => {
    busy = true;
    try {
      while (pending && !abort.signal.aborted) {
        pending = false;
        let page = history.page(actor, after, undefined, 32, true, live);
        for (;;) {
          for (const { cursor, ...observation } of page.observations) {
            await send("id: " + cursor + "\nevent: observation\ndata: " + JSON.stringify(observation) + "\n\n");
            after = cursor;
          }
          if (!page.nextCursor || abort.signal.aborted) break;
          await setImmediate();
          page = history.page(actor, after, page.through, 32, true, live);
        }
      }
    } catch { close(); }
    finally { busy = false; }
  };
  const flush = () => { pending = true; if (ready && !busy) void drain(); };
  const unsubscribe = history.subscribe(actor, flush);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  const finished = new Promise<void>(resolve => {
    const end = () => { abort.abort(); resolve(); };
    response.once("close", end); response.once("finish", end); request.once("aborted", end);
  });
  let checking = false;
  const check = setInterval(() => {
    if (checking) return;
    checking = true;
    void authorize(actor).catch(close).finally(() => { checking = false; });
  }, 30_000);
  const heartbeat = setInterval(() => { void send(": keepalive\n\n").catch(close); }, 15_000);
  const expiry = setTimeout(close, Date.parse(actor.expiresAt) - Date.now());
  try {
    await send(live ? "event: ready\ndata: " + JSON.stringify({ through: boundary }) + "\n\n" : ": ready\n\n");
    ready = true; flush(); await finished;
  }
  finally { unsubscribe(); clearInterval(check); clearInterval(heartbeat); clearTimeout(expiry); }
}
