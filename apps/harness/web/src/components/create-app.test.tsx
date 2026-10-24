// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateApp } from "./create-app";
import { workspaceAction, getSession, dispatchAppCreation, type AssistantSession } from "@/lib/assistant-api";
vi.mock("@/lib/assistant-api", () => ({ workspaceAction: vi.fn(), getSession: vi.fn(), dispatchAppCreation: vi.fn() }));
const draft = { name: "Draft notes", appId: "local.draft-notes", description: "Keep me", authorName: "Draft Author", authorEmail: "draft@example.test", consent: false, prompt: "Build a notebook" };
let root: Root, host: HTMLDivElement, session: AssistantSession;
const change = vi.fn();
const button = (name: string) => [...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === name || b.textContent === name)!;
const input = (id: string) => document.getElementById("create-app-" + id) as HTMLInputElement;
const click = async (element: HTMLElement) => act(async () => element.click());
const render = async () => act(async () => root.render(<CreateApp session={session} busy={false} onChange={change} />));
const type = async (id: string, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(id), value);
  input(id).dispatchEvent(new Event("input", { bubbles: true }));
});
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear(); vi.resetAllMocks();
  session = { id: "test", appCreations: [] } as unknown as AssistantSession;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(workspaceAction).mockResolvedValue({}); vi.mocked(getSession).mockImplementation(async () => session);
  vi.mocked(dispatchAppCreation).mockImplementation(async () => session);
  await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("local app creation form", () => {
  it("restores bounded fields even when JSON escaping increases the stored size", async () => {
    const prompt = "\u0000".repeat(20000);
    localStorage.setItem("hosty.creation.test", JSON.stringify({ ...draft, prompt, iconPng: "A".repeat(174764) }));
    await click(button("Create app"));
    expect(input("prompt").value).toBe(prompt);
    expect(input("author").value).toBe(draft.authorName);
    expect(document.body.textContent).not.toContain("could not be read");
  });

  it("restores all draft fields after remount, requires consent, and preserves a manually chosen id", async () => {
    localStorage.setItem("hosty.creation.test", JSON.stringify(draft));
    await click(button("Create app"));
    expect(input("author").value).toBe("Draft Author");
    expect(button("Create and build").disabled).toBe(true);
    await type("id", "custom.notes"); await type("name", "New name");
    expect(input("id").value).toBe("custom.notes");
    await click(document.getElementById("create-app-consent")!);
    await act(async () => root.unmount()); root = createRoot(host); await render();
    await click(button("Create app"));
    expect(input("name").value).toBe("New name"); expect(input("id").value).toBe("custom.notes");
    expect(button("Create and build").disabled).toBe(false);
  });
  it("suggests valid ids and saves a configured Git identity without overriding an edit", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(workspaceAction).mockImplementation(() => new Promise(r => { resolve = r; }));
    await click(button("Create app"));
    await type("name", "Notes & Tasks");
    expect(input("id").value).toBe("local.notes-tasks");
    await type("author", "Chosen Author");
    await act(async () => resolve({ gitIdentity: { name: "Profile", email: "profile@example.test" } }));
    expect(input("author").value).toBe("Chosen Author"); expect(input("email").value).toBe("profile@example.test");
    expect(JSON.parse(localStorage.getItem("hosty.creation.test")!).authorName).toBe("Chosen Author");
    await type("id", "local..bad"); expect(input("id").checkValidity()).toBe(false);
  });
  it("shows failed persistence, retains the open draft and makes no creation request", async () => {
    localStorage.setItem("hosty.creation.test", JSON.stringify({ ...draft, consent: true }));
    await click(button("Create app"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota"); });
    await type("description", "Unsaved but retained");
    await click(button("Create and build"));
    expect(document.body.textContent).toContain("Draft could not be saved");
    expect(workspaceAction).not.toHaveBeenCalled();
    expect(input("name").disabled).toBe(false);
    await click(button("Close")); await click(button("Create app"));
    expect(input("description").value).toBe("Unsaved but retained");
  });
  it("retains the original request on uncertainty and retries without changing bootstrap arguments", async () => {
    localStorage.setItem("hosty.creation.test", JSON.stringify({ ...draft, consent: true }));
    await click(button("Create app"));
    vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("Response lost"));
    await click(button("Create and build"));
    const original = vi.mocked(workspaceAction).mock.calls[0]![2];
    expect(input("name").disabled).toBe(true);
    expect(document.body.textContent).toContain("Response lost");
    await click(button("Close")); await click(button("Create app"));
    vi.mocked(workspaceAction).mockResolvedValue({});
    await click(button("Continue creation"));
    expect(vi.mocked(workspaceAction).mock.calls[1]![2]).toEqual(original);
    expect(dispatchAppCreation).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("hosty.creation.test")).toBeNull();
  });
  it("unlocks only a confirmed refusal and preserves the draft", async () => {
    localStorage.setItem("hosty.creation.test", JSON.stringify({ ...draft, consent: true }));
    await click(button("Create app"));
    vi.mocked(workspaceAction).mockImplementation(async (_id, _action, data) => {
      session = { ...session, appCreations: [{ input: data!, state: "rejected" }] };
      throw new Error("App id already exists");
    });
    await click(button("Create and build"));
    expect(input("id").disabled).toBe(false); expect(input("id").value).toBe(draft.appId);
    expect(JSON.parse(localStorage.getItem("hosty.creation.test")!).requestId).toBeUndefined();
  });
  it("recovers an observed creation with its server author and prompt after browser storage is gone", async () => {
    const requestId = crypto.randomUUID();
    session = { ...session, appCreations: [{ state: "observed", input: { requestId, appId: draft.appId, name: draft.name,
      authorName: draft.authorName, authorEmail: draft.authorEmail, bootstrapCommit: true }, prompt: draft.prompt }],
      handoffDispatch: { id: requestId, state: "queued" } };
    await render(); await click(button("Create app")); await click(button("Recover"));
    expect(input("author").value).toBe(draft.authorName); expect(input("author").disabled).toBe(true);
    expect(input("prompt").value).toBe(draft.prompt); expect(input("prompt").disabled).toBe(true);
    await click(button("Continue creation"));
    expect(workspaceAction).toHaveBeenCalledWith("test", "app-create", session.appCreations![0]!.input);
    expect(dispatchAppCreation).toHaveBeenCalledWith("test", requestId, draft.prompt);
  });
});
