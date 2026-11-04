// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedbackInbox } from "./feedback-inbox";
import { call, ApiError } from "@/lib/api";
import { listSessions } from "@/lib/assistant-api";
import { developmentRequest } from "@/lib/development-api";
import type { FeedbackReport } from "@hosty-sdk/app/feedback";
vi.mock("@/lib/api", () => ({ call: vi.fn(), ApiError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
vi.mock("@/lib/assistant-api", () => ({ listSessions: vi.fn() }));
vi.mock("@/lib/development-api", () => ({ developmentRequest: vi.fn() }));
let root: Root, element: HTMLDivElement;
const report = (id: string, status = "unprocessed", disposition: string | null = null) => ({ id, revision: 1, status, disposition, workspaceId: "workspace", comment: id,
  context: { appId: "example.app", appName: "Example", observedAt: "2026-10-30", version: "1.0" }, annotations: [{id:"note",text:"Move the label"}] }) as FeedbackReport;
const button = (name: string) => [...document.querySelectorAll("button")].find(b => b.textContent === name || b.getAttribute("aria-label") === name)!;
const click = async (name: string) => act(async () => button(name).click());
const choose = async (label: string, value: string) => act(async () => {
  const control = document.querySelector<HTMLSelectElement>('select[aria-label="' + label + '"]')!;
  control.value = value; control.dispatchEvent(new Event("change", { bubbles: true }));
});
const selectReport = async (name: string) => act(async () => element.querySelector<HTMLInputElement>('input[aria-label="Select ' + name + '"]')!.click());
const writes = () => vi.mocked(call).mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(call).mockImplementation(async () => Response.json({reports:[report("New"),report("Done","processed"),report("Busy","pending"),report("Dismissed","unprocessed","dismissed"),report("Partial","partial")],dispatches:[]}));
  vi.mocked(listSessions).mockResolvedValue([{id:"chat",title:"Existing chat",status:"idle",workspaceAssociation:{id:"workspace"}}] as never);
  vi.mocked(developmentRequest).mockResolvedValue({workspaces:[{id:"workspace",name:"Workspace",workflow:{state:"active"}}]});
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const mount = async (running = false) => act(async () => root.render(<FeedbackInbox workspaceId="workspace" sessionId="chat" running={running} />));
it("bulk review includes only unprocessed reports and busy chat creates no request", async () => {
  vi.mocked(listSessions).mockResolvedValue([{ id: "chat", title: "Existing chat", status: "running", workspaceAssociation: { id: "workspace" } }] as never);
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Workspace", "workspace"); await choose("Chat", "chat");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("1 complete reports"); expect(dialog.textContent).not.toContain("Done ·");
  expect(button("Send to chat").disabled).toBe(true);
  expect(dialog.textContent).toContain("This chat is busy");
  expect(vi.mocked(call).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it("server busy refusal preserves instruction and lost acceptance retries the frozen request", async () => {
  await act(async () => root.render(<FeedbackInbox />)); await click("Address all");
  await choose("Workspace", "workspace"); await choose("Chat", "chat");
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

it("sends a workspace report from its details straight to the active chat", async () => {
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (url, init) => init?.method === "POST" ? Response.json({ state: "accepted" }) : original(url, init));
  await mount();
  await act(async () => [...element.querySelectorAll("button")].find(b => b.textContent?.startsWith("Partial"))!.click());
  await click("Send again");
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
  await choose("Workspace", "workspace"); await choose("Chat", "chat");
  const input = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Keep this reviewed instruction");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Send to chat");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(input.value).toBe("Keep this reviewed instruction"); expect(input.disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Workspace"]')!.disabled).toBe(true);
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Chat"]')!.disabled).toBe(true);
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
  const select = async (label: string, value: string) => act(async () => {
    const control = document.querySelector<HTMLSelectElement>('select[aria-label="' + label + '"]')!;
    control.value = value; control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await select("Feedback status", "needs-review");
  await act(async () => [...element.querySelectorAll("button")].find(b => b.textContent?.startsWith("Stopped"))!.click());
  expect(button("Send again").disabled).toBe(false);
  await click("Send again");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Send feedback again");
  await select("Workspace", "workspace"); await select("Chat", "chat");
  await click("Send to chat");
  const writes = vi.mocked(call).mock.calls.filter(([, init]) => init?.method === "POST");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]![1]!.body as string)).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    reports: [{ id: "Stopped", revision: 7 }], workspaceId: "workspace", sessionId: "chat", instruction: "" });
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
