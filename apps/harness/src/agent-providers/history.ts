import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentApiError, type AgentHistoryObservation, type AgentProviderRef } from "@hosty-sdk/app/agent";
import { agentReplayCursor } from "@hosty-sdk/app/agent/server";
import { durableMkdir, durableWriteFile, syncDirectory } from "../persistence.js";
import type { CoreAgentBackend } from "./core.js";
import type { SessionStore } from "../sessions/store.js";
import { ProviderHistoryInbox } from "./history-inbox.js";

export type HistoryContactIssue = "denied" | "invalid" | "unavailable";
const providerKey = (p: AgentProviderRef) => JSON.stringify([p.appId, p.installationId, p.key]);
type InstallationFeed = { stop: AbortController; ready: Promise<boolean>; attempted: Promise<boolean>; done: Promise<void>; supported?: boolean; retry?: AbortController };

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
  private readonly feeds = new Map<string, InstallationFeed>();
  private readonly shutdown = new AbortController();

  private readonly inbox: ProviderHistoryInbox;
  private readonly incomplete = new Set<string>();
  private readonly transport = new Map<string, HistoryContactIssue | null>();
  constructor(private readonly store: SessionStore, private readonly backend: CoreAgentBackend,
    importItem: (id: string, provider: AgentProviderRef, fact: AgentHistoryObservation & { replayed?: boolean }) => Promise<void>,
    private readonly contact: (id: string, issue: HistoryContactIssue | null) => Promise<void>) {
    this.inbox = new ProviderHistoryInbox(store, this.shutdown.signal, importItem, async (id, failed) => {
      for (const [key, sessions] of this.bindings) for (const chats of sessions.values()) if (chats.has(id)) {
        await contact(id, failed ? "invalid" : this.transport.get(key) ?? null);
        return;
      }
    });
  }

  incompleteBindings(ids: string[]): void {
    const repaired = [...this.incomplete].some(id => !ids.includes(id));
    this.incomplete.clear();
    for (const id of ids) this.incomplete.add(id);
    if (repaired) for (const feed of this.feeds.values()) feed.retry?.abort();
  }

  bind(provider: AgentProviderRef, sessionId: string, chatId: string, owner: string): void {
    const key = providerKey(provider);
    let sessions = this.bindings.get(key);
    if (!sessions) this.bindings.set(key, sessions = new Map());
    let chats = sessions.get(sessionId);
    if (!chats) sessions.set(sessionId, chats = new Map());
    chats.set(chatId, owner);
    void this.inbox.resume(chatId).catch(() => {});
  }

  unbind(chatId: string): void {
    this.incomplete.delete(chatId);
    this.inbox.forget(chatId);
    for (const [key, sessions] of this.bindings) {
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
    if (existing && !existing.stop.signal.aborted && !(probeUpgrade && existing.supported === false)) return existing.ready;
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
    for (const chats of this.bindings.get(key)?.values() ?? []) for (const id of chats.keys()) {
      if (!issue && this.inbox.isBlocked(id)) continue;
      await this.contact(id, issue).catch(() => {});
    }
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
        for await (const observation of this.backend.history(provider, cursor, attempt, supported, () => this.report(key, null))) {
          supported();
          signal.throwIfAborted(); stage = "import";
          const chats = this.bindings.get(key)?.get(observation.sessionId);
          const matching = [...chats ?? []].filter(([, owner]) => owner === observation.userId);
          if (matching.length > 1) for (const [id] of matching) this.incomplete.add(id);
          if (matching.length === 1) await this.inbox.deliver(matching[0]![0], provider, observation);
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
        if (!knownSupported && error instanceof AgentApiError && error.code === "history_unsupported") {
          this.transport.delete(key); decide(false); return;
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

