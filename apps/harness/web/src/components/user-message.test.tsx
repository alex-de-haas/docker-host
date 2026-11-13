// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptEvent } from "./transcript";
import type { AssistantEvent } from "@/lib/assistant-api";

let root: Root, container: HTMLDivElement;
let contentHeight: number;
const observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
const render = (events: AssistantEvent[]) => act(async () => root.render(<>{events.map(event =>
  <TranscriptEvent key={event.seq} event={event} decision={null} answers={null} denyReason={false}
    onDecide={async () => {}} onAnswer={async () => {}} />,
)}</>));
const message = (seq: number, text: string): AssistantEvent => ({ seq, ts: "", type: "user_message", text });
const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const region = () => document.getElementById(toggle().getAttribute("aria-controls")!)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  contentHeight = 100;
  observers.length = 0;
  vi.stubGlobal("getComputedStyle", () => ({ lineHeight: "20px" }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ height: contentHeight }) as DOMRect);
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn();
    constructor(notify: () => void) { observers.push({ notify, disconnect: this.disconnect }); }
    observe() {}
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("keeps five-line prompts and assistant replies free of a message toggle", async () => {
  await render([message(1, "First\nSecond\nThird\nFourth\nFifth"), { ...message(2, "Long reply"), type: "assistant_text" }]);
  expect(toggle()).toBeNull();
  expect(container.querySelectorAll('[data-slot="user-message"]')).toHaveLength(1);
});

it("collapses rendered overflow even without newlines, toggles independently and retains source and attachments", async () => {
  contentHeight = 240;
  const first = Object.freeze({ ...message(1, "A long **wrapped** prompt. ".repeat(20)), attachments: ["notes.txt"] });
  const events = [first, message(2, "Another long prompt. ".repeat(20))];
  const recorded = JSON.stringify(events);
  await render(events);
  const button = toggle();
  expect(button.textContent).toBe("Show more");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(region().style.maxHeight).toBe("5lh");
  expect(region().querySelector("strong")?.textContent).toBe("wrapped");
  expect(region().contains(container.querySelector('[aria-label="Message attachments"]'))).toBe(false);
  expect(container.querySelector('[aria-label="Message attachments"]')?.textContent).toContain("notes.txt");
  await act(async () => { button.focus(); button.click(); });
  expect(button.textContent).toBe("Show less");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(region().style.maxHeight).toBe("");
  expect(document.activeElement).toBe(button);
  expect(container.querySelectorAll('button[aria-expanded="false"]')).toHaveLength(1);
  await act(async () => button.click());
  expect(region().style.maxHeight).toBe("5lh");
  expect(JSON.stringify(events)).toBe(recorded);
});

it("rechecks overflow after width/content changes and disconnects observers on unmount", async () => {
  await render([message(1, "A wrapped prompt")]);
  expect(toggle()).toBeNull();
  contentHeight = 120;
  await act(async () => observers.forEach(observer => observer.notify()));
  expect(toggle().textContent).toBe("Show more");
  contentHeight = 80;
  await act(async () => observers.forEach(observer => observer.notify()));
  expect(toggle()).toBeNull();
  await render([]);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
});

it("reveals clipped interactive Markdown when keyboard focus reaches it", async () => {
  contentHeight = 200;
  await render([message(1, "First\nSecond\nThird\nFourth\nFifth\n[Documentation](https://example.test/docs)")]);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  const link = container.querySelector<HTMLAnchorElement>("a")!;
  await act(async () => link.focus());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(region().style.maxHeight).toBe("");
  expect(document.activeElement).toBe(link);
});
