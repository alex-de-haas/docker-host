import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AgentApiError, type AgentHistorySessionState, type AgentProviderRef } from "@hosty-sdk/app/agent";
import { agentReplayCursor } from "@hosty-sdk/app/agent/server";
import { durableWriteFile } from "../persistence.js";
import type { CoreAgentBackend } from "./core.js";
import type { HistoryReceipt, ProviderHistoryCoverage } from "./history-coverage.js";

type Connection = Awaited<ReturnType<CoreAgentBackend["liveHistory"]>>;
type Ancestry = { generation: string; cursor?: string };
type Delivery = {
  match(sessionId: string, userId: string): string | undefined;
  bindings(): { id: string; sessionId: string; userId: string }[];
  invalid(id: string, sessionId: string): Promise<void>;
  ready(): Promise<void>;
  receive(id: string, fact: HistoryReceipt): Promise<void>;
  state(id: string, state: AgentHistorySessionState): Promise<void>;
};

async function readAncestry(file: string): Promise<Ancestry> {
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved && typeof saved.generation === "string" && agentReplayCursor(saved.cursor)) return saved;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof AgentApiError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { generation: randomUUID() };
}

type Job = { id: string; sessionId: string; userId: string; epoch: string; from: number; to: number; through: string; due?: number; failures?: number };

/** A slow history page can retry from the same fixed boundary while SSE continues delivering. */
const retryable = (error: unknown) => error instanceof TypeError || error instanceof Error && error.name === "TimeoutError"
  || error instanceof AgentApiError && error.status >= 500 && error.retryable;

async function readPage<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let failures = 0; ; failures++) {
    signal.throwIfAborted();
    try { return await read(); }
    catch (error) {
      signal.throwIfAborted();
      if (!retryable(error)) throw error;
      await delay(Math.min(30000, 250 * 2 ** Math.min(failures, 7)), undefined, { signal, ref: false });
    }
  }
}

async function backfill(connection: Connection, provider: AgentProviderRef, through: string, generation: string,
  signal: AbortSignal, stop: AbortController, coverage: ProviderHistoryCoverage, delivery: Delivery) {
  const jobs: Job[] = [];
  const listed = new Set<string>();
  let afterSession: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await readPage(() => connection.states(through, afterSession), signal);
    for (const state of page.sessions) {
      signal.throwIfAborted();
      const { sessionId, epoch, head, userId } = state, id = delivery.match(sessionId, userId);
      if (!id) continue;
      listed.add(sessionId);
      try { await delivery.state(id, state); }
      catch (error) { signal.throwIfAborted(); await delivery.invalid(id, sessionId); }
      // If the local transcript or its receipts need recovery, preserve this session's facts
      // through the destination inbox while the other sessions continue independently.
      const gaps = await coverage.observeHead(id, provider, { sessionId, epoch, generation }, head, through).catch(async () => {
        signal.throwIfAborted();
        await delivery.invalid(id, sessionId);
        return head ? [{ from: 1, to: head, unavailable: false }] : [];
      });
      for (const gap of gaps) {
        if (!gap.unavailable && gap.from <= head) jobs.push({ id, userId, sessionId, epoch, from: gap.from, to: Math.min(gap.to, head), through });
      }
    }
    afterSession = page.nextSession ?? undefined;
  } while (afterSession);
  for (const { id, sessionId, userId } of delivery.bindings()) {
    if (listed.has(sessionId) || delivery.match(sessionId, userId) !== id) continue;
    signal.throwIfAborted();
    for (const gap of await coverage.unlisted(id, provider, sessionId, generation))
      jobs.push({ id, userId, sessionId, epoch: gap.epoch, from: gap.from, to: gap.to, through: gap.through ?? through });
  }

  const work = async () => {
    while (jobs.length) {
      signal.throwIfAborted();
      const now = Date.now(), ix = jobs.findIndex(candidate => !candidate.due || candidate.due <= now);
      if (ix < 0) {
        const next = jobs.reduce((earliest, candidate) => Math.min(earliest, candidate.due!), Infinity);
        await delay(Math.min(1000, Math.max(1, next - now)), undefined, { signal, ref: false });
        continue;
      }
      const job = jobs.splice(ix, 1)[0]!;
      const { id, sessionId, epoch, userId, to, from, through: cut } = job;
      if (delivery.match(sessionId, userId) !== id) continue;
      try {
        const page = await connection.range(cut, sessionId, epoch, from, to);
        for (const observation of page.observations) {
          signal.throwIfAborted();
          if (delivery.match(observation.sessionId, observation.userId) !== id ||
              observation.sessionId !== sessionId || observation.userId !== userId)
            throw new AgentApiError("history_owner_invalid", "Range history changed its destination.", 502);
          await delivery.receive(id, { ...observation, recoveryGeneration: generation, replayed: true });
        }
        if (page.nextPosition !== null) jobs.push({ ...job, from: page.nextPosition, due: undefined, failures: 0 });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AgentApiError && error.status === 410 && error.code === "history_range_unavailable")
          await coverage.unavailable(id, provider, { sessionId, epoch, generation }, from, to);
        else if (retryable(error)) {
          const failures = (job.failures ?? 0) + 1;
          jobs.push({ ...job, failures, due: Date.now() + Math.min(30000, 250 * 2 ** Math.min(failures - 1, 7)) });
        } else throw error;
      }
    }
  };
  // Independent intervals can complete in either order. A failure wakes sibling requests.
  const workers = Array.from({ length: Math.min(4, jobs.length) }, work);
  try { await Promise.all(workers); }
  catch (error) {
    stop.abort(error);
    await Promise.allSettled(workers);
    throw error;
  }
}

