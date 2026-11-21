// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SessionContextDialog } from "./session-context-dialog";
import * as api from "@/lib/assistant-api";
import { connectionModels } from "@/lib/profiles-api";
vi.mock("@/lib/assistant-api", async original => ({ ...await original<typeof api>(), getSessionContextOptions: vi.fn(), changeSessionContext: vi.fn() }));
vi.mock("@/lib/profiles-api", () => ({ connectionModels: vi.fn() }));

const chat: api.AssistantSession = { id: "chat", createdBy: "owner", status: "failed", createdAt: "", title: "Same chat",
  connectionId: "old", providerLocked: true, executionSelection: { model: "old-model", reasoningEffort: null } };
const replacement = { id: "replacement", name: "Current account", bindingRevision: "installation-2" };
const options: api.SessionContextOptions = { connections: [replacement], currentConnectionId: null, selectionRevision: 9 };
const after = { ...chat, connectionId: replacement.id, selectionRevision: 10 };
const catalog: api.ModelCatalog = { revision: "2", models: [{ id: "model", label: "Current model", efforts: [{ id: "high", label: "High" }] }] };
let container: HTMLElement, root: Root;
const onChange = vi.fn(), onClose = vi.fn(), onSaving = vi.fn();
const render = (session = chat) => act(async () => root.render(<SessionContextDialog session={session} busy={false} onChange={onChange}
  onClose={onClose} onSavingChange={onSaving} focusTrigger={() => {}} />));
const button = (name: string) => [...document.querySelectorAll("button")].find(b => b.textContent === name);
const click = (name: string) => act(async () => button(name)!.click());
async function choose(label: string, value: string) {
  const field = [...document.querySelectorAll("label")].find(node => node.firstChild?.textContent === label)!.querySelector("select")!;
  await act(async () => { field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function reviewFresh() {
  await render();
  await choose("Connection", replacement.id); await choose("Model", "model");
  await choose("Reasoning effort", "high"); await click("Review fresh start");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.mocked(api.getSessionContextOptions).mockResolvedValue(options);
  vi.mocked(connectionModels).mockResolvedValue(catalog);
  vi.mocked(api.changeSessionContext).mockResolvedValue(after);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("allows inspecting the replacement's own models and cancelling before any change", async () => {
  await reviewFresh();
  expect(connectionModels).toHaveBeenCalledExactlyOnceWith(replacement.id);
  expect(document.body.textContent).toContain("no prior conversation history");
  expect(document.body.textContent).toContain("Current account · Current model");
  await click("Cancel");
  expect(onClose).toHaveBeenCalledOnce();
  expect(api.changeSessionContext).not.toHaveBeenCalled();
});
it("sends only the reviewed settings and replays the same confirmed request after a lost response and reload", async () => {
  vi.mocked(api.changeSessionContext).mockRejectedValueOnce(new Error("Connection lost"));
  await reviewFresh(); await click("Start new context");
  const [[id, request]] = vi.mocked(api.changeSessionContext).mock.calls;
  expect(id).toBe(chat.id);
  expect(request).toEqual({ requestId: expect.any(String), expectedRevision: 9, connectionId: replacement.id,
    expectedBinding: replacement.bindingRevision, model: "model", reasoningEffort: "high", mode: "fresh" });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  vi.mocked(api.getSessionContextOptions).mockRejectedValue(new Error("Offline"));
  await render(); await click("Retry confirmed change");
  expect(api.getSessionContextOptions).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.changeSessionContext).mock.calls[1]).toEqual([id, request]);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(after);
  expect(localStorage.getItem('hosty.session-context.v1.["owner","chat"]')).toBeNull();
});
it("offers native resume only for a connection the provider verified and keeps fresh opt-in distinct", async () => {
  vi.mocked(api.getSessionContextOptions).mockResolvedValue({ ...options, connections: [{ ...replacement, canResume: true },
    { id: "new-account", name: "Other account", bindingRevision: "other-binding" }], currentConnectionId: replacement.id });
  await render(); await choose("Model", "model");
  expect(button("Review verified resume")).toBeDefined();
  await choose("Connection", "new-account");
  expect(button("Review verified resume")).toBeUndefined();
  await choose("Connection", replacement.id); await choose("Model", "model"); await click("Review verified resume");
  expect(document.body.textContent).toContain("provider verified");
  expect(api.changeSessionContext).not.toHaveBeenCalled();
  await click("Resume context");
  expect(api.changeSessionContext).toHaveBeenCalledExactlyOnceWith(chat.id, expect.objectContaining({ mode: "resume", connectionId: replacement.id,
    expectedBinding: replacement.bindingRevision, expectedRevision: 9 }));
});
it("returns a stale confirmation to discovery without silently submitting a different binding", async () => {
  vi.mocked(api.changeSessionContext).mockRejectedValueOnce(new api.AssistantApiError("context_stale", "Connection changed.", 409));
  await reviewFresh(); await click("Start new context");
  expect(api.getSessionContextOptions).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Connection changed.");
  expect(button("Retry confirmed change")).toBeUndefined();
  expect(onChange).not.toHaveBeenCalled();
});
it("shows configuration guidance with zero accounts and supports retrying an unavailable catalog", async () => {
  vi.mocked(api.getSessionContextOptions).mockResolvedValueOnce({ ...options, connections: [] });
  vi.mocked(connectionModels).mockRejectedValueOnce(new Error("Provider is offline"));
  await render();
  expect(document.body.textContent).toContain("Configure an account");
  await click("Refresh connections"); await choose("Connection", replacement.id);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Provider is offline");
  await click("Retry models"); await choose("Model", "model");
  expect(button("Review fresh start")?.disabled).toBe(false);
  expect(api.changeSessionContext).not.toHaveBeenCalled();
});
it("keeps the catalog readable when the server reports an outstanding claim", async () => {
  vi.mocked(api.getSessionContextOptions).mockResolvedValue({ ...options, blockedReason: "Recover the workspace claim.", currentConnectionId: replacement.id });
  await render(); await choose("Model", "model");
  expect(document.body.textContent).toContain("Recover the workspace claim.");
  expect(button("Review fresh start")?.disabled).toBe(true);
});
