// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessageQueue as QueueSnapshot, QueueEntry } from "@/lib/message-queue-api";
import { MessageQueue } from "./message-queue";

type Props = ComponentProps<typeof MessageQueue>;
let root: Root, container: HTMLDivElement, props: Props;
let captureDescriptors: PropertyDescriptorMap;
const onCommand = vi.fn(), onEdit = vi.fn();
const entry = (id: string, state: QueueEntry["state"] = "queued"): QueueEntry => ({ id, text: `${id} message`, attachments: [], state, createdAt: "" });
const snapshot = (entries: QueueEntry[]): QueueSnapshot => ({ version: 1, installationId: "install", ownerId: "owner", revision: 1, paused: true, entries, updatedAt: "" });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
  .find(element => element.getAttribute("aria-label") === label || element.textContent === label)!;
const handle = (index: number) => button(`Reorder queued message ${index}`);
const render = (overrides: Partial<Props> = {}) => act(async () => {
  props = { ...props, ...overrides }; root.render(<MessageQueue {...props} />);
});
const key = (index: number, key: string) => act(async () => {
  handle(index).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
});
const pointer = (element: HTMLElement, type: string, y: number, pointerId = 1) => act(async () => {
  const event = new MouseEvent(type, { clientX: 12, clientY: y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
  element.dispatchEvent(event);
});
const rowY = (index: number) => 100 + (index - 1) * 40 + 20;
async function startDrag(from: number, to: number) {
  const element = handle(from); await pointer(element, "pointerdown", rowY(from)); await pointer(element, "pointermove", rowY(to)); return element;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = { queue: snapshot([entry("first"), entry("second"), entry("third")]), outbox: [], busy: false, viewId: "current-view", error: null,
    pendingOperation: false, legacySend: null, legacyBusy: false, onCommand, onEdit, onRefresh: vi.fn(), onRetryLocal: vi.fn(),
    onRecoverLocal: vi.fn(), onRetryOperation: vi.fn(), onLegacyRetry: vi.fn() };
  captureDescriptors = Object.fromEntries(["setPointerCapture", "releasePointerCapture", "hasPointerCapture"].map(name => [name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]).filter((value): value is [string, PropertyDescriptor] => value[1] !== undefined));
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() }, releasePointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = this.closest<HTMLElement>("[data-queue-entry]");
    const index = row ? [...container.querySelectorAll("[data-queue-entry]")].indexOf(row) : -1;
    return new DOMRect(0, index < 0 ? 100 : 100 + index * 40, 600, index < 0 ? (props.queue?.entries.length ?? 0) * 40 : 40);
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const) {
    if (captureDescriptors[name]) Object.defineProperty(HTMLElement.prototype, name, captureDescriptors[name]!);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

it("reorders queued and failed messages with the handle's arrow keys while retaining a sending identity", async () => {
  await render({ queue: snapshot([entry("sending", "sending"), entry("second"), entry("failed", "failed")]) });
  await key(3, "ArrowUp");
  expect(onCommand).toHaveBeenLastCalledWith({ type: "reorder", entryIds: ["sending", "failed", "second"] });
  await key(2, "ArrowDown");
  expect(onCommand).toHaveBeenLastCalledWith({ type: "reorder", entryIds: ["sending", "failed", "second"] });
  expect(onCommand).toHaveBeenCalledTimes(2);
});

it.each([{ from: 3, to: 1, ids: ["third", "first", "second"] }, { from: 1, to: 3, ids: ["second", "third", "first"] }])(
  "commits a pointer drag from row $from to row $to once on release", async ({ from, to, ids }) => {
    await render(); const element = await startDrag(from, to);
    expect(onCommand).not.toHaveBeenCalled();
    await pointer(element, "pointerup", rowY(to));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: "reorder", entryIds: ids });
  },
);

it.each(["sending", "unknown", "editing"] as const)("never crosses a %s row by keyboard or drag", async state => {
  await render({ queue: snapshot([entry("first"), entry("locked", state), entry("third"), entry("fourth")]) });
  await key(3, "ArrowUp"); const element = await startDrag(4, 1); await pointer(element, "pointerup", rowY(1));
  expect(onCommand).not.toHaveBeenCalled();
});

it.each(["Escape", "pointercancel", "lostpointercapture"])("abandons a drag after %s", async cancel => {
  await render(); const element = await startDrag(3, 1);
  if (cancel === "Escape") await key(3, cancel); else await pointer(element, cancel, rowY(1));
  await pointer(element, "pointerup", rowY(1));
  expect(onCommand).not.toHaveBeenCalled();
});

it.each(["revision", "state", "identity", "busy", "pending"])("abandons a drag when its %s changes", async change => {
  await render(); const element = await startDrag(3, 1), before = props.queue!;
  await render(change === "busy" ? { busy: true } : change === "pending" ? { pendingOperation: true } : {
    queue: { ...before, revision: before.revision + (change === "revision" ? 1 : 0), entries: before.entries.map((row, index) =>
      index ? row : change === "state" ? { ...row, state: "failed" } : change === "identity" ? { ...row, id: "replacement" } : row) },
  });
  await pointer(element, "pointerup", rowY(1)); expect(onCommand).not.toHaveBeenCalled();
});

it("keeps a handle click and an unrelated pointer from committing a reorder", async () => {
  await render(); const element = handle(3);
  await pointer(element, "pointerdown", rowY(3)); await pointer(element, "pointermove", rowY(1), 2); await pointer(element, "pointerup", rowY(3));
  expect(onCommand).not.toHaveBeenCalled();
});

it("retains Retry and Recover edit while exposing edit and deletion for eligible rows", async () => {
  const failed = { ...entry("failed", "failed"), error: { code: "fixture_failure", message: "Controlled failure" } };
  const editing = { ...entry("editing", "editing"), edit: { reservationId: "reservation", viewId: "another-view", generation: 1,
    text: "Retained edit", attachments: [], stashedDraft: { text: "Draft", attachments: [] } } };
  await render({ queue: snapshot([failed, editing]) });
  await act(async () => button("Retry").click()); expect(onCommand).toHaveBeenLastCalledWith({ type: "retry", entryId: failed.id });
  await act(async () => button("Recover edit").click()); expect(onEdit).toHaveBeenLastCalledWith(editing, true);
  await act(async () => button("Edit queued message 1").click()); expect(onEdit).toHaveBeenLastCalledWith(failed, false);
  await act(async () => button("Delete queued message 1").click()); expect(onCommand).toHaveBeenLastCalledWith({ type: "delete", entryId: failed.id });
  expect(container.textContent).toContain("Could not send"); expect(container.textContent).toContain("Controlled failure");
});
