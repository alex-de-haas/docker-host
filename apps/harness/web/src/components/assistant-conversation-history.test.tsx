// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantConversation } from "./assistant-conversation";
import * as api from "@/lib/assistant-api";

const controls = vi.hoisted(() => ({ ui: { reportSurfaceState: vi.fn(), getNavigation: () => ({ entries: [] }), navigate: vi.fn() } }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => controls.ui }));
vi.mock("@/lib/assistant-api", async original => ({ ...await original<object>(),
  getHealth: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(), listAppNames: vi.fn(),
  listAgentConnections: vi.fn(), getSuggestionPreference: vi.fn(), streamEvents: vi.fn(), postMessage: vi.fn(),
}));
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), useDevelopmentInventory: () => ({ workspaces: [], loading: false, error: "", refresh: vi.fn() }) }));
vi.mock("./speech-input", () => ({ SpeechInput: () => null }));
vi.mock("./session-credentials", () => ({ SessionCredentials: () => null }));
vi.mock("./session-autonomy", () => ({ SessionAutonomy: () => null }));
vi.mock("./session-agent-settings", () => ({ SessionAgentSettings: () => null }));
vi.mock("./app-context-picker", () => ({ AppContextPicker: () => null }));
vi.mock("./markdown", () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));

type Stream = { event: (event: api.AssistantEvent) => void; state: (state: api.StreamConnection) => void; signal: AbortSignal };
const sessions: api.AssistantSession[] = [
  { id: "history-one", title: "First conversation", status: "idle", createdAt: "" },
  { id: "history-two", title: "Second conversation", status: "idle", createdAt: "" },
];
let root: Root, container: HTMLDivElement;
const streams = new Map<string, Stream>();
const scrollTo = vi.fn();
const viewport = () => container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
const loading = () => container.querySelector('[role="status"][aria-label="Loading conversation history"]');
const stream = (id = "history-one") => streams.get(id)!;
const textEvent = (text: string, seq: number): api.AssistantEvent => ({ type: "assistant_text", text, seq, ts: "2026-11-04T19:00:00Z" });
const replay = (text: string, seq: number, id = "history-one") => act(async () => stream(id).event(textEvent(text, seq)));
const connect = (state: api.StreamConnection = "connected", id = "history-one") => act(async () => stream(id).state(state));
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
const mount = () => act(async () => root.render(<AssistantConversation fullPage />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear(); streams.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width: 1100px"), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.slot === "message-scroller-viewport" ? 100 : 0; });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.slot === "message-scroller-viewport" ? 2000 : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.dataset.slot === "message-scroller-item" ? 1000 : 100;
    return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON() {} };
  });
  scrollTo.mockImplementation(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0; this.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  vi.mocked(api.getHealth).mockResolvedValue({ name: "fake", available: true });
  vi.mocked(api.listSessions).mockResolvedValue(sessions);
  vi.mocked(api.getSession).mockImplementation(async id => sessions.find(session => session.id === id)!);
  vi.mocked(api.createSession).mockResolvedValue(sessions[0]!);
  vi.mocked(api.listAppNames).mockResolvedValue({});
  vi.mocked(api.listAgentConnections).mockResolvedValue({ connections: [], defaultId: null });
  vi.mocked(api.getSuggestionPreference).mockResolvedValue({ enabled: false, revision: 0 });
  vi.mocked(api.streamEvents).mockImplementation(async (id, event, signal, state) => {
    streams.set(id, { event, signal, state: state! }); state?.("connecting");
  });
  localStorage.setItem("hosty.assistant.session", "history-one");
  window.history.replaceState({}, "", "/chats?session=history-one");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("waits for the full replay before mounting the real scroller and initially positions it without smooth animation", async () => {
  await mount(); expect(stream()).toBeDefined();
  expect(loading()).not.toBeNull(); expect(viewport()).toBeNull();
  const composer = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Draft written while history loads");
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await replay("Oldest historical message", 1); await settle();
  expect(container.textContent).not.toContain("Oldest historical message");
  expect(viewport()).toBeNull(); expect(scrollTo).not.toHaveBeenCalled();
  await replay("Latest historical message", 2); await settle();
  expect(container.textContent).not.toContain("Latest historical message");
  expect(loading()).not.toBeNull(); expect(scrollTo).not.toHaveBeenCalled();
  await act(async () => stream().event({ type: "session_status", historical: true, status: "idle", seq: 3, ts: "" }));
  expect(loading()).not.toBeNull(); expect(viewport()).toBeNull();
  await connect(); await settle();
  expect(loading()).toBeNull(); expect(viewport()).not.toBeNull();
  expect(viewport()?.textContent).toContain("Oldest historical message");
  expect(viewport()?.textContent).toContain("Latest historical message");
  expect(scrollTo).toHaveBeenCalled();
  expect(scrollTo.mock.calls.every(([options]) => options.behavior !== "smooth")).toBe(true);
  expect(viewport()?.scrollTop).toBe(1900);
  expect(container.querySelector('textarea[aria-label="Message"]')).toBe(composer);
  expect(composer.value).toBe("Draft written while history loads");
});

it("keeps the loaded viewport and current position mounted during a reconnect", async () => {
  await mount(); await replay("Loaded history", 1); await connect(); await settle();
  const retained = viewport()!;
  await act(async () => {
    retained.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    retained.scrollTop = 200; retained.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await connect("reconnecting");
  expect(loading()).toBeNull(); expect(viewport()).toBe(retained); expect(retained.scrollTop).toBe(200);
  await replay("A message missed during reconnect", 2); await connect(); await settle();
  expect(viewport()).toBe(retained); expect(loading()).toBeNull();
  expect(retained.scrollTop).toBe(200);
  expect(retained.textContent).toContain("Loaded history"); expect(retained.textContent).toContain("A message missed during reconnect");
  expect(api.streamEvents).toHaveBeenCalledOnce();
});

it("waits independently for another chat and ignores the old stream's late messages and ready callback", async () => {
  await mount(); await replay("First chat history", 1); await connect(); await settle();
  const oldStream = stream(), oldViewport = viewport();
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window.parent,
    data: { type: "hosty:open-assistant-session", sessionId: "history-two" } })));
  expect(stream("history-two")).toBeDefined(); expect(oldStream.signal.aborted).toBe(true);
  expect(loading()).not.toBeNull(); expect(viewport()).toBeNull();
  await act(async () => { oldStream.event(textEvent("Late first chat message", 9)); oldStream.state("connected"); });
  expect(loading()).not.toBeNull(); expect(viewport()).toBeNull();
  await replay("Second chat history", 1, "history-two");
  expect(container.textContent).not.toContain("Second chat history");
  await connect("connected", "history-two"); await settle();
  expect(loading()).toBeNull(); expect(viewport()).not.toBe(oldViewport);
  expect(viewport()?.textContent).toContain("Second chat history");
  expect(viewport()?.textContent).not.toContain("First chat history");
  expect(viewport()?.textContent).not.toContain("Late first chat message");
});

it("shows terminal replay failures instead of leaving the conversation in an indefinite loading state", async () => {
  await mount(); await replay("Partial retained history", 1);
  await act(async () => {
    stream().state("disconnected");
    stream().event({ type: "error", message: "The event stream ended (403) — access was revoked.", seq: -1, ts: "" });
  });
  expect(loading()).toBeNull(); expect(viewport()).not.toBeNull();
  expect(container.textContent).toContain("The event stream ended (403)");
  expect(viewport()?.textContent).toContain("Partial retained history");
});
