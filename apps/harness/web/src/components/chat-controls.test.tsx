// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalDecisions, cancelledQuestions, ToolActivity, TranscriptEvent, type ApprovalDecision } from "./transcript";
import type { AssistantEvent } from "../lib/assistant-api";

describe("chat action cards", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });
  const click = async (element: Element | null) => {
    expect(element).not.toBeNull();
    await act(async () => (element as HTMLElement).click());
  };
  const type = async (element: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (name: string) => [...container.querySelectorAll("button")].find(button => button.textContent === name)!;
  const approval: AssistantEvent = { seq: 1, ts: "", type: "approval_request", approvalId: "a", toolName: "Bash", input: { command: "echo ok" } };

  it("keeps a deny reason on failure, retries, and prevents resubmission until replay", async () => {
    const onDecide = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(undefined);
    const render = async (decision: ApprovalDecision | null) => act(async () => root.render(
      <TranscriptEvent event={approval} decision={decision} answers={null} denyReason onDecide={onDecide} onAnswer={vi.fn()} />,
    ));
    await render(null);
    await click(button("Deny…"));
    await type(container.querySelector("input")!, "Use the safe directory");
    await click(button("Deny"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
    expect(container.querySelector("input")?.value).toBe("Use the safe directory");
    await click(button("Deny"));
    expect(onDecide).toHaveBeenLastCalledWith("a", "deny", "Use the safe directory");
    expect(button("Deny")).toBeUndefined();
    expect(container.textContent).toContain("Decision sent");
    await render({ decision: "deny", message: "Use the safe directory" });
    expect(container.textContent).toContain("Denied");
    expect(container.querySelector("input")).toBeNull();
  });


  it("opens an optional denial reason without submitting and permits only an explicit one-time allow", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<TranscriptEvent event={approval} decision={null} answers={null} denyReason onDecide={decide} onAnswer={vi.fn()} />));
    expect(container.querySelector("input")).toBeNull(); expect(button("Allow once")).toBeDefined();
    await click(button("Deny…")); expect(decide).not.toHaveBeenCalled(); expect(container.querySelector("input")).not.toBeNull();
    await type(container.querySelector("input")!, "Retained explanation"); await click(button("Cancel denial"));
    expect(decide).not.toHaveBeenCalled(); await click(button("Deny…")); expect(container.querySelector("input")?.value).toBe("Retained explanation");
    await click(button("Allow once")); expect(decide).toHaveBeenCalledExactlyOnceWith("a", "allow", undefined);
  });
  it("keeps immediate Deny when the provider cannot deliver a reason", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<TranscriptEvent event={approval} decision={null} answers={null} denyReason={false} onDecide={decide} onAnswer={vi.fn()} />));
    expect(button("Deny…")).toBeUndefined(); await click(button("Deny")); expect(decide).toHaveBeenCalledExactlyOnceWith("a", "deny", undefined);
  });

  it("replays cancellation without reviving old controls or cancelling a later turn", async () => {
    const events: AssistantEvent[] = [
      approval,
      { seq: 2, ts: "", type: "session_status", status: "cancelled" },
      { ...approval, seq: 3, approvalId: "later" },
    ];
    const decisions = approvalDecisions(events);
    expect(decisions.get("a")?.decision).toBe("cancelled");
    expect(decisions.has("later")).toBe(false);
    await act(async () => root.render(
      <TranscriptEvent event={approval} decision={decisions.get("a")!} answers={null} denyReason onDecide={vi.fn()} onAnswer={vi.fn()} />,
    ));
    expect(container.textContent).toContain("Cancelled");
    expect(button("Allow once")).toBeUndefined();
    expect(button("Deny")).toBeUndefined();
    expect(container.querySelector("input")).toBeNull();
    events.push({ seq: 4, ts: "", type: "approval_decision", approvalId: "a", decision: "deny", message: "Cancelled by operator" });
    expect(approvalDecisions(events).get("a")).toEqual({ decision: "deny", message: "Cancelled by operator" });
  });

  it("preserves explicit decisions when the session is subsequently cancelled", () => {
    expect(approvalDecisions([
      approval,
      { seq: 2, ts: "", type: "approval_decision", approvalId: "a", decision: "allow" },
      { seq: 3, ts: "", type: "session_status", status: "cancelled" },
    ]).get("a")?.decision).toBe("allow");
  });

  it("expires pending questions on cancellation while keeping answers and later questions", async () => {
    const questions = [{ question: "Continue?", header: "Next", multiSelect: false, options: [{ label: "Yes", description: "Continue" }] }];
    const question: AssistantEvent = { seq: 1, ts: "", type: "question_request", questionId: "pending", questions };
    const events: AssistantEvent[] = [
      { ...question, questionId: "answered" },
      { seq: 2, ts: "", type: "question_answered", questionId: "answered", answers: { "Continue?": "Yes" } },
      { ...question, seq: 3 },
      { seq: 4, ts: "", type: "session_status", status: "cancelled" },
      { ...question, seq: 5, questionId: "later" },
    ];
    expect([...cancelledQuestions(events)]).toEqual(["pending"]);
    const onAnswer = vi.fn();
    const render = async (cancelled: boolean) => act(async () => root.render(
      <TranscriptEvent event={question} decision={null} answers={null} questionCancelled={cancelled}
        denyReason={false} onDecide={vi.fn()} onAnswer={onAnswer} />,
    ));
    await render(false);
    await click(container.querySelector('[role="radio"]'));
    expect(button("Send answer").disabled).toBe(false);
    await render(cancelledQuestions(events).has("pending"));
    expect(container.textContent).toContain("Question cancelled");
    expect(button("Send answer")).toBeUndefined();
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(onAnswer).not.toHaveBeenCalled();
    // An answer acknowledged after Stop still wins when its event arrives.
    events.push({ seq: 6, ts: "", type: "question_answered", questionId: "pending", answers: { "Continue?": "Yes" } });
    expect(cancelledQuestions(events).has("pending")).toBe(false);
  });

  it("collects single, multi and free-text answers and preserves them through request failure", async () => {
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error("Try again")).mockResolvedValue(undefined);
    const questions = [
      { question: "Where?", header: "Location", multiSelect: false, options: [{ label: "Local", description: "On this host" }, { label: "Remote", description: "Another host" }] },
      { question: "Include?", header: "Details", multiSelect: true, options: [{ label: "Logs", description: "Recent logs" }, { label: "Metrics", description: "Recent metrics" }] },
    ];
    const event: AssistantEvent = { seq: 1, ts: "", type: "question_request", questionId: "q", questions };
    const render = async (answers: Record<string, string> | null) => act(async () => root.render(
      <TranscriptEvent event={event} decision={null} answers={answers} denyReason={false} onDecide={vi.fn()} onAnswer={onAnswer} />,
    ));
    await render(null);
    expect(button("Send answer").disabled).toBe(true);
    await click(container.querySelector('[role="radio"]'));
    await click(container.querySelector('[role="checkbox"]'));
    const inputs = container.querySelectorAll<HTMLInputElement>('input:not([type="radio"]):not([type="checkbox"])');
    await type(inputs[0], "Staging");
    expect(container.querySelector('[role="radio"]')?.getAttribute("aria-checked")).toBe("false");
    await type(inputs[1], "Traces");
    await click(button("Send answer"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    await click(button("Send answer"));
    expect(onAnswer).toHaveBeenLastCalledWith("q", { "Where?": "Staging", "Include?": "Logs, Traces" });
    expect(button("Send answer")).toBeUndefined();
    await render({ "Where?": "Staging", "Include?": "Logs, Traces" });
    expect(container.textContent).toContain("Answered");
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(container.textContent).toContain("Logs, Traces");
  });

  it("expands recorded calls and preserves the expanded group as another call arrives", async () => {
    const events: AssistantEvent[] = [{ seq: 1, ts: "", type: "tool_use", toolName: "Read", input: { file_path: "/app/log.txt" } }];
    const render = async () => act(async () => root.render(<ToolActivity events={events} />));
    await render();
    expect(container.textContent).toContain("1 tool call");
    expect(container.textContent).not.toContain("/app/log.txt");
    await click(container.querySelector("button"));
    expect(container.textContent).toContain("/app/log.txt");
    events.push({ seq: 2, ts: "", type: "tool_use", toolName: "Grep", input: { pattern: "error" } });
    await render();
    expect(container.textContent).toContain("2 tool calls");
    expect(container.textContent).toContain("/app/log.txt");
    expect(container.textContent).toContain("error");
    expect(container.textContent).not.toContain("Completed");
  });
});
