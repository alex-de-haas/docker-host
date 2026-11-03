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
const button = (name: string) => [...document.querySelectorAll("button")].find(b => b.textContent === name)!;
const click = async (name: string) => act(async () => button(name).click());
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
  await mount(true); await click("Address all");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("1 complete reports"); expect(dialog.textContent).not.toContain("Done ·");
  expect(button("Send to chat").disabled).toBe(true);
  expect(dialog.textContent).toContain("This chat is busy");
  expect(vi.mocked(call).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it("server busy refusal preserves instruction and lost acceptance retries the frozen request", async () => {
  await mount(); await click("Address all");
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
