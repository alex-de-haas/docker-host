// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolActivity, TranscriptEvent, type ApprovalDecision } from "./transcript";
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
