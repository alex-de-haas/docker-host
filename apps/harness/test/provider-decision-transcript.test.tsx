// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AgentPendingDecision } from "@hosty-sdk/app/agent";
import { publicProviderFixture, type PublicProviderFixture } from "../src/agent-providers/test-fixture";
import { providerDecisionCardId, type QuestionAnswers } from "../src/agent-providers/decision-identity";
import { approvalDecisions, cancelledQuestions, questionAnswers, transcriptDecisionId, TranscriptEvent } from "../web/src/components/transcript";
import type { AssistantEvent } from "../web/src/lib/assistant-api";

let fixture: PublicProviderFixture | undefined, root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await fixture?.close(); fixture = undefined; vi.unstubAllGlobals(); });

it("keeps reused provider question and approval IDs distinct through manager restart and UI controls", async () => {
  const f = fixture = await publicProviderFixture(), record = await f.manager.createSession({ createdBy: f.owner });
  await f.manager.postMessage(record.id, "First turn", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const firstRun = f.starts[0]!.runId;
  const question: AgentPendingDecision = { id: "same-question", revision: "1", kind: "question", delivery: "continue_run", questions: [
    { id: "choice", text: "Which check?", allowText: false, options: [{ id: "quick", label: "Check" }, { id: "full", label: "Check" }] },
    { id: "multiple", text: "Which details?", multiple: true, allowText: true, options: [{ id: "a", label: "Same" }, { id: "b", label: "Same" }] },
  ] };
  const approval: AgentPendingDecision = { id: "same-approval", revision: "1", kind: "approval", delivery: "continue_run", toolName: "Read" };
  const pause = (runId: string) => f.update(runId, { pending: [question, approval], state: "waiting_for_input", phase: "waiting" });
  pause(firstRun);
  await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).filter(event => ["question_request", "approval_request"].includes(event.type))).toHaveLength(2));
  const firstQuestion = providerDecisionCardId(firstRun, question.id), firstApproval = providerDecisionCardId(firstRun, approval.id);
  const originalAnswers = { choice: "quick", multiple: ["a", "b", "Own, exact"] };
  expect(await f.manager.resolveQuestion(record.id, firstQuestion, originalAnswers)).toBe(true);
  expect(await f.manager.resolveApproval(record.id, firstApproval, "allow")).toBe(true);
  f.update(firstRun, { pending: [], decisions: [{ decision: question, state: "resolved", response: { kind: "question", answers: originalAnswers } }, { decision: approval, state: "resolved", response: { kind: "approval", decision: "allow" } }] });
  f.complete(firstRun); await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("idle"));
  await f.manager.shutdown();
  const restored = f.makeManager(); await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
  await restored.manager.postMessage(record.id, "Second turn", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const secondRun = f.starts[1]!.runId; pause(secondRun);
  await vi.waitFor(async () => expect((await restored.store.readEvents(record.id)).filter(event => ["question_request", "approval_request"].includes(event.type))).toHaveLength(4));
  expect(await restored.manager.resolveQuestion(record.id, firstQuestion, { choice: "full" })).toBe(false);
  expect(await restored.manager.resolveApproval(record.id, firstApproval, "deny")).toBe(false);
  expect(f.controls.filter(control => control.path.endsWith("/responses"))).toHaveLength(2);

  const events = await restored.store.readEvents(record.id), answers = questionAnswers(events), decisions = approvalDecisions(events), cancelled = cancelledQuestions(events);
  // Existing public histories with raw IDs are read using their persisted run-qualified event ID.
  const oldQuestion = events.find(event => event.type === "question_request")!;
  const oldAnswer = events.find(event => event.type === "question_answered")!;
  expect(transcriptDecisionId({ ...oldQuestion, questionId: question.id })).toBe(firstQuestion);
  expect(questionAnswers([{ ...oldAnswer, questionId: question.id }]).get(firstQuestion)).toEqual(originalAnswers);
  const answer = vi.fn(async (id: string, value: QuestionAnswers) => { expect(await restored.manager.resolveQuestion(record.id, id, value)).toBe(true); });
  const decide = vi.fn(async (id: string, value: "allow" | "deny") => { expect(await restored.manager.resolveApproval(record.id, id, value)).toBe(true); });
  await act(async () => root.render(<>{events.filter(event => ["question_request", "approval_request"].includes(event.type)).map(event => <TranscriptEvent key={event.seq} event={event as AssistantEvent}
    decision={decisions.get(transcriptDecisionId(event)) ?? null} answers={answers.get(transcriptDecisionId(event)) ?? null} questionCancelled={cancelled.has(transcriptDecisionId(event))}
    denyReason={false} onAnswer={answer} onDecide={decide} />)}</>));
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(2);
  expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
  expect(container.textContent).toContain("Check [quick]; Same [a], Same [b], Own, exact");
  expect([...container.querySelectorAll("button")].filter(button => button.textContent === "Allow once")).toHaveLength(1);
  await act(async () => (container.querySelectorAll('[role="radio"]')[1] as HTMLElement).click());
  await act(async () => { for (const checkbox of container.querySelectorAll('[role="checkbox"]')) (checkbox as HTMLElement).click(); });
  await act(async () => {
    const text = container.querySelector<HTMLInputElement>('input[placeholder="Other…"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(text, "Own, exact"); text.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = [...container.querySelectorAll("button")].find(button => button.textContent === "Send answer")!;
  await act(async () => send.click());
  await vi.waitFor(() => expect(answer).toHaveBeenCalledWith(providerDecisionCardId(secondRun, question.id), { choice: "full", multiple: ["a", "b", "Own, exact"] }));
  await act(async () => { await answer.mock.results.at(-1)!.value; });
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Allow once")!.click());
  await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(providerDecisionCardId(secondRun, approval.id), "allow", undefined));
  await act(async () => { await decide.mock.results.at(-1)!.value; });
  await vi.waitFor(() => expect(f.controls.filter(control => control.path.endsWith("/responses"))).toHaveLength(4));
  expect(f.controls.filter(control => control.path.endsWith("/responses")).map(control => [control.runId, control.input.decisionId])).toEqual([
    [firstRun, question.id], [firstRun, approval.id], [secondRun, question.id], [secondRun, approval.id],
  ]);
  expect(events.filter(event => event.type === "question_answered")).toHaveLength(1);
  expect(f.controls.filter(control => control.path.endsWith("/responses"))[2]!.input.response).toEqual({ kind: "question", answers: { choice: "full", multiple: ["a", "b", "Own, exact"] } });
});
