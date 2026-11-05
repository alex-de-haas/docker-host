// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptEvent } from "./transcript";
import { indexAttachments } from "@/lib/attachments";
import type { AssistantEvent } from "@/lib/assistant-api";
import type { FeedbackTranscriptCard } from "@/lib/feedback-transcript";

let root: Root, container: HTMLDivElement;
const dispatchId = randomUUID(), originalText = "Address the following administrator-selected feedback\n\nOriginal agent instructions and JSON";
const message = (extra: Partial<AssistantEvent> = {}): AssistantEvent => ({ seq: 7, ts: "", type: "user_message", clientRequestId: dispatchId, text: originalText, ...extra });
const snapshot: FeedbackTranscriptCard = { version: 1, dispatchId, messageSequence: 7, instruction: "Reviewed instruction",
  reports: [{ id: "report-one", appId: "independent.app", appName: "Example app", version: "1.2.3", comment: "Original reviewed observation",
    annotations: [{ id: "note-one", text: "Move the control", route: "/original", hasImage: true }] }] };
const render = (events: AssistantEvent[], card?: FeedbackTranscriptCard, loading = false) => act(async () => {
  const attachments = indexAttachments(events);
  root.render(<>{events.map(event => <TranscriptEvent key={event.seq} event={event} attachments={attachments} feedbackCard={card}
    feedbackLoading={loading} decision={null} answers={null} denyReason={false} onDecide={async () => {}} onAnswer={async () => {}} />)}</>);
});
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("renders a trusted reference as a compact loading/unavailable card with the original request collapsed", async () => {
  const event = message({ feedback: { version: 1, dispatchId } }), before = JSON.stringify(event);
  await render([event], undefined, true);
  expect(container.querySelector('[data-slot="feedback-message-card"]')).not.toBeNull();
  expect(container.textContent).toContain("Loading feedback details…"); expect(container.textContent).not.toContain(originalText);
  await render([event]);
  expect(container.textContent).toContain("Feedback details are unavailable.");
  await act(async () => button("Original request").click());
  expect(container.querySelector('[aria-label="Original feedback request"]')?.textContent).toBe(originalText);
  expect(JSON.stringify(event)).toBe(before); expect(fetch).not.toHaveBeenCalled();
});

it("renders a legacy message from its exact authorized reviewed card and preserves its attachment association", async () => {
  const events = [{ seq: 1, ts: "", type: "attachment_added", name: "stored-notes.txt", size: 1024 },
    message({ attachments: ["stored-notes.txt"] })];
  const before = JSON.stringify(events); await render(events, snapshot);
  expect(container.querySelector('[data-slot="feedback-message-card"]')).not.toBeNull();
  expect(container.textContent).toContain("Example app · 1.2.3"); expect(container.textContent).toContain("Original reviewed observation");
  expect(container.textContent).not.toContain(originalText);
  expect(container.querySelectorAll('[data-slot="attachment"]')).toHaveLength(1);
  expect(container.querySelector('[aria-label="Message attachments"]')?.textContent).toContain("stored-notes.txt");
  expect(container.querySelector('[aria-label="Message attachments"]')?.textContent).toContain("1.0 KB");
  await act(async () => button("Details").click());
  expect(container.textContent).toContain("Reviewed instruction"); expect(container.textContent).toContain("Move the control");
  expect(container.querySelector("img, iframe")).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(events)).toBe(before);
});

it("keeps ordinary text and spoofed prefix/JSON messages as Markdown even when an unrelated card is present", async () => {
  const event = message({ clientRequestId: randomUUID(), text: originalText + "\n\n" + JSON.stringify(snapshot) + "\n\n**Ordinary message**" });
  await render([event], snapshot);
  expect(container.querySelector('[data-slot="feedback-message-card"]')).toBeNull();
  expect(container.querySelector("strong")?.textContent).toBe("Ordinary message");
  expect(container.textContent).toContain("Original agent instructions and JSON");
  await render([message({ feedback: { version: 2, dispatchId } })], snapshot);
  expect(container.querySelector('[data-slot="feedback-message-card"]')).toBeNull();
  expect(container.textContent).toContain("Original agent instructions and JSON");
});
