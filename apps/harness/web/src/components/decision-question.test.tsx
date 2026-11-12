// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DecisionRecord } from "@hosty-sdk/app/decisions";
import { DecisionAnswerForm, DecisionQuestion } from "./decision-question";
import { resolveDecision, readDecision, readDecisionWait, subscribeDecisionUpdates } from "@/lib/decisions";
vi.mock("@/lib/decisions", () => ({ resolveDecision: vi.fn(), readDecision: vi.fn(), readDecisionWait: vi.fn(), retryDecision: vi.fn(), subscribeDecisionUpdates: vi.fn() }));
let root: Root, element: HTMLDivElement;
const row = (): DecisionRecord => ({ id: crypto.randomUUID(), revision: 1, sequence: 1, userId: "alice", sourceAppId: "requester", sourceInstallation: "one", sourcePrincipal: "source", correlationHash: "hash",
  createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z", state: "pending", resolution: null, delivery: null, continuation: null,
  input: { correlationKey: "source-question", title: "Two choices", questions: ["q1", "q2"].map(id => ({ id, question: "Same wording?", allowText: true,
    options: [{ id: "a", label: "Same label", description: "First option" }, { id: "b", label: "Same label", description: "Second option" }] })) } });
const button = (text: string) => [...element.querySelectorAll("button")].find(b => b.textContent === text)!;
const click = async (selector: string) => act(async () => element.querySelector<HTMLInputElement>(selector)!.click());
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear();
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
it("requires explicit answers and preserves equal question and option labels as distinct identities", async () => {
  const record = row(); const saved = vi.fn(async () => {});
  vi.mocked(resolveDecision).mockImplementation(async (_, input) => ({ ...record, revision: 2, state: "answered", resolution: { revision: 2, userId: "alice", principalId: "alice", answers: input.answers, answeredAt: record.createdAt } }));
  await act(async () => root.render(<DecisionAnswerForm record={record} onSaved={saved} />));
  expect(button("Submit answer").disabled).toBe(true); expect(element.querySelectorAll("input:checked")).toHaveLength(0);
  await click('fieldset:nth-of-type(1) input[value="a"]'); await click('fieldset:nth-of-type(2) input[value="b"]');
  await act(async () => button("Submit answer").click());
  expect(vi.mocked(resolveDecision).mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 1, answers: { q1: { optionIds: ["a"] }, q2: { optionIds: ["b"] } } });
  expect(saved).toHaveBeenCalledTimes(1);
});
it("chat and inbox forms share an unsent draft only for the same addressed user and record", async () => {
  const record = row(), saved = async () => {};
  await act(async () => root.render(<><div data-view="chat"><DecisionAnswerForm record={record} onSaved={saved} /></div><div data-view="inbox"><DecisionAnswerForm record={record} onSaved={saved} /></div><div data-view="other"><DecisionAnswerForm record={{ ...record, userId: "bob" }} onSaved={saved} /></div></>));
  await click('[data-view="chat"] fieldset:first-of-type input[value="b"]');
  expect(element.querySelectorAll('[data-view="inbox"] input[value="b"]:checked')).toHaveLength(1);
  expect(element.querySelectorAll('[data-view="other"] input:checked')).toHaveLength(0);
});
it("freezes an uncertain submission, retains it after remount, and retries the exact request", async () => {
  const record = row(); vi.mocked(resolveDecision).mockRejectedValue(new Error("Lost receipt"));
  const render = () => root.render(<DecisionAnswerForm record={record} onSaved={async () => {}} />);
  await act(async () => render()); await click('fieldset:nth-of-type(1) input[value="a"]'); await click('fieldset:nth-of-type(2) input[value="b"]');
  await act(async () => button("Submit answer").click());
  expect(element.querySelectorAll("fieldset:disabled")).toHaveLength(2);
  await act(async () => root.render(null)); await act(async () => render());
  await act(async () => button("Check original submission").click());
  const calls = vi.mocked(resolveDecision).mock.calls; expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
});
it("background revision changes retain the draft but require review before a new submission", async () => {
  const record = row(); const render = (r: DecisionRecord) => root.render(<DecisionAnswerForm record={r} onSaved={async () => {}} />);
  await act(async () => render(record)); await click('fieldset:nth-of-type(1) input[value="a"]'); await click('fieldset:nth-of-type(2) input[value="b"]');
  await act(async () => render({ ...record, revision: 2 }));
  expect(element.querySelectorAll("input:checked")).toHaveLength(2); expect(button("Submit answer").disabled).toBe(true);
  await act(async () => button("I reviewed this revision").click()); expect(button("Submit answer").disabled).toBe(false);
});
it("renders an immutable saved answer and a separate blocked continuation without another Submit", async () => {
  const record = row(); record.state = "answered"; record.resolution = { revision: 2, userId: "alice", principalId: "alice", answers: { q1: { optionIds: ["b"] }, q2: { text: "Keep my detail" } }, answeredAt: record.createdAt };
  record.continuation = { revision: 2, commandId: "command", state: "blocked", reason: "unknown_stop", updatedAt: record.createdAt };
  await act(async () => root.render(<DecisionAnswerForm record={record} onSaved={async () => {}} />));
  expect(element.textContent).toContain("Answer saved"); expect(element.textContent).toContain("Continuation: blocked · unknown stop");
  expect([...element.querySelectorAll("button")].some(b => b.textContent === "Submit answer")).toBe(false);
  expect(readDecision).not.toHaveBeenCalled();
});
it("collapses a closed question to its saved answer and keeps every option behind a disclosure", async () => {
  const record = row(); record.state = "withdrawn"; record.reason = "The originating work was cancelled.";
  record.resolution = { revision: 2, userId: "alice", principalId: "alice", answers: { q1: { optionIds: ["b"], text: "Extra detail" } }, answeredAt: record.createdAt };
  record.continuation = { revision: 2, commandId: null, state: "cancelled", reason: "cancelled", updatedAt: record.createdAt };
  await act(async () => root.render(<DecisionAnswerForm record={record} onSaved={async () => {}} />));
  expect(element.querySelectorAll("input, textarea, fieldset")).toHaveLength(0);
  const answers = [...element.querySelectorAll("dd")].map(dd => [...dd.querySelectorAll(":scope > p")].map(p => p.textContent));
  expect(answers).toEqual([["Same label · Second option", "Extra detail"], ["Not answered"]]);
  expect(element.querySelectorAll("details li")).toHaveLength(4);
  expect(element.textContent).toContain("Continuation: cancelled"); expect(element.textContent).not.toContain("cancelled · cancelled");
});
it("folds a closed chat question to one line, links back only outside that chat and shows a repeated notice once", async () => {
  const record = row(); record.state = "withdrawn"; record.reason = "The originating work was cancelled or deleted.";
  record.input = { ...record.input!, waitReference: "a".repeat(64) };
  record.resolution = { revision: 2, userId: "alice", principalId: "alice", answers: { q1: { optionIds: ["b"] }, q2: { text: "Own words" } }, answeredAt: record.createdAt };
  vi.mocked(readDecision).mockResolvedValue(record);
  vi.mocked(readDecisionWait).mockResolvedValue({ id: "a".repeat(64), sessionId: "chat", questionId: "q", state: "cancelled", core: record, error: record.reason, reason: null });
  vi.mocked(subscribeDecisionUpdates).mockImplementation(refresh => { void refresh(); return () => {}; });
  const link = () => [...element.querySelectorAll("a")].find(a => a.textContent === "Open originating chat");
  const notices = () => element.textContent!.split("The originating work was cancelled or deleted.").length - 1;
  await act(async () => root.render(<DecisionQuestion waitId={"a".repeat(64)} />));
  const toggle = element.querySelector<HTMLButtonElement>('[data-slot="decision-row"] > button[aria-expanded]')!;
  expect(toggle.textContent).toBe("Same label; Own wordsSame wording?Withdrawn"); expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(element.querySelector("section")).toBeNull();
  await act(async () => toggle.click());
  expect(element.querySelector('section[aria-label="Agent question"]')).not.toBeNull(); expect(link()).toBeUndefined(); expect(notices()).toBe(1);
  await act(async () => root.render(<DecisionQuestion decisionId={record.id} />));
  expect(element.querySelector('[data-slot="decision-row"]')).toBeNull();
  expect(link()?.getAttribute("href")).toBe("/development?session=chat"); expect(notices()).toBe(1);
});
it("keeps a pending chat question open and marks a blocked continuation on its folded line", async () => {
  const record = row(), wait = { id: "b".repeat(64), sessionId: "chat", questionId: "q", state: "waiting", core: record, error: null, reason: null };
  vi.mocked(readDecision).mockResolvedValue(record); vi.mocked(readDecisionWait).mockResolvedValue(wait);
  vi.mocked(subscribeDecisionUpdates).mockImplementation(refresh => { void refresh(); return () => {}; });
  await act(async () => root.render(<DecisionQuestion waitId={wait.id} />));
  expect(element.querySelector('[data-slot="decision-row"]')).toBeNull(); expect(element.querySelectorAll("fieldset")).toHaveLength(2);
  const answered = { ...record, state: "answered" as const, resolution: { revision: 2, userId: "alice", principalId: "alice", answers: { q1: { optionIds: ["a"] }, q2: { optionIds: ["a"] } }, answeredAt: record.createdAt },
    continuation: { revision: 2, commandId: "command", state: "blocked" as const, reason: "missing_provider" as const, updatedAt: record.createdAt } };
  vi.mocked(readDecision).mockResolvedValue(answered); vi.mocked(readDecisionWait).mockResolvedValue({ ...wait, state: "blocked", core: answered, error: "Run not found." });
  await act(async () => root.render(<DecisionQuestion key="answered" waitId={wait.id} />));
  const badge = element.querySelector('[data-slot="decision-row"] [data-slot="badge"]');
  expect(badge?.textContent).toBe("Blocked"); expect(badge?.className).toContain("text-warning-foreground");
});
