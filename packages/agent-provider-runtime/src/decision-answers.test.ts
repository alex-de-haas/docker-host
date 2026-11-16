import { expect, it } from "vitest";
import type { AgentPendingDecision } from "@hosty-sdk/app/agent";
import { questionAnswers } from "./decision-answers.js";
const decision = (allowText?: boolean): AgentPendingDecision => ({ id: "decision", revision: "1", kind: "question", delivery: "continue_run", questions: [
  { id: "choices", text: "Which?", multiple: true, ...(allowText === undefined ? {} : { allowText }), options: [{ id: "one", label: "First" }, { id: "two", label: "Second" }] },
] });
it.each([true, undefined])("preserves multichoice stable IDs and permitted Other text (%s)", allowText => {
  expect(questionAnswers(decision(allowText), { kind: "question", answers: { choices: ["one", "two", "Another permitted choice"] } })).toEqual({ choices: "First, Second, Another permitted choice" });
});
it("rejects unknown array choices when free text is disabled", () => {
  expect(() => questionAnswers(decision(false), { kind: "question", answers: { choices: ["one", "Other"] } })).toThrow("permitted free text");
});
it.each([
  { reason: "duplicate label", choices: ["one", "First"] }, { reason: "duplicate ID", choices: ["one", "one"] },
  { reason: "blank Other", choices: ["one", " "] }, { reason: "oversized Other", choices: ["one", "界".repeat(22000)] },
])("keeps duplicate, blank and byte bounds for mixed choice arrays ($reason)", ({ choices }) => {
  expect(() => questionAnswers(decision(true), { kind: "question", answers: { choices } })).toThrow();
});
it("retains stable IDs for ambiguous labels with Other text", () => {
  const value = decision(true); value.questions![0]!.options = [{ id: "first", label: "Same" }, { id: "second", label: "Same" }];
  expect(questionAnswers(value, { kind: "question", answers: { choices: ["first", "second", "Other"] } })).toEqual({ choices: "Same [first], Same [second], Other" });
  expect(() => questionAnswers(value, { kind: "question", answers: { choices: ["Same", "Other"] } })).toThrow("stable option ID");
});
