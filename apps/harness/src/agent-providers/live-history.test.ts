import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentApiError, type AgentHistoryObservation, type AgentHistorySessionState } from "@hosty-sdk/app/agent";
import { CoreAgentBackend } from "./core.js";
import { ProviderHistoryCoverage, type HistoryReceipt, type ProviderHistoryGap } from "./history-coverage.js";
import { followLiveHistory } from "./live-history.js";
import { ChatTranscript } from "../sessions/chat-transcript.js";
import { SessionStore } from "../sessions/store.js";

const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const provider = { appId: "other.provider", installationId: "test-installation", key: "agent" };
const epoch = "session-history-1", generation = "local-archive-1";
const chats = [
  { sessionId: "primary", userId: "alice" },
  { sessionId: "secondary", userId: "alice" },
  { sessionId: "separate", userId: "bob" },
];

function record(chat: typeof chats[number], n: number): AgentHistoryObservation {
  const { sessionId, userId } = chat, runId = "run-" + sessionId;
  return { sessionId, userId, principalId: userId, epoch, sessionPosition: n, cursor: sessionId + "-" + n,
    runId, generation: "run-1", item: { kind: "event", cursor: "run-cursor-" + n, event: {
      schemaVersion: "agent-event.1", runId, generation: "run-1", revision: "1", sequence: String(n),
      occurredAt: new Date(0).toISOString(), source: { agentId: "root" }, type: "message.completed",
      data: { messageId: "m-" + n, text: "Message " + n },
    } } };
}
function state(chat: typeof chats[number], head: number): AgentHistorySessionState {
  return { ...chat, principalId: chat.userId, epoch, head, snapshot: {
    ref: { provider, id: "run-" + chat.sessionId }, sessionId: chat.sessionId,
    generation: "run-1", revision: "1", state: "running", phase: "executing",
    stopConfirmed: false, freshness: "current", observedAt: new Date(0).toISOString(),
    configurationRevision: "1", lastSequence: String(head), cursor: "run-cursor-" + head,
    pending: [], effects: { certainty: "known", unresolvedCallIds: [] },
  } };
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

it("resumes both durable holes while new live records and other owners continue independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-live-ranges-")); folders.push(root);
  const store = new SessionStore(root), primary = chats[0]!;
  const saved = new Map(chats.map(chat => [chat.sessionId, new Set<number>()]));
  const gaps = new Map<string, ProviderHistoryGap[]>();
  const book = () => new ProviderHistoryCoverage(store, async (id, value) => { gaps.set(id, value); });
  let coverage = book();
  const deliver = (id: string, fact: HistoryReceipt) => coverage.accept(id, provider, fact, async () => {
    expect(chats.find(chat => chat.sessionId === id)?.userId).toBe(fact.userId);
    expect(saved.get(id)!.has(fact.sessionPosition!)).toBe(false);
    saved.get(id)!.add(fact.sessionPosition!);
  });
  const seed = (n: number) => deliver(primary.sessionId, { ...record(primary, n), recoveryGeneration: generation });
  // Durable commits before the first disconnect, a partial repair and the concurrent live tail.
  for (let n = 1; n <= 140; n++) await seed(n);
  for (let n = 181; n <= 185; n++) await seed(n);
  // A fresh process only has the durable coverage file and a separately validated stream cursor.
  coverage = book();
  const anchor = path.join(root, "ancestry.json");
  await writeFile(anchor, JSON.stringify({ cursor: "validated-185", generation }));
  const stop = new AbortController(), first = gate(), second = gate(), live = gate(), requested: Array<[string, number, number]> = [];
  const backend = new CoreAgentBackend({ coreOrigin: "http://core.test", appId: "consumer", serviceToken: "test" });
  vi.spyOn(backend, "liveHistory").mockResolvedValue({
    observe: async function* (cursor, onReady, signal) {
      expect(cursor).toBe("validated-185");
      await onReady("fixed-boundary");
      await live.promise;
      yield record(primary, 211);
      yield record(primary, 185); // A duplicate crossing the boundary cannot create a second message.
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    states: async through => ({ through, nextSession: null, sessions: chats.map(chat => state(chat, chat === primary ? 210 : 2)) }),
    range: async (through, sessionId, sourceEpoch, from, to) => {
      expect(through).toBe("fixed-boundary");
      expect(sourceEpoch).toBe(epoch);
      requested.push([sessionId, from, to]);
      if (sessionId === primary.sessionId) await (from === 141 ? first : second).promise;
      const chat = chats.find(entry => entry.sessionId === sessionId)!;
      return { observations: Array.from({ length: to - from + 1 }, (_, index) => record(chat, from + index)), nextPosition: null };
    },
  });
  const done = followLiveHistory(backend, provider, anchor, stop.signal, coverage, {
    match: (session, user) => chats.find(chat => chat.sessionId === session && chat.userId === user)?.sessionId,
    bindings: () => chats.map(chat => ({ ...chat, id: chat.sessionId })),
    ready: async () => {}, state: async () => {}, invalid: async () => {}, receive: deliver,
  }).catch(error => { if (!stop.signal.aborted) throw error; });
  try {
    await vi.waitFor(() => expect(requested).toHaveLength(4));
    expect(requested.filter(([id]) => id === primary.sessionId)).toEqual([["primary", 141, 180], ["primary", 186, 210]]);
    expect(gaps.get("primary")?.map(({ from, to }) => [from, to])).toEqual([[141, 180], [186, 210]]);
    live.open();
    await vi.waitFor(() => expect(saved.get("primary")!.has(211)).toBe(true));
    second.open();
    await vi.waitFor(() => expect(gaps.get("primary")?.map(({ from, to }) => [from, to])).toEqual([[141, 180]]), { timeout: 10000 });
    expect([...saved.get("separate")!]).toEqual([1, 2]); expect([...saved.get("secondary")!]).toEqual([1, 2]);
    first.open();
    await vi.waitFor(() => expect(gaps.get("primary")).toEqual([]), { timeout: 10000 });
    expect([...saved.get("primary")!].sort((a, b) => a - b)).toEqual(Array.from({ length: 211 }, (_, i) => i + 1));
  } finally {
    live.open(); first.open(); second.open(); stop.abort(); await done;
  }
}, 60000);

