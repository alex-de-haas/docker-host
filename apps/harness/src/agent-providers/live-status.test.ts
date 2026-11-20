import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { AgentHistoryObservation, AgentWatchItem } from "@hosty-sdk/app/agent";
import { CoreAgentBackend } from "./core.js";
import { publicProviderFixture } from "./test-fixture.js";

it("keeps a live completion ahead of a delayed state page and reports only confirmed history loss", async () => {
  const f = await publicProviderFixture(true);
  let returnState!: () => void, readingState!: () => void;
  const stateGate = new Promise<void>(resolve => { returnState = resolve; });
  const stateRequested = new Promise<void>(resolve => { readingState = resolve; });
  try {
    const chat = await f.manager.createSession({ createdBy: f.owner });
    await f.manager.postMessage(chat.id, "Run the task", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
    const { sessionId, runId } = f.starts[0]!;
    await vi.waitFor(() => expect(f.activeHistoryStreams()).toBe(1));
    const initial = f.snapshot(runId);
    // Switch the existing public peer to the live contract on its next connection.
    f.disconnectHistory();
    const warning = f.emit(runId, "warning", { code: "snapshot_truncated", message: "Only the tool snapshot is bounded." });
    const stale = f.snapshot(runId), terminal = f.complete(runId, "Finished during catch-up");
    const epoch = "fixture-history";
    const frame = (position: number, item: AgentWatchItem): AgentHistoryObservation => ({
      sessionId, runId, generation: initial.generation, userId: f.owner, principalId: f.owner, epoch,
      sessionPosition: position, cursor: "installation-" + position, item,
    });
    const earlier = [frame(1, { kind: "snapshot", snapshot: initial }), frame(2, { kind: "event", event: warning, cursor: stale.cursor })];
    const live = frame(3, { kind: "snapshot", snapshot: { ...terminal,
      coverage: { messages: "complete", tools: "truncated" } } });
    vi.spyOn(CoreAgentBackend.prototype, "liveHistory").mockResolvedValue({
      observe: async function* (_cursor, ready, signal) {
        await ready("boundary-2");
        await stateRequested;
        yield live; yield live;
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      states: async through => {
        readingState(); await stateGate;
        return { through, nextSession: null, sessions: [{ sessionId, userId: f.owner, principalId: f.owner, epoch, head: 2, snapshot: stale }] };
      },
      range: async (_through, _session, _epoch, from, to) => ({
        observations: earlier.slice(from - 1, to).map(observation => ({ ...observation, sourceHistoryIncomplete: true as const })), nextPosition: null,
      }),
    });
    const events = () => f.store.readEvents(chat.id);
    const outcome = async () => {
      const record = await f.store.readRecord(chat.id), transcript = await events();
      expect(record?.status).toBe("idle");
      expect(record?.providerExecution?.run).toMatchObject({ state: "succeeded", stopConfirmed: true, revision: terminal.revision });
      expect(transcript.filter(e => e.type === "assistant_text" && e.text === "Finished during catch-up")).toHaveLength(1);
      expect(transcript.filter(e => e.type === "result" && e.status === "success")).toHaveLength(1);
    };
    await vi.waitFor(outcome, { timeout: 8000 });
    expect((await events()).filter(e => e.type === "notice")).toEqual([]);
    returnState();
    await vi.waitFor(async () => {
      expect((await f.store.readRecord(chat.id))?.providerHistoryGaps ?? []).toEqual([]);
      expect((await events()).filter(e => e.type === "notice").map(e => e.providerEventId))
        .toEqual([runId + ":source-history-incomplete"]);
    }, { timeout: 8000 });
    await outcome();
    expect(f.controls).toHaveLength(0);
    expect(f.starts).toHaveLength(1);
  } finally { returnState(); await f.close(); vi.restoreAllMocks(); }
}, 30000);
