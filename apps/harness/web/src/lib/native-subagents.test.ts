import { describe, expect, it } from "vitest";
import type { AssistantEvent } from "./assistant-api";
import { emptyTranscriptStreams, nativeAgentKey, nativeAgentStatus, nativeAgentTranscript, nativeSource, receiveTranscriptText } from "./native-subagents";
import { transcriptItems } from "./transcript-items";

const source = { provider: { appId: "independent.provider", installationId: "install", key: "agent" }, runId: "run", generation: "generation", agentId: "child", parentAgentId: "root", parentToolCallId: "native-parent", parentTranscriptToolUseId: "parent" };
const event = (seq: number, type: string, extra = {}): AssistantEvent => ({ seq, ts: "2026-11-17T11:25:01Z", type, ...extra });
const child = (seq: number, type: string, extra = {}) => event(seq, type, { providerSource: source, ...extra });
const group = (events: AssistantEvent[]) => [...nativeAgentTranscript(events).groups.values()][0]!;

describe("native agent transcript", () => {
  it("keeps child messages and tools out of root output while leaving decisions actionable", () => {
    const input = [event(1, "user_message", { text: "Investigate" }), event(2, "tool_use", { toolUseId: "parent", toolName: "Agent", input: { description: "Research storage" }, providerSource: { ...source, agentId: "root", parentAgentId: undefined, parentToolCallId: undefined } }),
      child(3, "native_agent_status", { state: "running", freshness: "current" }), child(4, "assistant_text", { text: "Child findings" }), child(5, "tool_use", { toolName: "Read" }),
      child(6, "approval_request", { approvalId: "approval" }), child(7, "question_request", { questionId: "question" }), event(8, "assistant_text", { text: "Root findings" })];
    const result = nativeAgentTranscript(input);
    expect(transcriptItems(result.events, new Set()).map(item => item.kind === "event" ? item.event.type : item.kind)).toEqual(["user_message", "native_agent_group", "approval_request", "question_request", "assistant_text"]);
    expect(result.events.some(event => event.text === "Child findings")).toBe(false);
    expect(group(input).agents[0]).toMatchObject({ label: "Research storage", parentLabel: "Main agent", lastAction: "Asked a question", events: expect.arrayContaining([input[3], input[4]]) });
    expect(new Set(transcriptItems(result.events, new Set()).map(item => item.key)).size).toBe(5);
  });

  it("keeps provider, run, generation and nested parent identities separate", () => {
    const nested = { ...source, agentId: "grandchild", parentAgentId: "child" };
    const other = { ...source, generation: "next" };
    const otherProvider = { ...source, provider: { ...source.provider, installationId: "other" } };
    const result = nativeAgentTranscript([child(1, "assistant_text"), child(2, "assistant_text", { providerSource: nested }), child(3, "assistant_text", { providerSource: other }), child(4, "assistant_text", { providerSource: otherProvider })]);
    expect(result.groups.size).toBe(4); expect(result.agents.size).toBe(4);
    expect(result.agents.get(nativeAgentKey(nested))?.parentLabel).toBe("Subagent 1");
  });

  it("joins only a child's actual launch, never a later send or an unclaimed tool", () => {
    const primary = { ...source, agentId: "root", parentAgentId: undefined, parentToolCallId: undefined };
    const input = [event(1, "tool_use", { providerSource: primary, toolName: "Agent: spawn", toolUseId: "parent", input: { prompt: "Original task" } }),
      event(2, "tool_use", { providerSource: primary, toolName: "Agent: sendInput", toolUseId: "followup", input: { prompt: "Follow up" } }),
      child(3, "native_agent_status", { state: "running", freshness: "current" }),
      child(4, "native_agent_status", { providerSource: { ...source, agentId: "other", parentTranscriptToolUseId: "followup" } })];
    const result = nativeAgentTranscript(input), [launched, other] = group(input).agents;
    expect(result.events).toContain(input[1]);
    expect(result.events).not.toContain(input[0]);
    expect(launched.prompt).toBe("Original task");
    expect(launched.launchEvents).toEqual([input[0]]);
    expect(other.prompt).toBeUndefined();
  });

  it("retains the latest child reply across backfill and folds its exact message once", () => {
    const input = [child(1, "native_agent_details", { prompt: "Delegated task", sourceSequence: "2" }),
      child(2, "assistant_text", { text: "Working" }), child(3, "assistant_text", { text: "New answer", providerEventId: "run:message:child:final" }),
      child(4, "native_agent_details", { result: "New answer", resultMessageId: "final", sourceSequence: "8" }),
      child(5, "native_agent_details", { result: "Old answer", sourceSequence: "4" }),
      child(6, "native_agent_details", { providerSource: { ...source, agentId: "other" }, result: "Independent result", resultTruncated: true })];
    const [one, two] = group(input).agents;
    expect(one).toMatchObject({ prompt: "Delegated task", result: "New answer", resultMessageSeq: 3 });
    expect(one.events).toEqual([input[1], input[2]]);
    expect(two).toMatchObject({ result: "Independent result", resultTruncated: true });
    expect(two.resultMessageSeq).toBeUndefined();
  });

  it("does not carry a previous response's message ID across a new answer or replay a stale result", () => {
    const input = [child(1, "assistant_text", { providerEventId: "run:message:child:first", text: "A" }),
      child(2, "assistant_text", { providerEventId: "run:message:child:third", text: "A" }),
      child(3, "native_agent_details", { sourceSequence: "20", result: "A" }),
      child(4, "native_agent_details", { sourceSequence: "3", resultMessageId: "first", result: "A" }),
      child(5, "native_agent_details", { sourceSequence: "12", result: "B" })];
    expect(group(input).agents[0].result).toBe("A");
    expect(group(input).agents[0].resultMessageSeq).toBeUndefined();
    expect(group([...input, child(6, "native_agent_details", { sourceSequence: "25", resultMessageId: "third" })]).agents[0].resultMessageSeq).toBe(2);
  });

  it("prefers full matching evidence over clipped summaries regardless of arrival order", () => {
    const full = child(4, "native_agent_details", { prompt: "Inspect settings", result: "All checks passed", sourceSequence: "8" });
    const partial = child(5, "native_agent_details", { prompt: "Inspect", promptTruncated: true, result: "All checks", resultTruncated: true, sourceSequence: "15" });
    for (const input of [[full, partial], [partial, full]]) expect(group(input).agents[0]).toMatchObject({
      prompt: "Inspect settings", result: "All checks passed", promptTruncated: false, resultTruncated: false });
    const malformed = child(6, "native_agent_details", { sourceSequence: "unknown", result: "Out of order" });
    expect(group([full, malformed]).agents[0].result).toBe("All checks passed");
  });

  it("recovers a legacy launch reply only with matching child evidence, or an explicit scoped message ID", () => {
    const primary = { ...source, agentId: "root", parentAgentId: undefined, parentToolCallId: undefined };
    const input = [event(1, "tool_use", { providerSource: primary, toolName: "Task", toolUseId: "parent", input: { prompt: "Delegated" } }),
      child(2, "assistant_text", { text: "Progress", providerEventId: "run:message:child:first" }),
      event(3, "tool_result", { providerSource: primary, toolUseId: "parent", status: "completed", output: "Started in background" })];
    expect(group(input).agents[0].result).toBeUndefined();
    const matching = [...input, child(4, "assistant_text", { text: "Answer" }), { ...input[2], output: "Answer" }];
    expect(group([matching[0], matching[1], matching[3], matching[4]]).agents[0]).toMatchObject({ result: "Answer", resultMessageSeq: 4 });
    expect(group([...input, child(4, "native_agent_details", { resultMessageId: "first" })]).agents[0]).toMatchObject({ result: "Progress", resultMessageSeq: 2 });
  });

  it("preserves historical source-less and arbitrary root-id messages without guessing a child", () => {
    const input = [event(1, "assistant_text", { text: "Historical answer" }), event(2, "assistant_text", { providerSource: { ...source, agentId: "provider-main", parentAgentId: undefined, parentToolCallId: undefined } })];
    expect(nativeSource(input[1])).toBeUndefined();
    expect(nativeAgentTranscript(input).events).toEqual(input);
    expect(nativeAgentTranscript(input).groups.size).toBe(0);
  });

  it("does not treat a child message or a root result as child completion", () => {
    const agent = group([child(1, "native_agent_status", { state: "running", freshness: "current", stopConfirmed: false }), child(2, "assistant_text"), event(3, "result", { status: "success" })]).agents[0]!;
    expect(nativeAgentStatus(agent, true).label).toBe("Running");
    expect(nativeAgentStatus(agent, false)).toMatchObject({ label: "Unknown", detail: "Last known: running" });
  });

  it("replays latest factual status and retains uncertainty until explicit settlement", () => {
    const events = [child(1, "native_agent_status", { state: "running", freshness: "current" }), child(2, "native_agent_status", { state: "unknown", lastKnownState: "running", freshness: "unavailable", stopConfirmed: false })];
    expect(nativeAgentStatus(group(events).agents[0]!, true)).toMatchObject({ label: "Unknown", detail: "Last known: running" });
    events.push(child(3, "native_agent_status", { state: "succeeded", freshness: "current", stopConfirmed: true }));
    expect(nativeAgentStatus(group(events).agents[0]!, false)).toMatchObject({ label: "Completed", detail: undefined });
  });

  it.each(["succeeded", "failed", "cancelled"])("preserves confirmed %s outcomes when the provider observation becomes unavailable", state => {
    const agent = group([child(1, "native_agent_status", { state, freshness: "last_known", stopConfirmed: true })]).agents[0]!;
    const label = state === "succeeded" ? "Completed" : state === "failed" ? "Failed" : "Cancelled";
    expect(nativeAgentStatus(agent, true).label).toBe(label);
    expect(nativeAgentStatus(agent, false).label).toBe(label);
    agent.status = { ...agent.status!, stopConfirmed: false };
    expect(nativeAgentStatus(agent, true).label).toBe("Unknown");
  });

  it("routes interleaved deltas and completions to their own agent and permits a delta-only child", () => {
    let streams = emptyTranscriptStreams();
    streams = receiveTranscriptText(streams, event(1, "assistant_delta", { text: "Root partial" }));
    streams = receiveTranscriptText(streams, child(2, "assistant_delta", { text: "Child partial" }));
    streams = receiveTranscriptText(streams, child(3, "assistant_delta", { providerSource: { ...source, agentId: "second" }, text: "Other partial" }));
    expect(nativeAgentTranscript([], streams.children).agents.size).toBe(2);
    streams = receiveTranscriptText(streams, child(4, "assistant_text", { text: "Child final" }));
    expect(streams.root).toBe("Root partial");
    expect(Object.values(streams.children).map(stream => stream.text)).toEqual(["Other partial"]);
    streams = receiveTranscriptText(streams, event(5, "assistant_text", { text: "Root final" }));
    expect(streams.root).toBe(""); expect(Object.values(streams.children)[0]!.text).toBe("Other partial");
  });
});
