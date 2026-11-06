// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedbackInbox } from "./feedback-inbox";
import { call, ApiError } from "@/lib/api";
import { listAgentConnections, listSessions } from "@/lib/assistant-api";
import { connectionModels, listProfiles } from "@/lib/profiles-api";
import { loadBrowserAgentDefaults } from "@/lib/browser-agent-preferences";
import { developmentRequest } from "@/lib/development-api";
import type { FeedbackReport } from "@hosty-sdk/app/feedback";
vi.mock("@/lib/api", () => ({ call: vi.fn(), ApiError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
vi.mock("@/lib/assistant-api", () => ({ listSessions: vi.fn(), listAgentConnections: vi.fn() }));
vi.mock("@/lib/profiles-api", () => ({ listProfiles: vi.fn(), connectionModels: vi.fn() }));
vi.mock("@/lib/development-api", () => ({ developmentRequest: vi.fn() }));
vi.mock("@/lib/browser-agent-preferences", () => ({ loadBrowserAgentDefaults: vi.fn() }));
let root: Root, element: HTMLDivElement;
const report = (id: string, status = "unprocessed", disposition: string | null = null) => ({ id, revision: 1, status, disposition, workspaceId: "workspace", comment: id,
  context: { appId: "example.app", appName: "Example", observedAt: "2026-10-30", version: "1.0" }, annotations: [{id:"note",text:"Move the label"}] }) as FeedbackReport;
const button = (name: string) => [...document.querySelectorAll("button")].find(b => b.textContent === name || b.getAttribute("aria-label") === name)!;
const click = async (name: string) => act(async () => button(name).click());
const combobox = (label: string) => document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="' + label + '"]')!;
const openSelect = async (label: string) => act(async () => combobox(label).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
const choose = async (label: string, option: string) => {
  await openSelect(label);
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === option);
  expect(item, `Missing ${label} option: ${option}`).toBeDefined();
  await act(async () => item!.click());
};
const selectReport = async (name: string) => act(async () => element.querySelector<HTMLInputElement>('input[aria-label="Select ' + name + '"]')!.click());
const writes = () => vi.mocked(call).mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  vi.mocked(loadBrowserAgentDefaults).mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(call).mockImplementation(async () => Response.json({reports:[report("New"),report("Done","processed"),report("Busy","pending"),report("Dismissed","unprocessed","dismissed"),report("Partial","partial")],dispatches:[]}));
  vi.mocked(listSessions).mockResolvedValue([{id:"chat",title:"Existing chat",status:"idle",workspaceAssociation:{id:"workspace"}}] as never);
  vi.mocked(developmentRequest).mockResolvedValue({workspaces:[{id:"workspace",name:"Workspace",workflow:{state:"active"}}]});
  vi.mocked(listProfiles).mockResolvedValue({ revision: 1, defaultId: null, profiles: [
    { id: "reviewer", revision: 3, name: "Reviewer", description: "Review changes", instructions: "Review", connectionId: "codex", model: "fast", reasoningEffort: "high", skillIds: [] },
  ] });
  vi.mocked(listAgentConnections).mockResolvedValue({ defaultId: "codex", connections: [
    { id: "codex", name: "Codex account", kind: "codex", revision: 1, available: true, auth: "chatgpt" },
    { id: "claude", name: "Claude account", kind: "claude", revision: 1, available: true, auth: "claude-token" },
  ] });
  vi.mocked(connectionModels).mockResolvedValue({ revision: "one", defaultModel: "fast", models: [
    { id: "fast", label: "Fast model", efforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
    { id: "plain", label: "Plain model", efforts: [] },
  ] });
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const mount = async (running = false) => act(async () => root.render(<FeedbackInbox workspaceId="workspace" sessionId="chat" running={running} />));
it("bulk review includes only unprocessed reports and busy chat creates no request", async () => {
  vi.mocked(listSessions).mockResolvedValue([{ id: "chat", title: "Existing chat", status: "running", workspaceAssociation: { id: "workspace" } }] as never);
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Workspace", "Workspace"); await choose("Chat", "Existing chat · busy");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("1 complete reports"); expect(dialog.textContent).not.toContain("Done ·");
  expect(button("Send to chat").disabled).toBe(true);
  expect(dialog.textContent).toContain("This chat is busy");
  expect(vi.mocked(call).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it("server busy refusal preserves instruction and lost acceptance retries the frozen request", async () => {
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Workspace", "Workspace"); await choose("Chat", "Existing chat");
  const input = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Preserve this instruction"); input.dispatchEvent(new Event("input",{bubbles:true})); });
  const original = vi.mocked(call).getMockImplementation()!; let attempts = 0;
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (init?.method === "POST") { attempts++; if (attempts === 1) throw new ApiError(409,"session_busy","The chat became busy"); if (attempts === 2) throw new Error("Reply lost"); return Response.json({state:"accepted"}); }
    return original(url,init);
  });
  await click("Send to chat"); expect(input.value).toBe("Preserve this instruction"); expect(button("Send to chat").disabled).toBe(false);
  await click("Send to chat"); expect(input.disabled).toBe(true); expect(button("Cancel").disabled).toBe(true);
  await click("Retry same request");
  const writes = vi.mocked(call).mock.calls.filter(([, init]) => init?.method === "POST");
  expect(writes).toHaveLength(3); expect(writes[2]).toEqual(writes[1]); expect(writes[0]).not.toEqual(writes[1]);
  expect(JSON.parse(writes[2]![1]!.body as string).instruction).toBe("Preserve this instruction");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("closes the chat selector with Escape while retaining the reviewed destination, instruction and dialog", async () => {
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Workspace", "Workspace"); await choose("Chat", "Existing chat");
  await editText("Additional instructions", "Keep this reviewed instruction");
  const dialog = document.querySelector('[role="dialog"]');
  await openSelect("Chat"); expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await act(async () => document.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="listbox"]')).toBeNull(); expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  expect(combobox("Chat").textContent).toBe("Existing chat");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Additional instructions"]')!.value).toBe("Keep this reviewed instruction");
  await vi.waitFor(() => expect(document.activeElement).toBe(combobox("Chat")));
  expect(writes()).toHaveLength(0); await click("Cancel"); expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("sends selected workspace feedback straight to the current chat without destination review", async () => {
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (url, init) => init?.method === "POST" ? Response.json({ state: "accepted" }) : original(url, init));
  await mount(); await selectReport("New");
  await act(async () => root.render(<FeedbackInbox workspaceId="workspace" sessionId="current-chat" />));
  await click("Send selected (1)");
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(writes()[0]![1]!.body as string)).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    reports: [{ id: "New", revision: 1 }], workspaceId: "workspace", sessionId: "current-chat", instruction: "" });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(listSessions).not.toHaveBeenCalled(); expect(developmentRequest).not.toHaveBeenCalled();
  expect(element.textContent).toContain("Sent to chat");
});

it("addresses only eligible feedback bound to the current workspace without another confirmation", async () => {
  vi.mocked(call).mockImplementation(async (_url, init) => Response.json(init?.method === "POST" ? { state: "accepted" } : {
    reports: [report("New"), report("Done", "processed"), report("Busy", "pending"), report("Dismissed", "unprocessed", "dismissed"),
      { ...report("Other workspace"), workspaceId: "other" }], dispatches: [],
  }));
  await mount(); await click("Address all");
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(writes()[0]![1]!.body as string)).toMatchObject({ reports: [{ id: "New", revision: 1 }], workspaceId: "workspace", sessionId: "chat" });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(listSessions).not.toHaveBeenCalled(); expect(developmentRequest).not.toHaveBeenCalled();
});

it("sends a selected partial workspace report straight to the active chat", async () => {
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (url, init) => init?.method === "POST" ? Response.json({ state: "accepted" }) : original(url, init));
  await mount(); await selectReport("Partial"); await click("Send selected (1)");
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(writes()[0]![1]!.body as string)).toMatchObject({ reports: [{ id: "Partial", revision: 1 }], workspaceId: "workspace", sessionId: "chat" });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps workspace rows focused on the report while retaining complete metadata in its title and details", async () => {
  const value = report("Compact feedback");
  value.context = { ...value.context, version: "9.8.7", observedAt: "2026-11-04T18:23:11Z" };
  vi.mocked(call).mockResolvedValue(Response.json({ reports: [value], dispatches: [] }));
  await mount();
  const row = element.querySelector('ul > li')!, open = row.querySelector<HTMLButtonElement>('button')!;
  expect(row.textContent).toContain("Compact feedback");
  expect(row.textContent).toContain("Example");
  expect(row.textContent).toMatch(/1 annotation/);
  expect(row.textContent?.toLowerCase()).toContain("unprocessed");
  expect(row.textContent).not.toContain("Workspace ");
  expect(row.textContent).not.toContain("9.8.7");
  expect(row.textContent).not.toContain(new Date(value.context.observedAt).toLocaleString());
  expect(open.title).toContain("9.8.7");
  expect(open.title).toContain("Example");
  expect(open.title).toContain(new Date(value.context.observedAt).toLocaleString());
  expect(button("Refresh feedback")).toBeDefined();
  await act(async () => open.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("9.8.7");
  expect(dialog.querySelector('time')?.getAttribute("datetime")).toBe(value.context.observedAt);
});

