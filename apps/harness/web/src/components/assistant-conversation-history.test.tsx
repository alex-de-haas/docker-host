// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantConversation } from "./assistant-conversation";
import * as api from "@/lib/assistant-api";

const controls = vi.hoisted(() => ({ ui: { reportSurfaceState: vi.fn(), getNavigation: () => ({ entries: [] }), navigate: vi.fn() } }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => controls.ui }));
vi.mock("@/lib/assistant-api", async original => ({ ...await original<object>(),
  getHealth: vi.fn(), refreshProviderHistory: vi.fn(), stopSession: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(), listAppNames: vi.fn(),
  listAgentConnections: vi.fn(), getSuggestionPreference: vi.fn(), streamEvents: vi.fn(), postMessage: vi.fn(), resolveApproval: vi.fn(), resolveQuestion: vi.fn(),
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


it("shows the last observed run on provider loss and recovers without stopping the agent", async () => {
  const ts = "2026-11-19T11:00:00Z";
  const providerSource = { provider: { appId: "third.party", installationId: "i", key: "agent" }, runId: "slow", generation: "g", agentId: "child", parentAgentId: "root" };
  const contact = { runId: "slow", observedAt: ts, reason: "unavailable" };
  const emit = (seq: number, type: string, fields: Record<string, unknown>) => stream().event({ seq, ts, type, ...fields });
  const activity = () => container.querySelector('[data-slot="assistant-activity"]');
  const filters = () => container.querySelector('[aria-label="Activity filters"]')?.textContent;
  const panel = () => container.querySelector('[aria-label="Provider subagents"]');
  vi.mocked(api.refreshProviderHistory).mockResolvedValue(undefined);
  await mount();
  await act(async () => {
    emit(1, "session_status", { status: "running" });
    emit(2, "assistant_text", { text: "Saved result" });
    emit(3, "native_agent_status", { providerSource, state: "running", freshness: "current" });
    emit(4, "native_agent_status", { providerSource: { ...providerSource, agentId: "finished" }, state: "succeeded", freshness: "current", stopConfirmed: true });
    emit(5, "notice", { message: "The operation was aborted due to timeout" });
    emit(6, "assistant_delta", { text: "Unfinished draft" });
  });
  await connect(); await settle();
  expect(activity()).not.toBeNull();
  expect(filters()).toContain("Working1");
  expect(viewport()?.textContent).toContain("Unfinished draft");

  await act(async () => emit(7, "session_status", { status: "running", providerHistoryContact: contact }));
  expect(container.textContent).toContain("Reconnecting to the provider.");
  expect(activity()).toBeNull();
  expect(filters()).toContain("Working0");
  expect(panel()?.textContent).toContain("Last known: running");
  expect(panel()?.textContent).toContain("Completed");
  expect(viewport()?.textContent).toContain("Saved result");
  expect(viewport()?.textContent).not.toContain("Unfinished draft");

  await act(async () => [...viewport()!.querySelectorAll("button")].find(b => b.textContent === "Refresh")!.click());
  expect(api.refreshProviderHistory).toHaveBeenCalledExactlyOnceWith("history-one");
  expect(api.stopSession).not.toHaveBeenCalled();
  await act(async () => {
    emit(8, "assistant_text", { text: "Caught up" });
    emit(9, "session_status", { status: "idle", providerHistoryContact: null });
  });
  expect(viewport()?.textContent).toContain("Caught up");
  expect(container.textContent).not.toContain("Reconnecting to the provider.");
  expect(activity()).toBeNull();
  expect(filters()).toContain("Working0");
});

it("keeps replayed child output and live deltas attributed, with actionable approvals outside collapsed details", async () => {
  const source = { provider: { appId: "third.party", installationId: "installation", key: "agent" }, runId: "run", generation: "generation", agentId: "child", parentAgentId: "root", parentToolCallId: "spawn", parentTranscriptToolUseId: "spawn-transcript" };
  const emit = (seq: number, type: string, extra = {}) => stream().event({ seq, ts: "2026-11-17T11:25:01Z", type, ...extra });
  await mount();
  await act(async () => {
    emit(1, "user_message", { text: "Research this" });
    emit(2, "tool_use", { providerSource: { ...source, agentId: "root", parentAgentId: undefined, parentToolCallId: undefined }, toolUseId: "spawn-transcript", toolName: "Agent", input: { description: "Storage research" } });
    emit(3, "native_agent_status", { providerSource: source, state: "running", freshness: "current", stopConfirmed: false });
    emit(4, "assistant_text", { providerSource: source, text: "Private child findings", incomplete: true });
    emit(5, "assistant_text", { text: "Root summary" });
  });
  await connect(); await settle();
  const panel = container.querySelector<HTMLElement>('section[aria-label="Provider subagents"]')!;
  expect(panel.textContent).toContain("Storage research"); expect(panel.textContent).toContain("Running");
  expect(container.textContent).not.toContain("Private child findings"); expect(container.textContent).toContain("Root summary");
  await act(async () => panel.querySelector("button")!.click());
  expect(panel.textContent).toContain("Private child findings"); expect(panel.textContent).toContain("Interrupted message");
  await act(async () => {
    emit(6, "assistant_delta", { text: "Root streaming" });
    emit(7, "assistant_delta", { providerSource: source, text: "Child streaming" });
  });
  expect(panel.textContent).toContain("Child streaming"); expect(panel.textContent).not.toContain("Root streaming");
  expect(container.querySelector('[data-slot="message-scroller-item"][data-message-id="streaming"]')?.textContent ?? container.textContent).toContain("Root streaming");
  await act(async () => emit(8, "assistant_text", { providerSource: source, text: "Child completed message" }));
  expect(panel.textContent).not.toContain("Child streaming"); expect(container.textContent).toContain("Root streaming");
  await act(async () => panel.querySelector("button")!.click());
  await act(async () => {
    emit(9, "approval_request", { providerSource: source, approvalId: "child-approval", toolName: "Bash", input: { command: "echo approved" } });
    emit(10, "session_status", { status: "awaiting_approval" });
  });
  const allow = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Allow once"))!;
  expect(allow).toBeDefined(); expect(panel.contains(allow)).toBe(false); expect(allow.closest('[data-slot="message-scroller-item"]')?.textContent).toContain("From Storage research");
  await act(async () => allow.click());
  expect(api.resolveApproval).toHaveBeenCalledWith("history-one", "child-approval", "allow", undefined);
  await act(async () => {
    emit(11, "approval_decision", { providerSource: source, approvalId: "child-approval", decision: "allow" });
    emit(12, "question_request", { providerSource: source, questionId: "child-question", questions: [{ id: "choice", question: "Which store?", header: "Store", multiSelect: false, allowText: false, options: [{ id: "local", label: "Local", description: "" }] }] });
    emit(13, "session_status", { status: "awaiting_question" });
  });
  const question = container.querySelector<HTMLElement>('[data-slot="question-card"]')!;
  expect(panel.contains(question)).toBe(false); expect(question.closest('[data-slot="message-scroller-item"]')?.textContent).toContain("From Storage research");
  await act(async () => question.querySelector<HTMLElement>('[role="radio"]')!.click());
  await act(async () => [...question.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Send answer")!.click());
  expect(api.resolveQuestion).toHaveBeenCalledWith("history-one", "child-question", { choice: "local" });
  await connect("reconnecting"); expect(panel.textContent).toContain("Last known: running");
  await act(async () => emit(14, "native_agent_status", { providerSource: source, state: "succeeded", freshness: "current", stopConfirmed: true }));
  await connect(); expect(panel.textContent).toContain("Completed"); expect(api.streamEvents).toHaveBeenCalledOnce();
});
