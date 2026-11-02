// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DraftNote, FeedbackOperation } from "./feedback-channel";
import type { EmbeddedUiClient } from "./ui-embedded";
import { FeedbackCapture } from "./feedback-react";
import { appFetch } from "./browser-auth";
vi.mock("./browser-auth", () => ({ APP_SESSION_RESTORED: "session-restored", appFetch: vi.fn() }));
vi.mock("./feedback-draft", async importOriginal => ({
  ...await importOriginal<typeof import("./feedback-draft")>(),
  readDraft: vi.fn(async () => null), saveDraft: vi.fn(async () => {}),
}));
let root: Root, mount: HTMLDivElement, surface: HTMLButtonElement, frame: HTMLIFrameElement, hit: Element | null;
const highlight = () => document.querySelector("[data-hosty-feedback-highlight]");
let navigationChanged:()=>void;
let invoke: (o:FeedbackOperation)=>Promise<unknown>;
const click=async(name:string)=>act(async()=>{void invoke({action:'pick',mode:name==='Select region'?'region':'element'});});
const pointer = async (target: EventTarget, type: string, options: MouseEventInit = {}) => act(async () => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 30, ...options }));
});
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(appFetch).mockResolvedValue(Response.json({ version: 1, coreId: "core", appId: "app", installation: "install", userId: "user", maxAnnotations: 20, maxImageBytes:2097152,maxTotalImageBytes:8388608 }));
  mount = document.createElement("div"); surface = document.createElement("button"); frame = document.createElement("iframe");
  document.body.append(mount, surface, frame); root = createRoot(mount); hit = surface;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 100, 40));
  const client={registerFeedbackSource:(_c:unknown,fn:typeof invoke)=>{invoke=fn;},unregisterFeedbackSource:()=>{},subscribe:()=>()=>{},subscribeNavigation:(cb:()=>void)=>{navigationChanged=cb;return()=>{};}} as unknown as EmbeddedUiClient;
  mount.setAttribute('data-hosty-feedback-control','');
  await act(async () => root.render(<FeedbackCapture active client={client}/>));
});
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers();
});
it("hands hover from the host into an iframe without leaving the host highlighted", async () => {
  await click("Select element"); await pointer(surface, "pointermove"); expect(highlight()).not.toBeNull();
  await pointer(surface, "pointerout", { relatedTarget: frame }); expect(highlight()).toBeNull();
  hit = frame; await pointer(frame, "pointermove"); expect(highlight()).toBeNull();
  hit = surface; await pointer(surface, "pointermove"); expect(highlight()).not.toBeNull();
});
it("clears the child hover on leaving its document and resumes when the pointer returns", async () => {
  await click("Select element"); await pointer(surface, "pointermove");
  await pointer(surface, "pointerout", { relatedTarget: null }); expect(highlight()).toBeNull();
  await pointer(surface, "pointermove"); expect(highlight()).not.toBeNull();
  await pointer(surface, "pointerout", { relatedTarget: mount }); expect(highlight()).not.toBeNull();
  hit = null; await pointer(document, "pointermove"); expect(highlight()).toBeNull();
});
it("clears stale hover over capture controls and when the window loses focus", async () => {
  await click("Select element"); await pointer(surface, "pointermove");
  await pointer(document.querySelector('[data-hosty-feedback-control]')!, "pointermove"); expect(highlight()).toBeNull();
  await pointer(surface, "pointermove"); expect(highlight()).not.toBeNull();
  await act(async () => window.dispatchEvent(new Event("blur"))); expect(highlight()).toBeNull();
});
it("abandons an unfinished region at the frame boundary instead of using a later pointerup", async () => {
  await click("Select region"); await pointer(surface, "pointerdown");
  await pointer(surface, "pointermove", { clientX: 80, clientY: 90 }); expect(highlight()).not.toBeNull();
  await pointer(surface, "pointerout", { relatedTarget: null }); expect(highlight()).toBeNull();
  await pointer(surface, "pointerup", { clientX: 100, clientY: 110 });
  expect(document.querySelector('[aria-label="Annotation comment"]')).toBeNull();
});

it("keeps selection active when navigation metadata refreshes without changing the route",async()=>{
  await click("Select element");await act(async()=>navigationChanged());
  await pointer(surface,"pointermove");expect(highlight()).not.toBeNull();
});

it("holds the chosen outline across frame blur until capture clears it", async () => {
  const target = { kind: 'element' as const, bounds: { x: 10, y: 20, width: 100, height: 40 } };
  await act(async () => { await invoke({ action: 'highlight', target }); });
  await pointer(surface, 'pointerout', { relatedTarget: frame });
  await act(async () => window.dispatchEvent(new Event('blur')));
  expect(highlight()).not.toBeNull();
  await act(async () => { await invoke({ action: 'highlight' }); });
  expect(highlight()).toBeNull();
});
it("expires abandoned capture outlines and removes them on cancellation", async () => {
  vi.useFakeTimers();
  const target = { kind: 'region' as const, bounds: { x: 10, y: 20, width: 100, height: 40 } };
  await act(async () => { await invoke({ action: 'highlight', target }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(highlight()).toBeNull();
  await act(async () => { await invoke({ action: 'highlight', target }); await invoke({ action: 'cancel' }); });
  expect(highlight()).toBeNull();
});

it("outlines the selected element at its new position after the composer reflows", async () => {
  let result!: Promise<unknown>;
  await act(async () => { result = invoke({ action: 'pick', mode: 'element' }); });
  await pointer(surface, 'pointerdown'); const chosen = await result as DraftNote;
  vi.mocked(surface.getBoundingClientRect).mockReturnValue(new DOMRect(10, 120, 100, 40));
  await act(async () => { await invoke({ action: 'highlight', target: chosen.target, requestId: chosen.id }); });
  expect((highlight() as HTMLElement).style.top).toBe('120px');
  await act(async () => { await invoke({ action: 'highlight' }); });
  surface.remove();
  await expect(invoke({ action: 'highlight', target: chosen.target, requestId: chosen.id })).rejects.toThrow('no longer visible');
});

it.each([true, false])('suppresses only the selected element click (same target: %s)', async same => {
  const next = document.createElement('button'), action = vi.fn(); document.body.append(next);
  const target = same ? surface : next; target.addEventListener('click', action);
  await click('Select element'); await pointer(surface, 'pointerdown');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(same); expect(action).toHaveBeenCalledTimes(same ? 0 : 1);
});
