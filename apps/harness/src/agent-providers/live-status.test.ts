import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { AgentHistoryObservation, AgentWatchItem } from "@hosty-sdk/app/agent";
import { SessionStore } from "../sessions/store.js";
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
    const stale = f.snapshot(runId), fullOutput = "x".repeat(20 * 1024);
    const message = f.emit(runId, "message.completed", { messageId: "earlier", text: "Complete earlier message" });
    const tool = f.emit(runId, "tool.completed", { toolCallId: "cmd", name: "Bash", state: "completed", output: fullOutput });
    const setup = f.emit(runId, "tool.completed", { toolCallId: "setup", name: "mcp__hosty-workspaces__environment_setup", state: "completed", output: "fixture-private-output" });
    const child = { agentId: "child", parentAgentId: "root", parentToolCallId: "spawn" };
    const assignment = f.emit(runId, "agent.updated", { agent: { ...child, state: "succeeded", stopConfirmed: true, prompt: "Recovered assignment" } }, child);
    const reply = f.emit(runId, "result.available", { result: { status: "succeeded", text: "Recovered child reply" } }, child);
    const terminal = f.complete(runId, "Finished during catch-up");
    const epoch = "fixture-history";
    const frame = (position: number, item: AgentWatchItem): AgentHistoryObservation => ({
      sessionId, runId, generation: initial.generation, userId: f.owner, principalId: f.owner, epoch,
      sessionPosition: position, cursor: "installation-" + position, item,
    });
    const earlier = [frame(1, { kind: "snapshot", snapshot: initial }), frame(2, { kind: "event", event: warning, cursor: stale.cursor })];
    for (const event of [message, tool, setup, assignment, reply]) earlier.push(frame(earlier.length + 1, { kind: "event", event, cursor: "cursor-" + event.sequence }));
    const live = frame(earlier.length + 1, { kind: "snapshot", snapshot: { ...terminal,
      messages: [...terminal.messages ?? [], { id: "earlier", source: { agentId: "root" }, role: "assistant", state: "complete", text: "Excerpt" }],
      tools: [{ id: "cmd", source: { agentId: "root" }, name: "Bash", state: "completed", output: fullOutput.slice(0, 8192), truncated: true }],
      coverage: { messages: "truncated", tools: "truncated" } } });
    vi.spyOn(CoreAgentBackend.prototype, "liveHistory").mockResolvedValue({
      observe: async function* (_cursor, ready, signal) {
        await ready("boundary-2");
        await stateRequested;
        yield live; yield live;
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      states: async through => {
        readingState(); await stateGate;
        return { through, nextSession: null, sessions: [{ sessionId, userId: f.owner, principalId: f.owner, epoch, head: earlier.length, snapshot: stale }] };
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
    expect((await events()).filter(e => e.type === "tool_result")).toEqual([expect.objectContaining({ output: fullOutput.slice(0, 8192), truncated: true })]);
    returnState();
    await vi.waitFor(async () => {
      expect((await f.store.readRecord(chat.id))?.providerHistoryGaps ?? []).toEqual([]);
      expect((await events()).filter(e => e.type === "notice").map(e => e.providerEventId))
        .toEqual([runId + ":source-history-incomplete"]);
    }, { timeout: 8000 });
    await outcome();
    const reopened = await new SessionStore(f.store.dataDir).readEvents(chat.id);
    expect(reopened.filter(e => e.type === "tool_result").map(e => [e.output, e.truncated])).toEqual([[fullOutput, undefined]]);
    expect(reopened.filter(e => e.type === "assistant_text").map(e => e.text)).toContain("Complete earlier message");
    expect(reopened.filter(e => e.type === "native_agent_details")).toMatchObject([
      { providerSource: child, prompt: "Recovered assignment" }, { providerSource: child, result: "Recovered child reply" }]);
    expect(reopened.filter(e => e.type === "native_agent_status")).toMatchObject([{ providerSource: child, state: "succeeded", stopConfirmed: true }]);
    expect(reopened.some(e => e.text === "Excerpt" || e.output === "fixture-private-output" || e.toolOutput === "fixture-private-output")).toBe(false);
    expect(f.controls).toHaveLength(0);
    expect(f.starts).toHaveLength(1);
  } finally { returnState(); await f.close(); vi.restoreAllMocks(); }
}, 30000);

it("recovers terminal lifecycle behind a newer live message after restarting the consumer", async () => {
  const f = await publicProviderFixture(true);
  try {
    const chat = await f.manager.createSession({ createdBy: f.owner });
    await f.manager.postMessage(chat.id, "Start", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
    const { sessionId, runId } = f.starts[0]!;
    await vi.waitFor(() => expect(f.activeHistoryStreams()).toBe(1));
    const initial = f.snapshot(runId);
    f.disconnectHistory();
    const terminal = f.complete(runId, "Final answer");
    const late = f.emit(runId, "message.completed", { messageId: "after-state", text: "Late evidence" });
    const newest = f.snapshot(runId), epoch = "reverse-race";
    const frame = (position: number, item: AgentWatchItem): AgentHistoryObservation => ({
      sessionId, runId, generation: initial.generation, userId: f.owner, principalId: f.owner, epoch,
      sessionPosition: position, cursor: "installation-" + position, item,
    });
    const earlier = [frame(1, { kind: "snapshot", snapshot: initial }), frame(2, { kind: "snapshot", snapshot: terminal })];
    const live = frame(3, { kind: "event", event: late, cursor: newest.cursor });
    const { messages: _messages, result: _result, ...compact } = terminal;
    let connection = 0;
    vi.spyOn(CoreAgentBackend.prototype, "liveHistory").mockImplementation(async (_provider, lifetime) => {
      const first = ++connection === 1;
      return {
        observe: async function* (_cursor, ready, signal) {
          await ready("boundary");
          if (first) yield live;
          if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
        states: async through => {
          if (first && !lifetime.aborted) await new Promise<void>(resolve => lifetime.addEventListener("abort", () => resolve(), { once: true }));
          return { through, nextSession: null, sessions: [{ sessionId, userId: f.owner, principalId: f.owner, epoch, head: first ? 2 : 3, snapshot: compact }] };
        },
        range: async (_through, _session, _epoch, from, to) => ({ observations: earlier.slice(from - 1, to), nextPosition: null }),
      };
    });
    await vi.waitFor(async () => {
      expect((await f.store.readProviderExecution(chat.id))?.run).toMatchObject({ state: "running", lastSequence: late.sequence });
      expect((await f.store.readEvents(chat.id)).filter(e => e.text === "Late evidence")).toHaveLength(1);
    }, { timeout: 8000 });
    await f.manager.shutdown();
    const reopened = f.makeManager();
    await reopened.manager.recoverProviderRuns();
    await vi.waitFor(async () => {
      expect((await reopened.store.readRecord(chat.id))?.status).toBe("idle");
      expect((await reopened.store.readProviderExecution(chat.id))?.run).toMatchObject({
        state: "succeeded", stopConfirmed: true, lastSequence: late.sequence, revision: newest.revision,
        cursor: newest.cursor, result: terminal.result,
      });
      const log = await reopened.store.readEvents(chat.id);
      expect(log.filter(e => e.text === "Final answer")).toHaveLength(1);
      expect(log.filter(e => e.text === "Late evidence")).toHaveLength(1);
      expect(log.filter(e => e.type === "result")).toHaveLength(1);
    }, { timeout: 8000 });
    await reopened.manager.postMessage(chat.id, "Continue", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
    expect(f.starts).toHaveLength(2);
  } finally { await f.close(); vi.restoreAllMocks(); }
}, 30000);
