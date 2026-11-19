import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { agentReplayCursor } from "@hosty-sdk/app/agent/server";
import type { ProviderController } from "./controller.js";
import type { HistoryAuthority } from "./history.js";

export async function serveHistory(controller: ProviderController, request: IncomingMessage, response: ServerResponse, url: URL) {
  controller.requireCapabilities(["installation-history"]);
  if (request.method !== "GET") throw new AgentApiError("method_not_allowed", "History is read-only.", 405);
  const paged = request.headers.accept?.split(",").some(value => value.split(";")[0]?.trim() === "application/json");
  const keys = Array.from(url.searchParams.keys());
  if (new Set(keys).size !== keys.length || keys.some(key => !(paged ? ["after", "through", "limit"] : ["after"]).includes(key)))
    throw new AgentApiError("invalid_input", "Unknown or duplicate history query parameter.", 400);
  const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer) throw new AgentApiError("token_required", "An installation history credential is required.", 401);
  const provider = controller.store.provider, history = controller.store.history;
  const authorize = async (expected?: HistoryAuthority) => {
    const actor = await controller.authority.history(bearer, provider.key), target = actor?.provider;
    if (!actor?.callerAppId || !actor.callerInstallation || target?.appId !== provider.appId || target.installationId !== provider.installationId || target.key !== provider.key ||
        expected && (expected.callerAppId !== actor.callerAppId || expected.callerInstallation !== actor.callerInstallation))
      throw new AgentApiError("operation_mismatch", "This credential cannot observe this installation's provider history.", 403);
    if (!(Date.parse(actor.expiresAt) > Date.now())) throw new AgentApiError("token_expired", "Installation history authorization expired.", 401);
    return actor;
  };
  const actor = await authorize();
  let after = agentReplayCursor(url.searchParams.get("after"), typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined);
  if (paged) {
    const limit = url.searchParams.get("limit");
    if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) throw new AgentApiError("invalid_input", "Invalid history page size.", 400);
    return history.page(actor, after, url.searchParams.get("through") ?? undefined, limit === null ? 32 : Number(limit));
  }
  // Reject a foreign, expired or ahead cursor before committing SSE headers.
  history.page(actor, after, undefined, 1);
  const abort = new AbortController();
  const close = () => { abort.abort(); if (!response.destroyed) response.end(); };
  const send = async (chunk: string) => {
    if (abort.signal.aborted || Date.now() >= Date.parse(actor.expiresAt)) throw new Error("History subscription ended.");
    if (!response.write(chunk)) await once(response, "drain", { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]) });
  };
  let busy = false, pending = false;
  const drain = async () => {
    busy = true;
    try {
      while (pending && !abort.signal.aborted) {
        pending = false;
        let page = history.page(actor, after, undefined, 32, true);
        for (;;) {
          for (const { cursor, ...observation } of page.observations) {
            await send("id: " + cursor + "\nevent: observation\ndata: " + JSON.stringify(observation) + "\n\n");
            after = cursor;
          }
          if (!page.nextCursor || abort.signal.aborted) break;
          await setImmediate();
          page = history.page(actor, after, page.through, 32, true);
        }
      }
    } catch { close(); }
    finally { busy = false; }
  };
  const flush = () => { pending = true; if (!busy) void drain(); };
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
  try { await send(": ready\n\n"); flush(); await finished; }
  finally { unsubscribe(); clearInterval(check); clearInterval(heartbeat); clearTimeout(expiry); }
}
