import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { AgentHistoryObservation, AgentRunSnapshot, AgentWatchItem } from "@hosty-sdk/app/agent";
import { SessionStore } from "../sessions/store.js";
import { CoreAgentBackend } from "./core.js";
import { publicProviderFixture } from "./test-fixture.js";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

it.each(["full snapshot", "earlier detail events"] as const)(
  "restores accounting from %s after the state summary has confirmed completion", async evidence => {
    const f = await publicProviderFixture(true);
    const rangeRequested = gate(), allowRange = gate(), allowDuplicate = gate(), duplicateRead = gate();
    try {
      const chat = await f.manager.createSession({ createdBy: f.owner });
      await f.manager.postMessage(chat.id, "Run the task", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
      await vi.waitFor(() => expect(f.activeHistoryStreams()).toBe(1));
      const { sessionId, runId } = f.starts[0]!, initial = f.snapshot(runId);
      const taskUsage = vi.fn(async () => {});
      f.manager.taskUsage = taskUsage;
      f.disconnectHistory();

      const executionUsage = { sequence: "8", activeMs: 1250, unknown: false };
      const usage = { usedTokens: 45, maxTokens: 1000, estimated: false, observedAt: "2026-11-19T18:00:00Z" };
      const items: AgentWatchItem[] = [{ kind: "snapshot", snapshot: initial }];
      let contextSequence: string | undefined;
      if (evidence === "earlier detail events") {
        const elapsed = f.emit(runId, "usage.updated", { execution: executionUsage });
        const context = f.emit(runId, "context.updated", { usage });
        for (const event of [elapsed, context]) items.push({ kind: "event", cursor: "cursor-" + event.sequence, event });
        contextSequence = context.sequence;
      }
      const terminal = f.complete(runId, "Final answer");
      const latestContext = { sequence: contextSequence ?? terminal.lastSequence, usage };
      const full = evidence === "full snapshot" ? { ...terminal, executionUsage, latestContext } : terminal;
      items.push({ kind: "event", cursor: full.cursor, event: { schemaVersion: "agent-event.1",
        type: "run.updated", source: { agentId: "root" }, runId, generation: full.generation,
        revision: full.revision, occurredAt: full.observedAt, sequence: full.lastSequence, data: { snapshot: full } } });
      // The state endpoint supplies terminal lifecycle fields before it returns accounting or result detail by range.
      const summary: AgentRunSnapshot = {
        ref: terminal.ref, sessionId, generation: terminal.generation, revision: terminal.revision,
        lastSequence: terminal.lastSequence, cursor: terminal.cursor, configurationRevision: terminal.configurationRevision,
        observedAt: terminal.observedAt, freshness: terminal.freshness, state: terminal.state, phase: terminal.phase,
        pending: [], effects: terminal.effects, stopConfirmed: true,
      };
      const epoch = "test-history";
      const records: AgentHistoryObservation[] = items.map((item, index) => ({
        sessionId, runId, userId: f.owner, principalId: f.owner, generation: terminal.generation,
        item, epoch, sessionPosition: index + 1, cursor: "installation-" + (index + 1),
      }));
      vi.spyOn(CoreAgentBackend.prototype, "liveHistory").mockResolvedValue({
        observe: async function* (_cursor, ready, signal) {
          await ready("terminal-boundary");
          await allowDuplicate.wait;
          yield records[records.length - 1]!;
          duplicateRead.release();
          if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
        states: async through => ({ through, nextSession: null, sessions: [{
          sessionId, epoch, userId: f.owner, principalId: f.owner, snapshot: summary, head: records.length,
        }] }),
        range: async (_through, _session, _epoch, from, to) => {
          rangeRequested.release();
          await allowRange.wait;
          return { observations: records.slice(from - 1, to), nextPosition: null };
        },
      });
      await rangeRequested.wait;
      const fromSummary = await f.store.readProviderExecution(chat.id);
      expect(fromSummary?.run).toMatchObject({ stopConfirmed: true, state: "succeeded", lastSequence: terminal.lastSequence });
      expect(fromSummary?.run?.executionUsage).toBeUndefined();
      expect(fromSummary?.run?.latestContext).toBeUndefined();
      expect(taskUsage).not.toHaveBeenCalled();
      allowRange.release();
      await vi.waitFor(async () => {
        expect((await f.store.readRecord(chat.id))?.providerHistoryGaps ?? []).toEqual([]);
        expect((await f.store.readHistoryRun(chat.id, runId))?.snapshot).toMatchObject({ executionUsage, latestContext });
      }, { timeout: 5000 });
      allowDuplicate.release();
      await duplicateRead.wait;

      const reopened = new SessionStore(f.store.dataDir), current = await reopened.readProviderExecution(chat.id);
      expect((await reopened.readRecord(chat.id))?.status).toBe("idle");
      expect(current?.run).toMatchObject({ stopConfirmed: true, state: "succeeded", revision: terminal.revision,
        lastSequence: terminal.lastSequence, executionUsage, latestContext });
      const events = await reopened.readEvents(chat.id);
      expect(events.filter(event => event.type === "context_usage").map(event => event.usage)).toEqual([usage]);
      expect(events.filter(event => event.type === "result" && event.status === "success")).toHaveLength(1);
      expect(taskUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: chat.id }), runId,
        { ...executionUsage, sequence: 8 });
      expect(f.controls).toHaveLength(0);
      expect(f.starts).toHaveLength(1);
    } finally {
      allowRange.release(); allowDuplicate.release();
      await f.close(); vi.restoreAllMocks();
    }
  }, 15000);