it("repairs fourteen scoped live writes after a single chat disk fills while another owner stays live", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-disk-repair-")); folders.push(root);
  const store = new SessionStore(root), [first, , second] = chats;
  const book = new ProviderHistoryCoverage(store, async () => {});
  const anchor = path.join(root, "anchor.json"), stop = new AbortController();
  const facts = Array.from({ length: 14 }, (_, i) => record(first!, i + 1));
  const journal = (id: string) => new ChatTranscript(path.join(root, id + ".sqlite"));
  journal(first!.sessionId).create(); journal(second!.sessionId).create();
  let full = true;
  const peer = vi.fn(async function* (_cursor, ready, signal) {
    await ready("before");
    for (const fact of facts) yield fact;
    yield record(second!, 1);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const backend = new CoreAgentBackend({ coreOrigin: "http://core.test", appId: "consumer", serviceToken: "test" });
  vi.spyOn(backend, "liveHistory").mockResolvedValue({
    observe: peer, states: async through => ({ through, sessions: [], nextSession: null }),
    range: async (_through, id, _epoch, from, to) => {
      expect(id).toBe(first!.sessionId);
      return { observations: facts.slice(from - 1, to), nextPosition: null };
    }
  });
  const source = followLiveHistory(backend, provider, anchor, stop.signal, book, {
    match: (session, user) => chats.find(chat => chat.sessionId === session && chat.userId === user)?.sessionId,
    bindings: () => [], ready: async () => {}, state: async () => {}, invalid: async () => {},
    receive: async (id, fact) => {
      if (id === first!.sessionId && full) throw Object.assign(new Error("chat disk full"), { code: "ENOSPC" });
      await book.accept(id, provider, fact, async () => {
        const chat = journal(id), input = chat.receive(provider, fact);
        if (!input) return;
        chat.append({ seq: fact.sessionPosition!, ts: new Date(0).toISOString(), type: "received", providerEventId: fact.cursor, item: fact.item });
        chat.projected(input);
      });
    }
  }).catch(error => { if (!stop.signal.aborted) throw error; });
  try {
    await vi.waitFor(() => expect(journal(second!.sessionId).read(0)).toHaveLength(1));
    expect(journal(first!.sessionId).read(0)).toEqual([]);
    full = false;
    await vi.waitFor(() => expect(journal(first!.sessionId).read(0).map(row => [row.providerEventId, row.item]))
      .toEqual(facts.map(fact => [fact.cursor, fact.item])), { timeout: 5000 });
    expect(journal(first!.sessionId).acknowledgements(provider)).toMatchObject([{ through: 14 }]);
    expect(peer).toHaveBeenCalledOnce();
  } finally { stop.abort(); await source; }
});

it("replays an overlapping page after a crash between the transcript commit and the coverage receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-history-receipt-")); folders.push(root);
  const store = new SessionStore(root), chat = chats[0]!, id = chat.sessionId;
  const scope = { sessionId: id, epoch, generation }, seen: ProviderHistoryGap[][] = [];
  const reopen = () => new ProviderHistoryCoverage(store, async (_id, gaps) => { seen.push(gaps); });
  let book = reopen(), crash = true;
  const page = [1, 2, 3].map(n => ({ ...record(chat, n), recoveryGeneration: generation }));
  const applyPage = async () => {
    for (const fact of page) await book.accept(id, provider, fact, async () => {
      // A transcript keyed by the provider fact ID has the same replay semantics as SessionManager.
      const filename = path.join(root, "fact-" + fact.sessionPosition);
      try { await writeFile(filename, JSON.stringify(fact), { flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (crash && fact.sessionPosition === 2) throw new Error("simulated process loss after transcript commit");
    });
  };
  await book.observeHead(id, provider, scope, 3, "page-at-3");
  await expect(applyPage()).rejects.toThrow("simulated process loss");
  book = reopen(); crash = false;
  expect(await book.observeHead(id, provider, scope, 3, "page-at-3")).toMatchObject([{ from: 2, to: 3 }]);
  await applyPage();
  await applyPage();
  expect((await readdir(root)).filter(name => name.startsWith("fact-")).sort()).toEqual(["fact-1", "fact-2", "fact-3"]);
  expect(seen.at(-1)).toEqual([]);
});

it("retains unavailable holes and checks omitted sessions at their highest durable receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-history-deleted-")); folders.push(root);
  const store = new SessionStore(root), id = chats[0]!.sessionId, scope = { sessionId: id, epoch, generation };
  const book = new ProviderHistoryCoverage(store, async () => {});
  await book.observeHead(id, provider, scope, 5, "page-at-5");
  for (const n of [1, 3, 9]) await book.accept(id, provider, { ...record(chats[0]!, n), recoveryGeneration: generation }, async () => {});
  await book.unavailable(id, provider, scope, 2, 2);
  const restored = new ProviderHistoryCoverage(store, async () => {});
  expect(await restored.unlisted(id, provider, id, generation)).toEqual([{ sessionId: id, epoch, from: 4, to: 8, through: id + "-9" }]);
  expect(await restored.unlisted(id, provider, id, "another-archive")).toEqual([]);
  expect(await restored.observeHead(id, provider, scope, 9, "page-at-9")).toEqual([
    { sessionId: id, epoch, from: 2, to: 2, unavailable: true },
    { sessionId: id, epoch, from: 4, to: 8 },
  ]);
});

