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
const full = () => new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date);

it("shows a prompt's local HH:mm with a full accessible timestamp and tap details", async () => {
  await act(async () => root.render(<TranscriptEvent event={{ seq: 1, ts, type: "user_message", text: "My prompt" }}
    decision={null} answers={null} denyReason={false} onDecide={async () => {}} onAnswer={async () => {}} />));
  expect(container.querySelector("time")?.textContent).toBe(new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date));
  const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Message time:"]')!;
  expect(button.getAttribute("aria-label")).toBe(`Message time: ${full()}`);
  await act(async () => button.click());
  expect(document.querySelector('[data-slot="popover-content"] time')?.textContent).toBe(full());
  expect(document.querySelector('[data-slot="popover-content"] time')?.getAttribute("datetime")).toBe(date.toISOString());
});

it("reveals the full timestamp to keyboard focus without adding a clock label to assistant prose", async () => {
  await act(async () => root.render(<MessageTimestamp ts={ts} compact />));
  expect(container.querySelector("time")).toBeNull();
  await act(async () => { container.querySelector("button")!.focus(); });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(full());
});

it("omits invalid or missing historical timestamps", async () => {
  await act(async () => root.render(<><MessageTimestamp /><MessageTimestamp ts="invalid" /><MessageTimestamp ts="" /></>));
  expect(container.innerHTML).toBe("");
});