it.each(["busy", "missing"])("does not create a chat or open a selector when the workspace chat is %s", async state => {
  await act(async () => root.render(<FeedbackInbox workspaceId="workspace" sessionId={state === "missing" ? undefined : "chat"} running={state === "busy"} />));
  await selectReport("New");
  expect(button("Send selected (1)").disabled).toBe(true); expect(button("Address all").disabled).toBe(true);
  expect(element.textContent?.toLowerCase()).toContain("chat");
  await click("Send selected (1)"); await click("Address all");
  expect(writes()).toHaveLength(0); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(listSessions).not.toHaveBeenCalled(); expect(developmentRequest).not.toHaveBeenCalled();
});

it("retries uncertain workspace delivery inline with the frozen destination after the selected chat changes", async () => {
  const original = vi.mocked(call).getMockImplementation()!; let attempts = 0;
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (init?.method === "POST") { if (++attempts === 1) throw new Error("Reply lost"); return Response.json({ state: "accepted" }); }
    return original(url, init);
  });
  await mount(); await selectReport("New"); await click("Send selected (1)");
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Reply lost");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Send selected (1)").disabled).toBe(true); expect(button("Address all").disabled).toBe(true);
  await act(async () => root.render(<FeedbackInbox workspaceId="workspace" sessionId="other-chat" running />));
  expect(button("Retry same request").disabled).toBe(false);
  await click("Retry same request");
  expect(writes()).toHaveLength(2); expect(writes()[1]).toEqual(writes()[0]);
  expect(JSON.parse(writes()[1]![1]!.body as string).sessionId).toBe("chat");
  expect(element.textContent).toContain("Sent to chat");
});

