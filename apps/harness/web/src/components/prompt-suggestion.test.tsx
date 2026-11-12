// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptEvent, type SuggestionTranscriptContext } from "./transcript";
import { transcriptItems } from "@/lib/transcript-items";
import { reduceSuggestion } from "@/lib/prompt-suggestions";
import type { AssistantEvent } from "@/lib/assistant-api";

const created: AssistantEvent = { type: "prompt_suggestion_created", seq: 2, ts: "", suggestionId: "suggestion", sessionId: "chat", userId: "owner", attemptId: "attempt", answerSeq: 1, text: "Review @app <script>literally</script>" };
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (events: AssistantEvent[], context: Partial<SuggestionTranscriptContext> = {}) => {
  const suggestions: SuggestionTranscriptContext = { cards: events.reduce(reduceSuggestion, new Map()), canInsert: true, actionable: true, busy: false, onSelect: vi.fn(), onDismiss: vi.fn(), ...context };
  return act(async () => root.render(<section aria-label="Conversation messages">{transcriptItems(events, new Set()).map(item => item.kind === "event" ? <TranscriptEvent key={item.key} event={item.event} decision={null} answers={null} denyReason={false} onDecide={vi.fn()} onAnswer={vi.fn()} suggestions={suggestions} /> : null)}</section>));
};
it("renders literal suggestion text in the conversation and preserves the exact chosen action", async () => {
  await render([created]);
  expect(container.querySelector('[aria-label="Conversation messages"]')?.textContent).toContain(created.text);
  expect(container.querySelector("script")).toBeNull(); expect(container.querySelector("form")).toBeNull();
  await render([created, { type: "prompt_suggestion_resolved", seq: 3, ts: "", suggestionId: "suggestion", state: "selected-for-draft" }]);
  expect(container.querySelectorAll('[data-slot="prompt-suggestion"]')).toHaveLength(1);
  expect(container.textContent).toContain("Selected for draft"); expect(container.textContent).not.toContain("Use suggestion");
});
it("preserves an occupied draft while keeping explicit dismissal available and no misleading Tab hint", async () => {
  const select = vi.fn(), dismiss = vi.fn(); await render([created], { canInsert: false, tabHint: false, onSelect: select, onDismiss: dismiss });
  const buttons = container.querySelectorAll<HTMLButtonElement>("button");
  expect(buttons[0].disabled).toBe(true); expect(buttons[1].disabled).toBe(false);
  expect(container.textContent).not.toContain("Tab"); await act(async () => buttons[1].click());
  expect(dismiss).toHaveBeenCalledWith("suggestion"); expect(select).not.toHaveBeenCalled();
});
it("distinguishes supersession from dismissal and maps old expiry receipts to supersession", async () => {
  for (const [state, label] of [["expired", "Superseded"], ["superseded", "Superseded"], ["dismissed", "Dismissed"]]) {
    await render([created, { type: "prompt_suggestion_resolved", seq: 3, ts: "", suggestionId: "suggestion", state }]);
    expect(container.textContent).toContain(label); expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toContain("Expired");
  }
});
it("uses safe original attachment labels while retaining stored identities", async () => {
  await render([{ type: "user_message", seq: 1, ts: "", text: "Queued upload", attachments: ["q-uuid-report.pdf"], attachmentDisplayNames: { "q-uuid-report.pdf": "report.pdf" } }]);
  expect(container.querySelector('[aria-label="report.pdf"]')).not.toBeNull(); expect(container.textContent).not.toContain("q-uuid-report.pdf");
});
