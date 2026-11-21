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

it("keeps a context boundary visible, reloads the chat and leaves an earlier open decision read-only", async () => {
  await mount(); await connect();
  await act(async () => stream().event({ seq: 1, ts: "", type: "approval_request", approvalId: "old", toolName: "Earlier tool" }));
  vi.mocked(api.getSession).mockClear();
  await act(async () => stream().event({ seq: 2, ts: "", type: "notice", contextChanged: true,
    contextRequestId: "change", message: "New native context. Earlier messages stay in this chat." }));
  await settle();
  expect(api.getSession).toHaveBeenCalledWith(sessions[0].id);
  expect(viewport()?.textContent).toContain("New native context");
  expect(viewport()?.textContent).toContain("The decision outcome is unconfirmed.");
  expect([...viewport()!.querySelectorAll("button")].some(b => b.textContent === "Approve")).toBe(false);
  expect(api.resolveApproval).not.toHaveBeenCalled();
});

it("keeps a late old reply and question in history without replacing live output or activating a decision", async () => {
  await mount(); await connect();
  const old = { providerHistoryEarlier: true, providerSource: { provider: { appId: "agent", installationId: "original", key: "agent" },
    runId: "old", generation: "one", agentId: "root" } };
  await act(async () => {
    stream().event({ seq: 2, ts: "", type: "notice", contextChanged: true, message: "Context changed" });
    stream().event({ seq: 3, ts: "", type: "assistant_delta", text: "Current streamed reply" });
    stream().event({ ...old, seq: 4, ts: "", type: "assistant_text", text: "Recovered earlier reply" });
    stream().event({ ...old, seq: 5, ts: "", type: "question_request", questionId: "old-question", decisionWaitId: "retired-wait" });
    stream().event({ seq: 6, ts: "", type: "session_status", status: "awaiting_question" });
  });
  expect(viewport()?.textContent).toContain("Recovered earlier reply");
  expect(viewport()?.textContent).toContain("Current streamed reply");
  expect(viewport()?.textContent).toContain("The response is unconfirmed.");
  expect(container.textContent).not.toContain("Needs you · Answer requested");
  expect(api.resolveQuestion).not.toHaveBeenCalled();
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
  expect(panel()?.textContent).toContain("1 completed · 1 unknown");
  await act(async () => panel()!.querySelector("button")!.click());
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
  const groupButton = panel.querySelector("button")!;
  expect(groupButton.getAttribute("aria-expanded")).toBe("false");
  expect(groupButton.textContent).toContain("1 subagent");
  expect(groupButton.textContent).toContain("1 running");
  expect(panel.textContent).not.toContain("Storage research");
  await act(async () => groupButton.click());
  const childButton = panel.querySelector<HTMLButtonElement>('button[aria-label^="Storage research:"]')!;
  expect(childButton.getAttribute("aria-expanded")).toBe("false");
  expect(childButton.textContent).toContain("Running");
  expect(container.textContent).not.toContain("Private child findings"); expect(container.textContent).toContain("Root summary");
  await act(async () => childButton.click());
  expect(panel.textContent).toContain("Prompt unavailable.");
  expect(panel.textContent).toContain("No final response recorded.");
  expect(panel.textContent).toContain("Launch by Main agent");
  expect(panel.querySelector('[data-slot="tool-activity"]')).toBeNull();
  expect(panel.textContent).toContain("Private child findings"); expect(panel.textContent).toContain("Interrupted message");
  await act(async () => {
    emit(6, "assistant_delta", { text: "Root streaming" });
    emit(7, "assistant_delta", { providerSource: source, text: "Child streaming" });
  });
  expect(panel.textContent).toContain("Child streaming"); expect(panel.textContent).not.toContain("Root streaming");
  expect(container.querySelector('[data-slot="message-scroller-item"][data-message-id="streaming"]')?.textContent ?? container.textContent).toContain("Root streaming");
  await act(async () => emit(8, "assistant_text", { providerSource: source, text: "Child completed message" }));
  expect(panel.textContent).not.toContain("Child streaming"); expect(container.textContent).toContain("Root streaming");
  await act(async () => groupButton.click());
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
  await connect("reconnecting");
  expect(groupButton.textContent).toContain("1 unknown");
  await act(async () => groupButton.click());
  expect(panel.textContent).toContain("Last known: running");
  await act(async () => emit(14, "native_agent_status", { providerSource: source, state: "succeeded", freshness: "current", stopConfirmed: true }));
  await connect(); expect(panel.textContent).toContain("Completed");
  await act(async () => emit(15, "native_agent_details", { providerSource: source, prompt: "Compare storage engines.", result: "Use SQLite.", resultTruncated: true }));
  await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label^="Storage research:"]')!.click());
  expect(panel.querySelectorAll("dd")[0]?.textContent).toBe("Compare storage engines.");
  expect(panel.querySelectorAll("dd")[1]?.textContent).toBe("Use SQLite.");
  expect(panel.textContent).toContain("Final response (partial)");
  expect(panel.textContent).toContain("Private child findings");
  await act(async () => {
    emit(16, "assistant_text", { providerSource: source, providerEventId: "run:message:child:answer", text: "Use SQLite for this project." });
    emit(17, "native_agent_details", { providerSource: source, resultMessageId: "answer" });
  });
  expect(panel.querySelectorAll("dd")[1]?.textContent).toBe("Use SQLite for this project.");
  expect(panel.textContent?.match(/Use SQLite for this project\./g)).toHaveLength(1);
  expect(panel.textContent).not.toContain("Final response (partial)");
  expect(api.streamEvents).toHaveBeenCalledOnce();
});