/** Keep the stream's ancestry check separate from the legacy contiguous replay cursor. */
export async function followLiveHistory(backend: CoreAgentBackend, provider: AgentProviderRef, ancestryFile: string,
  signal: AbortSignal, coverage: ProviderHistoryCoverage, delivery: Delivery,
  grant?: Awaited<ReturnType<CoreAgentBackend["historyOptions"]>>): Promise<void> {
  const lifetime = new AbortController(), combined = AbortSignal.any([signal, lifetime.signal]);
  const connection = await backend.liveHistory(provider, combined, grant);
  let ancestry = await readAncestry(ancestryFile), ready = false, repair: Promise<void> | undefined, repairFailure: unknown;
  const handshake = setTimeout(() => lifetime.abort(new DOMException("Provider live handshake timed out.", "TimeoutError")), 15000);
  const onReady = async (through: string) => {
    ready = true;
    clearTimeout(handshake);
    ancestry = { ...ancestry, cursor: through };
    await durableWriteFile(ancestryFile, JSON.stringify(ancestry));
    await delivery.ready();
    repair = backfill(connection, provider, through, ancestry.generation, combined, lifetime, coverage, delivery)
      .catch(error => { repairFailure = error; lifetime.abort(error); });
  };
  try {
    for await (const observation of connection.observe(ancestry.cursor, onReady, combined)) {
      combined.throwIfAborted();
      const id = delivery.match(observation.sessionId, observation.userId);
      if (!id) continue;
      if (observation.sessionPosition !== undefined && observation.epoch) {
        // After a crash this cursor validates the archive branch, and never skips uncommitted ranges.
        ancestry.cursor = observation.cursor;
        await durableWriteFile(ancestryFile, JSON.stringify(ancestry));
        coverage.activate(id, provider, { sessionId: observation.sessionId, epoch: observation.epoch, generation: ancestry.generation });
      }
      await delivery.receive(id, { ...observation, recoveryGeneration: ancestry.generation });
    }
    throw new AgentApiError("stream_closed", "The provider closed its live history stream.", 503, true);
  } catch (error) {
    if (!ready && ancestry.cursor && error instanceof AgentApiError && error.status === 410 && error.code === "history_cursor_invalid") {
      // A restored archive may reuse session ordinals. Prior coverage cannot attest to the replacement.
      await durableWriteFile(ancestryFile, JSON.stringify({ generation: randomUUID() }));
    }
    throw repairFailure ?? error;
  } finally {
    clearTimeout(handshake);
    lifetime.abort();
    await repair;
  }
}