it("resolves omitted-session gaps at each receipt boundary across deletion and new-session creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-history-omitted-")); folders.push(root);
  const store = new SessionStore(root), deleted = chats[0]!, newborn = chats[1]!;
  const earlier = new ProviderHistoryCoverage(store, async () => {});
  const scope = { sessionId: deleted.sessionId, epoch, generation };
  await earlier.observeHead(deleted.sessionId, provider, scope, 1, "prior-inventory");
  for (const n of [1, 4, 6])
    await earlier.accept(deleted.sessionId, provider, { ...record(deleted, n), recoveryGeneration: generation }, async () => {});

  const anchor = path.join(root, "ancestry.json"), stop = new AbortController(), receivedNewborn = gate();
  await writeFile(anchor, JSON.stringify({ cursor: record(deleted, 6).cursor, generation }));
  const gaps = new Map<string, ProviderHistoryGap[]>(), calls: [string, number, number, string][] = [];
  const book = new ProviderHistoryCoverage(store, async (id, value) => { gaps.set(id, value); });
  const backend = new CoreAgentBackend({ coreOrigin: "http://core.test", appId: "consumer", serviceToken: "test" });
  vi.spyOn(backend, "liveHistory").mockResolvedValue({
    observe: async function* (_cursor, ready, signal) {
      await ready("before-newborn");
      yield record(newborn, 3);
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    states: async through => { await receivedNewborn.promise; return { through, nextSession: null, sessions: [] }; },
    range: async (through, sessionId, _epoch, from, to) => {
      calls.push([sessionId, from, to, through]);
      // Requesting the newborn at the installation's earlier boundary would report it missing.
      if (sessionId === deleted.sessionId || through === "before-newborn")
        throw new AgentApiError("history_range_unavailable", "No session at this cut", 410);
      return { observations: [record(newborn, 1), record(newborn, 2)], nextPosition: null };
    },
  });
  const done = followLiveHistory(backend, provider, anchor, stop.signal, book, {
    match: (session, user) => chats.find(chat => chat.sessionId === session && chat.userId === user)?.sessionId,
    bindings: () => [deleted, newborn].map(chat => ({ ...chat, id: chat.sessionId })),
    state: async () => {}, invalid: async () => {}, ready: async () => {},
    receive: async (id, fact) => {
      await book.accept(id, provider, fact, async () => {});
      if (id === newborn.sessionId && fact.sessionPosition === 3) receivedNewborn.open();
    },
  }).catch(error => { if (!stop.signal.aborted) throw error; });
  try {
    await vi.waitFor(() => {
      expect(gaps.get(deleted.sessionId)).toMatchObject([{ from: 2, to: 3, unavailable: true }, { from: 5, to: 5, unavailable: true }]);
      expect(gaps.get(newborn.sessionId)).toEqual([]);
    });
    expect(calls).toEqual([
      [deleted.sessionId, 2, 3, record(deleted, 6).cursor], [deleted.sessionId, 5, 5, record(deleted, 6).cursor],
      [newborn.sessionId, 1, 2, record(newborn, 3).cursor],
    ]);
  } finally { stop.abort(); receivedNewborn.open(); await done; }
});