it("updates parallel child chats at their launch, opens the selected history and returns to the parent", async () => {
  const developer = { id: "history-two", profileId: "dev", profileName: "Developer", prompt: "Implement search", status: "running" } as const;
  const tester = { id: "history-three", profileId: "test", profileName: "Tester", prompt: "Check indexing", status: "running" } as const;
  vi.mocked(api.getSession).mockImplementation(async id => id === developer.id ? { ...sessions[1]!, parentSessionId: "history-one" } : sessions[0]!);
  const update = (seq: number, child: NonNullable<api.AssistantEvent["child"]>) => stream().event({ type: "session_subagent", seq, ts: "", child });
  await mount();
  await act(async () => {
    stream().event(textEvent("Before delegation", 1));
    update(2, developer);
    update(3, tester);
    stream().event(textEvent("Parent continues", 4));
  });
  await connect();
  const panel = viewport()!.querySelector<HTMLElement>('section[aria-label="Harness subagents"]')!;
  const summary = panel.querySelector("button")!;
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(summary.textContent).toContain("2 subagents");
  expect(summary.textContent).toContain("2 running");
  await act(async () => update(5, { ...developer, status: "completed", result: "Search is implemented." }));
  expect(summary.textContent).toContain("1 running · 1 completed");
  expect(viewport()!.textContent).toMatch(/Before delegation.*2 subagents.*Parent continues/);
  await connect("reconnecting");
  expect(summary.textContent).toContain("1 completed · 1 unknown");
  await connect();
  await act(async () => summary.click());
  await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label^="Developer:"]')!.click());
  expect(panel.textContent).toContain("Implement search");
  expect(panel.textContent).toContain("Search is implemented.");
  expect(panel.textContent).not.toContain("Check indexing");
  const childLink = panel.querySelector<HTMLAnchorElement>('a[href="?session=history-two"]')!;
  await act(async () => childLink.click());
  expect(api.getSession).toHaveBeenCalledWith("history-two");
  expect(window.location.search).toBe("?session=history-two");
  await act(async () => stream(developer.id).event({ type: "subagent_assignment", seq: 1, ts: "", text: developer.prompt }));
  await replay("Child's full transcript", 2, developer.id);
  await connect("connected", developer.id);
  expect(viewport()!.querySelector('[aria-label="Assignment from parent chat"]')?.textContent).toContain(developer.prompt);
  expect(viewport()!.textContent).toContain("Child's full transcript");
  const parentLink = container.querySelector<HTMLAnchorElement>('a[href="?session=history-one"]')!;
  expect(parentLink.textContent).toBe("Parent chat");
  await act(async () => parentLink.click());
  expect(window.location.search).toBe("?session=history-one");
  expect(controls.ui.reportSurfaceState).toHaveBeenCalledWith({ route: "/chats?session=history-one", state: "ready" });
});