it.each(["unknown", "reserved"])("keeps an HTTP 200 %s workspace dispatch unconfirmed until its exact request is accepted", async state => {
  const original = vi.mocked(call).getMockImplementation()!; let attempts = 0;
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (init?.method === "POST") return Response.json(++attempts === 1 ? { state, error: "Original delivery is not confirmed" } : { state: "accepted" });
    return original(url, init);
  });
  await mount(); await selectReport("New"); await click("Send selected (1)");
  expect(element.querySelector('[role="alert"]')?.textContent).toBe("Original delivery is not confirmed");
  expect(element.textContent).not.toContain("Sent to chat");
  expect(button("Send selected (1)").disabled).toBe(true);
  expect(button("Address all").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.render(<FeedbackInbox workspaceId="workspace" sessionId="other-chat" running />));
  expect(button("Retry same request").disabled).toBe(false);
  await click("Retry same request");
  expect(writes()).toHaveLength(2);
  expect(writes()[1]).toEqual(writes()[0]);
  expect(JSON.parse(writes()[1]![1]!.body as string)).toMatchObject({ sessionId: "chat", workspaceId: "workspace", reports: [{ id: "New", revision: 1 }] });
  expect(element.textContent).toContain("Sent to chat");
  expect(element.querySelector('[role="alert"]')).toBeNull();
  expect(button("Retry same request")).toBeUndefined();
});

it("keeps a reviewed HTTP 200 unknown dispatch frozen and preserves its instruction until accepted replay", async () => {
  const original = vi.mocked(call).getMockImplementation()!; let attempts = 0;
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (init?.method === "POST") return Response.json({ state: ++attempts === 1 ? "unknown" : "accepted" });
    return original(url, init);
  });
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Workspace", "Workspace"); await choose("Chat", "Existing chat");
  const input = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Keep this reviewed instruction");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Send to chat");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(input.value).toBe("Keep this reviewed instruction"); expect(input.disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  expect(combobox("Workspace").disabled).toBe(true);
  expect(combobox("Chat").disabled).toBe(true);
  expect(element.textContent).not.toContain("Sent to chat");
  await click("Retry same request");
  expect(writes()).toHaveLength(2); expect(writes()[1]).toEqual(writes()[0]);
  expect(JSON.parse(writes()[1]![1]!.body as string).instruction).toBe("Keep this reviewed instruction");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(element.textContent).toContain("Sent to chat");
});

it("shows a known workspace refusal inline and uses a fresh request when sending again", async () => {
  const original = vi.mocked(call).getMockImplementation()!; let attempts = 0;
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (init?.method === "POST") { if (++attempts === 1) throw new ApiError(409, "session_busy", "The chat became busy"); return Response.json({ state: "accepted" }); }
    return original(url, init);
  });
  await mount(); await selectReport("New"); await click("Send selected (1)");
  expect(element.querySelector('[role="alert"]')?.textContent).toBe("The chat became busy");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Send selected (1)").disabled).toBe(false);
  await click("Send selected (1)");
  expect(writes()).toHaveLength(2);
  const first = JSON.parse(writes()[0]![1]!.body as string), second = JSON.parse(writes()[1]![1]!.body as string);
  expect(second.requestId).not.toBe(first.requestId);
  expect({ ...second, requestId: first.requestId }).toEqual(first);
});
it("finds cancelled feedback through Needs review and resends it to the reviewed existing chat", async () => {
  const stopped = { ...report("Stopped", "cancelled"), revision: 7 };
  vi.mocked(call).mockImplementation(async (_url, init) => Response.json(init?.method === "POST" ? { state: "accepted" } : { reports: [stopped], dispatches: [] }));
  await act(async () => root.render(<FeedbackInbox />));
  expect(element.textContent).toContain("No feedback matches this view.");
  await choose("Feedback status", "Needs review");
  await selectReport("Stopped");
  expect(button("Send selected (1)").disabled).toBe(false);
  await click("Send selected (1)");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Send feedback again");
  await choose("Workspace", "Workspace"); await choose("Chat", "Existing chat");
  await click("Send to chat");
  const writes = vi.mocked(call).mock.calls.filter(([, init]) => init?.method === "POST");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]![1]!.body as string)).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    reports: [{ id: "Stopped", revision: 7 }], workspaceId: "workspace", sessionId: "chat", instruction: "" });
});