it("fills a delayed history range after a newer context observation has arrived live", async () => {
  const f = await publicProviderFixture(true);
  const allowRange = gate(), allowLive = gate();
  try {
    const chat = await f.manager.createSession({ createdBy: f.owner });
    await f.manager.postMessage(chat.id, "Run the task", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
    await vi.waitFor(() => expect(f.activeHistoryStreams()).toBe(1));
    const { sessionId, runId } = f.starts[0]!, initial = f.snapshot(runId);
    f.disconnectHistory();

    const executionUsage = { sequence: "8", activeMs: 1250, unknown: false };
    const usage = { usedTokens: 45, maxTokens: 1000, estimated: false, observedAt: "2026-11-24T10:00:00Z" };
    const elapsed = f.emit(runId, "usage.updated", { execution: executionUsage });
    const reply = f.emit(runId, "message.completed", { messageId: "reply", text: "Recovered reply" });
    const context = f.emit(runId, "context.updated", { usage });
    const latestContext = { sequence: context.sequence, usage };
    const items: AgentWatchItem[] = [
      { kind: "snapshot", snapshot: initial },
      ...[elapsed, reply, context].map(event => ({ kind: "event" as const, cursor: "cursor-" + event.sequence, event })),
    ];
    const epoch = "test-history";
    const records: AgentHistoryObservation[] = items.map((item, index) => ({
      sessionId, runId, userId: f.owner, principalId: f.owner, generation: initial.generation,
      item, epoch, sessionPosition: index + 1, cursor: "installation-" + (index + 1),
    }));
    const range = vi.fn(async (_through: string, _session: string, _epoch: string, from: number, to: number) => {
      await allowRange.wait;
      return { observations: records.slice(from - 1, to), nextPosition: null };
    });
    vi.spyOn(CoreAgentBackend.prototype, "liveHistory").mockResolvedValue({
      observe: async function* (_cursor, ready, signal) {
        await ready("before-live-context");
        await allowLive.wait;
        if (signal.aborted) return;
        yield records[3]!;
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      states: async through => ({ through, nextSession: null, sessions: [{
        sessionId, epoch, userId: f.owner, principalId: f.owner, snapshot: initial, head: 3,
      }] }),
      range,
    });

    await vi.waitFor(() => expect(range).toHaveBeenCalledWith("before-live-context", sessionId, epoch, 1, 3), { timeout: 5000 });
    allowLive.release();
    await vi.waitFor(async () => {
      expect((await f.store.readProviderExecution(chat.id))?.run).toMatchObject({ latestContext, lastSequence: context.sequence });
      expect((await f.store.readRecord(chat.id))?.providerHistoryGaps).toMatchObject([{ from: 1, to: 3 }]);
    }, { timeout: 5000 });

    allowRange.release();
    await vi.waitFor(async () => {
      const record = await f.store.readRecord(chat.id);
      expect(record?.providerHistoryGaps ?? []).toEqual([]);
      expect(record?.providerHistoryContact).toBeUndefined();
      expect((await f.store.readProviderExecution(chat.id))?.run).toMatchObject({
        state: "running", lastSequence: context.sequence, cursor: "cursor-" + context.sequence, latestContext, executionUsage,
      });
    }, { timeout: 5000 });
    const events = await f.store.readEvents(chat.id);
    expect(events.filter(event => event.type === "assistant_text").map(event => event.text)).toEqual(["Recovered reply"]);
    expect(f.controls).toHaveLength(0);
    expect(f.starts).toHaveLength(1);
  } finally {
    allowRange.release(); allowLive.release();
    await f.close(); vi.restoreAllMocks();
  }
}, 15000);
