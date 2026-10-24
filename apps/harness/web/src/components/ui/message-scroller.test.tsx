// @vitest-environment jsdom
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
} from "./message-scroller";

let root: Root | undefined;
let node: HTMLDivElement;
let reduced = false;
const listeners = new Set<() => void>();
const query = vi.fn();
const scrollTo = vi.fn();
const caller = vi.fn();
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
function Fixture({ behavior, cancel = false }: { behavior?: ScrollBehavior; cancel?: boolean }) {
  return <MessageScrollerProvider defaultScrollPosition="start">
    <MessageScroller>
      <MessageScrollerViewport><MessageScrollerContent>
        <MessageScrollerItem messageId="retained"><textarea aria-label="Message draft" defaultValue="Unsent draft" /></MessageScrollerItem>
      </MessageScrollerContent></MessageScrollerViewport>
      <MessageScrollerButton aria-label="Jump to latest message" behavior={behavior} onClick={event => { caller(); if (cancel) event.preventDefault(); }} />
    </MessageScroller>
  </MessageScrollerProvider>;
}
function viewport() { return node.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!; }
function jump() { return node.querySelector<HTMLButtonElement>('button[aria-label="Jump to latest message"]')!; }
async function readOlderMessages() {
  await act(async () => { viewport().scrollTop = 0; viewport().dispatchEvent(new Event("scroll", { bubbles: true })); });
  await settle();
  expect(jump().getAttribute("data-active")).toBe("true");
}
async function preference(value: boolean) {
  await act(async () => { reduced = value; listeners.forEach(listener => listener()); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  query.mockImplementation(() => ({ get matches() { return reduced; }, addEventListener(_event: string, listener: () => void) { listeners.add(listener); }, removeEventListener(_event: string, listener: () => void) { listeners.delete(listener); } }));
  vi.stubGlobal("matchMedia", query);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.slot === "message-scroller-viewport" ? 100 : 0; });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.slot === "message-scroller-viewport" ? 1000 : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.dataset.slot === "message-scroller-item" ? 1000 : 100;
    return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON() {} };
  });
  scrollTo.mockImplementation(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; this.dispatchEvent(new Event("scroll", { bubbles: true })); });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  node = document.createElement("div"); document.body.append(node);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; node.remove(); reduced = false; listeners.clear();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); query.mockReset(); scrollTo.mockReset(); caller.mockReset();
});

it("uses instant jumps for live reduced-motion changes while retaining the transcript and caller behavior", async () => {
  root = createRoot(node);
  await act(async () => root!.render(<Fixture />)); await settle();
  const draft = node.querySelector("textarea")!;
  draft.value = "Retained unsent text";
  expect(jump().getAttribute("data-active")).toBe("true");
  await act(async () => jump().click());
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: "smooth" });
  expect(caller).toHaveBeenCalledTimes(1);
  await readOlderMessages(); await preference(true);
  await act(async () => jump().click());
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: "instant" });
  await readOlderMessages(); await preference(false);
  await act(async () => root!.render(<Fixture behavior="auto" />));
  await act(async () => jump().click());
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: "auto" });
  await readOlderMessages();
  await act(async () => root!.render(<Fixture behavior="smooth" cancel />));
  const previousCalls = scrollTo.mock.calls.length;
  await act(async () => jump().click());
  expect(scrollTo).toHaveBeenCalledTimes(previousCalls);
  expect(node.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Retained unsent text");
  await act(async () => root!.unmount()); root = undefined;
  expect(listeners.size).toBe(0);
});

it("hydrates a reduced-motion browser without querying browser preferences during server rendering", async () => {
  reduced = true;
  node.innerHTML = renderToString(<Fixture />);
  expect(query).not.toHaveBeenCalled();
  const draft = node.querySelector("textarea")!;
  const recoverable = vi.fn();
  await act(async () => { root = hydrateRoot(node, <Fixture />, { onRecoverableError: recoverable }); });
  await settle();
  expect(recoverable).not.toHaveBeenCalled();
  expect(node.querySelector("textarea")).toBe(draft);
  await act(async () => jump().click());
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: "instant" });
});