it("combines status, application and unassigned filters while retaining selected reports across views", async () => {
  const other = { ...report("Other report"), workspaceId: null, context: { ...report("Other report").context, appId: "another.app", appName: "Other application" } };
  vi.mocked(call).mockImplementation(async () => Response.json({ reports: [report("Selected report"), other, { ...report("Handled report", "processed"), workspaceId: null }], dispatches: [] }));
  const visible = () => [...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input => input.getAttribute("aria-label"));
  await act(async () => root.render(<FeedbackInbox />));
  expect(visible()).toEqual(["Select Selected report", "Select Other report"]);
  await selectReport("Selected report");
  await choose("Feedback application", "Other application");
  expect(visible()).toEqual(["Select Other report"]); expect(button("Send selected (1)").disabled).toBe(false);
  await choose("Feedback workspace filter", "Unassigned"); await choose("Feedback application", "All applications");
  expect(visible()).toEqual(["Select Other report"]);
  await choose("Feedback status", "All");
  expect(visible()).toEqual(["Select Other report", "Select Handled report"]);
  await selectReport("Handled report");
  await choose("Feedback workspace filter", "All workspaces"); await choose("Feedback application", "Example");
  expect(visible()).toEqual(["Select Selected report", "Select Handled report"]);
  expect(button("Send selected (2)").disabled).toBe(false); await click("Send selected (2)");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("2 complete reports"); expect(dialog.textContent).toContain("Selected report"); expect(dialog.textContent).toContain("Handled report");
  expect(dialog.textContent).not.toContain("Other report"); expect(writes()).toHaveLength(0); await click("Cancel");
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("omits a workspace feedback section until it has reports, without flashing empty controls", async () => {
  const first = deferred<Response>();
  vi.mocked(call).mockReturnValue(first.promise);
  await mount();
  expect(element.textContent).toBe("");
  await act(async () => first.resolve(Response.json({ reports: [], dispatches: [] })));
  expect(element.textContent).toBe("");
  vi.mocked(call).mockResolvedValue(Response.json({ reports: [report("New report")], dispatches: [] }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(element.querySelector('[aria-label="Feedback"]')).not.toBeNull();
  expect(element.textContent).toContain("New report");
});

it("retains confirmed feedback while refreshing and ignores a previous workspace's late response", async () => {
  await act(async () => root.render(<FeedbackInbox key="first" workspaceId="workspace" />));
  const section = element.querySelector('[aria-label="Feedback"]');
  const oldRead = deferred<Response>();
  vi.mocked(call).mockReturnValue(oldRead.promise);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(element.querySelector('[aria-label="Feedback"]')).toBe(section);
  const nextRead = deferred<Response>();
  vi.mocked(call).mockReturnValue(nextRead.promise);
  await act(async () => root.render(<FeedbackInbox key="second" workspaceId="other" />));
  expect(element.textContent).toBe("");
  await act(async () => oldRead.resolve(Response.json({ reports: [report("Old report")], dispatches: [] })));
  expect(element.textContent).toBe("");
  await act(async () => nextRead.resolve(Response.json({ reports: [], dispatches: [] })));
  expect(element.textContent).toBe("");
});

it("shows workspace feedback read errors and keeps retry available", async () => {
  vi.mocked(call).mockRejectedValueOnce(new Error("Feedback unavailable"));
  await mount();
  expect(element.querySelector('[role="alert"]')?.textContent).toBe("Feedback unavailable");
  const retry = deferred<Response>();
  vi.mocked(call).mockReturnValue(retry.promise);
  await click("Refresh feedback");
  expect(element.querySelector('[aria-label="Feedback"]')).not.toBeNull();
  await act(async () => retry.resolve(Response.json({ reports: [], dispatches: [] })));
  expect(element.querySelector('[aria-label="Feedback"]')).toBeNull();
});

it("retains loading and empty states on the full feedback page", async () => {
  const read = deferred<Response>();
  vi.mocked(call).mockReturnValue(read.promise);
  await act(async () => root.render(<FeedbackInbox />));
  expect(element.textContent).toContain("Loading feedback…");
  await act(async () => read.resolve(Response.json({ reports: [], dispatches: [] })));
  expect(element.textContent).toContain("No feedback matches this view.");
});

it("freezes a new chat's reviewed agent choices across an uncertain delivery", async () => {
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (init?.method === "POST") throw new Error("Reply lost");
    return original(url, init);
  });
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Agent profile", "No profile · custom settings"); await choose("Agent / provider", "Claude account · claude");
  await choose("Model", "Fast model"); await choose("Reasoning effort", "High"); await choose("Autonomy", "Autonomous");
  expect(writes()).toHaveLength(0);
  await click("Send to chat");
  expect(JSON.parse(writes()[0]![1]!.body as string)).toMatchObject({ sessionId: null, profileId: null, connectionId: "claude",
    executionSelection: { model: "fast", reasoningEffort: "high" }, autonomy: "autonomous" });
  expect(document.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
  await click("Retry same request");
  expect(writes()).toHaveLength(2); expect(writes()[1]).toEqual(writes()[0]);
});

it("uses profile revisions and omits new-chat settings for an existing destination", async () => {
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (url, init) => init?.method === "POST" ? Response.json({ state: "accepted" }) : original(url, init));
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Agent profile", "Reviewer"); await choose("Autonomy", "Autonomous");
  expect(combobox("Model").disabled).toBe(true);
  await click("Send to chat");
  const body = JSON.parse(writes()[0]![1]!.body as string);
  expect(body).toMatchObject({ profileId: "reviewer", profileRevision: 3, autonomy: "autonomous" });
  expect(body).not.toHaveProperty("executionSelection");
  await click("Address all"); await choose("Agent profile", "Reviewer");
  await choose("Workspace", "Workspace"); await choose("Chat", "Existing chat");
  expect(combobox("Autonomy")).toBeNull();
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("current agent, reasoning and autonomy");
  await click("Send to chat");
  const existing = JSON.parse(writes()[1]![1]!.body as string);
  expect(existing.sessionId).toBe("chat"); expect(existing).not.toHaveProperty("profileId"); expect(existing).not.toHaveProperty("autonomy");
});

const sourceBinding = (id: string, workspaceId: string, state = "active") => ({ id, workspaceId, state });
const nativeSession = (id: string, developmentWorkspaces: ReturnType<typeof sourceBinding>[], status = "idle") => ({
  id, title: id, status, createdAt: "2026-11-05T12:00:00Z", executionMode: "native" as const, developmentWorkspaces,
});
const chatOptions = async () => {
  await openSelect("Chat");
  const labels = [...document.querySelectorAll('[role="option"]')].map(option => option.textContent);
  await act(async () => document.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  return labels;
};
const twoWorkspaces = () => vi.mocked(developmentRequest).mockResolvedValue({ workspaces: [
  { id: "workspace", name: "Workspace", workflow: { state: "active" } },
  { id: "other-workspace", name: "Other workspace", workflow: { state: "active" } },
] });

it("lists native-source chats only in their resolved current workspace", async () => {
  twoWorkspaces();
  vi.mocked(listSessions).mockResolvedValue([
    nativeSession("Native chat", [sourceBinding("native-tree", "workspace")]),
    nativeSession("Two repositories", [sourceBinding("repo-one", "workspace"), sourceBinding("repo-two", "workspace")]),
    nativeSession("Released old tree", [sourceBinding("old-tree", "workspace", "released")]),
    nativeSession("Current here", [sourceBinding("current-tree", "workspace"), sourceBinding("released-other", "other-workspace", "released")]),
    nativeSession("Current elsewhere", [sourceBinding("released-here", "workspace", "released"), sourceBinding("current-other", "other-workspace")]),
    nativeSession("Ambiguous source", [sourceBinding("ambiguous-here", "workspace"), sourceBinding("ambiguous-other", "other-workspace")]),
    { ...nativeSession("Explicit here", [sourceBinding("source-other", "other-workspace")]), workspaceAssociation: { id: "workspace", revision: 2 } },
    { ...nativeSession("Explicit elsewhere", [sourceBinding("source-here", "workspace")]), workspaceAssociation: { id: "other-workspace", revision: 3 } },
    { ...nativeSession("Null association", [sourceBinding("fresh-tree", "workspace")]), workspaceAssociation: null },
    nativeSession("Unbound chat", []),
  ]);
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all"); await choose("Workspace", "Workspace");
  expect(await chatOptions()).toEqual(["New chat", "Native chat", "Two repositories", "Current here", "Explicit here", "Null association"]);
  await choose("Workspace", "Other workspace");
  expect(await chatOptions()).toEqual(["New chat", "Current elsewhere", "Explicit elsewhere"]);
  expect(writes()).toHaveLength(0);
});

it("reuses a chosen native chat for later batches and refreshes its busy state without new-chat settings", async () => {
  let reports = [report("First batch")];
  const native = (status = "idle") => nativeSession("Native chat", [sourceBinding("first-repository", "workspace"), sourceBinding("second-repository", "workspace")], status);
  vi.mocked(listSessions).mockResolvedValue([native()]);
  vi.mocked(call).mockImplementation(async (_url, init) => {
    if (init?.method === "POST") { reports = [report("First batch", "pending"), report("Second batch")]; return Response.json({ state: "accepted" }); }
    return Response.json({ reports, dispatches: [] });
  });
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Agent profile", "Reviewer"); await choose("Autonomy", "Autonomous");
  await choose("Workspace", "Workspace"); await choose("Chat", "Native chat");
  expect(combobox("Agent profile")).toBeNull();
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("current agent, reasoning and autonomy");
  await editText("Additional instructions", "First batch instruction"); await click("Send to chat");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  vi.mocked(listSessions).mockResolvedValue([native("running")]);
  await click("Address all");
  expect(combobox("Workspace").textContent).toBe("Workspace");
  expect(combobox("Chat").textContent).toBe("Native chat · busy");
  expect(await chatOptions()).toContain("Native chat · busy");
  expect(button("Send to chat").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("This chat is busy");
  await click("Send to chat"); expect(writes()).toHaveLength(1);
  await editText("Additional instructions", "Second batch instruction");
  vi.mocked(listSessions).mockResolvedValue([native()]);
  expect(button("Send to chat").disabled).toBe(true);
  await click("Refresh chats");
  expect(combobox("Chat").textContent).toBe("Native chat");
  expect(await chatOptions()).toContain("Native chat");
  expect(button("Send to chat").disabled).toBe(false);
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Additional instructions"]')!.value).toBe("Second batch instruction");
  await click("Send to chat");
  expect(writes()).toHaveLength(2);
  const bodies = writes().map(([url, init]) => { expect(url).toBe("/feedback/dispatches"); return JSON.parse(init!.body as string); });
  for (let index = 0; index < bodies.length; index++) {
    expect(bodies[index]).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), reports: [{ id: index ? "Second batch" : "First batch", revision: 1 }],
      workspaceId: "workspace", sessionId: "Native chat", instruction: index ? "Second batch instruction" : "First batch instruction" });
  }
  expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  expect(listSessions).toHaveBeenCalledTimes(3);
  expect(vi.mocked(developmentRequest).mock.calls.every(args => args.length === 0)).toBe(true);
});

it("blocks a previously selected native chat after its source moves to another workspace", async () => {
  twoWorkspaces();
  vi.mocked(listSessions).mockResolvedValue([nativeSession("Native chat", [sourceBinding("source", "workspace")])]);
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Workspace", "Workspace"); await choose("Chat", "Native chat");
  expect(button("Send to chat").disabled).toBe(false);
  vi.mocked(listSessions).mockResolvedValue([nativeSession("Native chat", [sourceBinding("source", "other-workspace")])]);
  await click("Refresh chats");
  expect(await chatOptions()).toEqual(["Unavailable selection", "New chat"]);
  expect(button("Send to chat").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("The selected chat is no longer available in this workspace.");
  await click("Send to chat"); expect(writes()).toHaveLength(0);
  await choose("Workspace", "Other workspace");
  expect(await chatOptions()).toEqual(["New chat", "Native chat"]);
  await choose("Chat", "Native chat"); expect(button("Send to chat").disabled).toBe(false);
});

it("clears unsupported effort when the model changes and leaves cancellation free of writes", async () => {
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Reasoning effort", "High"); await choose("Model", "Plain model");
  expect(combobox("Reasoning effort").textContent).toBe("Default effort");
  expect(combobox("Reasoning effort").disabled).toBe(true);
  await click("Cancel"); expect(writes()).toHaveLength(0);
});

it("blocks new-chat delivery while agent choices are unavailable and supports explicit refresh", async () => {
  vi.mocked(listAgentConnections).mockRejectedValueOnce(new Error("Connection catalog unavailable"));
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  expect(button("Send to chat").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Connection catalog unavailable");
  await click("Refresh agent choices"); expect(button("Send to chat").disabled).toBe(false);
  expect(writes()).toHaveLength(0);
});

it("requires review of a selected profile that changed while refreshing choices", async () => {
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Agent profile", "Reviewer");
  const previous = await listProfiles();
  vi.mocked(listProfiles).mockResolvedValue({ ...previous, profiles: previous.profiles.map(profile => ({ ...profile, revision: 4, reasoningEffort: "low" })) });
  vi.mocked(connectionModels).mockRejectedValueOnce(new Error("Model catalog unavailable")).mockRejectedValueOnce(new Error("Model catalog unavailable"));
  await choose("Agent profile", "No profile · custom settings"); await choose("Agent / provider", "Claude account · claude");
  await choose("Agent profile", "Reviewer");
  // The failed catalog creates an explicit refresh entry point without changing the selected profile.
  expect(button("Refresh agent choices")).toBeDefined();
  await click("Refresh agent choices");
  expect(button("Send to chat").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("This profile changed");
  await click("Use updated profile");
  expect(button("Send to chat").disabled).toBe(false);
  expect(combobox("Reasoning effort").textContent).toBe("Low");
});

it("reviews remembered manual model, effort and autonomy before creating a feedback chat", async () => {
  const defaults = { models: { codex: { model: "fast", reasoningEffort: "high" } }, autonomy: "autonomous" as const };
  vi.mocked(loadBrowserAgentDefaults).mockResolvedValue(defaults);
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  expect(combobox("Model").textContent).toBe("Fast model");
  expect(combobox("Reasoning effort").textContent).toBe("High");
  expect(combobox("Autonomy").textContent).toBe("Autonomous");
  expect(writes()).toHaveLength(0);
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (url, init) => init?.method === "POST" ? Response.json({ state: "accepted" }) : original(url, init));
  await choose("Autonomy", "Normal"); await click("Send to chat");
  expect(JSON.parse(writes()[0]![1]!.body as string)).toMatchObject({ browserDefaults: defaults, autonomy: "normal" });
});

const openDetails = async (name: string) => act(async () => [...element.querySelectorAll("button")].find(b => b.textContent?.startsWith(name))!.click());
const actionTrigger = (name?: string) => (document.querySelector('[role="dialog"]') ?? element).querySelector<HTMLButtonElement>(name ? 'button[aria-label="Feedback actions for ' + name + '"]' : 'button[aria-label^="Feedback actions for "]')!;
const openActions = async (name?: string) => act(async () => actionTrigger(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
const menuAction = async (action: "Edit" | "Delete", name?: string) => {
  await openActions(name);
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === action)!.click());
};
const editText = async (label: string, value: string) => act(async () => {
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="' + label + '"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it.each(["workspace", undefined])("offers only Edit and Delete in %s feedback row menus without selecting or dispatching", async workspaceId => {
  await act(async () => root.render(<FeedbackInbox workspaceId={workspaceId} sessionId="chat" />));
  const row = element.querySelector('ul > li')!;
  expect(row.querySelectorAll("button")).toHaveLength(2);
  await openActions("New");
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["Edit", "Delete"]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(element.querySelector<HTMLInputElement>('input[aria-label="Select New"]')!.checked).toBe(false);
  expect(writes()).toHaveLength(0);
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "Edit")!.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Edit feedback");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.value).toBe("New");
  expect(document.activeElement).toBe(document.querySelector('textarea[aria-label="Overall comment"]'));
  expect(writes()).toHaveLength(0); await click("Cancel");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Feedback details");
  expect(element.querySelector<HTMLInputElement>('input[aria-label="Select New"]')!.checked).toBe(false);
  await click("Close");
  await vi.waitFor(() => expect(document.activeElement).toBe(row.querySelector("button")));
});

it.each(["workspace", undefined])("keeps %s feedback previews and their processing history read-only", async workspaceId => {
  vi.mocked(call).mockResolvedValue(Response.json({ reports: [report("New")], dispatches: [{ id: "attempt", input: { reports: [{ id: "New", revision: 1 }], sessionId: "chat", instruction: "Earlier instruction" }, state: "reserved", messageSequence: null }] }));
  await act(async () => root.render(<FeedbackInbox workspaceId={workspaceId} sessionId="chat" />));
  await openDetails("New");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Move the label");
  expect(dialog.textContent).toContain("Current workspace");
  expect(dialog.textContent).toContain("Processing history");
  expect(dialog.textContent).toContain("Earlier instruction");
  expect(dialog.querySelector('a[href="/chats?session=chat"]')?.textContent).toBe("Open chat");
  expect(dialog.querySelector('select, textarea, input, [role="combobox"]')).toBeNull();
  expect([...dialog.querySelectorAll("button")].map(b => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Feedback actions for New", "Close"]);
  expect(dialog.textContent).not.toMatch(/Send to chat|Send again|Dismiss|Restore|Mark duplicate|Recover delivery/);
  expect(writes()).toHaveLength(0);
  await menuAction("Delete");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Delete feedback?");
  expect(writes()).toHaveLength(0); await click("Cancel");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Feedback details");
});

it("opens row deletion directly in its confirmation without selecting or dispatching feedback", async () => {
  await mount(); await menuAction("Delete", "New");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Delete feedback?");
  expect(element.querySelector<HTMLInputElement>('input[aria-label="Select New"]')!.checked).toBe(false);
  expect(writes()).toHaveLength(0); await click("Cancel");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Feedback details");
});

it("recovers an unconfirmed delivery from the main inbox with its exact original input", async () => {
  const input = { requestId: crypto.randomUUID(), reports: [{ id: "New", revision: 7 }], sessionId: "original-chat", workspaceId: "workspace", instruction: "Original reviewed instruction" };
  let attempts = 0;
  vi.mocked(call).mockImplementation(async (_url, init) => {
    if (init?.method === "POST") { if (++attempts === 1) throw new Error("Reply lost"); return Response.json({ state: "accepted" }); }
    return Response.json({ reports: [report("New", "uncertain")], dispatches: [{ id: "attempt", input, state: "reserved", messageSequence: null }] });
  });
  await mount();
  expect(element.querySelector('[aria-label="Unconfirmed feedback deliveries"]')).not.toBeNull();
  await click("Recover delivery");
  expect(element.querySelector('[role="alert"]')?.textContent).toBe("Reply lost");
  await click("Recover delivery");
  expect(writes()).toHaveLength(2); expect(writes()[1]).toEqual(writes()[0]);
  expect(writes()[0]).toEqual(["/feedback/dispatches", { method: "POST", body: JSON.stringify(input) }]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(listSessions).not.toHaveBeenCalled(); expect(developmentRequest).not.toHaveBeenCalled();
});

it("cancels comment and annotation edits without changing the stored report", async () => {
  await mount(); await openDetails("New"); await menuAction("Edit");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Edit feedback");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.maxLength).toBe(5000);
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Annotation 1"]')!.maxLength).toBe(2000);
  await editText("Annotation 1", "   "); expect(button("Save changes").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Each annotation needs a comment.");
  await editText("Overall comment", "Unsubmitted explanation"); await editText("Annotation 1", "Unsubmitted note");
  await click("Cancel");
  expect(writes()).toHaveLength(0);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Feedback details");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Move the label");
  await menuAction("Edit");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.value).toBe("New");
});

it("saves only editable text while retaining annotation IDs, evidence and observation", async () => {
  const originalURL = URL;
  vi.stubGlobal("URL", class extends originalURL { static createObjectURL() { return "blob:feedback-image"; } static revokeObjectURL() {} });
  let saved = { ...report("New"), annotations: [{ ...report("New").annotations[0]!, mediaType: "image/png", route: "/original", capturedAt: "2026-10-30" }] };
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (url.includes("/images/")) return new Response(new Blob(["image"]));
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      saved = { ...saved, revision: 2, comment: body.comment, annotations: saved.annotations.map(n => ({ ...n, text: body.annotations.find((edited: { id: string; text: string }) => edited.id === n.id).text })) };
      return Response.json(saved);
    }
    return Response.json({ reports: [saved], dispatches: [] });
  });
  await mount(); await openDetails("New"); await menuAction("Edit");
  await editText("Overall comment", "Updated explanation"); await editText("Annotation 1", "Updated annotation"); await click("Save changes");
  expect(writes()).toHaveLength(1);
  expect(writes()[0]![0]).toBe("/feedback/New/edit");
  expect(JSON.parse(writes()[0]![1]!.body as string)).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 1,
    comment: "Updated explanation", annotations: [{ id: "note", text: "Updated annotation" }] });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Feedback details"); expect(dialog.textContent).toContain("Updated annotation");
  expect(dialog.textContent).toContain("/original"); expect(dialog.textContent).toContain("1.0");
  expect(dialog.querySelector("img")?.src).toBe("blob:feedback-image");
  expect(saved.context).toEqual(report("New").context); expect(element.textContent).toContain("Feedback updated.");
});

it("preserves unsaved text and its reviewed revision across refresh and shows conflicts inside the dialog", async () => {
  let fresh = report("New");
  vi.mocked(call).mockImplementation(async (_url, init) => {
    if (init?.method === "POST") throw new ApiError(409, "feedback_revision_conflict", "Feedback changed; refresh before continuing.");
    return Response.json({ reports: [fresh], dispatches: [] });
  });
  await mount(); await openDetails("New"); await menuAction("Edit");
  await editText("Overall comment", "Keep my draft"); await editText("Annotation 1", "Keep my note");
  fresh = { ...fresh, revision: 2, comment: "Someone else's change" };
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.value).toBe("Keep my draft");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Annotation 1"]')!.value).toBe("Keep my note");
  await click("Save changes");
  expect(JSON.parse(writes()[0]![1]!.body as string).expectedRevision).toBe(1);
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("Feedback changed; refresh before continuing.");
  expect(button("Save changes").disabled).toBe(true);
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.value).toBe("Keep my draft");
  await click("Cancel"); await menuAction("Edit");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.value).toBe("Someone else's change");
});

