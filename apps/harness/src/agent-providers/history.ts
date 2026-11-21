import { providerIdentityParts } from "../../shared/provider-reference.js";
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentApiError, type AgentHistoryObservation, type AgentHistorySessionState, type AgentProviderRef } from "@hosty-sdk/app/agent";
import { agentReplayCursor } from "@hosty-sdk/app/agent/server";
import { durableMkdir, durableWriteFile, syncDirectory } from "../persistence.js";
import type { CoreAgentBackend } from "./core.js";
import type { SessionStore } from "../sessions/store.js";
import { ProviderHistoryInbox } from "./history-inbox.js";
import { ProviderHistoryCoverage, type ProviderHistoryGap } from "./history-coverage.js";
import { followLiveHistory } from "./live-history.js";

export type { ProviderHistoryGap } from "./history-coverage.js";

export type HistoryContactIssue = "denied" | "invalid" | "unavailable";
const providerKey = (p: AgentProviderRef) => JSON.stringify(providerIdentityParts(p));
type InstallationFeed = { stop: AbortController; ready: Promise<boolean>; attempted: Promise<boolean>; done: Promise<void>; supported?: boolean; liveRanges?: boolean; retry?: AbortController };

async function readCheckpoint(filename: string): Promise<{ cursor: string; incomplete?: string[] } | undefined> {
  let raw: string;
  try { raw = await readFile(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const saved = JSON.parse(raw);
    if (saved?.version === 1 && typeof saved.cursor === "string" && agentReplayCursor(saved.cursor)
      && (saved.incomplete === undefined || Array.isArray(saved.incomplete) && saved.incomplete.every((id: unknown) => typeof id === "string")))
      return saved;
  } catch { /* A malformed checkpoint can be rebuilt from retained provider history. */ }
  await rename(filename, filename + ".invalid");
  await syncDirectory(path.dirname(filename));
  console.warn("[provider-history]", { stage: "checkpoint", reason: "invalid", recovery: "replay" });
}

/** Installation authority imports observations only into previously bound, owner-matching chats. */
export class ProviderHistoryFeeds {
  private readonly bindings = new Map<string, Map<string, Map<string, string>>>();
  private readonly current = new Map<string, { key: string; sessionId: string }>();
  private readonly feeds = new Map<string, InstallationFeed>();
  private readonly shutdown = new AbortController();

  private readonly inbox: ProviderHistoryInbox;
  private readonly coverage: ProviderHistoryCoverage;
  private readonly incomplete = new Set<string>();
  private readonly transport = new Map<string, HistoryContactIssue | null>();
  constructor(private readonly store: SessionStore, private readonly backend: CoreAgentBackend,
    importItem: (id: string, provider: AgentProviderRef, fact: AgentHistoryObservation & { replayed?: boolean }) => Promise<void>,
    private readonly contact: (id: string, issue: HistoryContactIssue | null) => Promise<void>,
    private readonly unsupported: (id: string) => void,
    gaps: (id: string, gaps: ProviderHistoryGap[]) => Promise<void> = async () => {},
    private readonly state: (id: string, provider: AgentProviderRef, state: AgentHistorySessionState) => Promise<void> = async () => {}) {
    this.coverage = new ProviderHistoryCoverage(store, gaps, (id, provider, sessionId) => {
      const binding = this.current.get(id);
      return binding?.key === providerKey(provider) && binding.sessionId === sessionId;
    });
    this.inbox = new ProviderHistoryInbox(store, this.shutdown.signal,
      (id, provider, fact) => this.coverage.accept(id, provider, fact, () => importItem(id, provider, fact)), async (id, failed) => {
      const binding = this.current.get(id);
      if (binding) await contact(id, failed ? "invalid" : this.transport.get(binding.key) ?? null);
    });
  }

  incompleteBindings(ids: string[]): void {
    const repaired = [...this.incomplete].some(id => !ids.includes(id));
    this.incomplete.clear();
    for (const id of ids) this.incomplete.add(id);
    if (repaired) for (const feed of this.feeds.values()) feed.retry?.abort();
  }

  bind(provider: AgentProviderRef, sessionId: string, chatId: string, owner: string, historical = false): void {
    const key = providerKey(provider);
    if (!historical) {
      const previous = this.current.get(chatId);
      if (previous && previous.key !== key) this.removeBindings(chatId, previous.key);
      if (previous?.key !== key || previous.sessionId !== sessionId) this.coverage.forget(chatId);
      this.current.set(chatId, { key, sessionId });
    }
    let sessions = this.bindings.get(key);
    if (!sessions) this.bindings.set(key, sessions = new Map());
    let chats = sessions.get(sessionId);
    if (!chats) sessions.set(sessionId, chats = new Map());
    const changed = chats.get(chatId) !== owner;
    chats.set(chatId, owner);
    const feed = this.feeds.get(key);
    if (changed && feed?.liveRanges) feed.retry?.abort();
    void this.inbox.resume(chatId).catch(() => {});
  }

  unbind(chatId: string): void {
    this.incomplete.delete(chatId);
    this.inbox.forget(chatId);
    this.coverage.forget(chatId);
    this.current.delete(chatId);
    this.removeBindings(chatId);
  }

  private removeBindings(chatId: string, installation?: string): void {
    for (const [key, sessions] of this.bindings) {
      if (installation && key !== installation) continue;
      for (const [sessionId, chats] of sessions) if (chats.delete(chatId) && !chats.size) sessions.delete(sessionId);
      if (sessions.size) continue;
      this.bindings.delete(key);
      this.transport.delete(key);
      const feed = this.feeds.get(key);
      if (!feed) continue;
      feed.stop.abort();
      void feed.done.then(() => { if (this.feeds.get(key) === feed) this.feeds.delete(key); });
    }
  }

  start(provider: AgentProviderRef, probeUpgrade = false): Promise<boolean> {
    const key = providerKey(provider), existing = this.feeds.get(key);
    if (this.shutdown.signal.aborted || !this.bindings.has(key)) return Promise.resolve(false);
    if (existing && !existing.stop.signal.aborted && !(probeUpgrade && existing.supported === false))
      return existing.supported === false ? Promise.resolve(false) : existing.ready;
    let decide!: (supported: boolean) => void, acknowledge!: (handled: boolean) => void;
    const ready = new Promise<boolean>(resolve => { decide = resolve; });
    const attempted = new Promise<boolean>(resolve => { acknowledge = resolve; });
    const feed: InstallationFeed = { stop: new AbortController(), ready, attempted, done: Promise.resolve() };
    this.feeds.set(key, feed);
    // A deleted installation binding may still be finishing its last cursor write.
    const follow = () => this.follow(provider, supported => {
      feed.supported = supported; decide(supported); acknowledge(supported);
    }, () => acknowledge(true), feed);
    feed.done = (existing ? existing.done.then(follow) : follow()).finally(() => { decide(false); acknowledge(false); });
    return ready;
  }

  refresh(provider: AgentProviderRef): Promise<boolean> {
    const key = providerKey(provider), existing = this.feeds.get(key);
    if (existing && existing.supported !== false) existing.retry?.abort();
    const ready = this.start(provider, true);
    // The background owner can wait for definitive capability evidence across a temporary outage.
    // The HTTP caller receives an acknowledgement after its first probe.
    return this.feeds.get(key)?.attempted ?? ready;
  }

  private async report(key: string, issue: HistoryContactIssue | null): Promise<void> {
    this.transport.set(key, issue);
    for (const [id, binding] of this.current) {
      if (binding.key !== key) continue;
      if (!issue && this.inbox.isBlocked(id)) continue;
      await this.contact(id, issue).catch(() => {});
    }
  }

  private match(key: string, sessionId: string, userId: string): string | undefined {
    const chats = this.bindings.get(key)?.get(sessionId);
    const matching = [...chats ?? []].filter(([, owner]) => owner === userId);
    if (matching.length > 1) for (const [id] of matching) this.incomplete.add(id);
    return matching.length === 1 ? matching[0]![0] : undefined;
  }

  private async follow(provider: AgentProviderRef, decide: (supported: boolean) => void, unavailable: () => void, feed: InstallationFeed): Promise<void> {
    const signal = AbortSignal.any([this.shutdown.signal, feed.stop.signal]), key = providerKey(provider);
    const directory = path.join(this.store.dataDir, "provider-history");
    const filename = path.join(directory, createHash("sha256").update(key).digest("hex") + ".json");
    let failures = 0, knownSupported = false, resetCursor = false;
    while (!signal.aborted) {
      const retry = feed.retry = new AbortController();
      const attempt = AbortSignal.any([signal, retry.signal]);
      const started = Date.now();
      let cursor: string | undefined, stage = "checkpoint", failed = false;
      try {
        const saved = await readCheckpoint(filename);
        if (saved) {
          // Revisit retained facts after formerly unreadable binding metadata becomes available.
          if (saved.incomplete?.some(id => !this.incomplete.has(id))) resetCursor = true;
          cursor = resetCursor ? undefined : saved.cursor; knownSupported = true;
        }
        await durableMkdir(directory);
        stage = "subscribe";
        const supported = () => { knownSupported = true; decide(true); };
        const grant = await this.backend.historyOptions(provider, attempt);
        try {
          await followLiveHistory(this.backend, provider, filename + ".live", attempt, this.coverage, {
            match: (session, owner) => this.match(key, session, owner),
            bindings: () => [...this.bindings.get(key) ?? []].flatMap(([sessionId, chats]) =>
              [...chats].map(([id, userId]) => ({ id, sessionId, userId }))),
            invalid: async (id, sessionId) => {
              const binding = this.current.get(id);
              if (binding?.key === key && binding.sessionId === sessionId) await this.contact(id, "invalid").catch(() => {});
            },
            ready: async () => { feed.liveRanges = true; supported(); failures = 0; await this.report(key, null); },
            receive: (id, observation) => this.inbox.deliver(id, provider, observation),
            state: (id, state) => this.state(id, provider, state),
          }, grant);
        } catch (error) {
          if (!(error instanceof AgentApiError && error.code === "history_live_unsupported")) throw error;
          feed.liveRanges = false;
        }
        for await (const observation of this.backend.history(provider, cursor, attempt, supported, () => this.report(key, null), grant)) {
          supported();
          signal.throwIfAborted(); stage = "import";
          const id = this.match(key, observation.sessionId, observation.userId);
          if (id) await this.inbox.deliver(id, provider, observation);
          signal.throwIfAborted();
          if (observation.item.kind === "event" && ["message.delta", "tool.output"].includes(observation.item.event.type)) continue;
          await durableWriteFile(filename, JSON.stringify({ version: 1, cursor: observation.cursor, ...(this.incomplete.size ? { incomplete: [...this.incomplete] } : {}) }));
          failures = 0; resetCursor = false; stage = "subscribe";
        }
        if (!attempt.aborted) throw new AgentApiError("stream_closed", "The provider closed its installation history stream.", 503, true);
      } catch (error) {
        if (signal.aborted) break;
        if (retry.signal.aborted) continue;
        failed = true;
        if (error instanceof AgentApiError && error.code === "history_unsupported") {
          const wasFollowing = feed.supported === true;
          this.transport.delete(key);
          decide(false);
          if (wasFollowing) {
            for (const [id, binding] of this.current) if (binding.key === key) this.unsupported(id);
          }
          return;
        }
        if (error instanceof AgentApiError && error.status === 410 && cursor && !resetCursor) {
          resetCursor = true; continue;
        }
        const issue = error instanceof AgentApiError && [401, 403].includes(error.status) ? "denied"
          : stage === "import" || stage === "checkpoint" || error instanceof AgentApiError && /invalid|budget/.test(error.code) ? "invalid" : "unavailable";
        // Keep a new binding waiting for a definitive capability result. A temporary failure
        // followed by an explicit legacy response must still start its per-run observer.
        if (knownSupported) decide(true);
        else unavailable();
        if (failures === 0) console.warn("[provider-history]", { stage, reason: issue, durationMs: Date.now() - started, retry: "scheduled" });
        await this.report(key, issue).catch(() => {});
      }
      failures = failed ? failures + 1 : 0;
      await delay(Math.min(30000, 250 * 2 ** Math.min(failures, 7)), undefined, { signal: attempt, ref: false }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.all([...this.feeds.values()].map(feed => feed.done));
    await this.inbox.wait();
  }
}