it("keeps transient HTTP retries on the live connection and settles every active page before reconnect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-history-abort-")); folders.push(root);
  const anchor = path.join(root, "ancestry.json"), stop = new AbortController();
  const entered = gate(), drain = gate(), closed = gate(), socketOpen = gate(), resume = gate(), seen = gate();
  const chat = chats[0]!, liveRecord = record(chat, 20);
  let attempts = 0, settled = false;
  const store = new SessionStore(root), book = new ProviderHistoryCoverage(store, async () => {});
  const backend = new CoreAgentBackend({ coreOrigin: "http://core.test", appId: "consumer", serviceToken: "test" });
  vi.spyOn(backend, "liveHistory").mockImplementation(async (_provider, signal) => ({
    observe: async function* (_cursor, ready) {
      await ready("fixed-boundary");
      socketOpen.open(); await resume.promise; yield liveRecord;
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    states: async through => ({ through, nextSession: null, sessions: [state(chat, 19)] }),
    range: async () => {
      if (!attempts++) throw new AgentApiError("provider_busy", "Retry page", 503, true);
      entered.open();
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      closed.open(); await drain.promise;
      signal.throwIfAborted(); throw new Error("Unexpected resume");
    },
  }));
  const done = followLiveHistory(backend, provider, anchor, stop.signal, book, {
    match: () => chat.sessionId, bindings: () => [{ ...chat, id: chat.sessionId }],
    state: async () => {}, invalid: async () => {}, ready: async () => {}, receive: async () => { seen.open(); },
  }).finally(() => { settled = true; });
  const failure = expect(done).rejects.toThrow();
  try {
    await socketOpen.promise; await entered.promise;
    resume.open(); await seen.promise;
    expect(backend.liveHistory).toHaveBeenCalledTimes(1);
    stop.abort(); await closed.promise;
    expect(settled).toBe(false);
  } finally { stop.abort(); resume.open(); drain.open(); await failure; }
});