it("retains the last workspace report's draft if another reviewer deletes it during a refresh", async () => {
  let removed = false;
  vi.mocked(call).mockImplementation(async (_url, init) => {
    if (init?.method === "POST") throw new ApiError(404, "feedback_missing", "Feedback no longer exists.");
    return Response.json({ reports: removed ? [] : [report("New")], dispatches: [] });
  });
  await mount(); await openDetails("New"); await menuAction("Edit"); await editText("Overall comment", "Retain this unsaved text");
  removed = true; await act(async () => window.dispatchEvent(new Event("focus")));
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.value).toBe("Retain this unsaved text");
  await click("Save changes");
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("Feedback no longer exists.");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.value).toBe("Retain this unsaved text");
  expect(button("Cancel").disabled).toBe(false);
});

it.each(["workspace", undefined].flatMap(workspaceId => ["pending", "uncertain", "disabled"].map(state => ({ workspaceId, state }))))("blocks $workspaceId feedback actions when $state", async ({ workspaceId, state }) => {
  vi.mocked(call).mockResolvedValue(Response.json({ reports: [report("New", state === "disabled" ? "unprocessed" : state)], dispatches: [] }));
  await act(async () => root.render(<FeedbackInbox workspaceId={workspaceId} sessionId="chat" disabled={state === "disabled"} />));
  if (!workspaceId) await choose("Feedback status", "All");
  expect(actionTrigger("New").disabled).toBe(true);
  await openDetails("New");
  expect(actionTrigger("New").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"] [role="combobox"]')).toBeNull();
  expect(writes()).toHaveLength(0);
});

it("freezes editing controls and other mutations while save is pending", async () => {
  const save = deferred<Response>();
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation((url, init) => init?.method === "POST" ? save.promise : original(url, init));
  await mount(); await openDetails("New"); await menuAction("Edit"); await editText("Overall comment", "Saving text"); await click("Save changes");
  expect(button("Cancel").disabled).toBe(true); expect(button("Saving…").disabled).toBe(true);
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.disabled).toBe(true);
  expect(button("Address all").disabled).toBe(true); expect(button("Close")).toBeUndefined();
  expect(element.querySelector<HTMLButtonElement>('button[aria-label="Feedback actions for New"]')!.disabled).toBe(true);
  await act(async () => save.resolve(Response.json({ ...report("New"), revision: 2, comment: "Saving text" })));
  expect(actionTrigger().disabled).toBe(false);
});

