// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptEvent } from "./transcript";
import { MessageTimestamp } from "./message-timestamp";

let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const ts = "2026-11-17T11:25:01Z", date = new Date(ts);
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date);
const localDateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(date);

it.each(["user_message", "assistant_text"])("shows the %s date and time as text alongside its actions", async type => {
  await act(async () => root.render(<TranscriptEvent event={{ seq: 1, ts, type, text: "A message" }}
    decision={null} answers={null} denyReason={false} onDecide={async () => {}} onAnswer={async () => {}} />));
  const footer = container.querySelector('[data-slot="message-footer"]');
  const time = footer?.querySelector("time");
  expect(time?.textContent).toBe(localDateTime);
  expect(time?.dateTime).toBe(date.toISOString());
  expect(time?.closest("button")?.getAttribute("aria-label")).toBe(`Message time: ${full}`);
  expect(footer?.querySelector('button[aria-label="Copy message"]')).toBeTruthy();
});

it("opens full timestamp details on focus or tap", async () => {
  await act(async () => root.render(<MessageTimestamp ts={ts} />));
  const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Message time:"]')!;
  await act(async () => button.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(full);
  await act(async () => button.click());
  const time = document.querySelector<HTMLTimeElement>('[data-slot="popover-content"] time');
  expect(time?.textContent).toBe(full);
  expect(time?.dateTime).toBe(date.toISOString());
});

it("omits invalid or missing historical timestamps", async () => {
  await act(async () => root.render(<><MessageTimestamp /><MessageTimestamp ts="invalid" /><MessageTimestamp ts="" /></>));
  expect(container.innerHTML).toBe("");
});