it.each(["edit", "delete"])("retries an uncertain %s with exactly the frozen UUID, revision and payload", async kind => {
  let saved = report("New"), deleted = false, attempts = 0;
  vi.mocked(call).mockImplementation(async (_url, init) => {
    if (init?.method === "POST") {
      if (++attempts === 1) throw new Error("Reply lost");
      if (kind === "delete") { deleted = true; return Response.json({ id: saved.id, status: "deleted" }); }
      saved = { ...saved, revision: 3, comment: "Reviewed text" }; return Response.json(saved);
    }
    return Response.json({ reports: deleted ? [] : [saved], dispatches: [] });
  });
  await act(async () => root.render(<FeedbackInbox />)); await openDetails("New"); await menuAction(kind === "edit" ? "Edit" : "Delete");
  if (kind === "edit") await editText("Overall comment", "Reviewed text");
  await click(kind === "edit" ? "Save changes" : "Delete feedback");
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("Reply lost");
  expect(button("Cancel").disabled).toBe(true); expect(button("Close")).toBeUndefined(); expect(button("Address all").disabled).toBe(true);
  expect(element.querySelector<HTMLButtonElement>('button[aria-label="Feedback actions for New"]')!.disabled).toBe(true);
  saved = { ...saved, revision: 2, comment: "New server value" };
  await act(async () => window.dispatchEvent(new Event("focus")));
  if (kind === "edit") expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!.value).toBe("Reviewed text");
  await click("Retry same request");
  expect(writes()).toHaveLength(2); expect(writes()[1]).toEqual(writes()[0]);
  expect(JSON.parse(writes()[1]![1]!.body as string).expectedRevision).toBe(1);
  expect(element.textContent).toContain(kind === "edit" ? "Feedback updated." : "Feedback deleted.");
  if (kind === "delete") expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("requires explicit delete confirmation, supports cancellation and clears deleted selection and details", async () => {
  let deleted = false;
  vi.mocked(call).mockImplementation(async (_url, init) => {
    if (init?.method === "POST") { deleted = true; return Response.json({ id: "New", status: "deleted" }); }
    return Response.json({ reports: [report("Remaining"), ...(!deleted ? [report("New")] : [])], dispatches: [] });
  });
  await mount(); await selectReport("New"); await openDetails("New"); await menuAction("Delete");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("This permanently deletes this report, all annotations and its screenshots. This cannot be undone.");
  expect(writes()).toHaveLength(0); await click("Cancel");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Feedback details");
  expect(writes()).toHaveLength(0); await menuAction("Delete"); await click("Delete feedback");
  expect(writes()[0]![0]).toBe("/feedback/New/delete");
  expect(JSON.parse(writes()[0]![1]!.body as string)).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 1 });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(button("Send selected (0)").disabled).toBe(true);
  expect(element.querySelector('input[aria-label="Select New"]')).toBeNull(); expect(element.textContent).toContain("Feedback deleted.");
});
